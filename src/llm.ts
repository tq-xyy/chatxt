import type {
    Message,
    ChatCompletionRequest,
    ChatCompletionChunk,
    ToolCall,
    Tool,
} from './llmapi.js'
import type { Config } from './config.js'

export interface LLMStreamResult {
    content: string
    reasoningContent: string
    toolCalls: ToolCall[]
    usage: {
        promptTokens: number
        completionTokens: number
        totalTokens: number
    } | null
}

interface StreamChunk {
    content: string
    reasoningContent: string
    toolCalls: ToolCall[]
    finishReason: string | null
}

/**
 * Call the LLM API with streaming support.
 * Calls onChunk for each received piece of content (with debounce).
 */
export async function callLLMStream(
    config: Config,
    messages: Message[],
    tools: Tool[] | null,
    onChunk: (chunk: StreamChunk) => void,
    signal?: AbortSignal
): Promise<LLMStreamResult> {
    const url = `${config.endpoint.replace(/\/+$/, '')}/v1/chat/completions`

    const requestBody: ChatCompletionRequest = {
        messages,
        model: config.model as any,
        stream: true,
        stream_options: { include_usage: true },
    }

    if (tools && tools.length > 0) {
        requestBody.tools = tools
    }

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal,
    })

    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(
            `API request failed (${response.status}): ${errorText}`
        )
    }

    if (!response.body) {
        throw new Error('Response body is null')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()

    const result: LLMStreamResult = {
        content: '',
        reasoningContent: '',
        toolCalls: [],
        usage: null,
    }

    let buffer = ''
    let accumulateContent = ''
    let accumulateReasoning = ''
    let accumulateToolCalls: ToolCall[] = []
    let lastFlush = Date.now()
    const DEBOUNCE_MS = 16

    function flushAccumulated() {
        if (accumulateContent || accumulateReasoning) {
            const chunk: StreamChunk = {
                content: accumulateContent,
                reasoningContent: accumulateReasoning,
                toolCalls: [],
                finishReason: null,
            }
            onChunk(chunk)
            result.content += accumulateContent
            result.reasoningContent += accumulateReasoning
            accumulateContent = ''
            accumulateReasoning = ''
        }
        if (accumulateToolCalls.length > 0) {
            result.toolCalls.push(...accumulateToolCalls)
            accumulateToolCalls = []
        }
        lastFlush = Date.now()
    }

    while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split('\n')
        buffer = lines.pop() || '' // Keep incomplete line in buffer

        for (const line of lines) {
            const trimmedLine = line.trim()
            if (!trimmedLine || !trimmedLine.startsWith('data: ')) continue

            const data = trimmedLine.slice(6)
            if (data === '[DONE]') continue

            try {
                const parsed = JSON.parse(data) as ChatCompletionChunk

                // Handle usage info in last chunk
                if (parsed.usage) {
                    result.usage = {
                        promptTokens: parsed.usage.prompt_tokens,
                        completionTokens: parsed.usage.completion_tokens,
                        totalTokens: parsed.usage.total_tokens,
                    }
                }

                const choice = parsed.choices?.[0]
                if (!choice) continue

                const delta = choice.delta

                if (delta?.content) {
                    accumulateContent += delta.content
                }

                if (delta?.reasoning_content) {
                    accumulateReasoning += delta.reasoning_content
                }

                // Check for tool_calls in delta
                if ((delta as any)?.tool_calls) {
                    for (const tc of (delta as any).tool_calls) {
                        // tool_calls come incrementally; we need to accumulate
                        let existingCall = accumulateToolCalls.find(
                            t => t.id === tc.id
                        )
                        if (!existingCall) {
                            existingCall = result.toolCalls.find(
                                t => t.id === tc.id
                            )
                        }
                        if (!existingCall) {
                            // Find if it's in toolCalls from previous iterations
                            if (tc.id) {
                                accumulateToolCalls.push({
                                    id: tc.id,
                                    type: 'function',
                                    function: {
                                        name: tc.function?.name || '',
                                        arguments:
                                            tc.function?.arguments || '',
                                    },
                                })
                            }
                        } else {
                            // Accumulate arguments
                            existingCall.function.arguments +=
                                tc.function?.arguments || ''
                            if (tc.function?.name) {
                                existingCall.function.name = tc.function.name
                            }
                        }
                    }
                }

                // Flush based on debounce
                const now = Date.now()
                if (
                    now - lastFlush >= DEBOUNCE_MS &&
                    (accumulateContent || accumulateReasoning)
                ) {
                    flushAccumulated()
                }
            } catch (err) {
                // Skip malformed JSON chunks
                continue
            }
        }
    }

    // Final flush
    flushAccumulated()

    // Process toolCalls: merge delta-style accumulations into final toolCalls
    // The accumulateToolCalls should be the final merged calls
    if (accumulateToolCalls.length > 0) {
        result.toolCalls = accumulateToolCalls
    }

    return result
}
