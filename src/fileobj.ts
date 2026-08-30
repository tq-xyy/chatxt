import { readFile, appendFile } from 'fs/promises'
import { isFile, isPlainUTF8Text } from './utils/file-utils'
import * as path from 'path'

import type {
    AssistantMessage,
    Message,
    FunctionCallDelta,
    FunctionCallMessage,
    FunctionCallResultMessage,
    SystemMessage,
    UserMessage,
} from './types/chat-file'
import type { Config } from './config'
import { printWarningMessage } from './tui'

export type ChatRole =
    | 'UNKNOWN'
    | 'SYSTEM'
    | 'USER'
    | 'ASSISTANT'
    | 'THINKING'
    | 'TOOL'
    // | 'PIPE'
    | 'TOOLRESPONSE'

const VALID_ROLES: ChatRole[] = [
    'UNKNOWN',
    'SYSTEM',
    'USER',
    'ASSISTANT',
    'THINKING',
    'TOOL',
    // 'PIPE',
    'TOOLRESPONSE',
]

type DirectiveType = 'file' | 'tool' | 'include' // | 'pipe'

const VALID_DIRECTIVES: DirectiveType[] = [
    'file',
    'tool',
    'include',
    //'pipe',
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

type ParsedBlock = {
    role: ChatRole
    components: (string | Directive)[]
}

function parseToBlock(chatText: string): ParsedBlock[] {
    const blocks: { role: ChatRole; components: (string | Directive)[] }[] = [
        { role: 'UNKNOWN', components: [] },
    ]

    // ignore shebang line
    if (chatText.startsWith('#!')) {
        chatText = chatText.replace(/^#![^\n]*\n?/, '')
    }

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
                    !VALID_DIRECTIVES.includes(match[1] as DirectiveType) &&
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
    config: Config
    private writeBuffer: string
    private writeTimer: ReturnType<typeof setTimeout> | null = null
    protected referredFiles: Set<string> = new Set()

    constructor(chatFilePath: string, config: Config) {
        this.chatFilePath = chatFilePath
        this.config = config
        this.writeBuffer = ''
    }

    async flushBuffer() {
        if (this.config.emitToConsole) return
        if (this.writeBuffer.length === 0) return
        if ((this.config.emitInterval || 16) <= 0) return
        if (this.writeTimer) {
            clearTimeout(this.writeTimer)
        }
        await appendFile(this.chatFilePath, this.writeBuffer, 'utf-8')
    }

    public async appendContent(content: string) {
        if (this.config.emitToConsole) {
            process.stdout.write(content)
            return
        }

        if ((this.config.emitInterval || 16) <= 0) {
            await appendFile(this.chatFilePath, content, 'utf-8')
        } else {
            this.writeBuffer += content

            if (this.writeTimer) return

            this.writeTimer = setTimeout(async () => {
                const buffer = this.writeBuffer
                this.writeBuffer = '' // prevent async bug
                await appendFile(this.chatFilePath, buffer, 'utf-8')
                this.writeTimer = null
            }, this.config.emitInterval || 16)
        }
    }

    public async appendRoleLine(
        role: ChatRole,
        options?: { withPrefixNewLine?: boolean; withSuffixNewLine?: boolean }
    ) {
        options = options || {}

        let text = `\n----- CHAT ROLE: ${role} -----`
        if (options.withPrefixNewLine) {
            text = '\n' + text
        }
        if (options.withSuffixNewLine) {
            text += '\n'
        }

        await this.appendContent(text)
    }

    private convertPlainBlockToMessage(block: ParsedBlock): AssistantMessage {
        let content = ''

        for (const comp of block.components) {
            // dont parse directives from non-user block
            content +=
                typeof comp === 'string' ? comp : `@${comp.type}(${comp.arg})`
        }

        return {
            role: 'assistant',
            content: content.trimEnd(),
        }
    }

    private async applyDirectiveToMessage(
        block: ParsedBlock,
        parentInclude?: string[]
    ): Promise<[SystemMessage | UserMessage, Set<string>]> {
        let content = ''
        let suffixContent = ''
        let toolSet = new Set<string>()

        for (const comp of block.components) {
            const rootDir = parentInclude
                ? path.dirname(parentInclude.at(-1)!)
                : path.dirname(this.chatFilePath)

            if (typeof comp === 'string') {
                content += comp
                continue
            }

            const filePath = path.join(rootDir, comp.arg)
            const filePathRel = path.relative(process.cwd(), filePath)
            const filePathAbs = path.resolve(filePath)

            const argIsFile = await isFile(filePath)

            if (comp.type === 'tool') {
                if (!argIsFile) {
                    printWarningMessage(
                        `Tool Script (${filePathRel}) is not found or a file`
                    )
                    continue
                }
                toolSet.add(filePath)
            } else if (comp.type === 'file') {
                if (!argIsFile) {
                    printWarningMessage(
                        `External file (${filePathRel}) is not found or a file`
                    )
                    continue
                }

                if (!this.referredFiles.has(filePathAbs)) {
                    if (!(await isPlainUTF8Text(filePath))) {
                        printWarningMessage(
                            `External file must be plain text encoded by UTF-8:` +
                                ` ${filePathRel}`
                        )
                    }
                    try {
                        const text = await readFile(filePath, 'utf-8')

                        suffixContent += `====== QUOTE BEGIN =====\n`
                        suffixContent += `File (${comp.arg}):\n${text}\n`
                        suffixContent += `====== QUOTE END =====\n`
                        this.referredFiles.add(filePathAbs)
                    } catch (err) {
                        printWarningMessage(
                            `External file open failed: ${filePathRel} (${(err as Error).toString()})`
                        )
                    }
                }

                content += `${comp.arg}`
            } else if (comp.type === 'include') {
                if (!argIsFile) {
                    printWarningMessage(
                        `Include file (${filePathRel}) is not found`
                    )
                    continue
                }

                try {
                    const text = await readFile(filePath, 'utf-8')

                    const blocks = parseToBlock(text)

                    if (blocks.length >= 2 || blocks[0].role !== 'UNKNOWN') {
                        printWarningMessage(
                            `Include file (${filePathRel}) should not include role line`
                        )
                        continue
                    }

                    if ((parentInclude || []).includes(filePathAbs)) {
                        printWarningMessage(
                            `Include file (${filePathRel}) should not include itself`
                        )
                        continue
                    }

                    const [includeMessages, includeToolSet] =
                        await this.applyDirectiveToMessage(
                            blocks[0] || { role: 'UNKNOWN', components: [] },
                            [...(parentInclude || []), path.resolve(filePath)]
                        )

                    content += `${includeMessages.content}\n`
                    toolSet = toolSet.union(includeToolSet)
                } catch (err) {
                    printWarningMessage(
                        `Include file open failed: ${filePathRel} (${(err as Error).toString()})`
                    )
                }
            } else {
                content += `@${comp.type}(${comp.arg})`
            }
        }

        return [
            {
                role: block.role === 'SYSTEM' ? 'system' : 'user',
                content:
                    content.trimEnd() +
                    (suffixContent.length > 0
                        ? '\n\n' + suffixContent.trimEnd()
                        : ''),
            },
            toolSet,
        ]
    }

    private parseToolCallBlock(block: ParsedBlock): FunctionCallMessage[] {
        const toolRegex = /^([\w.]+)\s*\(([^)]+)\):\s*(.*)$/

        const calls: FunctionCallMessage[] = []

        for (const line of block.components.join('').split('\n')) {
            const match = line.match(toolRegex)
            if (match) {
                const [, name, id, callString] = match
                calls.push({
                    role: 'tool-call',
                    callId: id,
                    name,
                    arguments: callString,
                })
            }
        }
        return calls
    }

    public appendToolCallChunkToToolBlock(delta: FunctionCallDelta) {
        if (delta.type === 'callee') {
            this.appendContent(
                `\n${delta.callee} (${delta.callId}): ${delta.arguments || ''}`
            )
        }
        if (delta.type === 'arguments') {
            this.appendContent(delta.delta)
        }
    }

    private parseToolResponseBlock(
        block: ParsedBlock
    ): FunctionCallResultMessage[] {
        const toolMessages: FunctionCallResultMessage[] = []

        for (const line of block.components.join('').split('\n')) {
            const [toolId, jsonStr] = line.split(/:(.+)/)
            if (toolId.length === 0 || !jsonStr) continue
            toolMessages.push({
                role: 'tool-result',
                callId: toolId,
                content: jsonStr,
            })
        }
        return toolMessages
    }

    public appendToolMessagesToToolResponseBlock(
        msgs: FunctionCallResultMessage[]
    ) {
        this.appendRoleLine('TOOLRESPONSE', {
            withPrefixNewLine: true,
            withSuffixNewLine: true,
        })
        this.appendContent(
            msgs.map(msg => `${msg.callId}: ${msg.content}`).join('\n')
        )
    }

    async buildPrompt(): Promise<{
        messages: Message[]
        toolPaths: string[]
    }> {
        const chatText = await readFile(this.chatFilePath, 'utf-8')

        const blocks = parseToBlock(chatText)

        const messages: Message[] = []
        const toolPaths = new Set<string>()

        this.referredFiles = new Set()

        for (const block of blocks) {
            if (block.role === 'SYSTEM' || block.role === 'USER') {
                const [msg, toolSet] =
                    await this.applyDirectiveToMessage(block)
                for (const toolPath of toolSet) {
                    toolPaths.add(toolPath)
                }

                if (msg.role === 'system') {
                    if (messages.some(m => m.role === 'system')) {
                        printWarningMessage(
                            'A chat file must only have one SYSTEM block'
                        )
                    } else {
                        messages.unshift(msg)
                    }
                } else {
                    messages.push(msg)
                }
            }
            if (block.role === 'THINKING') {
                const lastMessage = messages.at(-1)
                const reasoningContent =
                    this.convertPlainBlockToMessage(block).content
                if (lastMessage && lastMessage.role === 'assistant') {
                    lastMessage.reasoning_content = reasoningContent
                } else {
                    messages.push({
                        role: 'assistant',
                        reasoning_content: reasoningContent,
                        content: null,
                    })
                }
            }
            // put assistant output to the thinking block before
            if (block.role === 'ASSISTANT') {
                const lastMessage = messages.at(-1)
                const content = this.convertPlainBlockToMessage(block).content
                if (
                    lastMessage &&
                    lastMessage.role === 'assistant' &&
                    lastMessage.content === null
                ) {
                    lastMessage.content = content
                } else {
                    messages.push({
                        role: 'assistant',
                        content,
                    })
                }
            }
            if (block.role === 'TOOL' && !this.config.excludeHistoryToolCall) {
                messages.push(...this.parseToolCallBlock(block))
            }
            if (
                block.role === 'TOOLRESPONSE' &&
                !this.config.excludeHistoryToolCall
            ) {
                messages.push(...this.parseToolResponseBlock(block))
            }
        }

        return { messages, toolPaths: [...toolPaths] }
    }
}
