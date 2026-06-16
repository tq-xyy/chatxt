import { readFileSync, existsSync, statSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join, resolve, isAbsolute } from 'node:path'
import type { Tool } from './llmapi.js'

const TIMEOUT_DEFAULT = 30_000 // 30 seconds
const OUTPUT_LIMIT = 1 * 1024 * 1024 // 1 MB

// Track already processed includes/files to avoid duplicates
const processedIncludes = new Set<string>()
const processedFiles = new Set<string>()

export function resetDirectiveCache(): void {
    processedIncludes.clear()
    processedFiles.clear()
}

// ---------- Argument parsing ----------

interface DirectiveArg {
    raw: string
    value: string
}

function parseDirectiveArg(
    text: string,
    startPos: number
): { arg: DirectiveArg | null; endPos: number } {
    if (startPos >= text.length) return { arg: null, endPos: startPos }

    const char = text[startPos]

    if (char === '"') {
        // Double-quoted string
        const end = text.indexOf('"', startPos + 1)
        if (end === -1) return { arg: null, endPos: startPos }
        return {
            arg: {
                raw: text.slice(startPos, end + 1),
                value: text.slice(startPos + 1, end),
            },
            endPos: end + 1,
        }
    } else if (char === "'") {
        // Single-quoted string
        const end = text.indexOf("'", startPos + 1)
        if (end === -1) return { arg: null, endPos: startPos }
        return {
            arg: {
                raw: text.slice(startPos, end + 1),
                value: text.slice(startPos + 1, end),
            },
            endPos: end + 1,
        }
    } else {
        // Unquoted: until space, tab, or end of line
        let end = startPos
        while (
            end < text.length &&
            text[end] !== ' ' &&
            text[end] !== '\t' &&
            text[end] !== '\n' &&
            text[end] !== '\r'
        ) {
            end++
        }
        if (end === startPos) return { arg: null, endPos: startPos }
        return {
            arg: {
                raw: text.slice(startPos, end),
                value: text.slice(startPos, end),
            },
            endPos: end,
        }
    }
}

// ---------- Directive parsing ----------

interface ParsedDirective {
    type: 'file' | 'pipe' | 'tool' | 'include'
    raw: string
    arg: string
}

/**
 * Parse all @ directives from a text, returning them in order.
 */
