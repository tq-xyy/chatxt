import { readFile } from 'fs/promises'
import type { Message } from './llmapi'

import * as path from 'path'

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

type DirectiveType = 'file' | 'pipe' | 'tool' | 'include'

const VALID_DIRECTIVES: DirectiveType[] = ['file', 'pipe', 'tool', 'include']

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

export async function buildPromptFromChatFile(
    chatFilePath: string
): Promise<Message[]> {
    const chatText = await readFile(chatFilePath, 'utf-8')

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
                            path.join(path.dirname(chatFilePath), comp.arg),
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
                content: content.trimEnd() + '\n\n' + suffixContent.trimEnd(),
            })
        }
    }
    return messages
}

console.log(await buildPromptFromChatFile('./test.ignored.chat.md'))
