#!/usr/bin/env node

import { program } from 'commander'
import { existsSync, readFileSync } from 'fs'
import { loadConfig, initConfig } from './config.js'
import {
    readChatFile,
    createInitialChatFile,
    appendBlocks,
    writeChatFile,
    getLastUserBlockIndex,
    estimateTokens,
    type ChatBlock,
} from './parser.js'
import {
    processDirectives,
    resetDirectiveCache,
    toolsToApiFormat,
    executeTool,
} from './directives.js'
import { callLLMStream } from './llm.js'
import type { Message, ToolCall } from './llmapi.js'

const pkg = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf-8')
)
const version = pkg.version

// ---------- Error formatting ----------

function formatError(err: unknown): string {
    if (err instanceof Error) return err.message
    return String(err)
}

// ---------- Token display ----------

let displayedTokens = 0
let showProgress = true

function startProgress(filePath: string): void {
    displayedTokens = 0
    if (showProgress) {
        process.stdout.write('Generating... 0 tokens (Ctrl+C to cancel)')
    }
}

function updateProgress(deltaTokens: number): void {
    displayedTokens += deltaTokens
    if (showProgress && displayedTokens % 5 < deltaTokens) {
        process.stdout.clearLine?.(0)
        process.stdout.cursorTo?.(0)
        process.stdout.write(
            `Generating... ${displayedTokens} tokens (Ctrl+C to cancel)`
        )
    }
}

function finishProgress(filePath: string): void {
    if (showProgress) {
        process.stdout.clearLine?.(0)
        process.stdout.cursorTo?.(0)
        console.log(
            `${displayedTokens} tokens generated. Saved to ${filePath}`
        )
    }
}

function countTokens(text: string): number {
    // Simple word-based token estimation (~4 chars per token)
    // More accurate for English, but functional
    return Math.ceil(text.length / 4)
}

// ---------- Complete command ----------

function ensureFileExists(filePath: string): void {
    if (!existsSync(filePath)) {
        createInitialChatFile(filePath)
        if (showProgress) {
            console.log(`Created new chat file: ${filePath}`)
        }
    }
}

