import type {
    ExecuteMessage,
    ChatCompletionResultMessage,
    ExitMessage,
    IPCMessage,
} from './ipc-types'
import type {
    OpenAICompatibleRequest,
    OpenAICompatibleResponse,
} from '../types/apis/openai-compatible-api'
import type { JSONSchema7 as JSONSchema } from 'json-schema'
import type { ToolDef } from '../types/chat-file'

type ToolFunction = (arg: unknown) => unknown

interface RegisteredTool extends ToolDef {
    func: ToolFunction
}

type WithFalsy<T> = T | null | undefined | false

export type ChatxtToolAPI = {
    runtime: {
        exposeTool(
            tools: WithFalsy<{
                name: string
                description: string
                parameters: JSONSchema
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                func: (arg: any) => any
            }>[]
        ): void
        chatCompletion(
            request: Omit<OpenAICompatibleRequest, 'model'> & {
                model?: string
            }
        ): Promise<OpenAICompatibleResponse>
    }
    helpers: {
        convertArgsToSchema(
            argsDefs: [
                string,
                string,
                StringConstructor | NumberConstructor | BooleanConstructor,
                { optional?: boolean }?,
            ][]
        ): JSONSchema
    }
}

const toolMap = new Map<string, RegisteredTool>()
const toolDefs: ToolDef[] = []
let nextChatId = 0
const pendingChats = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
>()

const toolAPI: ChatxtToolAPI = {
    runtime: {
        exposeTool(tools) {
            for (const tool of tools) {
                if (!tool) continue
                const { name, func, description, parameters } = tool
                if (toolMap.has(name)) {
                    process.send!({
                        type: 'warning',
                        message: `Duplicate tool name "${name}" ignored.`,
                    } as IPCMessage)
                    continue
                }
                toolMap.set(name, {
                    name,
                    description,
                    parameters,
                    func: func as unknown as ToolFunction,
                })
                toolDefs.push({ name, description, parameters })
            }

            if (process.send) {
                process.send({ type: 'register', toolDefs } as IPCMessage)
            } else {
                console.error(
                    'FATAL: IPC channel not available. This script must be launched with child_process.fork.'
                )
                process.exit(1)
            }

            process.on(
                'message',
                async (
                    msg:
                        | ExecuteMessage
                        | ChatCompletionResultMessage
                        | ExitMessage
                ) => {
                    if (msg.type === 'execute') {
                        const { id, toolName, args } = msg
                        const tool = toolMap.get(toolName)
                        try {
                            if (!tool)
                                throw new Error(
                                    `Tool "${toolName}" not found.`
                                )
                            const result = tool.func(args)
                            const output =
                                result instanceof Promise
                                    ? await result
                                    : result
                            process.send!({
                                type: 'result',
                                id,
                                result: output,
                            } as IPCMessage)
                        } catch (err) {
                            let error: string
                            if (err instanceof Error) {
                                error = `${err.name}:${err.message}\n${err.stack}`
                            } else {
                                error = String(err)
                            }
                            process.send!({
                                type: 'result',
                                id,
                                error,
                            } as IPCMessage)
                        }
                    } else if (msg.type === 'chatCompletionResult') {
                        const pending = pendingChats.get(msg.id)
                        if (pending) {
                            if (msg.error) {
                                pending.reject(new Error(msg.error))
                            } else {
                                pending.resolve(msg.result)
                            }
                            pendingChats.delete(msg.id)
                        }
                    } else if (msg.type === 'exit') {
                        process.emit('beforeExit')
                        process.exit(0)
                    }
                }
            )
        },
        async chatCompletion(
            request: OpenAICompatibleRequest
        ): Promise<OpenAICompatibleResponse> {
            const id = String(++nextChatId)
            return new Promise((resolve, reject) => {
                pendingChats.set(id, {
                    resolve(value) {
                        resolve(value as OpenAICompatibleResponse)
                    },
                    reject,
                })
                process.send!({
                    type: 'chatCompletion',
                    id,
                    request,
                } as IPCMessage)
            })
        },
    },
    helpers: {
        convertArgsToSchema(argsDefs) {
            const properties: Record<string, JSONSchema> = {}
            const required: string[] = []

            for (const def of argsDefs) {
                const [name, description, Type, options] = def
                const optional = options?.optional ?? false

                switch (Type) {
                    case String:
                        properties[name] = {
                            type: 'string',
                            description,
                        }
                        break
                    case Number:
                        properties[name] = {
                            type: 'number',
                            description,
                        }
                        break
                    case Boolean:
                        properties[name] = {
                            type: 'boolean',
                            description,
                        }
                        break
                    default:
                        throw new Error(
                            `Unsupported type for argument "${name}"`
                        )
                }

                if (!optional) {
                    required.push(name)
                }
            }

            return {
                type: 'object',
                properties,
                required,
                additionalProperties: false,
            }
        },
    },
}

;(globalThis as Record<string, unknown>).chatxt = toolAPI
