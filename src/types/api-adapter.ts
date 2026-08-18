import type { Config, ModelGateway } from '../config'
import type {
    Message,
    SystemMessage,
    ToolDefinition,
    ToolMessage,
} from './openai-compatible-api'
import type { SSEMessage } from '../utils/sseStream'

import type { NormalizedUsage } from '../common/usage'
import type { ToolCall, ToolCallChunk } from './openai-compatible-api'

export interface ReasoningStartEvent {
    type: 'reasoning-start'
}

export interface ReasoningDeltaEvent {
    type: 'reasoning-delta'
    /** only for display */
    delta: string
}

export interface ReasoningEndEvent {
    type: 'reasoning-end'
}

export interface ContentStartEvent {
    type: 'content-start'
}

export interface ContentDeltaEvent {
    type: 'content-delta'
    /** only for display */
    delta: string
}

export interface ContentEndEvent {
    type: 'content-end'
}

export interface FunctionCallStartEvent {
    type: 'function-call-start'
}

export interface FunctionCallDeltaEvent {
    type: 'function-call-delta'
    /** only for display */
    toolCallChunk: ToolCallChunk
}

export interface FunctionCallEndEvent {
    type: 'function-call-end'
    toolCalls: ToolCall[]
}

export interface FinishEvent {
    type: 'finish'
    finishReason?: string
    usage?: NormalizedUsage
}

export type StreamEvent =
    | ReasoningStartEvent
    | ReasoningDeltaEvent
    | ReasoningEndEvent
    | ContentStartEvent
    | ContentDeltaEvent
    | ContentEndEvent
    | FunctionCallStartEvent
    | FunctionCallDeltaEvent
    | FunctionCallEndEvent
    | FinishEvent

export interface APIAdapter<Chunk = unknown> {
    whenParsedChat(
        chat: {
            messages: Message[]
            system: SystemMessage | null
        },
        toolDefitions: ToolDefinition[]
    ): Promise<void>
    whenReadyToRequest(
        config: Config,
        gateway: ModelGateway,
        toolMessages?: ToolMessage[]
    ): Promise<Response>
    whenRecvivedChunk(
        message: SSEMessage<Chunk>,
        emit: (event: StreamEvent) => Promise<void>
    ): Promise<void>
}
