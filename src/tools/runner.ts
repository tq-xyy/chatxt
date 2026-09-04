import { fork, ChildProcess } from 'child_process'
import * as path from 'path'
import { pathToFileURL } from 'url'
import { printWarningMessage, printExceptionMessage } from '../tui'
import { createAPIAdapter } from '../api'
import { getModelGateway } from '../config'
import { parseSSEStream } from '../utils/sse-stream'

import type {
    ToolDef,
    FunctionCallMessage,
    FunctionCallResultMessage,
    Message,
} from '../types/chat-file'
import type {
    ChatCompletionMessage,
    IPCMessageFromMain,
    IPCMessageFromChild,
} from './ipc-types'
import type { APIAdapter, StreamEvent } from '../types/api-adapter'
import type { OpenAICompatibleResponse } from '../types/apis/openai-compatible-api'
import type { ChatxtToolAPI } from '../types/tool-runtime-api'
import type { ChatSession } from '../session'
import { chatxtVersion } from '../utils/meta'

function sendToChild(
    child: ChildProcess,
    message: IPCMessageFromMain
): Promise<void> {
    return new Promise<void>((resovle, reject) => {
        try {
            if (
                child.connected &&
                child.exitCode === null &&
                child.signalCode === null
            ) {
                child.send(message, error =>
                    error ? reject(error) : resovle()
                )
            }
        } catch (error) {
            reject(error)
        }
    })
}

export class ToolRunner {
    private processes = new Map<string, ChildProcess>()
    private toolDefinitions = new Map<
        string,
        { definition: ToolDef; filePath: string }
    >()
    private pendingToolCalls = new Map<
        ChildProcess,
        Map<
            number,
            { resolve: (value: unknown) => void; reject: (err: Error) => void }
        >
    >()
    private requestIdCounter = 0
    private runtimePath: string
    private session: ChatSession

    constructor(session: ChatSession) {
        this.session = session
        this.runtimePath = pathToFileURL(
            path.join(import.meta.dirname, 'tool-runtime.ts')
        ).href
    }

    async loadTool(filePath: string): Promise<void> {
        const absPath = path.resolve(filePath)
        if (this.processes.has(absPath)) return

        const child = fork(absPath, [], {
            execArgv: [...process.execArgv, '--import', this.runtimePath],
            stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
            env: {
                ...process.env,
                CHATXT_TOOL_CONTEXT: JSON.stringify({
                    toolPath: absPath,
                    chatFilePath: this.session.file.chatFilePath,
                    chatFileDirname: path.dirname(
                        this.session.file.chatFilePath
                    ),
                    chatxtVersion,
                } as ChatxtToolAPI['context']),
            },
        })

        child.stdout?.pipe(process.stderr)

        child.stderr?.pipe(process.stderr)

        const tools = await new Promise<ToolDef[]>((resolve, reject) => {
            const onMessage = (msg: IPCMessageFromChild) => {
                if (msg.type === 'registerTool') {
                    resolve(msg.toolDefs)
                    child.removeListener('message', onMessage)
                } else if (msg.type === 'error') {
                    reject(new Error(msg.message))
                    child.removeListener('message', onMessage)
                }
            }
            child.on('message', onMessage)
            child.on('error', reject)
            setTimeout(() => {
                reject(
                    new Error(
                        `Tool process for ${absPath} registration timed out.`
                    )
                )
                child.removeListener('message', onMessage)
            }, 10000)
        })

        for (const tool of tools) {
            const name = tool.name
            if (this.toolDefinitions.has(name)) {
                const existing = this.toolDefinitions.get(name)!
                printWarningMessage(
                    `Duplicate tool name "${name}" found in ${absPath}, ignored (already defined in ${existing.filePath})`
                )
            } else {
                this.toolDefinitions.set(name, {
                    definition: tool,
                    filePath: absPath,
                })
            }
        }

        child.on('message', (msg: IPCMessageFromChild) =>
            this.handleMessage(msg, child)
        )
        child.on('error', err => {
            printExceptionMessage(err)
        })
        child.on('exit', () => {
            for (const [name, entry] of this.toolDefinitions) {
                if (entry.filePath === absPath)
                    this.toolDefinitions.delete(name)
            }
            this.processes.delete(absPath)

            const calls = this.pendingToolCalls.get(child)
            if (calls) {
                for (const call of calls.values()) {
                    call.reject(
                        new Error(`Tool process for ${absPath} exited`)
                    )
                }
                this.pendingToolCalls.delete(child)
            }
        })

        this.processes.set(absPath, child)
    }

