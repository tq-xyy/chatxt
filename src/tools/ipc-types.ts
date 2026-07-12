import type { ToolDefinition, ChatCompletionRequest } from '../types/openaiApi'

export interface RegisterMessage {
    type: 'register'
    tools: ToolDefinition[]
}

export interface ExecuteMessage {
    type: 'execute'
    id: string
    toolName: string
    args: any
}

export interface ResultMessage {
    type: 'result'
    id: string
    result?: any
    error?: string
}

export interface ChatCompletionMessage {
    type: 'chatCompletion'
    id: string
    request: ChatCompletionRequest
}

export interface ChatCompletionResultMessage {
    type: 'chatCompletionResult'
    id: string
    result?: any
    error?: string
}

export interface WarningMessage {
    type: 'warning'
    message: string
}

export type IPCMessage =
    | RegisterMessage
    | ExecuteMessage
    | ResultMessage
    | ChatCompletionMessage
    | ChatCompletionResultMessage
    | WarningMessage
