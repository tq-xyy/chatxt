import type { Config, ModelGateway } from '../config'
import type { ChatRole } from '../fileobj'
import type { APIAdapter, StreamEvent } from '../types/api-adapter'
import type {
    ChatCompletionChunk,
    ChatCompletionRequest,
    Message,
    SystemMessage,
    ToolCallChunk,
    ToolDefinition,
    ToolMessage,
    Usage,
    ToolCall,
} from '../types/openai-compatible-api'
import type { SSEMessage } from '../utils/sseStream'
import {
    mergeNormalizedUsage,
    type NormalizedUsage,
    normalizeUsage,
} from '../common/usage'

export async function chatCompletion(
    request: ChatCompletionRequest,
    api: {
        endpoint: string
        apikey: string
    }
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

export class OpenAICompatibleAPIAdapter implements APIAdapter<ChatCompletionChunk> {
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

        // clear reasoning place mark
        this.messages
            .filter(msg => msg.role === 'assistant')
            .forEach(msg => {
                if (
                    typeof msg.reasoning === 'string' &&
                    msg.reasoning.length === 0
                ) {
                    delete msg.reasoning
                }
                if (
                    typeof msg.reasoning_content === 'string' &&
                    msg.reasoning_content.length === 0
                ) {
                    delete msg.reasoning_content
                }
            })

        const reqBody: ChatCompletionRequest = {
            model: gateway.model,
            /* leave it default */
            // thinking: { type: 'enabled' },
            messages: this.messages,
            stream_options: { include_usage: true },
            tools: this.toolDefitions,
            stream: true,
        }

        if (config.thinkingMode) {
            reqBody.thinking = {
                type: config.thinkingMode as NonNullable<
                    ChatCompletionRequest['thinking']
                >['type'],
            }
        }

        if (config.thinkingEffort) {
            reqBody.reasoning_effort =
                config.thinkingEffort as ChatCompletionRequest['reasoning_effort']
        }

        if (config.maxTokens) {
            reqBody.max_tokens = config.maxTokens
        }

        if (config.jsonOnly) {
            reqBody.response_format = { type: 'json_object' }
        }

        const resp = await chatCompletion(reqBody, gateway)

        this.messages.push({
            role: 'assistant',
            content: '',

            // mark place for compatible
            reasoning_content: '',
            reasoning: '',
        })

        return resp
    }

    public async whenRecvivedChunk(
        message: SSEMessage<ChatCompletionChunk, string>,
        emit: (event: StreamEvent) => Promise<void>
    ) {
        const chunk = message.data
        if (chunk.usage) {
            this.addUsageRecord(chunk.usage)
            await emit({
                type: 'finish',
                usage: this.sumUsage,
            })
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
        const toolCallDelta: ToolCallChunk[] | null | undefined =
            choice.delta?.tool_calls

        if (reasoning && this.outputFlag !== 'THINKING') {
            this.outputFlag = 'THINKING'
            await emit({ type: 'reasoning-start' })
        }
        if (reasoning) {
            const lastMessage = this.messages.at(-1)
            if (lastMessage?.role === 'assistant') {
                if (choice.delta?.reasoning_content) {
                    lastMessage.reasoning_content += reasoning
                } else {
                    lastMessage.reasoning += reasoning
                }
            }

            await emit({ type: 'reasoning-delta', delta: reasoning })
        }

        if (content && this.outputFlag !== 'ASSISTANT') {
            this.outputFlag = 'ASSISTANT'
            await emit({ type: 'content-start' })
        }
        if (content) {
            this.messages.at(-1)!.content += content
            await emit({ type: 'content-delta', delta: content })
        }

        if (toolCallDelta && this.outputFlag !== 'TOOL') {
            this.outputFlag = 'TOOL'
            await emit({ type: 'function-call-start' })
        }
        if (toolCallDelta) {
            for (const toolCallChunk of toolCallDelta) {
                await emit({ type: 'function-call-delta', toolCallChunk })
                this.toolCallChunks.push(toolCallChunk)
            }
        }

        if (choice.finish_reason === 'tool_calls') {
            const lastMessage = this.messages.at(-1)
            // discard duplicate tool calls
            if (this.outputFlag !== 'UNKNOWN') {
                const toolCalls = mergeToolCallChunks(this.toolCallChunks)
                if (lastMessage?.role === 'assistant') {
                    lastMessage.tool_calls = toolCalls
                }

                this.outputFlag = 'UNKNOWN'
                await emit({ type: 'function-call-end', toolCalls })
            }
        } else if (choice.finish_reason) {
            await emit({
                type: 'finish',
                finishReason: choice.finish_reason,
            })
        }
    }

    private addUsageRecord(usage: Usage) {
        this.sumUsage = mergeNormalizedUsage(
            this.sumUsage,
            normalizeUsage(usage)
        )
    }
}
