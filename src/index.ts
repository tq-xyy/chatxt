import { existsSync } from 'fs'
import { writeFile } from 'fs/promises'

import type { ChatCompletionChunk, ToolCall } from './types/openaiApi'
import { computeTokenCostCNY, mergeUsage } from './utils/computeCost'
import type { Config } from './config'
import { parseSSEStream } from './utils/sseStream'
import { defaultSystemPrompt } from './utils/prompt'
import { chatCompletionStream } from './utils/api'
import { ChatFile } from './fileobj'
import type { ChatRole } from './fileobj'
import { ToolRunner } from './tools/runner'
import { mergeToolCallChunks } from './tools/streamhelper'

class ProgressReporter {
    private displayed: number = 0
    private prompt: string = ''

    constructor(prompt: string = 'Generating...') {
        this.setPrompt(prompt)
    }

    public setPrompt(prompt: string) {
        this.prompt = prompt
    }

    /**
     * 更新进度，增加 token 数量并在满足条件时刷新显示
     * @param delta 本次新增的 token 数量
     */
    public update(delta: number): void {
        this.displayed += delta
        this.clear()
        process.stdout.write(
            `${this.prompt} ${this.displayed} tokens (Ctrl+C to cancel)`
        )
    }

    public clear(): void {
        process.stdout.clearLine(0)
        process.stdout.cursorTo(0)
    }
}

export async function chatfile(
    chatFilePath: string,
    config: Config
): Promise<void> {
    if (!existsSync(chatFilePath)) {
        console.warn(
            `${chatFilePath} don't exist. Automatically create a none file.`
        )
        const content = [
            `#!/usr/bin/env chatfile`,
            `----- CHAT ROLE: SYSTEM -----`,
            defaultSystemPrompt,
            `----- CHAT ROLE: USER -----`,
            '',
        ].join('\n')
        await writeFile(chatFilePath, content, 'utf-8')
        return
    }

    const chatfile = new ChatFile(chatFilePath)
    const toolRunner = new ToolRunner()

    const [messages, toolPaths] = await chatfile.buildPrompt()

    await toolRunner.loadTools(toolPaths)

    if (
        messages.at(-1)?.role !== 'user' ||
        (messages.at(-1)?.content?.trimEnd().length || 0) < 1
    ) {
        console.warn('No user input.')
        return
    }

    const startTime = performance.now()

    const reporter: ProgressReporter = new ProgressReporter('Requesting...')
    let sumUsage: NonNullable<ChatCompletionChunk['usage']> = {
        completion_tokens: 0,
        prompt_tokens: 0,
        prompt_cache_hit_tokens: 0,
        prompt_cache_miss_tokens: 0,
        total_tokens: 0,
        completion_tokens_details: {
            reasoning_tokens: 0,
        },
    }

    let outputFlag: ChatRole | boolean = 'UNKNOWN'

    while (outputFlag !== false) {
        const resp = await chatCompletionStream(
            messages,
            config,
            toolRunner.getDefinitions()
        )

        const toolCalls: ToolCall[] = []
        messages.push({
            role: 'assistant',
            reasoning_content: '',
            content: '',
        })

        for await (const chunk of parseSSEStream<ChatCompletionChunk>(resp)) {
            // 合并 usage
            if (chunk.usage) {
                reporter.clear()
                sumUsage = mergeUsage(sumUsage, chunk.usage)
            }

            for (const choice of chunk.choices) {
                if (
                    choice.delta?.reasoning_content &&
                    outputFlag !== 'THINKING'
                ) {
                    if (config.showThinking) {
                        chatfile.appendRoleLine('THINKING')
                    }
                    reporter.setPrompt('Thinking...')
                    outputFlag = 'THINKING'
                }
                if (choice.delta?.reasoning_content) {
                    if (config.showThinking) {
                        chatfile.appendContent(choice.delta.reasoning_content)
                    }
                    // @ts-expect-error
                    messages[messages.length - 1].reasoning_content +=
                        choice.delta.reasoning_content
                    reporter.update(1)
                }

                if (choice.delta?.content && outputFlag !== 'ASSISTANT') {
                    chatfile.appendRoleLine('ASSISTANT')
                    outputFlag = 'ASSISTANT'
                    reporter.clear()
                    reporter.setPrompt('Generating Answer...')
                }
                if (choice.delta?.content) {
                    chatfile.appendContent(choice.delta.content)

                    messages[messages.length - 1].content +=
                        choice.delta.content
                    reporter.update(1)
                }

                if (choice.delta?.tool_calls && outputFlag !== 'TOOL') {
                    chatfile.appendRoleLine('TOOL')
                    outputFlag = 'TOOL'
                    reporter.clear()
                    reporter.setPrompt('Generating Function Call...')
                }
                if (choice.delta?.tool_calls) {
                    mergeToolCallChunks(toolCalls, choice.delta.tool_calls)
                    if (choice.delta.tool_calls[0].type === 'function') {
                        chatfile.appendContent(
                            `\n${
                                choice.delta.tool_calls[0].function.name
                            } (${choice.delta.tool_calls[0].id}): `
                        )
                    } else {
                        chatfile.appendContent(
                            choice.delta.tool_calls[0].function.arguments
                        )
                    }
                    reporter.update(1)
                }

                if (choice.finish_reason) {
                    switch (choice.finish_reason) {
                        case 'stop':
                        case 'length':
                            // do nothing
                            outputFlag = false
                            break
                        case 'tool_calls':
                            // @ts-expect-error
                            messages[messages.length - 1].tool_calls =
                                toolCalls
                            const msgs = await toolRunner.executeAll(toolCalls)
                            messages.push(...msgs)
                            for (const msg of msgs) {
                                if (msg.role === 'tool') {
                                    chatfile.appendRoleLine('TOOLRESPONSE')
                                    chatfile.appendContent(
                                        `${msg.tool_call_id}: ${msg.content}`
                                    )
                                }
                            }
                            break
                        case 'content_filter':
                            console.warn(
                                'stop by content filter, ' +
                                    'dont ask for politics senstive or yellow content.'
                            )
                            outputFlag = false
                            break
                        case 'insufficient_system_resource':
                            console.warn(
                                'model provider system crush because of insufficient resource'
                            )
                            outputFlag = false
                            break
                        default:
                            console.error(
                                `unkonwn finish reason: ${choice.finish_reason}`
                            )
                            outputFlag = false
                    }
                }
            }
        }
    }

    console.log(
        `Used ${sumUsage.total_tokens} tokens, ` +
            `${sumUsage.prompt_tokens} for input ` +
            `(${sumUsage.prompt_cache_hit_tokens} cached)` +
            ` and ${sumUsage.completion_tokens} for output` +
            ` (${sumUsage.completion_tokens_details?.reasoning_tokens} for thinking).`
    )
    console.log(
        `Time in total is ${Math.floor(performance.now() - startTime)}ms. ` +
            `For model ${config.model}, ` +
            `estimated cost is ${computeTokenCostCNY(sumUsage, config.model).toFixed(7)} yuan.`
    )

    chatfile.appendRoleLine('USER')
}
