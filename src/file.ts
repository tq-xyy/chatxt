import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs'
import { parseChatFile } from './parser'
import type { ChatBlock } from './parser'

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
