import type {
    ExecuteMessage,
    ChatCompletionResultMessage,
    ExitMessage,
} from './ipc-types'
import type {
    ChatCompletionRequest,
    ChatCompletionResponse,
} from '../types/openai-compatible-api'

type ToolFunction = (...args: unknown[]) => unknown

interface RegisteredTool {
    name: string
    description: string
    parameters: Record<string, unknown>
    func: ToolFunction
}

const toolMap = new Map<string, RegisteredTool>()
const toolDefs: Omit<RegisteredTool, 'func'>[] = []
let nextChatId = 0
const pendingChats = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
>()

function serveAsTool(
    ...entries: (
        | [ToolFunction, string, Record<string, unknown>]
        | null
        | undefined
        | false
    )[]
): void {
    const validEntries = entries.filter(Boolean) as [
        ToolFunction,
        string,
        Record<string, unknown>,
    ][]

    for (const [func, description, parameters] of validEntries) {
        const name = func.name || `anonymous_${toolDefs.length}`
        if (toolMap.has(name)) {
            process.send!({
                type: 'warning',
                message: `Duplicate tool name "${name}" ignored.`,
            })
            continue
        }
        toolMap.set(name, { name, description, parameters, func })
        toolDefs.push({ name, description, parameters })
    }

    const definitions = toolDefs.map(({ name, description, parameters }) => ({
        type: 'function' as const,
        function: { name, description, parameters },
    }))

    if (process.send) {
        process.send({ type: 'register', tools: definitions })
    } else {
        console.error(
            'FATAL: IPC channel not available. This script must be launched with child_process.fork.'
        )
        process.exit(1)
    }

    process.on(
        'message',
        async (
            msg: ExecuteMessage | ChatCompletionResultMessage | ExitMessage
        ) => {
            if (msg.type === 'execute') {
                const { id, toolName, args } = msg
                const tool = toolMap.get(toolName)
                try {
                    if (!tool) throw new Error(`Tool "${toolName}" not found.`)
                    const result = tool.func(args)
                    const output =
                        result instanceof Promise ? await result : result
                    process.send!({ type: 'result', id, result: output })
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
        }
    )
}

async function chatCompletion(
    request: ChatCompletionRequest
): Promise<ChatCompletionResponse> {
    const id = String(++nextChatId)
    return new Promise((resolve, reject) => {
        pendingChats.set(id, {
            resolve(value) {
                resolve(value as ChatCompletionResponse)
            },
            reject,
        })
        process.send!({ type: 'chatCompletion', id, request })
    })
}

function ToJSONSchema(
    argsDefs: [
        string,
        string,
        StringConstructor | NumberConstructor | BooleanConstructor,
        { optional?: boolean }?,
    ][]
): Record<string, unknown> {
    const properties: Record<string, unknown> = {}
    const required: string[] = []

    for (const def of argsDefs) {
        const [name, description, Type, options] = def
        const optional = options?.optional ?? false

        let jsonType: string
        switch (Type) {
            case String:
                jsonType = 'string'
                break
            case Number:
                jsonType = 'number'
                break
            case Boolean:
                jsonType = 'boolean'
                break
            default:
                throw new Error(`Unsupported type for argument "${name}"`)
        }

        properties[name] = {
            type: jsonType,
            description,
        }

        if (!optional) {
            required.push(name)
        }
    }

    return {
        type: 'object',
        properties,
        required,
    }
}

;(globalThis as Record<string, unknown>).serveAsTool = serveAsTool
;(globalThis as Record<string, unknown>).chatCompletion = chatCompletion
;(globalThis as Record<string, unknown>).ToJSONSchema = ToJSONSchema
