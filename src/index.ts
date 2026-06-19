import { existsSync } from 'fs'
import { readFile, appendFile, writeFile } from 'fs/promises'
import * as path from 'path'

import type { Message, ChatCompletionChunk } from './llmapi'
import { computeTokenCostCNY } from './llmapi'
import { loadConfig } from './config'
import { parseSSEStream } from './utils/sseStream'
import { defaultSystemPrompt } from './utils/prompt'
import { chatCompletion } from './utils/api'

type ChatRole =
    | 'UNKNOWN'
    | 'SYSTEM'
    | 'USER'
    | 'ASSISTANT'
    | 'THINKING'
    | 'TOOL'
    | 'PIPE'

const VALID_ROLES: ChatRole[] = [
    'UNKNOWN',
    'SYSTEM',
    'USER',
    'ASSISTANT',
    'THINKING',
    'TOOL',
    'PIPE',
]

type DirectiveType = 'file' //| 'pipe' | 'tool' | 'include'

const VALID_DIRECTIVES: DirectiveType[] = [
    'file', //'pipe', 'tool', 'include'
]

interface Directive {
    type: DirectiveType
    arg: string
}

const ROLE_SEPARATOR_REGEX = new RegExp(
    `^----- CHAT ROLE: (${VALID_ROLES.join('|')}) -----$`
)

const DIRECTIVE_SEPARATOR_REGEX = new RegExp(
    `(@(?:${VALID_DIRECTIVES.join('|')})?\\([\\w\\W]+\\))`,
    'g'
)

const DIRECTIVE_MATCH_REGEX = new RegExp(
    `^@(${VALID_DIRECTIVES.join('|')})?\\(([\\w\\W]+)\\)$`,
    'g'
)

function parseToBlock(chatText: string) {
    const blocks: { role: ChatRole; components: (string | Directive)[] }[] = [
        { role: 'UNKNOWN', components: [] },
    ]

    for (let line of chatText.split('\n')) {
        line = line.endsWith('\r') ? line.slice(0, -1) : line
        if (ROLE_SEPARATOR_REGEX.test(line)) {
            blocks.push({
                role: ROLE_SEPARATOR_REGEX.exec(line)![1] as ChatRole,
                components: [],
            })
            continue
        }

        const components: (string | Directive)[] = line
            .split(DIRECTIVE_SEPARATOR_REGEX)
            .map(component => {
                const match = DIRECTIVE_MATCH_REGEX.exec(component)
                if (!match) {
                    return component
                }
                if (
                    VALID_DIRECTIVES.includes(match[1] as any) &&
                    match[1] !== ''
                ) {
                    return component
                }
                let arg = match[2]
                if (arg.startsWith('"') && arg.endsWith('"')) {
                    arg = arg.slice(1, -1)
                } else if (arg.startsWith("'") && arg.endsWith("'")) {
                    arg = arg.slice(1, -1)
                }

                return { type: match[1] || 'file', arg } as Directive
            })

        if (typeof components.at(-1) === 'string') {
            components[components.length - 1] += '\n'
        } else {
            components.push('\n')
        }

        blocks.at(-1)!.components.push(...components)
    }
    return blocks
}

class ChatFile {
    chatFilePath: string
    private writeBuffer: string
    private writeTimer: ReturnType<typeof setTimeout> | null = null

    constructor(chatFilePath: string) {
        this.chatFilePath = chatFilePath
        this.writeBuffer = ''
    }

    private debounceWrite() {
        if (this.writeTimer) return
        this.writeTimer = setTimeout(async () => {
            const buffer = this.writeBuffer
            this.writeBuffer = ''
            await appendFile(this.chatFilePath, buffer, 'utf-8')
            this.writeTimer = null
        }, 16)
    }

    async appendRoleLine(role: ChatRole) {
        this.writeBuffer += `\n\n----- CHAT ROLE: ${role} -----\n`
        this.debounceWrite()
    }

    async appendContent(content: string) {
        this.writeBuffer += content
        this.debounceWrite()
    }

    async buildPrompt(): Promise<Message[]> {
        let chatText = await readFile(this.chatFilePath, 'utf-8')

        // 忽略 shebang 行
        if (chatText.startsWith('#!')) {
            chatText = chatText.replace(/^#![^\n]*\n?/, '')
        }

        const blocks = parseToBlock(chatText)

        const messages: Message[] = []

        const referredFile: Set<string> = new Set()

        for (const block of blocks) {
            if (
                block.role === 'SYSTEM' ||
                block.role === 'USER' ||
                block.role === 'ASSISTANT'
            ) {
                let content = ''
                let suffixContent = ''

                for (const comp of block.components) {
                    if (typeof comp === 'string') {
                        content += comp
                    } else if (comp.type === 'file') {
                        const filePath = path.join(
                            path.dirname(this.chatFilePath),
                            comp.arg
                        )
                        if (!referredFile.has(filePath)) {
                            referredFile.add(filePath)
                            if (!existsSync(filePath)) {
                                console.error(
                                    'External file open failed: ' + filePath
                                )
                            } else {
                                try {
                                    const text = await readFile(
                                        path.join(
                                            path.dirname(this.chatFilePath),
                                            comp.arg
                                        ),
                                        'utf-8'
                                    )

                                    suffixContent += `File (${comp.arg}):\n${text}\n`
                                } catch (err) {
                                    console.error(
                                        `External file open failed: ${filePath} (${(err as Error).toString()})`
                                    )
                                }
                            }
                        }

                        content += `${comp.arg}`
                    } else {
                        content += `@${comp.type}(${comp.arg})`
                    }
                }

                messages.push({
                    role: block.role.toLowerCase() as
                        | 'system'
                        | 'user'
                        | 'assistant',
                    content:
                        content.trimEnd() +
                        (suffixContent.length > 0
                            ? '\n\n' + suffixContent.trimEnd()
                            : ''),
                })
            }
        }
        return messages
    }
}

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
    showThinking: boolean = false
): Promise<void> {
    const config = await loadConfig()

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

    const resp = await chatCompletion(messages, config)

    let reasoningStartFlag = false
    let answerStartFlag = false

    let reporter: ProgressReporter | null = null

    for await (const chunk of parseSSEStream<ChatCompletionChunk>(resp)) {
        // 处理 delta
        for (const choice of chunk.choices) {
            if (choice.delta?.reasoning_content && !reasoningStartFlag) {
                if (showThinking) {
                    chatfile.appendRoleLine('THINKING')
                }
                reporter = new ProgressReporter('Thinking...')
                reasoningStartFlag = true
                answerStartFlag = false
            }
            if (choice.delta?.reasoning_content) {
                if (showThinking) {
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
