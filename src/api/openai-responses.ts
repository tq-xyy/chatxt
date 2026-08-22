import type { Config, ModelGateway } from '../config'
import type { ChatRole } from '../fileobj'
import type { APIAdapter, StreamEvent } from '../types/api-adapter'
import type {
    Message,
    SystemMessage,
    ToolCall,
    ToolDefinition,
    ToolMessage,
} from '../types/chat-file'
import type { SSEMessage } from '../utils/sseStream'
import type {
    ResponsesInputItem,
    ResponsesRequest,
    ResponsesStreamEvent,
    ResponsesToolDefinition,
    ResponsesUsage,
} from '../types/apis/openai-responses-api'
import { mergeNormalizedUsages, type NormalizedUsage } from '../common/usage'

/** Responses 内部累积的工具调用分片（用于挂载 lastMessage.tool_calls） */
type ToolCallChunk = {
    index: number
    id?: string
    name?: string
    arguments: string
}

// ======================== HTTP 层 ========================

async function responsesRequest(
    request: ResponsesRequest,
    api: { endpoint: string; apikey: string }
): Promise<Response> {
    const resp = await fetch(`${api.endpoint}/responses`, {
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
 * 把 OpenAI 形状的 Message[] 转成 Responses input items。
 * - system 消息抽到 instructions（顶层）
 * - assistant.tool_calls → function_call items
 * - tool 消息 → function_call_output items
 */
function toResponsesInput(messages: Message[]): ResponsesInputItem[] {
    const items: ResponsesInputItem[] = []

    for (const msg of messages) {
        if (msg.role === 'system') continue

        if (msg.role === 'user') {
            items.push({ type: 'message', role: 'user', content: msg.content })
        } else if (msg.role === 'assistant') {
            if (msg.tool_calls?.length) {
                for (const tc of msg.tool_calls) {
                    items.push({
                        type: 'function_call',
                        call_id: tc.id,
                        name: tc.function.name,
                        arguments: tc.function.arguments,
                    })
                }
            } else {
                items.push({
                    type: 'message',
                    role: 'assistant',
                    content: msg.content ?? '',
                })
            }
        } else if (msg.role === 'tool') {
            items.push({
                type: 'function_call_output',
                call_id: msg.tool_call_id,
                output: msg.content,
            })
        }
    }

    return items
}

function toResponsesTools(
    toolDefitions: ToolDefinition[]
): ResponsesToolDefinition[] {
    return toolDefitions.map(td => ({
        type: 'function',
        name: td.function.name,
        description: td.function.description,
        parameters: td.function.parameters,
        strict: td.function.strict ?? null,
    }))
}

// ======================== Adapter ========================

export class OpenAIResponsesAPIAdapter implements APIAdapter<ResponsesStreamEvent> {
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

    /** 记录已 emit function-call-end 的 output_index，避免重复 */
    private endedToolCallIndexes = new Set<number>()

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
        this.endedToolCallIndexes = new Set()
        if (toolMessages) {
            this.messages.push(...toolMessages)
        }

        const reqBody: ResponsesRequest = {
            model: gateway.model,
            input: toResponsesInput(this.messages),
            tools: toResponsesTools(this.toolDefitions),
            stream: true,
        }

        const system = this.messages.find(msg => msg.role === 'system')
        if (system?.role === 'system' && system.content) {
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

        const resp = await responsesRequest(reqBody, gateway)

        this.messages.push({
            role: 'assistant',
            content: '',
            reasoning_content: '',
            reasoning: '',
        })

        return resp
    }

    public async whenRecvivedChunk(
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
                    this.toolCallChunks.push({
                        index: event.output_index,
                        id: item.call_id,
                        name: item.name,
                        arguments: '',
                    })
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
                        this.toolCallChunks.push({
                            index: event.output_index,
                            arguments: item.arguments,
                        })
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
                this.messages.at(-1)!.content += event.delta
                await emit({ type: 'content-delta', delta: event.delta })
                return
            }

            case 'response.function_call_arguments.delta': {
                // 标准 OpenAI 的流式参数分片（此网关未使用，预留兼容）
                if (this.outputFlag !== 'TOOL') {
                    this.outputFlag = 'TOOL'
                    await emit({ type: 'function-call-start' })
                }
                this.toolCallChunks.push({
                    index: event.output_index,
                    arguments: event.delta,
                })
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
                // 兼容两种事件名：
                // - Opencode 网关: response.reasoning_summary_text.delta
                // - DeepSeek 官方: response.reasoning_text.delta
                if (this.outputFlag !== 'THINKING') {
                    this.outputFlag = 'THINKING'
                    await emit({ type: 'reasoning-start' })
                }
                const lastMessage = this.messages.at(-1)
                if (lastMessage?.role === 'assistant') {
                    lastMessage.reasoning_content += event.delta
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

                    const toolCalls = this.mergeToolCalls()

                    const lastMessage = this.messages.at(-1)
                    if (lastMessage?.role === 'assistant') {
                        lastMessage.tool_calls = toolCalls
                    }
                    this.outputFlag = 'UNKNOWN'
                    await emit({
                        type: 'function-call-end',
                    })
                }
                return
            }

            case 'response.completed': {
                const hasFunctionCall = event.response.output.some(
                    item => item.type === 'function_call'
                )
                if (hasFunctionCall) {
                    // function-call-end 已触发下一轮，此处不再发 response-end
                    if (event.response.usage) {
                        this.addUsageRecord(event.response.usage)
                    }
                    return
                }
                if (event.response.usage) {
                    this.addUsageRecord(event.response.usage)
                }
                this.outputFlag = 'UNKNOWN'
                await emit({
                    type: 'response-end',
                    finishReason: 'stop',
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

    private mergeToolCalls(): ToolCall[] {
        const toolCallList: ToolCall[] = []
        for (const chunk of this.toolCallChunks) {
            if (chunk.name) {
                toolCallList.push({
                    index: chunk.index,
                    id: chunk.id!,
                    type: 'function',
                    function: {
                        name: chunk.name,
                        arguments: chunk.arguments,
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
                toolCallList[index].function.arguments += chunk.arguments
            }
        }
        return toolCallList
    }

    private addUsageRecord(usage: ResponsesUsage) {
        this.sumUsage = mergeNormalizedUsages(this.sumUsage, {
            input: usage.input_tokens,
            output: usage.output_tokens,
            cached: usage.input_tokens_details?.cached_tokens ?? 0,
            thinking: usage.output_tokens_details?.reasoning_tokens ?? 0,
        })[0]
    }
}
