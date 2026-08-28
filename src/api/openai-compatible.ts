import type { Config, ModelGateway } from '../config'
import type { APIAdapter, StreamEvent } from '../types/api-adapter'
import type { Message, ToolDef, FinishReason } from '../types/chat-file'
import type {
    OpenAICompatibleAssistantMessage,
    OpenAICompatibleChunk,
    OpenAICompatibleMessage,
    OpenAICompatibleRequest,
    OpenAICompatibleUsage,
    OpenAICompatibleToolCall,
    OpenAICompatibleToolCallChunk,
    OpenAICompatibleToolDefinition,
} from '../types/apis/openai-compatible-api'
import type { SSEMessage } from '../utils/sse-stream'
import type { NormalizedUsage } from '../common/usage'
import { assertOk } from './http'

type OutputFlag = 'UNKNOWN' | 'THINKING' | 'ASSISTANT' | 'TOOL'

function normalizeUsage(usage: OpenAICompatibleUsage): NormalizedUsage {
    return {
        input: usage.prompt_tokens,
        output: usage.completion_tokens,
        cached:
            usage.prompt_cache_hit_tokens ||
            usage.prompt_tokens_details?.cached_tokens ||
            0,
        thinking: usage.completion_tokens_details?.reasoning_tokens || 0,
    }
}

/** 平铺消息 → OpenAI 消息列表（FunctionCall 挂到前置 assistant 的 tool_calls） */
function toOpenAIMessages(
    messages: Message[],
    reasoningField: 'reasoning_content' | 'reasoning'
): OpenAICompatibleMessage[] {
    const result: OpenAICompatibleMessage[] = []
    let lastAssistant: OpenAICompatibleAssistantMessage | null = null

    for (const msg of messages) {
        if (msg.role === 'system') {
            result.push({ role: 'system', content: msg.content })
        } else if (msg.role === 'user') {
            lastAssistant = null
            result.push({ role: 'user', content: msg.content })
        } else if (msg.role === 'assistant') {
            const apiMsg: OpenAICompatibleAssistantMessage = {
                role: 'assistant',
                content: msg.content ?? '',
            }
            if (msg.reasoning_content) {
                apiMsg[reasoningField] = msg.reasoning_content
            }
            lastAssistant = apiMsg
            result.push(apiMsg)
        } else if (msg.role === 'tool-call') {
            const call: OpenAICompatibleToolCall = {
                index: lastAssistant?.tool_calls?.length ?? 0,
                id: msg.callId,
                type: 'function',
                function: {
                    name: msg.name,
                    arguments: msg.arguments,
                },
            }
            if (lastAssistant) {
                lastAssistant.tool_calls = [
                    ...(lastAssistant.tool_calls ?? []),
                    call,
                ]
            } else {
                const apiMsg: OpenAICompatibleAssistantMessage = {
                    role: 'assistant',
                    content: null,
                    tool_calls: [call],
                }
                lastAssistant = apiMsg
                result.push(apiMsg)
            }
        } else if (msg.role === 'tool-result') {
            result.push({
                role: 'tool',
                tool_call_id: msg.callId,
                content: msg.content,
            })
        }
    }
    return result
}

export class OpenAICompatibleAPIAdapter implements APIAdapter<OpenAICompatibleChunk> {
    private outputFlag: OutputFlag = 'UNKNOWN'
    private reasoningField: 'reasoning_content' | 'reasoning' =
        'reasoning_content'
    private pendingFinishReason: FinishReason | null = null
    private pendingUsage: NormalizedUsage | null = null