async function cmdComplete(
    filePath: string,
    options: { quiet?: boolean }
): Promise<void> {
    showProgress = !options.quiet

    // Load config
    const config = loadConfig()
    if (!config.apiKey) {
        console.error(
            'Error: No API key found. Set OPENAI_API_KEY or CHATFILE_API_KEY environment variable, or configure in .chatfilerc/config.json'
        )
        process.exit(1)
    }

    // Ensure file exists
    ensureFileExists(filePath)

    // Read and parse file
    const blocks = readChatFile(filePath)
    if (!blocks) {
        console.error('Error: Failed to parse .chat.md file. Invalid format.')
        process.exit(1)
    }

    // Find last USER block
    const lastUserIdx = getLastUserBlockIndex(blocks)
    if (lastUserIdx === -1) {
        console.error('Error: No USER block found in file.')
        process.exit(1)
    }

    const lastUserBlock = blocks[lastUserIdx]

    // Check if USER block is empty (no new input)
    if (!lastUserBlock.content || lastUserBlock.content.trim() === '') {
        console.error(
            'Error: Last USER block is empty. Please add your input.'
        )
        process.exit(1)
    }

    // Reset directive cache
    resetDirectiveCache()

    // Process directives in the USER message
    const { processedText, result } = processDirectives(
        lastUserBlock.content,
        !!options.quiet
    )

    // If there are pipe outputs, append PIPE blocks to file
    if (result.pipeOutputs.length > 0) {
        const pipeBlocks: ChatBlock[] = result.pipeOutputs.map(p => ({
            role: 'PIPE' as const,
            content: p.output,
        }))
        // Insert PIPE blocks before the last USER block
        const beforeBlocks = blocks.slice(0, lastUserIdx)
        const afterBlocks = blocks.slice(lastUserIdx)
        const newBlocks = [...beforeBlocks, ...pipeBlocks, ...afterBlocks]
        writeChatFile(filePath, newBlocks)

        // Re-read blocks since file was modified
        const updatedBlocks = readChatFile(filePath)
        if (updatedBlocks) {
            // Replace blocks with updated version
            blocks.splice(0, blocks.length, ...updatedBlocks)
        }
    }

    // Assemble messages for API
    const messages: Message[] = []
    const toolDefs = toolsToApiFormat(result.toolDefs)

    for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i]

        if (block.role === 'SYSTEM') {
            messages.push({ role: 'system', content: block.content })
        } else if (block.role === 'USER') {
            if (i === lastUserIdx) {
                // Current user message with directives processed
                let finalContent = processedText
                // Append file/pipe injections
                const injections = result.fileInjections
                if (injections.length > 0) {
                    finalContent += '\n\n---\n' + injections.join('\n\n')
                }
                messages.push({ role: 'user', content: finalContent })
            } else {
                messages.push({ role: 'user', content: block.content })
            }
        } else if (block.role === 'ASSISTANT') {
            messages.push({ role: 'assistant', content: block.content })
        } else if (block.role === 'THINKING') {
            // Skip thinking blocks for history (they're part of the assistant's reasoning)
            continue
        } else if (block.role === 'TOOL') {
            // Parse tool result to add as tool message
            // Format: Tool Name: name\nArguments: {...}\nResult: {...}
            const toolContent = block.content
            messages.push({
                role: 'tool',
                content: toolContent,
                tool_call_id: `tool_${i}`,
            })
        } else if (block.role === 'PIPE') {
            // Pipe blocks are informational, not sent as messages
            continue
        }
    }

    // Start streaming
    startProgress(filePath)

    let abortController = new AbortController()
    let currentToolCalls: ToolCall[] = []
    let assistantContent = ''
    let reasoningContent = ''
    let toolCallCount = 0
    const MAX_TOOL_ITERATIONS = 5

    // Buffer for assistant response
    let responseBuffer = ''
    let reasoningBuffer = ''

    try {
        while (toolCallCount <= MAX_TOOL_ITERATIONS) {
            const streamResult = await callLLMStream(
                config,
                messages,
                toolDefs.length > 0 ? toolDefs : null,
                chunk => {
                    if (chunk.content) {
                        responseBuffer += chunk.content
                        updateProgress(countTokens(chunk.content))
                    }
                    if (chunk.reasoningContent) {
                        reasoningBuffer += chunk.reasoningContent
                    }
                },
                abortController.signal
            )

            assistantContent = streamResult.content
            reasoningContent = streamResult.reasoningContent
            currentToolCalls = streamResult.toolCalls

            // Write ASSISTANT block
            const assistantBlock: ChatBlock = {
                role: 'ASSISTANT',
                content: assistantContent,
            }

            // Write THINKING block if exists
            const newBlocks: ChatBlock[] = []
            if (reasoningContent) {
                newBlocks.push({
                    role: 'THINKING',
                    content: reasoningContent,
                })
            }
            newBlocks.push(assistantBlock)

            // Handle tool calls
            if (currentToolCalls && currentToolCalls.length > 0) {
                for (const tc of currentToolCalls) {
                    // Find the tool definition
                    const toolData = result.toolDefs.find(
                        t => t.name === tc.function.name
                    )
                    if (!toolData) {
                        console.error(
                            `[Warning] Unknown tool call: ${tc.function.name}`
                        )
                        continue
                    }

                    // Execute the tool
                    if (showProgress) {
                        console.log(
                            `\n[Tool] Executing ${tc.function.name}...`
                        )
                    }

                    const toolResult = executeTool(
                        toolData.filePath,
                        tc.function.arguments
                    )

                    const toolBlock: ChatBlock = {
                        role: 'TOOL',
                        content: `Tool Name: ${tc.function.name}\nArguments: ${tc.function.arguments}\n---\nResult:\n${toolResult}`,
                    }
                    newBlocks.push(toolBlock)

                    // Add tool call and result to messages for next iteration
                    messages.push({
                        role: 'assistant',
                        content: null,
                        tool_calls: [tc],
                    } as any)
                    messages.push({
                        role: 'tool',
                        content: toolResult,
                        tool_call_id: tc.id,
                    })
                }

                toolCallCount++
                responseBuffer = ''
                reasoningBuffer = ''
                continue
            }

            // No more tool calls, write blocks to file
            appendBlocks(filePath, newBlocks, false)

            // Append empty USER block
            appendBlocks(filePath, [{ role: 'USER', content: '' }], false)

            // Re-add tool declarations in USER block (permissions continuation)
            if (result.toolDefs.length > 0) {
                // Read current file
                const currentBlocks = readChatFile(filePath)
                if (currentBlocks) {
                    const lastUser = getLastUserBlockIndex(currentBlocks)
                    if (lastUser >= 0) {
                        currentBlocks[lastUser].content =
                            result.toolDefs
                                .map(t => `@tool(${t.filePath})`)
                                .join('\n') + '\n'
                        writeChatFile(filePath, currentBlocks)
                    }
                }
            }

            finishProgress(filePath)
            return
        }

        // Exceeded max tool iterations
        const errorBlock: ChatBlock = {
            role: 'ASSISTANT',
            content: `[Error] Maximum tool call iterations (${MAX_TOOL_ITERATIONS}) exceeded. The conversation has been terminated.`,
        }
        appendBlocks(filePath, [errorBlock], false)
        appendBlocks(filePath, [{ role: 'USER', content: '' }], false)
        console.error(
            `\n[Error] Exceeded maximum tool call iterations (${MAX_TOOL_ITERATIONS}).`
        )
    } catch (err: any) {
        if (err.name === 'AbortError') {
            // Write what we have so far
            if (responseBuffer || reasoningBuffer) {
                const partialBlocks: ChatBlock[] = []
                if (reasoningBuffer) {
                    partialBlocks.push({
                        role: 'THINKING',
                        content: reasoningBuffer,
                    })
                }
                partialBlocks.push({
                    role: 'ASSISTANT',
                    content:
                        responseBuffer + '\n[Generation cancelled by user]',
                })
                appendBlocks(filePath, partialBlocks, false)
                appendBlocks(filePath, [{ role: 'USER', content: '' }], false)
                process.stdout.write('\n')
                console.log('Generation cancelled.')
            }
            process.exit(130)
        }

        console.error(`\n[Error] ${formatError(err)}`)
        process.exit(1)
    }
}

