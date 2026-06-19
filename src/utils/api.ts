import { Config } from '../config'
import { ChatCompletionRequest, Message } from '../llmapi'

export async function chatCompletion(
    messages: Message[],
    config: Config,
    stream: boolean = true
) {
    const body: Partial<ChatCompletionRequest> = {
        model: config.model,
        thinking: {},
        reasoning_effort:
            config.thinking_effort as ChatCompletionRequest['reasoning_effort'],
        messages,
    }

    if (stream) {
        body.stream = true
        body.stream_options = { include_usage: true }
    }

    const resp = await fetch(`${config.endpoint}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
    })

    if (!resp.ok) {
        const errorText = await resp.text()
        try {
            const errorJSON = JSON.parse(errorText)
            throw new Error(`API Request Failed, error message: ${errorJSON.error.message}`)
        } catch {
            throw new Error(`HTTP ${resp.status}: ${errorText}`)
        }
    }

    return resp
}
