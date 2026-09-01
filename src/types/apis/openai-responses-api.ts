// ======================== OpenAI Responses API 类型 ========================

// ---------- 请求 ----------

export interface ResponsesToolDefinition {
    type: 'function'
    name: string
    description?: string
    parameters?: Record<string, unknown>
    strict?: boolean | null
}

export type ResponsesInputItem =
    | {
          type: 'message'
          role: 'user' | 'assistant' | 'system'
          content: string
      }
    | {
          type: 'function_call'
          call_id: string
          name: string
          arguments: string
      }
    | {
          type: 'function_call_output'
          call_id: string
          output: string
      }
    | ResponsesReasoningItem

/** 思维链 item：思考模式下 DeepSeek 等要求回传上轮 reasoning_text */
export interface ResponsesReasoningItem {
    type: 'reasoning'
    id?: string
    content: {
        type: 'reasoning_text'
        text: string
    }[]
}

export interface ResponsesRequest {
    model: string
    input: ResponsesInputItem[]
    instructions?: string
    tools?: ResponsesToolDefinition[]
    stream: true
    reasoning?: {
        effort?: 'low' | 'medium' | 'high' | 'max'
        summary?: 'auto' | 'detailed' | null
    }
    max_output_tokens?: number
    text?: {
        format?: 'text' | 'json_object'
    }
}

// ---------- 流式事件 ----------

export interface ResponsesUsage {
    input_tokens: number
    output_tokens: number
    total_tokens: number
    input_tokens_details?: {
        cached_tokens?: number
    }
    output_tokens_details?: {
        reasoning_tokens?: number
    }
}

export interface ResponsesFunctionCallItem {
    id: string
    type: 'function_call'
    status: string
    name: string
    call_id: string
    arguments: string
}

export interface ResponsesMessageItem {
    id: string
    type: 'message'
    status: string
    role: 'assistant'
    content: unknown
}

export type ResponsesStreamEvent =
    | { type: 'ping'; cost?: string }
    | { type: 'response.created'; response: Record<string, unknown> }
    | { type: 'response.in_progress'; response: Record<string, unknown> }
    | {
          type: 'response.output_item.added'
          output_index: number
          item: ResponsesFunctionCallItem | ResponsesMessageItem
      }
    | {
          type: 'response.output_text.delta'
          output_index: number
          content_index: number
          item_id: string
          delta: string
      }
    | {
          type: 'response.output_text.done'
          output_index: number
          content_index: number
          item_id: string
          text: string
      }
    | {
          type: 'response.output_item.done'
          output_index: number
          item: ResponsesFunctionCallItem | ResponsesMessageItem
      }
    | {
          type: 'response.function_call_arguments.delta'
          output_index: number
          item_id: string
          delta: string
      }
    | {
          type: 'response.reasoning_summary_text.delta'
          output_index: number
          item_id: string
          delta: string
      }
    | {
          type: 'response.reasoning_text.delta'
          output_index: number
          item_id: string
          delta: string
      }
    | {
          type: 'response.completed'
          response: {
              id: string
              status: string
              output: (
                  | ResponsesFunctionCallItem
                  | ResponsesMessageItem
                  | ResponsesReasoningItem
              )[]
              usage: ResponsesUsage | null
          }
      }
    | {
          type: 'response.incomplete'
          response: {
              id: string
              status: string
              output: (
                  | ResponsesFunctionCallItem
                  | ResponsesMessageItem
                  | ResponsesReasoningItem
              )[]
              usage: ResponsesUsage | null
          }
      }
    | { type: 'response.failed'; response: Record<string, unknown> }
    | { type: 'error'; error: { message: string; type?: string } }
