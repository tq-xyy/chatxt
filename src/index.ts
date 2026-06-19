import { existsSync } from 'fs'
import { writeFile } from 'fs/promises'

import type { ChatCompletionChunk } from './types/openaiApi'
import { computeTokenCostCNY } from './utils/computeCost'
import type { Config } from './config'
import { parseSSEStream } from './utils/sseStream'
import { defaultSystemPrompt } from './utils/prompt'
import { chatCompletionStream } from './utils/api'
import { ChatFile } from './fileobj'

class ProgressReporter {
    private displayed: number = 0
    prompt: string

    /**
     * @param showProgress 是否启用进度显示，默认为 true
     */
    constructor(prompt: string = 'Generating...') {
        this.displayed = 0
        this.prompt = prompt
        process.stdout.write(this.prompt + ' 0 tokens (Ctrl+C to cancel)')
    }

    /**
     * 更新进度，增加 token 数量并在满足条件时刷新显示
     * @param delta 本次新增的 token 数量
     */
    update(delta: number): void {
        this.displayed += delta
        process.stdout.clearLine?.(0)
        process.stdout.cursorTo?.(0)
        process.stdout.write(
            `${this.prompt} ${this.displayed} tokens (Ctrl+C to cancel)`
        )
    }

    /**
     * 完成进度，清空当前行并输出最终结果
     */
    finish(): void {
        process.stdout.clearLine?.(0)
        process.stdout.cursorTo?.(0)
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

    const messages = await chatfile.buildPrompt()

    if (
        messages.at(-1)?.role !== 'user' ||
        (messages.at(-1)?.content?.trimEnd().length || 0) < 1
    ) {
        console.warn('No user input.')
        return
    }

    const resp = await chatCompletionStream(messages, config)

    let reasoningStartFlag = false
    let answerStartFlag = false

    let reporter: ProgressReporter | null = null

    for await (const chunk of parseSSEStream<ChatCompletionChunk>(resp)) {
        // 处理 delta
        for (const choice of chunk.choices) {
            if (choice.delta?.reasoning_content && !reasoningStartFlag) {
                if (config.showThinking) {
                    chatfile.appendRoleLine('THINKING')
                }
                reporter = new ProgressReporter('Thinking...')
                reasoningStartFlag = true
                answerStartFlag = false
            }
            if (choice.delta?.reasoning_content) {
                if (config.showThinking) {
                    chatfile.appendContent(choice.delta.reasoning_content)
                }
                reporter?.update(1)
            }

            if (choice.delta?.content && !answerStartFlag) {
                chatfile.appendRoleLine('ASSISTANT')
                answerStartFlag = true
                reasoningStartFlag = false
                reporter?.finish()
                reporter = new ProgressReporter('Generating Answer...')
            }
            if (choice.delta?.content) {
                chatfile.appendContent(choice.delta.content)
                reporter?.update(1)
            }
        }

        if (chunk.usage) {
            reporter?.finish()
            console.log(
                `Used ${chunk.usage.total_tokens} tokens, ` +
                    `${chunk.usage.prompt_tokens} for input ` +
                    `(${chunk.usage.prompt_cache_hit_tokens} cached)` +
                    ` and ${chunk.usage.completion_tokens} for output` +
                    (chunk.usage.completion_tokens_details
                        ? ` (${chunk.usage.completion_tokens_details?.reasoning_tokens} for thinking).`
                        : '.')
            )
            console.log(
                `Estimated cost is ${computeTokenCostCNY(chunk.usage, config.model).toFixed(7)} yuan.`
            )
        }
    }

    chatfile.appendRoleLine('USER')
}
