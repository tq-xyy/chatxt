import type {
    ChatCompletionRequest,
    ChatCompletionResponse,
    ToolCall,
    ToolCallChunk,
} from '../types/openai-compatible-api'

type ChatCompletionAPI = {
    endpoint: string
    apikey: string
}

async function requestChatCompletion(
    request: ChatCompletionRequest,
    api: ChatCompletionAPI
): Promise<Response> {
    const resp = await fetch(`${api.endpoint}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${api.apikey}`,
        },
        body: JSON.stringify(request),
    })

    if (!resp.ok) {
        let errorText = await resp.text()
        try {
            const errorJSON = JSON.parse(errorText)
            errorText = errorJSON.error.message || errorText
        } catch {}

        const statusText =
            resp.statusText.length > 0
                ? `${resp.status} ${resp.statusText}`
                : `${resp.status}`

        throw new Error(
            `API Request Failed (${statusText}), error message: ${errorText}`
        )
    }

    return resp
}

export async function chatCompletionStream(
    request: ChatCompletionRequest,
    api: ChatCompletionAPI
): Promise<Response> {
    return requestChatCompletion({ ...request, stream: true }, api)
}

export async function chatCompletion(
    request: ChatCompletionRequest,
    api: ChatCompletionAPI
): Promise<ChatCompletionResponse> {
    const resp = await requestChatCompletion(request, api)
    const json = await resp.json()
    return json as ChatCompletionResponse
}

export function mergeToolCallChunks(chunks: ToolCallChunk[]): ToolCall[] {
    const toolCallList: ToolCall[] = []

    for (const chunk of chunks) {
        if (!chunk.function.name) {
            const index = toolCallList.findIndex(
                block => block.index === chunk.index
            )
            if (index === -1) {
                throw new Error(`unexcepted tool call index: ${chunk.index}`)
            }
            toolCallList[index].function.arguments += chunk.function.arguments
        } else {
            toolCallList.push(chunk as ToolCall)
        }
    }

    return toolCallList
}
