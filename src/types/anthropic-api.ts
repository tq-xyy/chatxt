// ======================== Anthropic Messages API 类型 ========================
// 参考实测：https://docs.anthropic.com/en/api/messages-streaming

// ---------- 请求 ----------

export interface AnthropicToolDefinition {
    name: string
    description?: string
    input_schema: Record<string, unknown>
}

export type AnthropicContentBlock =
    | { type: 'text'; text: string }
    | {
          type: 'tool_use'
          id: string
          name: string
          input: Record<string, unknown>
      }
    | {
          type: 'tool_result'
          tool_use_id: string
          content: string
          is_error?: boolean
      }
    | { type: 'thinking'; thinking: string; signature?: string }

export interface AnthropicMessage {
    role: 'user' | 'assistant'
    content: string | AnthropicContentBlock[]
}

export interface AnthropicRequest {
    model: string
    max_tokens: number
    system?: string
    messages: AnthropicMessage[]
    tools?: AnthropicToolDefinition[]
    stream: true
    thinking?: {
        type: 'enabled' | 'disabled'
        budget_tokens?: number
    }
}

// ---------- 流式事件 ----------

export interface AnthropicUsage {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
}

export type AnthropicStreamEvent =
    | { type: 'ping' }
    | {
          type: 'message_start'
          message: {
              id: string
              type: 'message'
              role: 'assistant'
              model: string
              content: unknown[]
              usage: AnthropicUsage
          }
      }
    | {
          type: 'content_block_start'
          index: number
          content_block: AnthropicContentBlock
      }
    | {
          type: 'content_block_delta'
          index: number
          delta:
              | { type: 'text_delta'; text: string }
              | { type: 'thinking_delta'; thinking: string }
              | { type: 'input_json_delta'; partial_json: string }
      }
    | { type: 'content_block_stop'; index: number }
    | {
          type: 'message_delta'
          delta: { stop_reason: string | null }
          usage: { output_tokens: number }
      }
    | { type: 'message_stop' }
    | { type: 'error'; error: { type: string; message: string } }