// ---------- Compact command ----------

async function cmdCompact(
    filePath: string,
    options: { quiet?: boolean }
): Promise<void> {
    showProgress = !options.quiet

    if (!existsSync(filePath)) {
        console.error(`Error: File not found: ${filePath}`)
        process.exit(1)
    }

    const config = loadConfig()
    if (!config.apiKey) {
        console.error('Error: No API key found.')
        process.exit(1)
    }

    const blocks = readChatFile(filePath)
    if (!blocks) {
        console.error('Error: Failed to parse .chat.md file.')
        process.exit(1)
    }

    if (blocks.length <= 1) {
        console.error('Error: Not enough content to compact.')
        process.exit(1)
    }

    // Build conversation history for summary
    const conversationText = blocks
        .filter(b => b.role !== 'SYSTEM')
        .map(b => `[${b.role}]\n${b.content}`)
        .join('\n\n')

    // Call API to generate summary
    const summaryMessages: Message[] = [
        {
            role: 'system',
            content:
                'You are a summarization assistant. Summarize the following conversation concisely while preserving key information, decisions, and conclusions. Output only the summary in markdown format, no extra commentary.',
        },
        {
            role: 'user',
            content: `Please summarize this conversation:\n\n${conversationText}`,
        },
    ]

    if (showProgress) {
        console.log('Generating summary...')
    }

    let summaryContent = ''

    try {
        const streamResult = await callLLMStream(
            config,
            summaryMessages,
            null,
            chunk => {
                if (chunk.content) {
                    summaryContent += chunk.content
                    if (showProgress) {
                        process.stdout.write(chunk.content)
                    }
                }
            }
        )
    } catch (err) {
        console.error(
            `\n[Error] Failed to generate summary: ${formatError(err)}`
        )
        process.exit(1)
    }

    if (showProgress) {
        console.log('\n\nCompacting file...')
    }

    // Backup original file
    const backupPath = filePath.replace(/\.chat\.md$/, '.original.chat.md')
    try {
        const originalContent = readFileSync(filePath, 'utf-8')
        const { writeFileSync } = await import('node:fs')
        writeFileSync(backupPath, originalContent)
        if (showProgress) {
            console.log(`Backup saved to ${backupPath}`)
        }
    } catch (err) {
        console.error(`[Warning] Failed to create backup: ${formatError(err)}`)
    }

    // Build compacted file
    const newBlocks: ChatBlock[] = []

    if (blocks[0]?.role === 'SYSTEM') {
        // Keep the original SYSTEM block, replace everything after
        newBlocks.push(blocks[0])
    } else {
        // Create a new SYSTEM block with summary
        newBlocks.push({
            role: 'SYSTEM',
            content: `Conversation Summary:\n\n${summaryContent}`,
        })
    }

    // Add the summary as context
    newBlocks.push({
        role: 'USER',
        content: `Previous conversation summary:\n\n${summaryContent}\n\n(Conversation has been compressed. Continue from here.)`,
    })

    writeChatFile(filePath, newBlocks)

    // Append empty USER block
    appendBlocks(filePath, [{ role: 'USER', content: '' }], false)

    if (showProgress) {
        console.log(`File compacted: ${filePath}`)
    }
}

