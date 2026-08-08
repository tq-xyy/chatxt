import type {
    ExecuteMessage,
    ChatCompletionResultMessage,
    ExitMessage,
} from './ipc-types'
import type {
    ChatCompletionRequest,
    ChatCompletionResponse,
} from '../types/openaiApi'

type ToolFunction = (...args: any[]) => any

interface RegisteredTool {
    name: string
    description: string
    parameters: Record<string, any>
    func: ToolFunction
}

const toolMap = new Map<string, RegisteredTool>()
const toolDefs: {
    name: string
    description: string
    parameters: Record<string, any>
}[] = []
let nextChatId = 0
const pendingChats = new Map<
    string,
    { resolve: (value: any) => void; reject: (err: Error) => void }
>()

function serveAsTool(
    ...entries: (
        [ToolFunction, string, Record<string, any>] | null | undefined | false
    )[]
): void {
    const validEntries = entries.filter(Boolean) as [
        ToolFunction,
        string,
        Record<string, any>,
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
                } catch (err: any) {
                    process.send!({
                        type: 'result',
                        id,
                        error: err.message || String(err),
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
        pendingChats.set(id, { resolve, reject })
        process.send!({ type: 'chatCompletion', id, request })
    })
}

function ToJSONSchema(
    argsDefs: [
        string,
        string,
        { new (...args: any[]): any },
        { optional?: boolean }?,
    ][]
): Record<string, any> {
    const properties: Record<string, any> = {}
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

;(globalThis as any).serveAsTool = serveAsTool
;(globalThis as any).chatCompletion = chatCompletion
;(globalThis as any).ToJSONSchema = ToJSONSchema
