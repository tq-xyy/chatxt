import { writeFile } from 'fs/promises'

import { getModelGateway, type Config } from './config'
import { ChatFile } from './fileobj'

import { mergeNormalizedUsages, type NormalizedUsage } from './common/usage'
import { defaultSystemPrompt } from './common/prompt'
import { ToolRunner } from './tools/runner'
import {
    printExceptionMessage,
    printFinalStatus,
    printWarningMessage,
    ProgressPanel,
} from './tui'
import { parseSSEStream } from './utils/sse-stream'
import { isFile } from './utils/file-utils'

import type {
    AssistantMessage,
    FinishReason,
    FunctionCallDelta,
    FunctionCallMessage,
    Message,
} from './types/chat-file'
import type { APIAdapter, StreamEvent } from './types/api-adapter'
import { createAPIAdapter } from './api'
import { computeTokenCostCNY } from './common/pricing'

function processFinishReason(finishReason: FinishReason): void {
    switch (finishReason) {
        case 'stop':
        case 'length':
            break
        case 'content_filter':
            printWarningMessage(
                'stop by content filter, ' +
                    'dont ask for politics senstive or yellow content.'
            )
            break
        case 'insufficient_system_resource':
            printWarningMessage(
                'model provider system crush because of insufficient resource'
            )
            break
        default:
            throw new TypeError(`unkonwn finish reason: ${finishReason}`)
    }
}

/** 把流式分片合并为 FunctionCallMessage 列表（按分片 index 排序） */
function mergeFunctionCallDeltas(
    deltas: FunctionCallDelta[]
): FunctionCallMessage[] {
    const calls = new Map<number, FunctionCallMessage>()
    for (const chunk of deltas) {
        if (chunk.type === 'callee') {
            if (!calls.has(chunk.index)) {
                calls.set(chunk.index, {
                    role: 'tool-call',
                    callId: chunk.callId,
                    name: chunk.callee,
                    arguments: chunk.arguments || '',
                })
            }
        } else {
            const prev = calls.get(chunk.index)
            if (prev) {
                prev.arguments += chunk.delta
            }
        }
    }
    return [...calls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, call]) => call)
}

function computeTotalCost(usages: NormalizedUsage[], config: Config) {
    let total: number = 0
    for (const usage of usages) {
        const pricing = usage.model
            ? getModelGateway(config, usage.model).pricing
            : usage.model
        const cost = computeTokenCostCNY(usage, pricing)
        if (!isNaN(cost)) {
            total += cost
        }
    }
    return total
}

export class ChatSession {
    public config: Config
    public file: ChatFile
    public toolRunner: ToolRunner
    public panel: ProgressPanel
    public api: APIAdapter

    private sumUsages: NormalizedUsage[]
    private sumToolCall = 0
    private startTime: number

    // state
    private shouldStop: boolean = false
    private messages: Message[] = []
    private toolCallDeltaBuffer: FunctionCallDelta[]

    constructor(
        private chatFilePath: string,
        config: Config
    ) {
        this.config = config
        this.file = new ChatFile(chatFilePath, config)
        this.startTime = performance.now()
        this.panel = new ProgressPanel({
            config,
            // 面板独占 stdout，写文件模式下才可用；emitToConsole 静默
            enabled: !this.config.emitToConsole && !!process.stdout.isTTY,
        })
        this.toolRunner = new ToolRunner(this)

        this.sumUsages = []
        this.toolCallDeltaBuffer = []

        const gateway = getModelGateway(this.config, this.config.model)
        this.api = createAPIAdapter(gateway.endpointType)
    }

    async loop(): Promise<void> {
        if (!(await isFile(this.chatFilePath))) {
            printWarningMessage(
                `${this.chatFilePath} don't exist. Automatically create a none file.`
            )
            const content = [
                `#!/usr/bin/env chatxt`,
                `----- CHAT ROLE: SYSTEM -----`,
                defaultSystemPrompt,
                `----- CHAT ROLE: USER -----`,
                '',
            ].join('\n')
            await writeFile(this.chatFilePath, content, 'utf-8')
            this.panel.close()
            return
        }

        process.on('SIGINT', async () => {
            this.shouldStop = true
            await this.checkFinish('ctrl-c')
            process.exit(0)
        })

        try {
            const gateway = getModelGateway(this.config, this.config.model)

            const { messages, toolPaths } = await this.file.buildPrompt()

            const lastMessage = messages.at(-1)
            if (
                lastMessage?.role !== 'user' ||
                (lastMessage.content.trimEnd().length || 0) < 1
            ) {
                printWarningMessage('No user input.')
                this.panel.close()
                return
            }

            await this.toolRunner.loadTools(toolPaths)

            this.messages = messages

            let retryTimes: number = 0
            this.shouldStop = false

            while (!this.shouldStop) {
                try {
                    // fetch 内 await 消耗 TTFB，必须在此记账才能捕获网络等待
                    this.panel.onRequestStart()
                    const resp = await this.api.buildRequest(
                        this.config,
                        gateway,
                        this.messages,
                        this.toolRunner.getToolDefinitions()
                    )

                    this.toolCallDeltaBuffer = []
                    this.messages.push({ role: 'assistant', content: '' })

                    for await (const message of parseSSEStream(resp)) {
                        await this.api.handleChunk(
                            message,
                            this.onEmit.bind(this)
                        )
                    }
                    await this.api.handleStreamEnd(this.onEmit.bind(this))
                } catch (err) {
                    this.panel.clear()
                    retryTimes += 1
                    if (retryTimes <= 3) {
                        console.log()
                        printExceptionMessage(err)
                        printWarningMessage(`Retry... (${retryTimes}/3)`)
                    } else {
                        throw new Error('Retry limit exceeds.', { cause: err })
                    }
                }
            }
            await this.checkFinish('ok')
        } catch (err) {
            this.shouldStop = true
            printExceptionMessage(err)
            await this.checkFinish('error')
        }
    }

