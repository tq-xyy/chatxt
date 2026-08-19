import type { Config, ModelGateway } from '../config'
import type { ChatRole } from '../fileobj'
import type { APIAdapter, StreamEvent } from '../types/api-adapter'
import type {
    FinishReason,
    Message,
    SystemMessage,
    ToolCall,
    ToolCallChunk,
    ToolDefinition,
    ToolMessage,
} from '../types/chat-file'
import type { SSEMessage } from '../utils/sseStream'
import type {
    AnthropicContentBlock,
    AnthropicMessage,
    AnthropicRequest,
    AnthropicStreamEvent,
    AnthropicToolDefinition,
    AnthropicUsage,
} from '../types/apis/anthropic-api'
import { mergeNormalizedUsage, type NormalizedUsage } from '../common/usage'

// ======================== HTTP 层 ========================

async function anthropicRequest(
    request: AnthropicRequest,
    api: { endpoint: string; apikey: string }
): Promise<Response> {
    const resp = await fetch(`${api.endpoint}/messages`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': api.apikey,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(request),
    })

    if (!resp.ok) {
        let errorText = await resp.text()
        try {
            const errorJSON = JSON.parse(errorText)
            // Anthropic 错误体: { type: 'error', error: { type, message } }
            errorText = errorJSON.error?.message || errorText
        } catch {
            // use original error text
        }

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

// ======================== 请求转换 ========================

/**
 * 把 OpenAI 形状的 Message[] 转成 Anthropic messages。
 * - system 消息已抽到顶层，这里跳过
 * - assistant.tool_calls → tool_use blocks
 * - tool 消息 → 累积成 user(tool_result[])（Anthropic 要求 tool_result 在 user 消息里）
 */
function toAnthropicMessages(messages: Message[]): AnthropicMessage[] {
    const result: AnthropicMessage[] = []
    let pendingToolResults: AnthropicContentBlock[] = []

    const flushToolResults = () => {
        if (pendingToolResults.length === 0) return
        result.push({ role: 'user', content: pendingToolResults })
        pendingToolResults = []
    }

    for (const msg of messages) {
        if (msg.role === 'system') continue

        if (msg.role === 'user') {
            flushToolResults()
            result.push({ role: 'user', content: msg.content })
        } else if (msg.role === 'assistant') {
            flushToolResults()
            if (msg.tool_calls?.length) {
                result.push({
                    role: 'assistant',
                    content: msg.tool_calls.map(tc => ({
                        type: 'tool_use' as const,
                        id: tc.id,
                        name: tc.function.name,
                        input: JSON.parse(tc.function.arguments),
                    })),
                })
            } else {
                result.push({ role: 'assistant', content: msg.content ?? '' })
            }
        } else if (msg.role === 'tool') {
            pendingToolResults.push({
                type: 'tool_result',
                tool_use_id: msg.tool_call_id,
                content: msg.content,
            })
        }
    }

    flushToolResults()
    return result
}

function toAnthropicTools(
    toolDefitions: ToolDefinition[]
): AnthropicToolDefinition[] {
    return toolDefitions.map(td => ({
        name: td.function.name,
        description: td.function.description,
        input_schema: td.function.parameters ?? { type: 'object' },
    }))
}

// ======================== Adapter ========================

export class AnthropicAPIAdapter implements APIAdapter<AnthropicStreamEvent> {
    private outputFlag: ChatRole | boolean = 'UNKNOWN'
    private toolCallChunks: ToolCallChunk[] = []
    private messages: Message[] = []
    private toolDefitions: ToolDefinition[] = []
    private sumUsage: NormalizedUsage = {
        input: 0,
        output: 0,
        cached: 0,
        thinking: 0,
    }

    public async whenParsedChat({
        messages,
        system,
        toolDefitions,
    }: {
        messages: Message[]
        system: SystemMessage | null
        toolDefitions: ToolDefinition[]
    }) {
        this.outputFlag = 'UNKNOWN'
        this.messages = system ? [system, ...messages] : messages
        this.toolDefitions = toolDefitions
    }

    public async whenReadyToRequest(
        config: Config,
        gateway: ModelGateway,
        toolMessages?: ToolMessage[]
    ) {
        this.toolCallChunks = []
        if (toolMessages) {
            this.messages.push(...toolMessages)
        }

        const reqBody: AnthropicRequest = {
            model: gateway.model,
            max_tokens: config.maxTokens ?? 4096,
            messages: toAnthropicMessages(this.messages),
            tools: toAnthropicTools(this.toolDefitions),
            stream: true,
        }

        const system = this.messages.find(msg => msg.role === 'system')
        if (system?.role === 'system' && system.content) {
            reqBody.system = system.content
        }

        if (config.thinkingMode === 'enabled') {
            reqBody.thinking = {
                type: 'enabled',
                budget_tokens: config.thinkingEffort === 'max' ? 8192 : 4096,
            }
        }

        const resp = await anthropicRequest(reqBody, gateway)

        this.messages.push({
            role: 'assistant',
            content: '',
            reasoning_content: '',
            reasoning: '',
        })

        return resp
    }

    public async whenRecvivedChunk(
        message: SSEMessage<AnthropicStreamEvent, string>,
        emit: (event: StreamEvent) => Promise<void>
    ) {
        const event = message.data

        switch (event.type) {
            case 'ping':
            case 'message_start':
                return

            case 'content_block_start': {
                const block = event.content_block
                if (block.type === 'tool_use') {
                    if (this.outputFlag !== 'TOOL') {
                        this.outputFlag = 'TOOL'
                        await emit({ type: 'function-call-start' })
                    }
                    const chunk: ToolCallChunk = {
                        index: event.index,
                        id: block.id,
                        type: 'function',
                        function: { name: block.name, arguments: '' },
                    }
                    this.toolCallChunks.push(chunk)
                    await emit({
                        type: 'function-call-delta',
                        toolCallChunk: chunk,
                    })
                }
                return
            }

            case 'content_block_delta': {
                const delta = event.delta
                if (delta.type === 'text_delta') {
                    if (this.outputFlag !== 'ASSISTANT') {
                        this.outputFlag = 'ASSISTANT'
                        await emit({ type: 'content-start' })
                    }
                    this.messages.at(-1)!.content += delta.text
                    await emit({ type: 'content-delta', delta: delta.text })
                } else if (delta.type === 'thinking_delta') {
                    if (this.outputFlag !== 'THINKING') {
                        this.outputFlag = 'THINKING'
                        await emit({ type: 'reasoning-start' })
                    }
                    const lastMessage = this.messages.at(-1)
                    if (lastMessage?.role === 'assistant') {
                        lastMessage.reasoning_content += delta.thinking
                    }
                    await emit({
                        type: 'reasoning-delta',
                        delta: delta.thinking,
                    })
                } else if (delta.type === 'input_json_delta') {
                    if (this.outputFlag !== 'TOOL') {
                        this.outputFlag = 'TOOL'
                        await emit({ type: 'function-call-start' })
                    }
                    const chunk: ToolCallChunk = {
                        index: event.index,
                        function: { arguments: delta.partial_json },
                    }
                    this.toolCallChunks.push(chunk)
                    await emit({
                        type: 'function-call-delta',
                        toolCallChunk: chunk,
                    })
                }
                return
            }

            case 'content_block_stop':
                return

            case 'message_delta': {
                const stopReason = event.delta.stop_reason
                if (stopReason === 'tool_use') {
                    const lastMessage = this.messages.at(-1)
                    if (lastMessage?.role === 'assistant') {
                        lastMessage.tool_calls = this.mergeToolCalls()
                    }
                    this.outputFlag = 'UNKNOWN'
                    await emit({
                        type: 'function-call-end',
                        toolCalls: this.mergeToolCalls(),
                    })
                } else if (stopReason) {
                    await emit({
                        type: 'response-end',
                        finishReason: this.mapStopReason(stopReason),
                    })
                }
                if (event.usage) {
                    this.addUsageRecord({
                        input_tokens: 0,
                        output_tokens: event.usage.output_tokens,
                    })
                    await emit({ type: 'response-end', usage: this.sumUsage })
                }
                return
            }

            case 'message_stop':
                return

            case 'error':
                throw new Error(
                    `Anthropic API error: ${event.error.message} (${event.error.type})`
                )
        }
    }

    private mergeToolCalls(): ToolCall[] {
        const toolCallList: ToolCall[] = []
        for (const chunk of this.toolCallChunks) {
            if (chunk.function.name) {
                // 复制对象，避免累加时污染 this.toolCallChunks
                toolCallList.push({
                    index: chunk.index,
                    id: chunk.id!,
                    type: 'function',
                    function: {
                        name: chunk.function.name,
                        arguments: chunk.function.arguments,
                    },
                })
            } else {
                const index = toolCallList.findIndex(
                    block => block.index === chunk.index
                )
                if (index === -1) {
                    throw new Error(
                        `unexcepted tool call index: ${chunk.index}`
                    )
                }
                toolCallList[index].function.arguments +=
                    chunk.function.arguments
            }
        }
        return toolCallList
    }

    private mapStopReason(stopReason: string): FinishReason {
        switch (stopReason) {
            case 'end_turn':
                return 'stop'
            case 'max_tokens':
                return 'length'
            case 'stop_sequence':
                return 'stop'
            default:
                return stopReason as FinishReason
        }
    }

    private addUsageRecord(usage: AnthropicUsage) {
        this.sumUsage = mergeNormalizedUsage(this.sumUsage, {
            input: usage.input_tokens,
            output: usage.output_tokens,
            cached:
                (usage.cache_read_input_tokens ?? 0) +
                (usage.cache_creation_input_tokens ?? 0),
            thinking: 0,
        })
    }
}
