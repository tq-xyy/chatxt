import { existsSync } from 'fs'
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
    ProgressReporter,
} from './tui'
import { parseSSEStream } from './utils/sseStream'

import type {
    FinishReason,
    ToolCall,
    ToolCallDelta,
    ToolMessage,
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
    public reporter: ProgressReporter
    public api: APIAdapter

    private sumUsages: NormalizedUsage[]
    private sumToolCall = 0
    private startTime: number

    // state
    private shouldStop: boolean = false
    private toolCallDeltaBuffer: ToolCallDelta[]
    private toolMessageBuffer: ToolMessage[]

    constructor(
        private chatFilePath: string,
        config: Config
    ) {
        this.config = config
        this.file = new ChatFile(chatFilePath, config)
        this.startTime = performance.now()
        this.reporter = new ProgressReporter(
            'Requesting...',
            !!this.config.emitToConsole || !process.stdout.isTTY
        )
        this.toolRunner = new ToolRunner(this)

        this.sumUsages = []
        this.toolCallDeltaBuffer = []
        this.toolMessageBuffer = []

        const gateway = getModelGateway(this.config, this.config.model)
        this.api = createAPIAdapter(gateway.endpointType)
    }

    async loop(): Promise<void> {
        if (!existsSync(this.chatFilePath)) {
            printWarningMessage(
                `${this.chatFilePath} don't exist. Automatically create a none file.`
            )
            const content = [
                `#!/usr/bin/env chatfile`,
                `----- CHAT ROLE: SYSTEM -----`,
                defaultSystemPrompt,
                `----- CHAT ROLE: USER -----`,
                '',
            ].join('\n')
            await writeFile(this.chatFilePath, content, 'utf-8')
            this.reporter.close()
            return
        }

        process.on('SIGINT', async () => {
            this.shouldStop = true
            await this.checkFinish('ctrl-c')
            process.exit(0)
        })

        try {
            const gateway = getModelGateway(this.config, this.config.model)

            const { system, messages, toolPaths } =
                await this.file.buildPrompt()

            if (
                messages.at(-1)?.role !== 'user' ||
                (messages.at(-1)?.content?.trimEnd().length || 0) < 1
            ) {
                printWarningMessage('No user input.')
                this.reporter.close()
                return
            }

            await this.toolRunner.loadTools(toolPaths)

            this.api.whenParsedChat({
                messages,
                system,
                toolDefitions: this.toolRunner.getDefinitions(),
            })

            let retryTimes: number = 0
            this.shouldStop = false

            while (!this.shouldStop) {
                this.reporter.setPrompt('Requesting...')

                try {
                    const resp = await this.api.whenReadyToRequest(
                        this.config,
                        gateway,
                        this.toolMessageBuffer
                    )

                    this.toolCallDeltaBuffer = []
                    this.toolMessageBuffer = []

                    for await (const message of parseSSEStream(resp)) {
                        await this.api.whenRecvivedChunk(
                            message,
                            this.onEmit.bind(this)
                        )
                    }
                } catch (err) {
                    this.reporter.clear()
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
        switch (msg.type) {
            case 'reasoning-start':
                if (this.config.emitThinking) {
                    this.file.appendRoleLine('THINKING')
                }
                this.reporter.setPrompt('Thinking...')
                break
            case 'reasoning-delta':
                if (this.config.emitThinking) {
                    this.file.appendContent(msg.delta)
                }
                this.reporter.update(msg.delta)
                break
            case 'reasoning-end':
                break

            case 'content-start':
                this.file.appendContent('\n')
                this.file.appendRoleLine('ASSISTANT')
                this.reporter.setPrompt('Generating Answer...')
                break
            case 'content-delta':
                this.file.appendContent(msg.delta)
                this.reporter.update(msg.delta)
                break
            case 'content-end':
                this.file.appendContent('\n')
                break

            case 'function-call-start':
                this.file.appendRoleLine('TOOL', { withoutNewLine: true })
                this.reporter.setPrompt('Generating Function Call...')
                break
            case 'function-call-delta':
                this.file.appendToolCallChunkToToolBlock(msg.delta)
                this.toolCallDeltaBuffer.push(msg.delta)
                this.reporter.update(
                    msg.delta.type === 'arguments' ? msg.delta.delta : ''
                )
                break
            case 'function-call-end': {
                const toolCalls = this.toolCallDeltaBuffer.reduce<ToolCall[]>(
                    (calls, chunk) => {
                        const indexedCall = calls.findIndex(
                            call => call.index === chunk.index
                        )
                        if (chunk.type === 'callee' && indexedCall < 0) {
                            calls.push({
                                type: 'function',
                                index: chunk.index,
                                id: chunk.callId,
                                function: {
                                    name: chunk.callee,
                                    arguments: chunk.arguments || '',
                                },
                            })
                        } else if (
                            chunk.type === 'arguments' &&
                            indexedCall >= 0
                        ) {
                            calls[indexedCall].function.arguments +=
                                chunk.delta
                        }
                        // ignore invaild chunks
                        return calls
                    },
                    []
                )
                this.toolCallDeltaBuffer = []

                this.sumToolCall += toolCalls.length

                this.reporter.setPrompt('Call Function...')

                const toolResponses =
                    await this.toolRunner.executeAll(toolCalls)

                this.file.appendToolMessagesToToolResponseBlock(toolResponses)
                this.toolMessageBuffer.push(...toolResponses)

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
            this.file.appendRoleLine('USER')
        }
        await this.file.flushBuffer()

        this.reporter.close()

        printFinalStatus({
            status,
            startTime: this.startTime,
            usages: this.sumUsages,
            toolCallCount: this.sumToolCall,
            config: this.config,
            totalCost: computeTotalCost(this.sumUsages, this.config),
        })

        this.toolRunner.close()
    }

    public addUsageRecord(usage: NormalizedUsage) {
        this.sumUsages = mergeNormalizedUsages(this.sumUsages, usage)
    }
}
