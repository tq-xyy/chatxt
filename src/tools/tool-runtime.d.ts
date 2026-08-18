import type {
    ChatCompletionRequest,
    ChatCompletionResponse,
} from '../types/openai-compatible-api'

export {}

declare global {
    function serveAsTool(
        ...entries: (
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
            { new (...args: any[]): any },
            { optional?: boolean }?,
        ][]
    ): {
        type: 'object'
        properties: Record<string, { type: string; description: string }>
        required: string[]
    }
}