    public async buildRequest(
        config: Config,
        gateway: ModelGateway,
        messages: Message[],
        toolDefinitions: ToolDef[]
    ): Promise<Response> {
        this.outputFlag = 'UNKNOWN'
        this.pendingFinishReason = null
        this.pendingUsage = null

        const reqBody: OpenAICompatibleRequest = {
            model: gateway.model,
            messages: toOpenAIMessages(messages, this.reasoningField),
            stream_options: { include_usage: true },
            tools: toolDefinitions.map<OpenAICompatibleToolDefinition>(
                ({ name, description, parameters }) => ({
                    type: 'function',
                    function: {
                        name,
                        description,
                        parameters: parameters as unknown as Record<
                            string,
                            unknown
                        >,
                    },
                })
            ),
            stream: true,
        }

        if (config.thinkingMode) {
            reqBody.thinking = {
                type: config.thinkingMode as NonNullable<
                    OpenAICompatibleRequest['thinking']
                >['type'],
            }
        }

        if (config.thinkingEffort) {
            reqBody.reasoning_effort =
                config.thinkingEffort as OpenAICompatibleRequest['reasoning_effort']
        }

        if (config.maxTokens) {
            reqBody.max_tokens = config.maxTokens
        }

        if (config.jsonOnly) {
            reqBody.response_format = { type: 'json_object' }
        }

        const resp = await fetch(`${gateway.endpoint}/chat/completions`, {
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
        message: SSEMessage<OpenAICompatibleChunk, string>,
        emit: (event: StreamEvent) => Promise<void>
    ) {
        const chunk = message.data
        if (chunk.usage) {
            this.pendingUsage = normalizeUsage(chunk.usage)
        }

        if (chunk?.choices.length === 0) {
            // discard empty chunk
            return
        }

        const choice = chunk.choices[0]

        const content: string | null | undefined = choice.delta?.content
        const reasoning: string | null | undefined =
            choice.delta?.reasoning_content || // deepseek, kimi
            choice.delta?.reasoning // others
        const toolCallDelta:
            OpenAICompatibleToolCallChunk[] | null | undefined =
            choice.delta?.tool_calls

        if (reasoning) {
            if (this.outputFlag !== 'THINKING') {
                this.outputFlag = 'THINKING'
                await emit({ type: 'reasoning-start' })
            }
            if (choice.delta?.reasoning_content) {
                this.reasoningField = 'reasoning_content'
            } else if (choice.delta?.reasoning) {
                this.reasoningField = 'reasoning'
            }
            await emit({ type: 'reasoning-delta', delta: reasoning })
        }

        if (content && this.outputFlag !== 'ASSISTANT') {
            this.outputFlag = 'ASSISTANT'
            await emit({ type: 'content-start' })
        }
        if (content) {
            await emit({ type: 'content-delta', delta: content })
        }

        if (toolCallDelta && this.outputFlag !== 'TOOL') {
            this.outputFlag = 'TOOL'
            await emit({ type: 'function-call-start' })
        }
        if (toolCallDelta) {
            for (const tc of toolCallDelta) {
                if (tc.type === 'function' && tc.id && tc.function.name) {
                    await emit({
                        type: 'function-call-delta',
                        delta: {
                            type: 'callee',
                            index: tc.index,
                            callee: tc.function.name,
                            callId: tc.id,
                            arguments: tc.function.arguments,
                        },
                    })
                } else if (tc.function.arguments?.length) {
                    await emit({
                        type: 'function-call-delta',
                        delta: {
                            type: 'arguments',
                            index: tc.index,
                            delta: tc.function.arguments,
                        },
                    })
                }
            }
        }

        if (choice.finish_reason === 'tool_calls') {
            // discard duplicate tool calls
            if (this.outputFlag !== 'UNKNOWN') {
                this.outputFlag = 'UNKNOWN'
                await emit({ type: 'function-call-end' })
            }
        }
        if (choice.finish_reason) {
            this.pendingFinishReason = choice.finish_reason
        }
    }

    public async handleStreamEnd(emit: (event: StreamEvent) => Promise<void>) {
        if (this.pendingFinishReason || this.pendingUsage) {
            await emit({
                type: 'response-end',
                finishReason: this.pendingFinishReason ?? undefined,
                usage: this.pendingUsage ?? undefined,
            })
        }
    }
}
