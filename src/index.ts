import { existsSync } from 'fs'
import { writeFile } from 'fs/promises'

import type { ChatCompletionChunk, ToolCall, Usage } from './types/openaiApi'
import { computeTokenCostCNY, mergeUsage } from './utils/computeCost'
import type { Config } from './config'
import { parseSSEStream } from './utils/sseStream'
import { defaultSystemPrompt } from './utils/prompt'
import { chatCompletionStream } from './utils/api'
import { ChatFile } from './fileobj'
import type { ChatRole } from './fileobj'
import { ToolRunner } from './tools/runner'
import { mergeToolCallChunks } from './tools/streamhelper'
import { ProgressReporter } from './utils/progress'

import chalk from 'chalk'

function printExceptionMessage(err: unknown): void {
    const error = err instanceof Error ? err : new Error(String(err))

    console.error(chalk.bold.red('× Exception Happens.'))
    console.error(
        chalk.bold.white(error.constructor.name) +
            chalk.white(': ') +
            chalk.white(error.message)
    )

    if (error.stack) {
        const frames = error.stack.split('\n').slice(1, 4)
        for (const frame of frames) {
            console.error(chalk.gray(`  ${frame.trim()}`))
        }
    }
}

function printFinalStatus(status: {
    usage: Usage
    startTime: number
    config: { model: string }
    toolCallCount: number
}): void {
    const { usage, startTime, config, toolCallCount } = status
    const elapsed = ((performance.now() - startTime) / 1000).toFixed(2)

    const fn = (n: number) => n.toLocaleString('en-US')

    // 第一行：生成完成提示
    console.log(chalk.green('✔ Generation completed.'))

    // 第二行：Token 总计与分类
    const cachedPart = usage.prompt_cache_hit_tokens
        ? ' (' +
          chalk.gray('cached ') +
          chalk.gray(fn(usage.prompt_cache_hit_tokens)) +
          ') '
        : ''
    const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens
    const thinkingPart = reasoningTokens
        ? ' (' +
          chalk.magenta('thinking ') +
          chalk.magenta(fn(reasoningTokens)) +
          ')'
        : ''
    console.log(
        chalk.white.bold('Total tokens: ') +
            chalk.yellow(fn(usage.total_tokens)) +
            chalk.italic(
                '  ·  input for ' +
                    chalk.blue(fn(usage.prompt_tokens)) +
                    cachedPart +
                    ', output for ' +
                    chalk.blue(fn(usage.completion_tokens)) +
                    thinkingPart
            )
    )

    // 第三行：时间、预估花费、工具调用次数（如果有）
    const cost = computeTokenCostCNY(usage, config.model)
    let thirdLine =
        chalk.white('Elapsed time: ') +
        chalk.green(`${elapsed}s`) +
        '  ·  ' +
        chalk.white('Estimated cost: ') +
        chalk.red(`¥${cost.toFixed(6)}`)
    if (toolCallCount > 0) {
        thirdLine +=
            '  ·  ' +
            chalk.white('Total tool calls: ') +
            chalk.cyan(toolCallCount.toString())
    }
    console.log(thirdLine)
}

export async function chatfile(
    chatFilePath: string,
    config: Config
): Promise<void> {
    const startTime = performance.now()

    const reporter: ProgressReporter = new ProgressReporter('Requesting...')

    try {
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

        if (
            messages.at(-1)?.role !== 'user' ||
            (messages.at(-1)?.content?.trimEnd().length || 0) < 1
        ) {
            console.warn('No user input.')
            return
        }

        await toolRunner.loadTools(toolPaths)

        let sumUsage: Usage = {
            completion_tokens: 0,
            prompt_tokens: 0,
            prompt_cache_hit_tokens: 0,
            prompt_cache_miss_tokens: 0,
            total_tokens: 0,
            completion_tokens_details: {
                reasoning_tokens: 0,
            },
        }
        let sumToolCall: number = 0
        const chatTurn = messages.filter(msg => msg.role === 'user').length

        reporter.update(0)

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

            for await (const chunk of parseSSEStream<ChatCompletionChunk>(
                resp
            )) {
                // 合并 usage
                if (chunk.usage) {
                    reporter.clear()
                    sumUsage = mergeUsage(sumUsage, chunk.usage)
                }

                const choice = chunk.choices[0]
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
                    reporter.setPrompt('Generating Function Call...')
                }
                if (choice.delta?.tool_calls) {
                    // 流式模式下一次迭代只输出一次工具调用
                    if (choice.delta.tool_calls[0].type === 'function') {
                        sumToolCall++
                        choice.delta.tool_calls[0].id = `${chatTurn}-${sumToolCall}`
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

                    mergeToolCallChunks(toolCalls, choice.delta.tool_calls)

                    reporter.update(1)
                }

                if (choice.finish_reason === 'tool_calls') {
                    // @ts-expect-error
                    messages[messages.length - 1].tool_calls = toolCalls

                    reporter.setPrompt('Call Function...')
                    reporter.update(0)

                    const intervalTimer = setInterval(
                        () => reporter.update(0),
                        1000
                    )

                    const msgs = await toolRunner.executeAll(toolCalls)

                    clearInterval(intervalTimer)

                    messages.push(...msgs)
                    chatfile.appendRoleLine('TOOLRESPONSE')
                    for (const msg of msgs) {
                        if (msg.role === 'tool') {
                            chatfile.appendContent(
                                `${msg.tool_call_id}: ${msg.content}\n`
                            )
                        }
                    }
                    outputFlag = 'UNKNOWN'
                } else if (choice.finish_reason !== null) {
                    switch (choice.finish_reason) {
                        case 'stop':
                        case 'length':
                            // do nothing
                            break
                        case 'content_filter':
                            console.warn(
                                'stop by content filter, ' +
                                    'dont ask for politics senstive or yellow content.'
                            )
                            break
                        case 'insufficient_system_resource':
                            console.warn(
                                'model provider system crush because of insufficient resource'
                            )
                            break
                        default:
                            console.error(
                                `unkonwn finish reason: ${choice.finish_reason}`
                            )
                    }
                    outputFlag = false
                }
            }
        }

        printFinalStatus({
            startTime,
            usage: sumUsage,
            toolCallCount: sumToolCall,
            config,
        })

        chatfile.appendRoleLine('USER')
        await chatfile.flushBuffer()
    } catch (err) {
        reporter.clear()
        printExceptionMessage(err)
    }
}