// ---------- Info command ----------

function cmdInfo(filePath: string, options: { quiet?: boolean }): void {
    showProgress = !options.quiet

    if (!existsSync(filePath)) {
        console.error(`Error: File not found: ${filePath}`)
        process.exit(1)
    }

    const blocks = readChatFile(filePath)
    if (!blocks) {
        console.error('Error: Failed to parse .chat.md file.')
        process.exit(1)
    }

    const config = loadConfig()

    const userCount = blocks.filter(b => b.role === 'USER').length
    const assistantCount = blocks.filter(b => b.role === 'ASSISTANT').length
    const toolCount = blocks.filter(b => b.role === 'TOOL').length
    const pipeCount = blocks.filter(b => b.role === 'PIPE').length
    const thinkingCount = blocks.filter(b => b.role === 'THINKING').length

    // Estimate token count from all content
    let totalChars = 0
    for (const block of blocks) {
        totalChars += block.content.length
    }

    const estimatedTokens = estimateTokens(
        blocks.map(b => b.content).join('\n')
    )

    // Round count (interactions)
    const rounds = Math.max(userCount, assistantCount)

    if (showProgress) {
        console.log(`File: ${filePath}`)
        console.log(`Model: ${config.model}`)
        console.log(`Conversation rounds: ${rounds}`)
        console.log(`Blocks: ${blocks.length} total`)
        console.log(
            `  SYSTEM:   ${blocks.filter(b => b.role === 'SYSTEM').length}`
        )
        console.log(`  USER:     ${userCount}`)
        console.log(`  ASSISTANT: ${assistantCount}`)
        console.log(`  THINKING: ${thinkingCount}`)
        console.log(`  TOOL:     ${toolCount}`)
        console.log(`  PIPE:     ${pipeCount}`)
        console.log(`Estimated token count: ${estimatedTokens}`)
        console.log(
            `File size: ${(readFileSync(filePath).length / 1024).toFixed(1)} KB`
        )
    }
}

// ---------- Init command ----------

function cmdInit(filePath: string, options: { quiet?: boolean }): void {
    showProgress = !options.quiet

    if (existsSync(filePath)) {
        console.error(`Error: File already exists: ${filePath}`)
        process.exit(1)
    }

    const emptySystem: ChatBlock = { role: 'SYSTEM', content: '' }
    const emptyUser: ChatBlock = { role: 'USER', content: '' }
    writeChatFile(filePath, [emptySystem, emptyUser])

    if (showProgress) {
        console.log(`Initialized empty chat file: ${filePath}`)
    }
}

// ========================
// CLI Setup
// ========================

program
    .name('chatfile')
    .description('CLI tool for AI conversations recorded in .chat.md files')
    .version(version)

program
    .argument('[file]', 'Path to .chat.md file')
    .option('-q, --quiet', 'Quiet mode, no output')
    .option('--init-config', 'Create .chatfilerc/config.json template')
    .action(async (file: string | undefined, options: any) => {
        if (options.initConfig) {
            initConfig()
            return
        }

        if (!file) {
            console.error('Error: Please specify a .chat.md file path.')
            process.exit(1)
        }

        await cmdComplete(file, { quiet: options.quiet })
    })

program
    .command('complete')
    .description('Complete the conversation (default command)')
    .argument('<file>', 'Path to .chat.md file')
    .option('-q, --quiet', 'Quiet mode')
    .action(async (file: string, options: any) => {
        await cmdComplete(file, { quiet: options.quiet })
    })

program
    .command('compact')
    .description('Compress conversation history')
    .argument('<file>', 'Path to .chat.md file')
    .option('-q, --quiet', 'Quiet mode')
    .action(async (file: string, options: any) => {
        await cmdCompact(file, { quiet: options.quiet })
    })

program
    .command('info')
    .description('Show file metadata and statistics')
    .argument('<file>', 'Path to .chat.md file')
    .option('-q, --quiet', 'Quiet mode')
    .action((file: string, options: any) => {
        cmdInfo(file, { quiet: options.quiet })
    })

program
    .command('init')
    .description('Create an empty .chat.md file (fails if exists)')
    .argument('<file>', 'Path to .chat.md file')
    .option('-q, --quiet', 'Quiet mode')
    .action((file: string, options: any) => {
        cmdInit(file, { quiet: options.quiet })
    })

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
    process.stdout.write('\n')
    process.exit(130)
})

// Parse and run
program.parse(process.argv)
