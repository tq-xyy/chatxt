import type { IPCMessageFromChild, IPCMessageFromMain } from './ipc-types'
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
        ): Promise<void>
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
                (
                    | StringConstructor
                    | NumberConstructor
                    | BooleanConstructor
                    | JSONSchema
                ),
                { optional?: boolean }?,
            ][]
        ): JSONSchema
    }
}

if (!process.send) {
    throw new Error(
        'FATAL: IPC channel not available. This script must be launched with child_process.fork.'
    )
}

function sendToIPC(message: IPCMessageFromChild): Promise<void> {
    return new Promise<void>((resovle, reject) => {
        process.send!(message, error => (error ? reject(error) : resovle()))
    })
}

const toolMap = new Map<string, RegisteredTool>()

let nextChatId = 0
const pendingChats = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
>()

process.on('message', async (msg: IPCMessageFromMain) => {
    if (msg.type === 'executeTool') {
        const { id, toolName, args } = msg
        const tool = toolMap.get(toolName)

        try {
            if (!tool) throw new Error(`Tool "${toolName}" not found.`)
            const result = tool.func(args)
            const output = result instanceof Promise ? await result : result
            sendToIPC({
                type: 'toolResult',
                id,
                result: output,
            })
        } catch (err) {
            let error: string
            if (err instanceof Error) {
                error = `${err.name}: ${err.message}`
            } else {
                error = String(err)
            }
            sendToIPC({
                type: 'toolResult',
                id,
                error,
            })
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
})

process.on('uncaughtException', error => {
    sendToIPC({
        type: 'error',
        name: error.name,
        message: error.message,
        stack: error.stack,
    })
})

const toolAPI: ChatxtToolAPI = {
    runtime: {
        async exposeTool(tools) {
            const toolDefs: ToolDef[] = []

            for (const tool of tools) {
                if (!tool) continue
                const { name, func, description, parameters } = tool
                if (toolMap.has(name)) {
                    await sendToIPC({
                        type: 'warning',
                        message: `Duplicate tool name "${name}" ignored.`,
                    })
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

            await sendToIPC({ type: 'registerTool', toolDefs })
        },
        async chatCompletion(request) {
            nextChatId++
            const id = nextChatId

            return new Promise((resolve, reject) => {
                pendingChats.set(id, {
                    resolve(value) {
                        resolve(value as OpenAICompatibleResponse)
                    },
                    reject,
                })
                sendToIPC({
                    type: 'chatCompletion',
                    id,
                    request: request as OpenAICompatibleRequest,
                })
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
                        properties[name] = { description, ...Type }
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
