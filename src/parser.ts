import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs'

export type ChatRole =
    | 'SYSTEM'
    | 'USER'
    | 'ASSISTANT'
    | 'THINKING'
    | 'TOOL'
    | 'PIPE'

const VALID_ROLES: ChatRole[] = [
    'SYSTEM',
    'USER',
    'ASSISTANT',
    'THINKING',
    'TOOL',
    'PIPE',
]

const ROLE_SEPARATOR_REGEX =
    /^----- CHAT ROLE: (SYSTEM|USER|ASSISTANT|THINKING|TOOL|PIPE) -----$/

export interface ChatBlock {
    role: ChatRole
    content: string
}

/**
 * Parse .chat.md content into an array of ChatBlocks.
 * Returns null on invalid format.
 */
export function parseChatFile(content: string): ChatBlock[] | null {
    const lines = content.split('\n')
    const blocks: ChatBlock[] = []
    let currentRole: ChatRole | null = null
    let currentContent: string[] = []

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        const match = line.match(ROLE_SEPARATOR_REGEX)

        if (match) {
            // Save previous block
            if (currentRole !== null) {
                // Remove trailing newline from content
                let contentStr = currentContent.join('\n')
                // Remove trailing empty lines
                contentStr = contentStr.replace(/\n+$/, '')
                blocks.push({ role: currentRole, content: contentStr })
            }

            currentRole = match[1] as ChatRole
            currentContent = []

            // Validate role
            if (!VALID_ROLES.includes(currentRole)) {
                return null
            }
        } else {
            if (currentRole !== null) {
                currentContent.push(line)
            } else {
                // Content before first separator - invalid
                if (line.trim() !== '') {
                    return null
                }
            }
        }
    }

    // Save last block
    if (currentRole !== null) {
        let contentStr = currentContent.join('\n')
        contentStr = contentStr.replace(/\n+$/, '')
        blocks.push({ role: currentRole, content: contentStr })
    }

    return blocks
}

/**
 * Read and parse a .chat.md file.
 */
export function readChatFile(filePath: string): ChatBlock[] | null {
    if (!existsSync(filePath)) {
        return null
    }

    const content = readFileSync(filePath, 'utf-8')
    return parseChatFile(content)
}

/**
 * Create initial .chat.md file skeleton.
 */
export function createInitialChatFile(
    filePath: string,
    systemPrompt?: string
): void {
    const defaultSystem = 'You are a helpful AI assistant.'
    const content = [
        `----- CHAT ROLE: SYSTEM -----`,
        systemPrompt || defaultSystem,
        '',
        `----- CHAT ROLE: USER -----`,
        '',
    ].join('\n')

    writeFileSync(filePath, content)
}

/**
 * Convert blocks back to file content string.
 */
export function blocksToContent(blocks: ChatBlock[]): string {
    return blocks
        .map(block => {
            const content = block.content ? block.content : ''
            // Ensure content doesn't start with a separator line
            return `----- CHAT ROLE: ${block.role} -----\n${content}`
        })
        .join('\n\n')
}

/**
 * Append content to a specific block (identified by index) in the file.
 */
export function appendToBlock(
    filePath: string,
    blockIndex: number,
    appendContent: string
): void {
    const content = readFileSync(filePath, 'utf-8')
    const blocks = parseChatFile(content)
    if (!blocks || blockIndex >= blocks.length) {
        throw new Error('Invalid block index')
    }

    blocks[blockIndex].content += appendContent

    writeFileSync(filePath, blocksToContent(blocks) + '\n')
}

/**
 * Append new blocks to the end of the file (before the trailing empty user block if it exists).
 * Returns the new file content.
 */
export function appendBlocks(
    filePath: string,
    newBlocks: ChatBlock[],
    preserveTrailingUserBlock: boolean
): void {
    const content = readFileSync(filePath, 'utf-8')
    const blocks = parseChatFile(content)
    if (!blocks) {
        throw new Error('Failed to parse chat file')
    }

    // Find trailing empty USER block
    let lastUserIdx = -1
    if (preserveTrailingUserBlock && blocks.length > 0) {
        const lastBlock = blocks[blocks.length - 1]
        if (lastBlock.role === 'USER') {
            lastUserIdx = blocks.length - 1
        }
    }

    if (lastUserIdx >= 0) {
        // Insert new blocks before the trailing empty USER block
        const before = blocks.slice(0, lastUserIdx)
        const after = blocks.slice(lastUserIdx)
        const combined = [...before, ...newBlocks, ...after]
        writeFileSync(filePath, blocksToContent(combined) + '\n')
    } else {
        blocks.push(...newBlocks)
        writeFileSync(filePath, blocksToContent(blocks) + '\n')
    }
}

/**
 * Replace file content entirely.
 */
export function writeChatFile(filePath: string, blocks: ChatBlock[]): void {
    writeFileSync(filePath, blocksToContent(blocks) + '\n')
}

/**
 * Append text content directly to the end of a file (assumes last USER block exists).
 */
export function appendTextToFile(filePath: string, text: string): void {
    appendFileSync(filePath, text)
}

/**
 * Get the index of the last USER block.
 */
export function getLastUserBlockIndex(blocks: ChatBlock[]): number {
    for (let i = blocks.length - 1; i >= 0; i--) {
        if (blocks[i].role === 'USER') {
            return i
        }
    }
    return -1
}

/**
 * Estimate token count from text (simple char-based estimation).
 */
export function estimateTokens(text: string): number {
    // Rough estimation: ~4 chars per token for English, ~2 for CJK
    let tokenCount = 0
    for (const char of text) {
        const code = char.charCodeAt(0)
        if (code >= 0x4e00 && code <= 0x9fff) {
            // CJK character: ~2 chars per token
            tokenCount += 0.5
        } else {
            tokenCount += 0.25
        }
    }
    return Math.ceil(tokenCount)
}
