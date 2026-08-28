import type { Config, ModelGateway } from '../config'
import type {
    Message,
    ToolDef,
    FinishReason,
    FunctionCallDelta,
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
    delta: FunctionCallDelta
}

interface FunctionCallEndEvent {
    type: 'function-call-end'
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
    /**
     * 把会话消息转成协议请求并发送，每轮调用一次。
     * 实现方不得修改传入的 messages。
     */
    buildRequest(
        config: Config,
        gateway: ModelGateway,
        messages: Message[],
        toolDefinitions: ToolDef[]
    ): Promise<Response>
    handleChunk(
        message: SSEMessage<Chunk>,
        emit: (event: StreamEvent) => Promise<void>
    ): Promise<void>
    /** SSE 流结束后调用，发射剩余事件（如 response-end） */
    handleStreamEnd(emit: (event: StreamEvent) => Promise<void>): Promise<void>
}
