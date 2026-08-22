export type {
    FinishReason,
    // Messages
    OpenAICompatibleMessage as Message,
    OpenAICompatibleSystemMessage as SystemMessage,
    OpenAICompatibleAssistantMessage as AssistantMessage,
    OpenAICompatibleUserMessage as UserMessage,
    // Tools
    OpenAICompatibleToolCall as ToolCall,
    OpenAICompatibleToolDefinition as ToolDefinition,
    OpenAICompatibleToolMessage as ToolMessage,
} from './apis/openai-compatible-api'

export type ToolCallDelta =
    | {
          type: 'callee'
          index: number
          callee: string
          callId: string
          arguments?: string
      }
    | {
          type: 'arguments'
          index: number
          delta: string
      }
