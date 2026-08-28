import type { JSONSchema7 as JSONSchema } from 'json-schema'

export type FinishReason =
    | 'stop'
    | 'length'
    | 'content_filter'
    | 'tool_calls'
    | 'insufficient_system_resource'

export interface SystemMessage {
    role: 'system'
    content: string
}

export interface UserMessage {
    role: 'user'
    content: string
}

export interface AssistantMessage {
    role: 'assistant'
    content: string | null
    reasoning_content?: string | null
}

export interface FunctionCallMessage {
    role: 'tool-call'
    callId: string
    name: string
    arguments: string
}

export interface FunctionCallResultMessage {
    role: 'tool-result'
    callId: string
    content: string
}

export type Message =
    | SystemMessage
    | UserMessage
    | AssistantMessage
    | FunctionCallMessage
    | FunctionCallResultMessage

export type FunctionCallDelta =
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
