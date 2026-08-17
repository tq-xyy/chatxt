import { fork, ChildProcess } from 'child_process'
import * as path from 'path'
import { pathToFileURL } from 'url'
import type { ToolDefinition, ToolCall, Message } from '../types/openaiApi'
import type {
    ResultMessage,
    ChatCompletionMessage,
    WarningMessage,
} from './ipc-types'
import type { ChatSession } from '../session'
import { printWarningMessage, printExceptionMessage } from '../tui'

export class ToolRunner {
    private processes = new Map<string, ChildProcess>()
    private toolDefinitions = new Map<
        string,
        { definition: ToolDefinition; filePath: string }
    >()
    private pendingRequests = new Map<
        string,
        { resolve: (value: any) => void; reject: (err: Error) => void }
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

        child.stdout?.pipe(process.stdout)
        child.stderr?.pipe(process.stderr)

        const tools = await new Promise<ToolDefinition[]>(
            (resolve, reject) => {
                const onMessage = (msg: any) => {
                    if (msg.type === 'register') {
                        resolve(msg.tools)
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
            }
        )

        for (const tool of tools) {
            const name = tool.function.name
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

        child.on('message', (msg: any) => this.handleMessage(msg, child))
        child.on('error', err => {
            printExceptionMessage(err)
        })
        child.on('exit', (code, signal) => {
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

    getDefinitions(): ToolDefinition[] {
        return Array.from(this.toolDefinitions.values()).map(v => v.definition)
    }

    async execute(toolCall: ToolCall): Promise<Message> {
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
                args: JSON.parse(argsJson),
            })
        }).then(result => ({
            role: 'tool' as const,
            tool_call_id: id,
            content:
                typeof result === 'string' ? result : JSON.stringify(result),
        }))
    }

    executeAll(toolCalls: ToolCall[]): Promise<Message[]> {
        return Promise.all(toolCalls.map(tc => this.execute(tc)))
    }

    close(): void {
        for (const child of this.processes.values()) {
            child.send({ type: 'exit' })
        }
    }

    private handleMessage(
        msg: ResultMessage | ChatCompletionMessage | WarningMessage,
        child: ChildProcess
    ) {
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
            this.forwardChatCompletion(msg, child)
        } else if (msg.type === 'warning') {
            printWarningMessage(msg.message)
        }
    }

    private async forwardChatCompletion(
        msg: ChatCompletionMessage,
        child: ChildProcess
    ): Promise<void> {
        const { id, request } = msg
        try {
            const result = await this.session.subAgentChatCompletion(request)
            child.send({ type: 'chatCompletionResult', id, result })
        } catch (err: any) {
            child.send({
                type: 'chatCompletionResult',
                id,
                error: err.message,
            })
        }
    }
}