    async loadTools(filePaths: string[]): Promise<void> {
        for (const fp of filePaths) {
            await this.loadTool(fp)
        }
    }

    async unloadTool(filePath: string) {
        const absPath = path.resolve(filePath)
        if (!this.processes.has(absPath)) return

        await sendToChild(this.processes.get(absPath)!, { type: 'exit' })
    }

    getToolDefinitions(): ToolDef[] {
        return Array.from(this.toolDefinitions.values()).map(v => v.definition)
    }

    async execute(
        toolCall: FunctionCallMessage
    ): Promise<FunctionCallResultMessage> {
        const { callId, name: toolName, arguments: argsJson } = toolCall

        const entry = this.toolDefinitions.get(toolName)

        if (!entry) {
            printWarningMessage(`Agent calls a unknown tool '${toolName}'.`)
            return {
                role: 'tool-result' as const,
                callId,
                content: JSON.stringify({
                    status: 'error',
                    message:
                        `Tool '${toolName}' is not available. ` +
                        'Check your tool definition list for right spelling.',
                }),
            }
        }

        const child = this.processes.get(entry.filePath)
        if (!child) {
            throw new Error(`Process for "${entry.filePath}" is not running.`)
        }

        this.requestIdCounter++
        const requestId = this.requestIdCounter

        if (!this.pendingToolCalls.has(child)) {
            this.pendingToolCalls.set(child, new Map())
        }

        let callMap = this.pendingToolCalls.get(child)

        if (!callMap) {
            callMap = new Map()
            this.pendingToolCalls.set(child, callMap)
        }

        const args = JSON.parse(argsJson)

        try {
            const result = await new Promise((resolve, reject) => {
                callMap.set(requestId, { resolve, reject })

                sendToChild(child, {
                    type: 'executeTool',
                    id: requestId,
                    toolName,
                    args,
                })
            })

            return {
                role: 'tool-result' as const,
                callId,
                content:
                    typeof result === 'string'
                        ? result
                        : JSON.stringify(result),
            }
        } catch (err) {
            const message = `Error when executing tool ${toolName}: ${err instanceof Error ? err.message : err}`
            printWarningMessage(message)
            return {
                role: 'tool-result' as const,
                callId,
                content: JSON.stringify({
                    status: 'error',
                    message,
                }),
            }
        }
    }

    executeAll(
        toolCalls: FunctionCallMessage[]
    ): Promise<FunctionCallResultMessage[]> {
        return Promise.all(toolCalls.map(tc => this.execute(tc)))
    }

    async close(): Promise<void> {
        for (const child of this.processes.values()) {
            await sendToChild(child, { type: 'exit' })
        }
    }

    private async handleMessage(
        msg: IPCMessageFromChild,
        child: ChildProcess
    ) {
        if (msg.type === 'toolResult') {
            const pending = this.pendingToolCalls.get(child)?.get(msg.id)

            if (pending) {
                if (msg.error) {
                    pending.reject(new Error(msg.error))
                } else {
                    pending.resolve(msg.result)
                }
                this.pendingToolCalls.get(child)?.delete(msg.id)
                const ids = this.pendingToolCalls.get(child)
                if (ids) ids.delete(msg.id)
            }
        } else if (msg.type === 'chatCompletion') {
            await this.subAgentChatCompletion(msg, child)
        } else if (msg.type === 'warning') {
            printWarningMessage(msg.message)
        } else if (msg.type === 'error') {
            const err = new Error(msg.message)
            err.name = msg.name
            err.stack = msg.stack
            printExceptionMessage(err)
        }
    }

