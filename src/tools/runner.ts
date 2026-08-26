import { fork, ChildProcess } from 'child_process'
import * as path from 'path'
import { pathToFileURL } from 'url'
import type { ToolDef, ToolCall, ToolMessage } from '../types/chat-file'
import type { ChatCompletionMessage, IPCMessage } from './ipc-types'
import type { ChatSession } from '../session'
import { printWarningMessage, printExceptionMessage } from '../tui'
import { createAPIAdapter } from '../api'
import { getModelGateway } from '../config'
import type { APIAdapter, StreamEvent } from '../types/api-adapter'
import type { OpenAICompatibleResponse } from '../types/apis/openai-compatible-api'
import { parseSSEStream } from '../utils/sseStream'

export class ToolRunner {
    private processes = new Map<string, ChildProcess>()
    private toolDefinitions = new Map<
        string,
        { definition: ToolDef; filePath: string }
    >()
    private pendingRequests = new Map<
        string,
        { resolve: (value: unknown) => void; reject: (err: Error) => void }
    >()
    private childRequests = new Map<ChildProcess, Set<string>>()
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
        })

        if (this.session.config.emitToConsole) {
            child.stdout?.pipe(process.stderr)
        } else {
            child.stdout?.pipe(process.stdout)
        }

        child.stderr?.pipe(process.stderr)

        const tools = await new Promise<ToolDef[]>((resolve, reject) => {
            const onMessage = (msg: IPCMessage) => {
                if (msg.type === 'register') {
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

        child.on('message', (msg: IPCMessage) =>
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
            const requestIds = this.childRequests.get(child)
            if (requestIds) {
                for (const id of requestIds) {
                    const pending = this.pendingRequests.get(id)
                    if (pending)
                        pending.reject(
                            new Error(`Tool process for ${absPath} exited`)
                        )
                    this.pendingRequests.delete(id)
                }
                this.childRequests.delete(child)
            }
        })

        this.processes.set(absPath, child)
    }

    async loadTools(filePaths: string[]): Promise<void> {
        for (const fp of filePaths) {
            await this.loadTool(fp)
        }
    }

    getDefinitions(): ToolDef[] {
        return Array.from(this.toolDefinitions.values()).map(v => v.definition)
    }

    async execute(toolCall: ToolCall): Promise<ToolMessage> {
        const {
            id,
            function: { name, arguments: argsJson },
        } = toolCall
        const entry = this.toolDefinitions.get(name)
        if (!entry) {
            printWarningMessage(`Agent calls a unknown tool '${name}'.`)
            return {
                role: 'tool' as const,
                tool_call_id: id,
                content: JSON.stringify({
                    status: 'error',
                    message:
                        `Tool '${name}' is not available. ` +
                        'Check your tool definition list for right spelling.',
                }),
            }
        }
        const child = this.processes.get(entry.filePath)
        if (!child) {
            throw new Error(`Process for "${entry.filePath}" is not running.`)
        }

        const requestId = String(++this.requestIdCounter)
        if (!this.childRequests.has(child)) {
            this.childRequests.set(child, new Set())
        }
        this.childRequests.get(child)!.add(requestId)

        const args = JSON.parse(argsJson)

        return new Promise(resolve => {
            this.pendingRequests.set(requestId, {
                resolve,
                reject(err) {
                    resolve({
                        role: 'tool' as const,
                        tool_call_id: toolCall.id,
                        content: JSON.stringify({
                            status: 'error',
                            message: `Error executing tool ${toolCall.function.name}: ${err.message}`,
                        }),
                    })
                },
            })
            child.send({
                type: 'execute',
                id: requestId,
                toolName: name,
                args,
            })
        }).then(result => ({
            role: 'tool' as const,
            tool_call_id: id,
            content:
                typeof result === 'string' ? result : JSON.stringify(result),
        }))
    }

    executeAll(toolCalls: ToolCall[]): Promise<ToolMessage[]> {
        return Promise.all(toolCalls.map(tc => this.execute(tc)))
    }

    close(): void {
        for (const child of this.processes.values()) {
            child.send({ type: 'exit' })
        }
    }

    private handleMessage(msg: IPCMessage, child: ChildProcess) {
        if (msg.type === 'result') {
            const pending = this.pendingRequests.get(msg.id)
            if (pending) {
                if (msg.error) {
                    pending.reject(new Error(msg.error))
                } else {
                    pending.resolve(msg.result)
                }
                this.pendingRequests.delete(msg.id)
                const ids = this.childRequests.get(child)
                if (ids) ids.delete(msg.id)
            }
        } else if (msg.type === 'chatCompletion') {
            this.subAgentChatCompletion(msg, child)
        } else if (msg.type === 'warning') {
            printWarningMessage(msg.message)
        }
    }

    async subAgentChatCompletion(
        msg: ChatCompletionMessage,
        child: ChildProcess
    ): Promise<void> {
        const { id, request } = msg

        if (request.stream) {
            child.send({
                type: 'chatCompletionResult',
                id,
                error: {
                    message:
                        'chatCompletion not support stream, please use `fetch`',
                },
            })
            return
        }

        if (request.tools) {
            child.send({
                type: 'chatCompletionResult',
                id,
                error: {
                    message:
                        'chatCompletion not support tools, please use `fetch`',
                },
            })
            return
        }

        if (!request.model) {
            request.model = this.session.config.model
        }

        this.session.reporter.setPrompt(
            'Call Function | Sub Agent Generating...'
        )

        const apiGateway = getModelGateway(this.session.config, request.model)

        const api: APIAdapter = createAPIAdapter(apiGateway.endpointType)

        await api.whenParsedChat({
            messages: request.messages.filter(msg => msg.role !== 'system'),
            system:
                request.messages.find(msg => msg.role === 'system') ?? null,
            toolDefinitions: [],
        })

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
            switch (msg.type) {
                case 'reasoning-delta':
                    result.choices[0].message.reasoning_content += msg.delta
                    this.session.reporter.update(msg.delta)
                    break
                case 'content-delta':
                    result.choices[0].message.content += msg.delta
                    this.session.reporter.update(msg.delta)
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
            const resp = await api.whenReadyToRequest(newConfig, apiGateway)

            for await (const streamMessage of parseSSEStream(resp)) {
                await api.whenRecvivedChunk(streamMessage, emit)
            }

            child.send({ type: 'chatCompletionResult', id, result })
        } catch (err) {
            child.send({
                type: 'chatCompletionResult',
                id,
                error: (err as { message: string }).message,
            })
        }
    }
}
