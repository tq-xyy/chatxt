import type {
    ChatCompletionRequest,
    ChatCompletionResponse,
} from '../types/apis/openai-compatible-api'

export {}

declare global {
    function serveAsTool(
        ...entries: (
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            [(...args: any[]) => any, string, any] | null | undefined | false
        )[]
    ): void

    function chatCompletion(
        request: Partial<ChatCompletionRequest>
    ): Promise<ChatCompletionResponse>

    function ToJSONSchema(
        argsDefs: [
            string,
            string,
            NumberConstructor | StringConstructor | BooleanConstructor,
            { optional?: boolean }?,
        ][]
    ): {
        type: 'object'
        properties: Record<string, { type: string; description: string }>
        required: string[]
    }
}
