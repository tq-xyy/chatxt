import { readFile, appendFile, writeFile } from 'fs/promises'
import * as path from 'path'

import type {
    Message,
    ChatCompletionRequest,
    ChatCompletionChunk,
} from './llmapi'
import { computeTokenCostCNY } from './llmapi'
import { loadConfig } from './config'
import { existsSync } from 'fs'

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

    for (const line of chatText.split('\n')) {
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
        const chatText = await readFile(this.chatFilePath, 'utf-8')

        const blocks = parseToBlock(chatText)

        const messages: Message[] = []

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
                        suffixContent +=
                            `File (${comp.arg}):\n` +
                            (await readFile(
                                path.join(
                                    path.dirname(this.chatFilePath),
                                    comp.arg
                                ),
                                'utf-8'
                            )) +
                            '\n'
                        content += `@${comp.type}(${comp.arg})`
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

const defaultSystemPrompt = `你是一个有帮助的 AI 助手，用中文回应用户。

重要：本对话环境为纯文本，完全不支持 Markdown 渲染。你必须遵守以下格式约定：
- 禁止使用任何 Markdown 格式符号，尤其是 ** 加粗、* 斜体、# 标题、表格等。
- 用短横线 "-" 或数字 "1." 组织列表，列表项之间无需额外空行。
- 用冒号引出说明、定义或举例，如：“注意：这里要小心”。
- 用空行分隔不同段落或逻辑块，保持版面清晰。
- 需要展示代码时，使用三个反引号包裹，并在开头标记语言，例如：\`\`\`python。
- 避免使用连续的特殊符号作为装饰线，除非用于分隔。

在内容组织上：
- 先给出直接、简明的答案或结论，再按需补充细节或推理过程。
- 如果有多个要点，优先使用列表形式。
- 对复杂问题，可以用小标题式的短文（例如：“原因：”、“解决方法：”）来引导，但不要使用 # 或 ## 符号，直接书写文字即可。
- 保持语气自然、专业、有帮助，但不必寒暄。

你的目标是让用户在纯文本终端或编辑器中，也能轻松阅读和理解你的每一个回复。
`

async function chatfile(
    chatFilePath: string,
    showThinking: boolean = false
): Promise<void> {
    const config = loadConfig()

    if (!existsSync(chatFilePath)) {
        console.warn(
            `${chatFilePath} don't exist. Automatically create a none file.`
        )
        const content = [
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

    const resp = await fetch(`${config.endpoint}/v1/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
            model: config.model,
            messages,
            stream: true,
            stream_options: { include_usage: true },
        } as ChatCompletionRequest),
    })

    if (!resp.ok) {
        const errorText = await resp.text()
        console.error(`HTTP ${resp.status}: ${errorText}`)
        return
    }

    const reader = resp.body?.getReader()

    if (!reader) {
        console.error(`HTTP stream reader unavailable.`)
        return
    }

    const decoder = new TextDecoder()
    let buffer = '' // 缓冲区，处理跨 chunk 的行

    let reasoningStartFlag = false
    let answerStartFlag = false

    let reporter: ProgressReporter | null = null

    while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        // 保留最后一个不完整的行
        buffer = lines.pop() || ''

        for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed || !trimmed.startsWith('data:')) continue

            const data = trimmed.slice(5).trim()
            if (data === '[DONE]') break // 流结束标记

            try {
                const chunk: ChatCompletionChunk = JSON.parse(data)
                // 处理 delta
                for (const choice of chunk.choices) {
                    if (
                        choice.delta?.reasoning_content &&
                        !reasoningStartFlag
                    ) {
                        if (showThinking) {
                            chatfile.appendRoleLine('THINKING')
                        }
                        reporter = new ProgressReporter('Thinking...')
                        reasoningStartFlag = true
                    }
                    if (choice.delta?.reasoning_content) {
                        if (showThinking) {
                            chatfile.appendContent(
                                choice.delta.reasoning_content
                            )
                        }
                        reporter?.update(1)
                    }

                    if (choice.delta?.content && !answerStartFlag) {
                        chatfile.appendRoleLine('ASSISTANT')
                        answerStartFlag = true
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
            } catch (e) {
                console.error('Parse chunk failed:', data, e)
            }
        }
    }

    chatfile.appendRoleLine('USER')
}

await chatfile(process.argv[2])