export function parseDirectives(text: string): ParsedDirective[] {
    const directives: ParsedDirective[] = []
    const regex = /@(file|pipe|tool|include)?\s*\(/g
    let match: RegExpExecArray | null

    // Also match @(path) shorthand
    const shorthandRegex = /@\(/g

    // Find named directives
    while ((match = regex.exec(text)) !== null) {
        const cmd = match[1] || 'file' // default to file
        const startPos = match.index + match[0].length

        const result = parseDirectiveArg(text, startPos)
        if (result.arg) {
            // Find closing paren
            const closeParen = text.indexOf(')', result.endPos)
            if (closeParen !== -1) {
                directives.push({
                    type: cmd as 'file' | 'pipe' | 'tool' | 'include',
                    raw: text.slice(match.index, closeParen + 1),
                    arg: result.arg.value,
                })
            }
        }
    }

    // Find shorthand @(path) directives not already captured
    // Since @( is also matched by the named directive regex, we skip if already captured
    // Actually @file(path) and @(path) are both handled by the regex above
    // @(path) matches with cmd='file' (default)

    return directives
}

// ---------- Execution ----------

export interface DirectiveResult {
    fileInjections: string[] // Content to append to message
    pipeOutputs: PipeRecord[]
    toolDefs: ToolData[]
    includeReplacements: Map<string, string> // raw directive -> replacement content
}

export interface PipeRecord {
    command: string
    output: string
}

export interface ToolData {
    name: string
    description: string
    parameters: Record<string, any>
    filePath: string
}

/**
 * Process @include directive: read file content and resolve nested directives.
 */
function processInclude(
    filePath: string,
    visited: Set<string>
): { content: string; error?: string } {
    const resolved = resolve(process.cwd(), filePath)

    if (visited.has(resolved)) {
        // Cycle detected, return empty
        return {
            content: '',
            error: `Circular include detected for ${filePath}`,
        }
    }

    if (!existsSync(resolved)) {
        return { content: '', error: `Include file not found: ${filePath}` }
    }

    visited.add(resolved)

    try {
        let content = readFileSync(resolved, 'utf-8')
        // Process nested @include in the included file
        const nestedDirectives = parseDirectives(content)
        for (const dir of nestedDirectives) {
            if (dir.type === 'include' && !processedIncludes.has(resolved)) {
                const nestedResult = processInclude(dir.arg, visited)
                if (nestedResult.content) {
                    content = content.replace(dir.raw, nestedResult.content)
                } else {
                    content = content.replace(dir.raw, '')
                }
            } else if (dir.type === 'file') {
                // Don't process @file inside includes for now (they're not replaced, just appended)
                // But mark the file as processed
                const fileResolved = resolve(process.cwd(), dir.arg)
                processedFiles.add(fileResolved)
            }
        }

        processedIncludes.add(resolved)
        return { content }
    } catch (err) {
        return {
            content: '',
            error: `Failed to read include file: ${(err as Error).message}`,
        }
    }
}

/**
 * Execute a shell command and return its output.
 */
function executePipeCommand(command: string): {
    stdout: string
    stderr: string
} {
    try {
        const result = execSync(command, {
            timeout: TIMEOUT_DEFAULT,
            maxBuffer: OUTPUT_LIMIT,
            encoding: 'utf-8',
            cwd: process.cwd(),
        })
        return { stdout: result, stderr: '' }
    } catch (err: any) {
        const stdout = err.stdout || ''
        const stderr = err.stderr || ''
        const errorMsg = err.message || 'Unknown error'
        return {
            stdout: stdout,
            stderr: `[Error] Command failed: ${errorMsg}\n${stderr}`,
        }
    }
}

/**
 * Parse a .agent.* tool file to extract its function definition.
 */
function parseToolFile(toolPath: string): ToolData | null {
    const resolved = resolve(process.cwd(), toolPath)
    if (!existsSync(resolved)) {
        console.error(`[Warning] Tool file not found: ${toolPath}`)
        return null
    }

    try {
        const content = readFileSync(resolved, 'utf-8')

        // Extract top comment block (/* ... */)
        const commentMatch = content.match(/^\/\*([\s\S]*?)\*\//)
        if (!commentMatch) {
            console.error(
                `[Warning] Tool file ${toolPath} missing JSON header comment`
            )
            return null
        }

        const header = commentMatch[1].trim()
        const def = JSON.parse(header)

        return {
            name: def.name || '',
            description: def.description || '',
            parameters: def.parameters || {},
            filePath: resolved,
        }
    } catch (err) {
        console.error(
            `[Warning] Failed to parse tool file ${toolPath}: ${(err as Error).message}`
        )
        return null
    }
}

/**
 * Process all directives found in a text block.
 */
export function processDirectives(
    text: string,
    quiet: boolean
): {
    processedText: string
    result: DirectiveResult
} {
    const directives = parseDirectives(text)
    const result: DirectiveResult = {
        fileInjections: [],
        pipeOutputs: [],
        toolDefs: [],
        includeReplacements: new Map(),
    }

    let processedText = text

    for (const dir of directives) {
        switch (dir.type) {
            case 'include': {
                if (!processedIncludes.has(resolve(process.cwd(), dir.arg))) {
                    const visited = new Set<string>()
                    const incResult = processInclude(dir.arg, visited)
                    if (incResult.content) {
                        result.includeReplacements.set(
                            dir.raw,
                            incResult.content
                        )
                        processedText = processedText.replace(
                            dir.raw,
                            incResult.content
                        )
                    } else {
                        // Remove the include directive
                        processedText = processedText.replace(dir.raw, '')
                        if (incResult.error && !quiet) {
                            console.error(`[Warning] ${incResult.error}`)
                        }
                    }
                } else {
                    // Already included, remove the directive
                    processedText = processedText.replace(dir.raw, '')
                }
                break
            }

            case 'file': {
                const filePath = resolve(process.cwd(), dir.arg)
                if (!processedFiles.has(filePath)) {
                    if (existsSync(filePath)) {
                        try {
                            const fileContent = readFileSync(filePath, 'utf-8')
                            result.fileInjections.push(
                                `File (${dir.arg}):\n${fileContent}`
                            )
                            processedFiles.add(filePath)
                            if (!quiet) {
                                console.log(
                                    `[Info] Referenced file: ${dir.arg}`
                                )
                            }
                        } catch (err) {
                            if (!quiet) {
                                console.error(
                                    `[Warning] Failed to read file ${dir.arg}: ${(err as Error).message}`
                                )
                            }
                        }
                    } else {
                        if (!quiet) {
                            console.error(
                                `[Warning] File not found: ${dir.arg}`
                            )
                        }
                    }
                }
                break
            }

            case 'pipe': {
                if (!quiet) {
                    console.log(`[Info] Executing pipe: ${dir.arg}`)
                }
                const execResult = executePipeCommand(dir.arg)
                const output =
                    execResult.stdout || execResult.stderr || '(no output)'
                result.pipeOutputs.push({
                    command: dir.arg,
                    output: `Command Output (${dir.arg}):\n${output}`,
                })
                result.fileInjections.push(
                    `Command Output (${dir.arg}):\n${output}`
                )
                break
            }

            case 'tool': {
                const toolData = parseToolFile(dir.arg)
                if (toolData) {
                    result.toolDefs.push(toolData)
                }
                break
            }
        }
    }

    return { processedText, result }
}

/**
 * Convert tool data to OpenAI-compatible tool definitions.
 */
export function toolsToApiFormat(tools: ToolData[]): Tool[] {
    return tools.map(t => ({
        type: 'function' as const,
        function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
        },
    }))
}

/**
 * Execute a tool with given arguments. Returns result string.
 */
export function executeTool(toolPath: string, args: string): string {
    try {
        const result = execSync(toolPath, {
            input: args,
            timeout: TIMEOUT_DEFAULT,
            maxBuffer: OUTPUT_LIMIT,
            encoding: 'utf-8',
            cwd: process.cwd(),
        })

        // Validate JSON output
        try {
            JSON.parse(result)
        } catch {
            return JSON.stringify({
                error: `Tool returned non-JSON output. Output was: ${result.slice(0, 500)}`,
            })
        }

        return result
    } catch (err: any) {
        return JSON.stringify({
            error: `Tool execution failed: ${err.message || 'Unknown error'}`,
            stderr: err.stderr || '',
        })
    }
}
