import { existsSync } from 'fs'
import { writeFile } from 'fs/promises'

import type {
    ChatCompletionChunk,
    ChatCompletionResponse,
    ChatCompletionRequest,
    ToolCall,
    Usage,
    Message,
    ToolCallChunk,
} from './types/openaiApi'
import { mergeNormalizedUsage, normalizeUsage } from './utils/computeCost'
import type { NormalizedUsage } from './utils/computeCost'
import type { Config } from './config'
import { parseSSEStream } from './utils/sseStream'
import { defaultSystemPrompt } from './utils/prompt'
import { chatCompletionStream } from './utils/api'
import { ChatFile } from './fileobj'
import type { ChatRole } from './fileobj'
import { ToolRunner } from './tools/runner'
import { mergeToolCallChunks } from './tools/streamhelper'
import {
    printExceptionMessage,
    printFinalStatus,
    printWarningMessage,
    ProgressReporter,
} from './tui'
import { estimateTokens } from './utils/estimateTokens'

function processFinishReason(choice: ChatCompletionChunk['choices'][0]): void {
    switch (choice.finish_reason) {
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
            throw new TypeError(
                `unkonwn finish reason: ${choice.finish_reason}`
            )
    }
}

export class ChatSession {
    private config: Config
    private file: ChatFile
    private toolRunner: ToolRunner
    private messages: Message[] = []
    private sumUsage: NormalizedUsage
    private sumToolCall = 0
    private chatTurn = 0
    private startTime: number
    private reporter: ProgressReporter

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
            const { system, messages, toolPaths } =
                await this.file.buildPrompt()
            this.messages = system ? [system, ...messages] : messages
            this.chatTurn = messages.filter(msg => msg.role === 'user').length

            if (
                this.messages.at(-1)?.role !== 'user' ||
                (this.messages.at(-1)?.content?.trimEnd().length || 0) < 1
            ) {
                printWarningMessage('No user input.')
                this.reporter.close()
                return
            }

            await this.toolRunner.loadTools(toolPaths)

            this.reporter.update(0)

            let outputFlag: ChatRole | boolean = 'UNKNOWN'
            let retryTimes: number = 0

            while (outputFlag !== false) {
                this.reporter.setPrompt('Requesting...')
                try {
                    const resp = await chatCompletionStream(
                        {
                            model: this.config.model,
                            /* leave it default */
                            // thinking: { type: 'enabled' },
                            reasoning_effort: this.config
                                .thinkingEffort as ChatCompletionRequest['reasoning_effort'],
                            messages: this.messages,
                            stream_options: { include_usage: true },
                            tools: this.toolRunner.getDefinitions(),
                        },
                        this.config
                    )

                    const toolCallChunks: ToolCallChunk[] = []
                    this.messages.push({
                        role: 'assistant',
                        reasoning_content: '',
                        content: '',
                    })

                    for await (const chunk of parseSSEStream<ChatCompletionChunk>(
                        resp
                    )) {
                        outputFlag = await this.handleChunk(
                            chunk,
                            outputFlag,
                            toolCallChunks
                        )
                    }
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

            this.file.appendRoleLine('USER')
            await this.file.flushBuffer()

            this.reporter.close()

            printFinalStatus({
                startTime: this.startTime,
                usage: this.sumUsage,
                toolCallCount: this.sumToolCall,
                config: this.config,
            })
            console.log()
        } catch (err) {
            this.reporter.close()
            printExceptionMessage(err)
        } finally {
            this.toolRunner.close()
        }
    }

    private async handleChunk(
        chunk: ChatCompletionChunk,
        outputFlag: ChatRole | boolean,
        toolCallChunks: ToolCallChunk[]
    ): Promise<ChatRole | boolean> {
        if (chunk.usage) {
            this.addUsageRecord(chunk.usage)
        }

        if (chunk.choices.length === 0) {
            // discard empty chunk
            return outputFlag
        }

        const choice = chunk.choices[0]

        const content: string | null | undefined = choice.delta?.content
        const reasoning: string | null | undefined =
            choice.delta?.reasoning_content || // deepseek, kimi
            choice.delta?.reasoning // others
        const toolCallDelta: ToolCallChunk[] | null | undefined =
            choice.delta?.tool_calls

        if (reasoning && outputFlag !== 'THINKING') {
            this.file.appendThinkingText('', true)
            this.reporter.setPrompt('Thinking...')
            outputFlag = 'THINKING'
        }
        if (reasoning) {
            this.file.appendThinkingText(reasoning, false)
            // @ts-expect-error
            this.messages.at(-1)!.reasoning_content += reasoning
            this.reporter.update(estimateTokens(reasoning))
        }

        if (content && outputFlag !== 'ASSISTANT') {
            this.file.appendRoleLine('ASSISTANT')
            outputFlag = 'ASSISTANT'
            this.reporter.setPrompt('Generating Answer...')
        }
        if (content) {
            this.file.appendContent(content)
            this.messages.at(-1)!.content += content
            this.reporter.update(estimateTokens(content))
        }

        if (toolCallDelta && outputFlag !== 'TOOL') {
            this.file.appendRoleLine('TOOL')
            outputFlag = 'TOOL'
            this.reporter.setPrompt('Generating Function Call...')
        }
        if (toolCallDelta) {
            for (const tc of toolCallDelta) {
                this.file.appendToolCallChunkToToolBlock(tc)
                this.reporter.update(estimateTokens(tc.function.arguments))
                toolCallChunks.push(tc)
            }
        }

        if (choice.finish_reason === 'tool_calls') {
            // discard duplicate tool calls
            if (this.messages.at(-1)?.role !== 'tool') {
                const calls = mergeToolCallChunks(toolCallChunks)
                await this.handleToolCalls(calls)
                outputFlag = 'UNKNOWN'
            }
        } else if (choice.finish_reason) {
            processFinishReason(choice)
            outputFlag = false
        }

        return outputFlag
    }

    private async handleToolCalls(toolCalls: ToolCall[]) {
        // @ts-expect-error
        this.messages.at(-1)!.tool_calls = toolCalls
        this.sumToolCall += toolCalls.length

        this.reporter.setPrompt('Call Function...')
        this.reporter.update(0)

        const msgs = await this.toolRunner.executeAll(toolCalls)

        this.messages.push(...msgs)
        this.file.appendToolMessagesToToolResponseBlock(msgs)
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

        const resp = await chatCompletionStream(
            {
                ...request,
                stream_options: { include_usage: true },
            },
            this.config
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

        for await (const chunk of parseSSEStream<ChatCompletionChunk>(resp)) {
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
                this.reporter.update(1)
            }
            if (choice.delta?.content) {
                message.content =
                    (message.content ?? '') + choice.delta.content
                this.reporter.update(1)
            }
            if (choice.finish_reason) {
                result.choices[0].finish_reason = choice.finish_reason
            }
        }

        return result
    }

    private addUsageRecord(usage: Usage) {
        this.reporter.clear()
        this.sumUsage = mergeNormalizedUsage(
            this.sumUsage,
            normalizeUsage(usage)
        )
    }
}
