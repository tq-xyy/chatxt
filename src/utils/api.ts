import type {
    ChatCompletionRequest,
    ChatCompletionResponse,
} from '../types/openaiApi'

/** 连接 OpenAI 兼容 API 所需的连接信息 */
type ChatCompletionAPI = {
    endpoint: string
    apiKey: string
}

/**
 * 发送请求到 /chat/completions 并统一处理错误。
 * 纯 HTTP 封装：请求体原样透传，不含任何业务默认值。
 */
async function requestChatCompletion(
    request: ChatCompletionRequest,
    api: ChatCompletionAPI
): Promise<Response> {
    const resp = await fetch(`${api.endpoint}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${api.apiKey}`,
        },
        body: JSON.stringify(request),
    })

    if (!resp.ok) {
        let errorText = await resp.text()
        try {
            const errorJSON = JSON.parse(errorText)
            errorText = errorJSON.error.message || errorText
        } catch {}

        throw new Error(
            `API Request Failed (${resp.status} ${resp.statusText}), error message: ${errorText}`
        )
    }

    return resp
}

/** 流式请求：始终以 stream=true 发送，返回原始 Response，由调用方消费 SSE */
export async function chatCompletionStream(
    request: ChatCompletionRequest,
    api: ChatCompletionAPI
): Promise<Response> {
    return requestChatCompletion({ ...request, stream: true }, api)
}

/** 非流式请求：返回解析后的完整响应 */
export async function chatCompletion(
    request: ChatCompletionRequest,
    api: ChatCompletionAPI
): Promise<ChatCompletionResponse> {
    const resp = await requestChatCompletion(request, api)
    const json = await resp.json()
    return json as ChatCompletionResponse
}
