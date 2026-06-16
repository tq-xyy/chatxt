// ======================== 消息类型 ========================

export interface SystemMessage {
    content: string
    role: 'system'
    name?: string
}

export interface UserMessage {
    content: string
    role: 'user'
    name?: string
}

export interface AssistantMessage {
    content: string | null // 必需，但可为 null
    role: 'assistant'
    name?: string
    prefix?: boolean // Beta
    reasoning_content?: string | null // Beta，可为 null
}

export interface ToolMessage {
    content: string
    role: 'tool'
    tool_call_id: string
}

export type Message =
    | SystemMessage
    | UserMessage
    | AssistantMessage
    | ToolMessage

// ======================== 请求参数 ========================

export interface ThinkingConfig {
    type?: 'enabled' | 'disabled'
}

export interface ResponseFormat {
    type?: 'text' | 'json_object'
}

export interface StreamOptions {
    include_usage?: boolean
}

export interface FunctionDefinition {
    description?: string
    name: string
    parameters?: Record<string, any> // JSON Schema
    strict?: boolean
}

export interface Tool {
    type: 'function'
    function: FunctionDefinition
}

export interface NamedToolChoiceFunction {
    name: string
}

export interface ChatCompletionNamedToolChoice {
    type: 'function'
    function: NamedToolChoiceFunction
}

export type ToolChoice =
    | 'none'
    | 'auto'
    | 'required'
    | ChatCompletionNamedToolChoice

export interface ChatCompletionRequest {
    // 原生 /chat/completions 请求体
    messages: Message[] // Required
    model: 'deepseek-v4-flash' | 'deepseek-v4-pro' // Required
    thinking?: ThinkingConfig | null
    reasoning_effort?: 'high' | 'max' | null
    max_tokens?: number | null
    response_format?: ResponseFormat | null
    stop?: string | string[] | null
    stream?: boolean | null
    stream_options?: StreamOptions | null
    temperature?: number | null
    top_p?: number | null
    tools?: Tool[] | null
    tool_choice?: ToolChoice | null
    logprobs?: boolean | null
    top_logprobs?: number | null
    user_id?: string | null
}

// ======================== 响应类型 ========================

export interface ToolCallFunction {
    name: string
    arguments: string
}

export interface ToolCall {
    id: string
    type: 'function'
    function: ToolCallFunction
}

export interface ChatMessage {
    content: string | null
    reasoning_content?: string | null
    tool_calls?: ToolCall[]
    role: 'assistant'
}

export interface TopLogProb {
    token: string
    logprob: number
    bytes: number[] | null
}

export interface LogProbToken {
    token: string
    logprob: number
    bytes: number[] | null
    top_logprobs: TopLogProb[]
}

export interface LogProbs {
    content: LogProbToken[] | null
    reasoning_content?: LogProbToken[] | null
}

export interface Choice {
    finish_reason:
        | 'stop'
        | 'length'
        | 'content_filter'
        | 'tool_calls'
        | 'insufficient_system_resource'
    index: number
    message: ChatMessage
    logprobs: LogProbs | null
}

export interface CompletionTokensDetails {
    reasoning_tokens?: number
}

export interface Usage {
    completion_tokens: number
    prompt_tokens: number
    prompt_cache_hit_tokens: number
    prompt_cache_miss_tokens: number
    total_tokens: number
    completion_tokens_details?: CompletionTokensDetails
}

export interface ChatCompletionResponse {
    /** 非流式 200 响应 */
    id: string
    choices: Choice[]
    created: number
    model: string
    system_fingerprint: string
    object: 'chat.completion'
    usage?: Usage
}

// ---------- 流式 chunk ----------
export interface ChoiceDelta {
    content: string | null // 必需，但可为 null
    reasoning_content?: string | null
    role?: 'assistant'
}

export interface ChoiceChunk {
    delta: ChoiceDelta
    logprobs: LogProbs | null
    finish_reason:
        | 'stop'
        | 'length'
        | 'content_filter'
        | 'tool_calls'
        | 'insufficient_system_resource'
        | null
    index: number
}

export interface ChatCompletionChunk {
    /** 流式 200 响应中的一个 chunk */
    id: string
    choices: ChoiceChunk[]
    created: number
    model: string
    system_fingerprint: string
    object: 'chat.completion.chunk'
    usage?: Usage | null
}

// ======================== 工具函数 ========================

export function computeTokenCostCNY(tokenUsage: Usage, model: string): number {
    if (model === 'deepseek-v4-flash') {
        return (
            (tokenUsage.prompt_cache_hit_tokens * 0.02 +
                tokenUsage.prompt_cache_miss_tokens * 1 +
                tokenUsage.completion_tokens * 2) /
            1_000_000
        )
    } else if (model === 'deepseek-v4-pro') {
        return (
            (tokenUsage.prompt_cache_hit_tokens * 0.025 +
                tokenUsage.prompt_cache_miss_tokens * 3 +
                tokenUsage.completion_tokens * 6) /
            1_000_000
        )
    } else {
        return -1.0
    }
}
