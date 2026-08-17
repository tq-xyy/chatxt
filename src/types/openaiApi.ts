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
        parameters?: Record<string, any> // JSON Schema
        strict?: boolean
    }
}

type ToolChoice =
    | 'none'
    | 'auto'
    | 'required'
    | {
          type: 'function'
          function: {
              name: string
          }
      }

export interface ChatCompletionRequest {
    // 原生 /chat/completions 请求体
    messages: Message[] // Required
    model: string // Required, 'deepseek-v4-flash' | 'deepseek-v4-pro'
    thinking?: {
        type?: 'enabled' | 'disabled' | /* mimimax only */ 'adaptive'
    } | null
    reasoning_effort?: 'high' | 'max' | null
    max_tokens?: number | null
    response_format?: {
        type?: 'text' | 'json_object'
    } | null
    stop?: string | string[] | null
    stream?: boolean | null
    stream_options?: {
        include_usage?: boolean
    } | null
    temperature?: number | null
    top_p?: number | null
    tools?: ToolDefinition[] | null
    tool_choice?: ToolChoice | null
}

// ======================== 响应类型 ========================

interface Choice {
    finish_reason:
        | 'stop'
        | 'length'
        | 'content_filter'
        | 'tool_calls'
        | 'insufficient_system_resource'
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
    /** 非流式 200 响应 */
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
    content: string | null // 必需，但可为 null
    reasoning_content?: string | null // deepseek, kimi
    reasoning?: string | null // hy3
    role?: 'assistant'
    tool_calls?: ToolCallChunk[] | null // 可为 null
}

interface ChoiceChunk {
    delta: ChoiceDelta
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
    choices: ChoiceChunk[]
    usage?: Usage | null
}
