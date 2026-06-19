import { readFile, appendFile } from 'fs/promises'
import { existsSync } from 'fs'
import * as path from 'path'

import type { Message } from './types/openaiApi'

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

type Block = {
    role: ChatRole
    components: (string | Directive)[]
}

function parseToBlock(chatText: string): Block[] {
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

export class ChatFile {
    chatFilePath: string
    private writeBuffer: string
    private writeTimer: ReturnType<typeof setTimeout> | null = null
    protected referredFile: Set<string> = new Set()

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

    async rewriteBlockToMessage(block: Block): Promise<Message> {
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
                if (!this.referredFile.has(filePath)) {
                    this.referredFile.add(filePath)
                    if (!existsSync(filePath)) {
                        console.error('External file open failed: ' + filePath)
                    } else {
                        try {
                            const text = await readFile(
                                path.join(
                                    path.dirname(this.chatFilePath),
                                    comp.arg
                                ),
                                'utf-8'
                            )

                            suffixContent += `===========\nFile (${comp.arg}):\n${text}\n`
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

        return {
            role: block.role.toLowerCase() as 'system' | 'user' | 'assistant',
            content:
                content.trimEnd() +
                (suffixContent.length > 0
                    ? '\n\n' + suffixContent.trimEnd()
                    : ''),
        }
    }

    async buildPrompt(): Promise<Message[]> {
        let chatText = await readFile(this.chatFilePath, 'utf-8')

        // 忽略 shebang 行
        if (chatText.startsWith('#!')) {
            chatText = chatText.replace(/^#![^\n]*\n?/, '')
        }

        const blocks = parseToBlock(chatText)

        const messages: Message[] = []

        for (const block of blocks) {
            if (
                block.role === 'SYSTEM' ||
                block.role === 'USER' ||
                block.role === 'ASSISTANT'
            ) {
                messages.push(await this.rewriteBlockToMessage(block))
            }
        }
        return messages
    }
}
