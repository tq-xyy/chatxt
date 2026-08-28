import type { Config, ModelGateway } from '../config'
import type { APIAdapter, StreamEvent } from '../types/api-adapter'
import type { FinishReason, Message, ToolDef } from '../types/chat-file'
import type { SSEMessage } from '../utils/sseStream'
import type {
    AnthropicContentBlock,
    AnthropicMessage,
    AnthropicRequest,
    AnthropicStreamEvent,
} from '../types/apis/anthropic-api'
import type { NormalizedUsage } from '../common/usage'
import { assertOk } from './http'

type OutputFlag = 'UNKNOWN' | 'THINKING' | 'ASSISTANT' | 'TOOL'

// ======================== 请求转换 ========================

/** 平铺消息 → Anthropic messages；tool_use 前无 assistant 时兜底创建 */
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
            result.push({
                role: 'assistant',
                content: msg.content
                    ? [{ type: 'text', text: msg.content }]
                    : [],
            })
        } else if (msg.role === 'tool-call') {
            const block: AnthropicContentBlock = {
                type: 'tool_use',
                id: msg.callId,
                name: msg.name,
                input: JSON.parse(msg.arguments),
            }
            const last = result.at(-1)
            if (last?.role === 'assistant' && Array.isArray(last.content)) {
                last.content.push(block)
            } else {
                result.push({ role: 'assistant', content: [block] })
            }
        } else if (msg.role === 'tool-result') {
            pendingToolResults.push({
                type: 'tool_result',
                tool_use_id: msg.callId,
                content: msg.content,
            })
        }
    }

    flushToolResults()
    return result
}

// ======================== Adapter ========================

export class AnthropicAPIAdapter implements APIAdapter<AnthropicStreamEvent> {
    private outputFlag: OutputFlag = 'UNKNOWN'
    private sumUsage: NormalizedUsage = {
        input: 0,
        output: 0,
        cached: 0,
        thinking: 0,
    }

    public async buildRequest(
        config: Config,
        gateway: ModelGateway,
        messages: Message[],
        toolDefinitions: ToolDef[]
    ): Promise<Response> {
        this.outputFlag = 'UNKNOWN'
        this.sumUsage = { input: 0, output: 0, cached: 0, thinking: 0 }

        const reqBody: AnthropicRequest = {
            model: gateway.model,
            max_tokens: config.maxTokens ?? 4096,
            messages: toAnthropicMessages(messages),
            tools: toolDefinitions.map(
                ({ name, description, parameters }) => ({
                    name,
                    description,
                    input_schema: parameters as unknown as Record<
                        string,
                        unknown
                    >,
                })
            ),
            stream: true,
        }

        const system = messages.find(msg => msg.role === 'system')
        if (system?.role === 'system') {
            reqBody.system = system.content
        }

        if (config.thinkingMode === 'enabled') {
            const budget = config.thinkingEffort === 'max' ? 8192 : 4096
            reqBody.thinking = {
                type: 'enabled',
                budget_tokens: Math.min(budget, reqBody.max_tokens - 1),
            }
        }

        const resp = await fetch(`${gateway.endpoint}/messages`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': gateway.apikey,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify(reqBody),
        })

        await assertOk(resp)
        return resp
    }

    public async handleChunk(
        message: SSEMessage<AnthropicStreamEvent, string>,
        emit: (event: StreamEvent) => Promise<void>
    ) {
        const event = message.data

        switch (event.type) {
            case 'ping':
                return
            case 'message_start': {
                const usage = event.message.usage
                const cachedParts =
                    (usage.cache_read_input_tokens ?? 0) +
                    (usage.cache_creation_input_tokens ?? 0)
                this.sumUsage = {
                    input: usage.input_tokens + cachedParts,
                    output: usage.output_tokens,
                    cached: cachedParts,
                    thinking: 0,
                }
                return
            }
            case 'content_block_start': {
                const block = event.content_block
                if (block.type === 'tool_use') {
                    if (this.outputFlag !== 'TOOL') {
                        this.outputFlag = 'TOOL'
                        await emit({ type: 'function-call-start' })
                    }
                    await emit({
                        type: 'function-call-delta',
                        delta: {
                            type: 'callee',
                            index: event.index,
                            callee: block.name,
                            callId: block.id,
                            arguments: '',
                        },
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
                    await emit({ type: 'content-delta', delta: delta.text })
                } else if (delta.type === 'thinking_delta') {
                    if (this.outputFlag !== 'THINKING') {
                        this.outputFlag = 'THINKING'
                        await emit({ type: 'reasoning-start' })
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
                    await emit({
                        type: 'function-call-delta',
                        delta: {
                            type: 'arguments',
                            index: event.index,
                            delta: delta.partial_json,
                        },
                    })
                }
                return
            }

            case 'content_block_stop':
                return

            case 'message_delta': {
                if (event.usage) {
                    this.sumUsage = {
                        ...this.sumUsage,
                        output: event.usage.output_tokens,
                    }
                }

                const stopReason = event.delta.stop_reason
                if (stopReason === 'tool_use') {
                    this.outputFlag = 'UNKNOWN'
                    await emit({ type: 'function-call-end' })
                }
                if (stopReason) {
                    this.outputFlag = 'UNKNOWN'
                    await emit({
                        type: 'response-end',
                        finishReason: this.mapStopReason(stopReason),
                        usage: this.sumUsage,
                    })
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

    public async handleStreamEnd(): Promise<void> {}

    private mapStopReason(stopReason: string): FinishReason {
        switch (stopReason) {
            case 'end_turn':
                return 'stop'
            case 'max_tokens':
                return 'length'
            case 'stop_sequence':
                return 'stop'
            case 'tool_use':
                return 'tool_calls'
            default:
                return stopReason as FinishReason
        }
    }
}
