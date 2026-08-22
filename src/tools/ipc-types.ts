import type { ToolDefinition } from '../types/chat-file'
import type { OpenAICompatibleRequest } from '../types/apis/openai-compatible-api'

export interface RegisterMessage {
    type: 'register'
    tools: ToolDefinition[]
}

export interface ExecuteMessage {
    type: 'execute'
    id: string
    toolName: string
    args: unknown
}

export interface ResultMessage {
    type: 'result'
    id: string
    result?: unknown
    error?: string
}

export interface ChatCompletionMessage {
    type: 'chatCompletion'
    id: string
    request: OpenAICompatibleRequest
}

export interface ChatCompletionResultMessage {
    type: 'chatCompletionResult'
    id: string
    result?: unknown
    error?: string
}

export interface WarningMessage {
    type: 'warning'
    message: string
}

export interface ExitMessage {
    type: 'exit'
}

export interface ErrorMessage {
    type: 'error'
    message: string
}

export type IPCMessage =
    | RegisterMessage
    | ExecuteMessage
    | ResultMessage
    | ChatCompletionMessage
    | ChatCompletionResultMessage
    | WarningMessage
    | ExitMessage
    | ErrorMessage
