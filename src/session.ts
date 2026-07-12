import { existsSync } from 'fs'
import { writeFile } from 'fs/promises'

import type {
    ChatCompletionChunk,
    ChatCompletionResponse,
    ChatCompletionRequest,
    ToolCall,
    Usage,
    Message,
} from './types/openaiApi'
import { mergeUsage } from './utils/computeCost'
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
    private sumUsage: Usage = {
        completion_tokens: 0,
        prompt_tokens: 0,
        prompt_cache_hit_tokens: 0,
        prompt_cache_miss_tokens: 0,
        total_tokens: 0,
        completion_tokens_details: { reasoning_tokens: 0 },
    }
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
            return
        }

        try {
            const [messages, toolPaths] = await this.file.buildPrompt()
            this.messages = messages
            this.chatTurn = messages.filter(msg => msg.role === 'user').length

            if (
                this.messages.at(-1)?.role !== 'user' ||
                (this.messages.at(-1)?.content?.trimEnd().length || 0) < 1
            ) {
                printWarningMessage('No user input.')
                return
            }

            await this.toolRunner.loadTools(toolPaths)

            this.reporter.update(0)

            let outputFlag: ChatRole | boolean = 'UNKNOWN'

            while (outputFlag !== false) {
                const resp = await chatCompletionStream(
                    this.messages,
                    this.config,
                    this.toolRunner.getDefinitions()
                )

                const toolCalls: ToolCall[] = []
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
                        toolCalls
                    )
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
        toolCalls: ToolCall[]
    ): Promise<ChatRole | boolean> {
        if (chunk.usage) {
            this.addUsageRecord(chunk.usage)
        }

        const choice = chunk.choices[0]

        if (choice.delta?.reasoning_content && outputFlag !== 'THINKING') {
            this.file.appendThinkingText('', true)
            this.reporter.setPrompt('Thinking...')
            outputFlag = 'THINKING'
        }
        if (choice.delta?.reasoning_content) {
            this.file.appendThinkingText(choice.delta.reasoning_content, false)
            // @ts-expect-error
            this.messages.at(-1)!.reasoning_content +=
                choice.delta.reasoning_content
            this.reporter.update(1)
        }

        if (choice.delta?.content && outputFlag !== 'ASSISTANT') {
            this.file.appendRoleLine('ASSISTANT')
            outputFlag = 'ASSISTANT'
            this.reporter.setPrompt('Generating Answer...')
        }
        if (choice.delta?.content) {
            this.file.appendContent(choice.delta.content)
            this.messages.at(-1)!.content += choice.delta.content
            this.reporter.update(1)
        }

        if (choice.delta?.tool_calls && outputFlag !== 'TOOL') {
            this.file.appendRoleLine('TOOL')
            outputFlag = 'TOOL'
            this.reporter.setPrompt('Generating Function Call...')
        }
        if (choice.delta?.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
                if (tc.type === 'function') {
                    this.sumToolCall++
                    tc.id = this.generateToolCallId()
                    this.file.appendContent(
                        `\n${tc.function.name} (${tc.id}): `
                    )
                } else {
                    this.file.appendContent(tc.function.arguments)
                }
            }

            mergeToolCallChunks(toolCalls, choice.delta.tool_calls)

            this.reporter.update(1)
        }

        if (choice.finish_reason === 'tool_calls') {
            await this.handleToolCalls(toolCalls)
            outputFlag = 'UNKNOWN'
        } else if (choice.finish_reason !== null) {
            processFinishReason(choice)
            outputFlag = false
        }

        return outputFlag
    }

    private async handleToolCalls(toolCalls: ToolCall[]) {
        // @ts-expect-error
        this.messages.at(-1)!.tool_calls = toolCalls

        this.reporter.setPrompt('Call Function...')
        this.reporter.update(0)

        const msgs = await this.toolRunner.executeAll(toolCalls)

        this.messages.push(...msgs)
        this.file.appendRoleLine('TOOLRESPONSE')
        for (const msg of msgs) {
            if (msg.role === 'tool') {
                this.file.appendContent(
                    `${msg.tool_call_id}: ${msg.content}\n`
                )
            }
        }
    }

    async subAgentChatCompletion(
        request: ChatCompletionRequest
    ): Promise<ChatCompletionResponse> {
        if (request.stream) {
            throw new Error(
                'chatCompletion not support stream, please use `fetch`'
            )
        }

        const body: Partial<ChatCompletionRequest> = {
            ...request,
            model: request.model || this.config.model,
            messages: request.messages,
            thinking: request.thinking ?? { type: 'enabled' },
            reasoning_effort:
                request.reasoning_effort ||
                (this.config.thinkingEffort as ChatCompletionRequest['reasoning_effort']),
            temperature: request.temperature,
            max_tokens: request.max_tokens,
        }

        const resp = await fetch(
            `${this.config.endpoint}/chat/completions`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${this.config.apiKey}`,
                },
                body: JSON.stringify(body),
            }
        )

        if (!resp.ok) {
            let errorText = await resp.text()
            try {
                const errorJSON = JSON.parse(errorText)
                errorText = errorJSON.error.message
            } catch {}
            throw new Error(
                `API Request Failed (${resp.status}), error message: ${errorText}`
            )
        }

        const result = (await resp.json()) as ChatCompletionResponse

        if (result.usage) {
            this.addUsageRecord(result.usage)
        }
        return result
    }

    private addUsageRecord(usage: Usage) {
        this.reporter.clear()
        this.sumUsage = mergeUsage(this.sumUsage, usage)
    }

    private generateToolCallId(): string {
        return `${this.chatTurn}-${this.sumToolCall}`
    }
}
