import type { ToolDef } from '../types/chat-file'
import type { OpenAICompatibleRequest } from '../types/apis/openai-compatible-api'

export interface RegisterMessage {
    type: 'registerTool'
    toolDefs: ToolDef[]
}

export interface ToolExecuteMessage {
    type: 'executeTool'
    id: number
    toolName: string
    args: unknown
}

export interface ToolResultMessage {
    type: 'toolResult'
    id: number
    result?: unknown
    error?: string
}

export interface ChatCompletionMessage {
    type: 'chatCompletion'
    id: number
    request: OpenAICompatibleRequest
}

export interface ChatCompletionResultMessage {
    type: 'chatCompletionResult'
    id: number
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
    name: string
    message: string
    stack?: string
}

export type IPCMessageFromMain =
    ToolExecuteMessage | ChatCompletionResultMessage | ExitMessage

export type IPCMessageFromChild =
    | RegisterMessage
    | ToolResultMessage
    | ChatCompletionMessage
    | WarningMessage
    | ErrorMessage
