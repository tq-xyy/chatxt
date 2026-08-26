export type {
    FinishReason,
    // Messages
    OpenAICompatibleMessage as Message,
    OpenAICompatibleSystemMessage as SystemMessage,
    OpenAICompatibleAssistantMessage as AssistantMessage,
    OpenAICompatibleUserMessage as UserMessage,
    // Tools
    OpenAICompatibleToolCall as ToolCall,
    OpenAICompatibleToolMessage as ToolMessage,
} from './apis/openai-compatible-api'
import type { JSONSchema7 as JSONSchema } from 'json-schema'

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

export interface ToolDef {
    name: string
    description: string
    parameters: JSONSchema
}
