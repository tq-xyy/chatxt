import { Config } from '../config'
import { ChatCompletionRequest, Message, Tool } from '../llmapi'

export async function chatCompletion(
    messages: Message[],
    config: Config,
    stream: boolean = true,
    tools: Tool[] | null = null
) {
    const body: Partial<ChatCompletionRequest> = {
        model: config.model,
        thinking: { type: 'enabled' },
        reasoning_effort:
            config.thinking_effort as ChatCompletionRequest['reasoning_effort'],
        messages,
    }

    if (stream) {
        body.stream = true
        body.stream_options = { include_usage: true }
    }

    if (tools) {
        body.tools = tools
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
        let errorText = await resp.text()
        try {
            const errorJSON = JSON.parse(errorText)
            console.log(errorJSON)
            errorText = errorJSON.error.message
        } catch {}

        throw new Error(
            `API Request Failed (${resp.status}), error message: ${errorText}`
        )
    }

    return resp
}
