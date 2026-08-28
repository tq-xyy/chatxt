import type { Config, ModelGateway } from '../config'
import type { APIAdapter, StreamEvent } from '../types/api-adapter'
import type { Message, ToolDef } from '../types/chat-file'
import type { SSEMessage } from '../utils/sseStream'
import type {
    ResponsesInputItem,
    ResponsesRequest,
    ResponsesStreamEvent,
} from '../types/apis/openai-responses-api'
import type { NormalizedUsage } from '../common/usage'
import { assertOk } from './http'

type OutputFlag = 'UNKNOWN' | 'THINKING' | 'ASSISTANT' | 'TOOL'

// ======================== 请求转换 ========================

/** 平铺消息 → Responses input items；system 抽到顶层 instructions */
function toResponsesInput(messages: Message[]): ResponsesInputItem[] {
    const items: ResponsesInputItem[] = []

    for (const msg of messages) {
        if (msg.role === 'system') continue

        if (msg.role === 'user') {
            items.push({ type: 'message', role: 'user', content: msg.content })
        } else if (msg.role === 'assistant') {
            items.push({
                type: 'message',
                role: 'assistant',
                content: msg.content ?? '',
            })
        } else if (msg.role === 'tool-call') {
            items.push({
                type: 'function_call',
                call_id: msg.callId,
                name: msg.name,
                arguments: msg.arguments,
            })
        } else if (msg.role === 'tool-result') {
            items.push({
                type: 'function_call_output',
                call_id: msg.callId,
                output: msg.content,
            })
        }
    }

    return items
}

// ======================== Adapter ========================

export class OpenAIResponsesAPIAdapter implements APIAdapter<ResponsesStreamEvent> {
    private outputFlag: OutputFlag = 'UNKNOWN'
    private sumUsage: NormalizedUsage = {
        input: 0,
        output: 0,
        cached: 0,
        thinking: 0,
    }

    /** 记录已 emit function-call-end 的 output_index，避免重复 */
    private endedToolCallIndexes = new Set<number>()

    public async buildRequest(
        config: Config,
        gateway: ModelGateway,
        messages: Message[],
        toolDefinitions: ToolDef[]
    ): Promise<Response> {
        this.outputFlag = 'UNKNOWN'
        this.sumUsage = { input: 0, output: 0, cached: 0, thinking: 0 }
        this.endedToolCallIndexes = new Set()

        const reqBody: ResponsesRequest = {
            model: gateway.model,
            input: toResponsesInput(messages),
            tools: toolDefinitions.map(
                ({ name, description, parameters }) => ({
                    type: 'function' as const,
                    name,
                    description,
                    parameters: parameters as unknown as Record<
                        string,
                        unknown
                    >,
                })
            ),
            stream: true,
        }

        const system = messages.find(msg => msg.role === 'system')
        if (system?.role === 'system') {
            reqBody.instructions = system.content
        }

        if (config.thinkingEffort) {
            reqBody.reasoning = {
                effort: config.thinkingEffort as NonNullable<
                    ResponsesRequest['reasoning']
                >['effort'],
            }
        }

        if (config.maxTokens) {
            reqBody.max_output_tokens = config.maxTokens
        }

        if (config.jsonOnly) {
            reqBody.text = { format: 'json_object' }
        }

        const resp = await fetch(`${gateway.endpoint}/responses`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${gateway.apikey}`,
            },
            body: JSON.stringify(reqBody),
        })

        await assertOk(resp)
        return resp
    }

    public async handleChunk(
        message: SSEMessage<ResponsesStreamEvent, string>,
        emit: (event: StreamEvent) => Promise<void>
    ) {
        const event = message.data

        switch (event.type) {
            case 'ping':
            case 'response.created':
            case 'response.in_progress':
                return

            case 'response.output_item.added': {
                const item = event.item
                if (item.type === 'function_call') {
                    if (this.outputFlag !== 'TOOL') {
                        this.outputFlag = 'TOOL'
                        await emit({ type: 'function-call-start' })
                    }
                    await emit({
                        type: 'function-call-delta',
                        delta: {
                            type: 'callee',
                            index: event.output_index,
                            callee: item.name,
                            callId: item.call_id,
                            arguments: '',
                        },
                    })

                    // 此网关一次性给出完整 arguments
                    if (item.arguments) {
                        await emit({
                            type: 'function-call-delta',
                            delta: {
                                type: 'arguments',
                                index: event.output_index,
                                delta: item.arguments,
                            },
                        })
                    }
                }
                return
            }

            case 'response.output_text.delta': {
                if (this.outputFlag !== 'ASSISTANT') {
                    this.outputFlag = 'ASSISTANT'
                    await emit({ type: 'content-start' })
                }
                await emit({ type: 'content-delta', delta: event.delta })
                return
            }

            case 'response.function_call_arguments.delta': {
                // 标准 OpenAI 的流式参数分片（此网关未使用，预留兼容）
                if (this.outputFlag !== 'TOOL') {
                    this.outputFlag = 'TOOL'
                    await emit({ type: 'function-call-start' })
                }
                await emit({
                    type: 'function-call-delta',
                    delta: {
                        type: 'arguments',
                        index: event.output_index,
                        delta: event.delta,
                    },
                })
                return
            }

            case 'response.reasoning_summary_text.delta':
            case 'response.reasoning_text.delta': {
                // - Opencode 网关: response.reasoning_summary_text.delta
                // - DeepSeek 官方: response.reasoning_text.delta
                if (this.outputFlag !== 'THINKING') {
                    this.outputFlag = 'THINKING'
                    await emit({ type: 'reasoning-start' })
                }
                await emit({ type: 'reasoning-delta', delta: event.delta })
                return
            }

            case 'response.output_item.done': {
                const item = event.item
                if (item.type === 'function_call') {
                    if (this.endedToolCallIndexes.has(event.output_index)) {
                        return
                    }
                    this.endedToolCallIndexes.add(event.output_index)

                    this.outputFlag = 'UNKNOWN'
                    await emit({
                        type: 'function-call-end',
                    })
                }
                return
            }

            case 'response.completed':
            case 'response.incomplete': {
                const usage = event.response.usage
                if (usage) {
                    this.sumUsage = {
                        input: usage.input_tokens,
                        output: usage.output_tokens,
                        cached: usage.input_tokens_details?.cached_tokens ?? 0,
                        thinking:
                            usage.output_tokens_details?.reasoning_tokens ?? 0,
                    }
                }
                const hasFunctionCall = event.response.output.some(
                    item => item.type === 'function_call'
                )
                this.outputFlag = 'UNKNOWN'
                await emit({
                    type: 'response-end',
                    finishReason:
                        event.type === 'response.incomplete'
                            ? 'length'
                            : hasFunctionCall
                              ? 'tool_calls'
                              : 'stop',
                    usage: this.sumUsage,
                })
                return
            }

            case 'response.failed':
                throw new Error(
                    `OpenAI Responses API failed: ${JSON.stringify(event.response)}`
                )

            case 'error':
                throw new Error(
                    `OpenAI Responses API error: ${event.error.message}`
                )
        }
    }

    public async handleStreamEnd(): Promise<void> {}
}
