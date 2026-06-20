// ======================== 消息类型 ========================

interface SystemMessage {
    content: string
    role: 'system'
    name?: string
}

interface UserMessage {
    content: string
    role: 'user'
    name?: string
}

export interface ToolCall {
    index: number
    id: string
    type: 'function'
    function: {
        name: string
        arguments: string
    }
}

interface AssistantMessage {
    content: string | null // 必需，但可为 null
    role: 'assistant'
    name?: string
    prefix?: boolean // Beta
    reasoning_content?: string | null // Beta，可为 null
    tool_calls?: ToolCall[] | null // 可为 null
}

interface ToolMessage {
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

interface ThinkingConfig {
    type?: 'enabled' | 'disabled'
}

interface ResponseFormat {
    type?: 'text' | 'json_object'
}

interface StreamOptions {
    include_usage?: boolean
}

interface FunctionDefinition {
    description?: string
    name: string
    parameters?: Record<string, any> // JSON Schema
    strict?: boolean
}

export interface ToolDefinition {
    type: 'function'
    function: FunctionDefinition
}

interface NamedToolChoiceFunction {
    name: string
}

interface ChatCompletionNamedToolChoice {
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
    model: string // Required, 'deepseek-v4-flash' | 'deepseek-v4-pro'
    thinking?: ThinkingConfig | null
    reasoning_effort?: 'high' | 'max' | null
    max_tokens?: number | null
    response_format?: ResponseFormat | null
    stop?: string | string[] | null
    stream?: boolean | null
    stream_options?: StreamOptions | null
    temperature?: number | null
    top_p?: number | null
    tools?: ToolDefinition[] | null
    tool_choice?: ToolChoice | null
    logprobs?: boolean | null
    top_logprobs?: number | null
    user_id?: string | null
}

// ======================== 响应类型 ========================

interface TopLogProb {
    token: string
    logprob: number
    bytes: number[] | null
}

interface LogProbToken {
    token: string
    logprob: number
    bytes: number[] | null
    top_logprobs: TopLogProb[]
}

interface LogProbs {
    content: LogProbToken[] | null
    reasoning_content?: LogProbToken[] | null
}

interface Choice {
    finish_reason:
        | 'stop'
        | 'length'
        | 'content_filter'
        | 'tool_calls'
        | 'insufficient_system_resource'
    index: number
    message: AssistantMessage
    logprobs: LogProbs | null
}

export interface Usage {
    completion_tokens: number
    prompt_tokens: number
    prompt_cache_hit_tokens: number
    prompt_cache_miss_tokens: number
    total_tokens: number
    completion_tokens_details?: {
        reasoning_tokens?: number
    }
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

export interface ToolCallChunk {
    index: number
    id?: string
    type?: 'function'
    function: {
        name?: string
        arguments: string
    }
}

interface ChoiceDelta {
    content: string | null // 必需，但可为 null
    reasoning_content?: string | null
    role?: 'assistant'
    tool_calls?: ToolCallChunk[] | null // 可为 null
}

interface ChoiceChunk {
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
