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
    ChatCompletionResponse,
    ChatCompletionRequest,
} from './types/apis/openai-compatible-api'
import type { FinishReason } from './types/chat-file'
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
    private config: Config
    private file: ChatFile
    private toolRunner: ToolRunner
    private sumUsages: NormalizedUsage[]
    private sumToolCall = 0
    private startTime: number
    private reporter: ProgressReporter

    private api: APIAdapter
    private stop: boolean = false

    constructor(
        private chatFilePath: string,
        config: Config
    ) {
        this.config = config
        this.file = new ChatFile(chatFilePath, config)
        this.startTime = performance.now()
        this.reporter = new ProgressReporter('Requesting...')
        this.toolRunner = new ToolRunner(this)

        this.sumUsages = []

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
            this.stop = true
            await this.checkFinish('ctrl-c')
            process.exit(0)
        })

        try {
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

            while (true) {
                this.reporter.setPrompt('Requesting...')
                this.reporter.update(0)

                try {
                    const resp = await this.api.whenReadyToRequest(
                        this.config,
                        getModelGateway(this.config, this.config.model)
                    )

                    for await (const message of parseSSEStream(resp)) {
                        this.api.whenRecvivedChunk(
                            message,
                            this.onEmit.bind(this)
                        )
                    }

                    break
                } catch (err) {
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
            this.stop = true
            printExceptionMessage(err)
            await this.checkFinish('error')
        }
    }

    private async onEmit(msg: StreamEvent): Promise<void> {
        switch (msg.type) {
            case 'reasoning-start':
                if (this.config.showThinking) {
                    this.file.appendRoleLine('THINKING')
                }
                this.reporter.setPrompt('Thinking...')
                break
            case 'reasoning-delta':
                if (this.config.showThinking) {
                    this.file.appendContent(msg.delta)
                }
                this.reporter.update(msg.delta)
                break
            case 'reasoning-end':
                break

            case 'content-start':
                this.file.appendRoleLine('ASSISTANT')
                this.reporter.setPrompt('Generating Answer...')
                break
            case 'content-delta':
                this.file.appendContent(msg.delta)
                this.reporter.update(msg.delta)
                break
            case 'content-end':
                break

            case 'function-call-start':
                this.file.appendRoleLine('TOOL', { withoutNewLine: false })
                this.reporter.setPrompt('Generating Function Call...')
                break
            case 'function-call-delta':
                this.file.appendToolCallChunkToToolBlock(msg.toolCallChunk)
                this.reporter.update(msg.toolCallChunk.function.arguments)
                break
            case 'function-call-end': {
                this.sumToolCall += msg.toolCalls.length

                this.reporter.setPrompt('Call Function...')

                const toolResponses = await this.toolRunner.executeAll(
                    msg.toolCalls
                )

                this.file.appendToolMessagesToToolResponseBlock(toolResponses)

                this.reporter.setPrompt('Requesting...')

                const resp = await this.api.whenReadyToRequest(
                    this.config,
                    getModelGateway(this.config, this.config.model),
                    toolResponses
                )

                for await (const message of parseSSEStream(resp)) {
                    this.api.whenRecvivedChunk(message, this.onEmit.bind(this))
                }

                await this.checkFinish('ok')
                break
            }

            case 'response-end': {
                if (msg.finishReason) {
                    processFinishReason(msg.finishReason)
                    this.stop = true
                }
                if (msg.usage) {
                    this.addUsageRecord({
                        model: this.config.model,
                        ...msg.usage,
                    })
                }
                break
            }
        }
    }

    private async checkFinish(status: 'ok' | 'error' | 'ctrl-c') {
        if (!this.stop) {
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

    async subAgentChatCompletion(
        request: ChatCompletionRequest
    ): Promise<ChatCompletionResponse> {
        if (request.stream) {
            throw new Error(
                'chatCompletion not support stream, please use `fetch`'
            )
        }

        if (request.tools) {
            throw new Error(
                'chatCompletion not support tools, please use `fetch`'
            )
        }

        if (!request.model) {
            request.model = this.config.model
        }

        this.reporter.setPrompt('Call Function | Sub Agent Generating...')

        const apiGateway = getModelGateway(this.config, request.model)

        const api: APIAdapter = createAPIAdapter(apiGateway.endpointType)

        await api.whenParsedChat({
            messages: request.messages.filter(msg => msg.role !== 'system'),
            system:
                request.messages.find(msg => msg.role === 'system') ?? null,
            toolDefitions: [],
        })

        const newConfig = { ...this.config }

        if (request.thinking) {
            newConfig.thinkingMode = request.thinking.type
        }

        if (request.reasoning_effort) {
            newConfig.thinkingEffort = request.reasoning_effort
        }

        if (request.max_tokens) {
            newConfig.maxTokens = request.max_tokens
        }

        if (request.response_format?.type === 'json_object') {
            newConfig.jsonOnly = true
        }

        const resp = await api.whenReadyToRequest(newConfig, apiGateway)

        const result: ChatCompletionResponse = {
            choices: [
                {
                    index: 0,
                    finish_reason: 'stop',
                    message: {
                        role: 'assistant',
                        content: '',
                        reasoning_content: '',
                    },
                },
            ],
            usage: undefined,
        }

        const emit = async (msg: StreamEvent) => {
            switch (msg.type) {
                case 'reasoning-delta':
                    result.choices[0].message.reasoning_content += msg.delta
                    this.reporter.update(msg.delta)
                    break
                case 'content-delta':
                    result.choices[0].message.content += msg.delta
                    this.reporter.update(msg.delta)
                    break
                case 'response-end':
                    if (msg.finishReason) {
                        result.choices[0].finish_reason =
                            msg.finishReason as ChatCompletionResponse['choices'][0]['finish_reason']
                    }
                    if (msg.usage) {
                        result.usage = {
                            prompt_tokens: msg.usage.input,
                            completion_tokens: msg.usage.output,
                            total_tokens: msg.usage.input + msg.usage.output,
                            prompt_cache_hit_tokens: msg.usage.cached,
                            prompt_cache_miss_tokens:
                                msg.usage.input - msg.usage.cached,
                            completion_tokens_details: {
                                reasoning_tokens: msg.usage.thinking,
                            },
                        }
                        this.addUsageRecord({
                            model: request.model,
                            ...msg.usage,
                        })
                    }
                    break
            }
        }

        for await (const streamMessage of parseSSEStream(resp)) {
            await api.whenRecvivedChunk(streamMessage, emit)
        }

        return result
    }

    private addUsageRecord(usage: NormalizedUsage) {
        this.sumUsages = mergeNormalizedUsages(this.sumUsages, usage)
    }
}
