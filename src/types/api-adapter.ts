import type { Config, ModelGateway } from '../config'
import type {
    Message,
    SystemMessage,
    ToolDefinition,
    ToolMessage,
    ToolCall,
    ToolCallChunk,
    FinishReason,
} from './chat-file'
import type { SSEMessage } from '../utils/sseStream'

import type { NormalizedUsage } from '../common/usage'

interface ReasoningStartEvent {
    type: 'reasoning-start'
}

interface ReasoningDeltaEvent {
    type: 'reasoning-delta'
    /** only for display */
    delta: string
}

interface ReasoningEndEvent {
    type: 'reasoning-end'
}

interface ContentStartEvent {
    type: 'content-start'
}

interface ContentDeltaEvent {
    type: 'content-delta'
    /** only for display */
    delta: string
}

interface ContentEndEvent {
    type: 'content-end'
}

interface FunctionCallStartEvent {
    type: 'function-call-start'
}

interface FunctionCallDeltaEvent {
    type: 'function-call-delta'
    /** only for display */
    toolCallChunk: ToolCallChunk
}

interface FunctionCallEndEvent {
    type: 'function-call-end'
    toolCalls: ToolCall[]
}

interface ResponseEndEvent {
    type: 'response-end'
    finishReason?: FinishReason
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
    | ResponseEndEvent

export interface APIAdapter<Chunk = unknown> {
    whenParsedChat(chat: {
        messages: Message[]
        system: SystemMessage | null
        toolDefitions: ToolDefinition[]
    }): Promise<void>
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