    private async onEmit(msg: StreamEvent): Promise<void> {
        this.panel.onEvent(msg)

        switch (msg.type) {
            case 'reasoning-start':
                if (this.config.emitThinking) {
                    this.file.appendRoleLine('THINKING', {
                        withPrefixNewLine: true,
                        withSuffixNewLine: true,
                    })
                }
                this.panel.setPhase('thinking')
                break
            case 'reasoning-delta': {
                if (this.config.emitThinking) {
                    await this.file.appendContent(msg.delta)
                }
                const assistant = this.getPendingAssistant()
                assistant.reasoning_content =
                    (assistant.reasoning_content ?? '') + msg.delta
                break
            }
            case 'reasoning-end':
                break

            case 'content-start':
                this.file.appendRoleLine('ASSISTANT', {
                    withPrefixNewLine: true,
                    withSuffixNewLine: true,
                })
                this.panel.setPhase('output')
                break
            case 'content-delta': {
                await this.file.appendContent(msg.delta)
                const assistant = this.getPendingAssistant()
                assistant.content = (assistant.content ?? '') + msg.delta
                break
            }
            case 'content-end':
                break

            case 'function-call-start':
                this.file.appendRoleLine('TOOL', {
                    withPrefixNewLine: true,
                    withSuffixNewLine: false,
                })
                // 生成函数调用参数仍属输出阶段
                this.panel.setPhase('output')
                break
            case 'function-call-delta':
                await this.file.appendToolCallChunkToToolBlock(msg.delta)
                this.toolCallDeltaBuffer.push(msg.delta)
                break
            case 'function-call-end': {
                const toolCalls = mergeFunctionCallDeltas(
                    this.toolCallDeltaBuffer
                )
                this.toolCallDeltaBuffer = []

                this.sumToolCall += toolCalls.length

                // 工具开始执行的时序只在此处可知（适配器不携带）
                this.panel.setPendingToolNames(
                    toolCalls.map(c => c.name).filter(Boolean)
                )
                this.panel.setPhase('tool')

                this.messages.push(...toolCalls)

                const toolResponses =
                    await this.toolRunner.executeAll(toolCalls)

                await this.file.appendToolMessagesToToolResponseBlock(
                    toolResponses
                )
                this.messages.push(...toolResponses)

                break
            }

            case 'response-end': {
                if (msg.finishReason) {
                    if (msg.finishReason === 'tool_calls') {
                        this.shouldStop = false
                    } else {
                        processFinishReason(msg.finishReason)
                        this.shouldStop = true
                    }
                }
                if (msg.usage) {
                    this.addUsageRecord({
                        ...msg.usage,
                        model: msg.usage.model ?? this.config.model,
                    })
                }
                break
            }
        }
    }

    private async checkFinish(status: 'ok' | 'error' | 'ctrl-c') {
        if (!this.shouldStop) {
            return
        }

        if (status === 'ok') {
            this.file.appendRoleLine('USER', {
                withPrefixNewLine: true,
                withSuffixNewLine: true,
            })
        }
        await this.file.flushBuffer()

        this.panel.close()

        printFinalStatus({
            status,
            startTime: this.startTime,
            usages: this.sumUsages,
            toolCallCount: this.sumToolCall,
            config: this.config,
            totalCost: computeTotalCost(this.sumUsages, this.config),
            requestCount: this.panel.summary.roundCount,
            timing: {
                netMs: this.panel.summary.netMs,
                outMs: this.panel.summary.outMs,
                toolMs: this.panel.summary.toolMs,
            },
        })

        await this.toolRunner.close()
    }

    private getPendingAssistant(): AssistantMessage {
        const last = this.messages.findLast(
            (m): m is AssistantMessage => m.role === 'assistant'
        )
        if (last) {
            return last
        }
        const created: AssistantMessage = { role: 'assistant', content: '' }
        this.messages.push(created)
        return created
    }

    public addUsageRecord(usage: NormalizedUsage) {
        this.sumUsages = mergeNormalizedUsages(this.sumUsages, usage)
    }
}
