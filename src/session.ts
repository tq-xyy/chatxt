import { existsSync } from 'fs'
import { writeFile } from 'fs/promises'

import { getModelGateway, type Config } from './config'
import { ChatFile } from './fileobj'

import {
    mergeNormalizedUsage,
    normalizeUsage,
    type NormalizedUsage,
} from './common/usage'
import { defaultSystemPrompt } from './common/prompt'
import { chatCompletionStream } from './api/openai-compatible'
import { ToolRunner } from './tools/runner'
import {
    printExceptionMessage,
    printFinalStatus,
    printWarningMessage,
    ProgressReporter,
} from './tui'
import { parseSSEStream } from './utils/sseStream'
import { estimateTokens } from './utils/estimateTokens'

import type {
    ChatCompletionChunk,
    ChatCompletionResponse,
    ChatCompletionRequest,
    Usage,
} from './types/openai-compatible-api'
import type { APIAdapter, StreamEvent } from './types/api-adapter'
import { OpenAICompatibleAPIAdapter } from './controllers/openai-compatible'

function processFinishReason(finishReason: string): void {
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

export class ChatSession {
    private config: Config
    private file: ChatFile
    private toolRunner: ToolRunner
    private sumUsage: NormalizedUsage
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

        this.sumUsage = { input: 0, output: 0, cached: 0, thinking: 0 }

        this.api = new OpenAICompatibleAPIAdapter()
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

        try {
            const gateway = getModelGateway(this.config, this.config.model)

            if (gateway.endpointType !== 'openai-compatible') {
                throw new Error(
                    'The support of OpenAI Responses API and Anthropic API will come soon~'
                )
            }

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

            this.reporter.update(0)

            this.api.whenParsedChat(
                { messages, system },
                this.toolRunner.getDefinitions()
            )

            let retryTimes: number = 0

            while (true) {
                this.reporter.setPrompt('Requesting...')
                try {
                    const resp = await this.api.whenReadyToRequest(
                        this.config,
                        gateway
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
            this.checkFinish()
        } catch (err) {
            this.reporter.close()
            printExceptionMessage(err)
        }
    }

    private async onEmit(msg: StreamEvent): Promise<void> {
        switch (msg.type) {
            case 'reasoning-start':
                this.file.appendThinkingText('', true)
                this.reporter.setPrompt('Thinking...')
                break
            case 'reasoning-delta':
                this.file.appendThinkingText(msg.delta, false)
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
                this.file.appendRoleLine('TOOL')
                this.reporter.setPrompt('Generating Function Call...')
                break
            case 'function-call-delta':
                this.file.appendToolCallChunkToToolBlock(msg.toolCallChunk)
                this.reporter.update(
                    estimateTokens(msg.toolCallChunk.function.arguments)
                )
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

                await this.checkFinish()
                break
            }

            case 'finish': {
                if (msg.finishReason) {
                    processFinishReason(msg.finishReason)
                    this.stop = true
                }
                if (msg.usage) {
                    this.addUsageRecord(msg.usage)
                }
                break
            }
        }
    }

    async checkFinish() {
        if (!this.stop) {
            return
        }
        this.file.appendRoleLine('USER')
        await this.file.flushBuffer()

        this.reporter.close()

        printFinalStatus({
            startTime: this.startTime,
            usage: this.sumUsage,
            toolCallCount: this.sumToolCall,
            config: this.config,
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

        const apiGateway = getModelGateway(this.config, request.model)

        const resp = await chatCompletionStream(
            {
                ...request,
                stream_options: { include_usage: true },
            },
            apiGateway
        )

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

        this.reporter.setPrompt('Call Function | Sub Agent Generating...')

        for await (const streamMessage of parseSSEStream<ChatCompletionChunk>(
            resp
        )) {
            const chunk = streamMessage.data

            if (chunk.usage) {
                this.addUsageRecord(chunk.usage)
                result.usage = chunk.usage
            }

            const choice = chunk.choices[0]
            if (!choice) continue

            const message = result.choices[0].message
            if (choice.delta?.reasoning_content) {
                message.reasoning_content =
                    (message.reasoning_content ?? '') +
                    choice.delta.reasoning_content
                this.reporter.update(
                    estimateTokens(choice.delta?.reasoning_content)
                )
            }
            if (choice.delta?.reasoning) {
                message.reasoning =
                    (message.reasoning ?? '') + choice.delta.reasoning
                this.reporter.update(estimateTokens(choice.delta?.reasoning))
            }
            if (choice.delta?.content) {
                message.content =
                    (message.content ?? '') + choice.delta.content
                this.reporter.update(estimateTokens(choice.delta.content))
            }
            if (choice.finish_reason) {
                result.choices[0].finish_reason = choice.finish_reason
            }
        }

        return result
    }

    private addUsageRecord(usage: Usage | NormalizedUsage) {
        this.reporter.clear()
        this.sumUsage = mergeNormalizedUsage(
            this.sumUsage,
            normalizeUsage(usage)
        )
    }
}