    async subAgentChatCompletion(
        msg: ChatCompletionMessage,
        child: ChildProcess
    ): Promise<void> {
        const { id, request } = msg

        if (request.stream) {
            await sendToChild(child, {
                type: 'chatCompletionResult',
                id,
                error: 'chatCompletion not support stream, please use `fetch`',
            })
            return
        }

        if (request.tools) {
            await sendToChild(child, {
                type: 'chatCompletionResult',
                id,
                error: 'chatCompletion not support tools, please use `fetch`',
            })
            return
        }

        if (!request.model) {
            request.model = this.session.config.model
        }

        this.session.panel.setPhase('subagent')

        const apiGateway = getModelGateway(this.session.config, request.model)

        const api: APIAdapter = createAPIAdapter(apiGateway.endpointType)

        const messages: Message[] = []
        for (const m of request.messages) {
            if (m.role === 'system') {
                messages.push({ role: 'system', content: m.content })
            } else if (m.role === 'user') {
                messages.push({ role: 'user', content: m.content })
            } else if (m.role === 'assistant') {
                if (m.tool_calls?.length) {
                    messages.push({
                        role: 'assistant',
                        content: m.content ?? '',
                    })
                    for (const tc of m.tool_calls) {
                        messages.push({
                            role: 'tool-call',
                            callId: tc.id,
                            name: tc.function.name,
                            arguments: tc.function.arguments,
                        })
                    }
                } else {
                    messages.push({
                        role: 'assistant',
                        content: m.content ?? '',
                        reasoning_content: m.reasoning_content ?? '',
                    })
                }
            } else if (m.role === 'tool') {
                messages.push({
                    role: 'tool-result',
                    callId: m.tool_call_id,
                    content: m.content,
                })
            }
        }

        const newConfig = { ...this.session.config }

        if (request.thinking) {
            newConfig.thinkingMode = request.thinking.type
        }

        if (request.reasoning_effort) {
            newConfig.thinkingEffort = request.reasoning_effort
        }

        if (request.max_tokens) {
            newConfig.maxTokens = request.max_tokens
        }

        if (request.response_format?.type === 'json_object') {
            newConfig.jsonOnly = true
        }

        const result: OpenAICompatibleResponse = {
            choices: [
                {
                    index: 0,
                    finish_reason: 'stop',
                    message: {
                        role: 'assistant',
                        content: '',
                        reasoning_content: '',
                    },
                },
            ],
            usage: undefined,
        }

        const emit = async (msg: StreamEvent) => {
            this.session.panel.onEvent(msg)
            switch (msg.type) {
                case 'reasoning-delta':
                    result.choices[0].message.reasoning_content += msg.delta
                    break
                case 'content-delta':
                    result.choices[0].message.content += msg.delta
                    break
                case 'response-end':
                    if (msg.finishReason) {
                        result.choices[0].finish_reason =
                            msg.finishReason as OpenAICompatibleResponse['choices'][0]['finish_reason']
                    }
                    if (msg.usage) {
                        result.usage = {
                            prompt_tokens: msg.usage.input,
                            completion_tokens: msg.usage.output,
                            total_tokens: msg.usage.input + msg.usage.output,
                            prompt_cache_hit_tokens: msg.usage.cached,
                            prompt_cache_miss_tokens:
                                msg.usage.input - msg.usage.cached,
                            completion_tokens_details: {
                                reasoning_tokens: msg.usage.thinking,
                            },
                        }
                        this.session.addUsageRecord({
                            ...msg.usage,
                            model: msg.usage.model ?? request.model,
                        })
                    }
                    break
            }
        }

        try {
            const resp = await api.buildRequest(
                newConfig,
                apiGateway,
                messages,
                []
            )

            for await (const streamMessage of parseSSEStream(resp)) {
                await api.handleChunk(streamMessage, emit)
            }
            await api.handleStreamEnd(emit)

            await sendToChild(child, {
                type: 'chatCompletionResult',
                id,
                result,
            })
        } catch (err) {
            await sendToChild(child, {
                type: 'chatCompletionResult',
                id,
                error: (err as { message: string }).message,
            })
        } finally {
            // 子代理结束：恢复工具执行阶段（可能还有并行工具在跑）
            this.session.panel.setPhase('tool')
        }
    }
}
