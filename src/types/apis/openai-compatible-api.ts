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

export interface ToolCall {
    index: number
    id: string
    type: 'function'
    function: {
        name: string
        arguments: string
    }
}

export interface AssistantMessage {
    content: string | null // 必需，但可为 null
    role: 'assistant'
    name?: string
    reasoning_content?: string | null // deepseek, kimi
    reasoning?: string | null // hy3
    tool_calls?: ToolCall[] | null // 可为 null
}

export interface ToolMessage {
    content: string
    role: 'tool'
    tool_call_id: string
}

export type Message =
    SystemMessage | UserMessage | AssistantMessage | ToolMessage

// ======================== 请求参数 ========================

export interface ToolDefinition {
    type: 'function'
    function: {
        description?: string
        name: string
        parameters?: Record<string, unknown> // JSON Schema
        strict?: boolean
    }
}

export interface ChatCompletionRequest {
    messages: Message[]
    model: string
    thinking?: {
        type?: 'enabled' | 'disabled' | /* mimimax only */ 'adaptive'
    }
    reasoning_effort?: 'low' | 'medium' | 'high' | 'max'
    max_tokens?: number
    response_format?: {
        type?: 'text' | 'json_object'
    }

    stream?: boolean
    stream_options?: {
        include_usage?: boolean
    }

    temperature?: number
    top_p?: number

    tools?: ToolDefinition[]
}

// ======================== 响应类型 ========================

export type FinishReason =
    | 'stop'
    | 'length'
    | 'content_filter'
    | 'tool_calls'
    | 'insufficient_system_resource'

interface Choice {
    finish_reason: FinishReason
    index: number
    message: AssistantMessage
}

export interface Usage {
    completion_tokens: number
    prompt_tokens: number
    total_tokens: number

    /** Only deepseek */
    prompt_cache_hit_tokens: number
    /** Only deepseek */
    prompt_cache_miss_tokens: number

    prompt_tokens_details?: {
        audio_tokens?: number
        cached_tokens: number
        cache_write_tokens?: number
    }

    completion_tokens_details?: {
        audio_tokens?: number
        reasoning_tokens: number
    }
}

export interface ChatCompletionResponse {
    choices: Choice[]
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
    content: string // 必需，但可为 null

    reasoning_content?: string // deepseek, kimi
    reasoning?: string // hy3

    role: 'assistant'

    tool_calls?: ToolCallChunk[] // 可为 null
}

interface ChoiceChunk {
    delta: ChoiceDelta
    finish_reason: FinishReason | null
    index: number
}

export interface ChatCompletionChunk {
    /** 流式 200 响应中的一个 chunk */
    choices: ChoiceChunk[]
    usage?: Usage | null
}
