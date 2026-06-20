// runner.ts
import { spawn } from 'child_process'
import * as path from 'path'
import type { ToolDefinition, ToolCall, Message } from '../types/openaiApi'

// --------------------- 通用接口 ---------------------

/** 工具执行器接口：每种语言运行时需实现此接口，负责获取工具定义和调用工具函数 */
export interface ToolExecutor {
    /**
     * 获取指定工具文件中定义的所有工具列表
     * @param filePath - 工具文件绝对路径
     * @returns 工具定义数组（可直接用作 API 请求的 tools 字段）
     */
    getDefinitions(filePath: string): Promise<ToolDefinition[]>

    /**
     * 执行指定工具文件中的某个工具函数
     * @param filePath - 工具文件绝对路径
     * @param toolName - 要执行的函数名
     * @param argsJson - 调用参数字符串（JSON 格式）
     * @returns 工具函数返回值的 JSON 字符串（stdout）
     */
    executeTool(
        filePath: string,
        toolName: string,
        argsJson: string
    ): Promise<string>
}

/**
 * Node.js 专用工具执行器，利用子进程与 tool-runtime.ts 通信。
 * 通过环境变量 FUNCTION_CALL 控制描述/执行模式，通过 stdin/stdout 传输数据。
 */
export class NodeToolExecutor implements ToolExecutor {
    private nodePath: string
    private nodeArgs: string[]
    private runtimePath: string

    constructor() {
        this.nodePath = process.execPath
        this.nodeArgs = [...process.execArgv]
        this.runtimePath = path.dirname(import.meta.url) + '/tool-runtime.ts'
    }

    /** 内部通用子进程启动器 */
    private async spawn(options: {
        filePath: string
        env: Record<string, string>
        stdin?: string
        timeoutMs?: number
    }): Promise<{
        stdout: string
        stderr: string
        exitCode: number
    }> {
        const { filePath, env, stdin, timeoutMs = 30_000 } = options

        const args = [...this.nodeArgs, '--import', this.runtimePath, filePath]

        const child = spawn(this.nodePath, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env,
        })

        let stdout = ''
        let stderr = ''

        child.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString('utf-8')
        })
        child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString('utf-8')
        })

        if (stdin !== undefined) {
            child.stdin.write(stdin)
            child.stdin.end()
        } else {
            child.stdin.end()
        }

        const timeout = setTimeout(() => child.kill('SIGTERM'), timeoutMs)

        return new Promise((resolve, reject) => {
            child.on('close', code => {
                clearTimeout(timeout)
                resolve({ stdout, stderr, exitCode: code ?? -1 })
            })
            child.on('error', err => {
                clearTimeout(timeout)
                reject(
                    new Error(`Failed to spawn tool process: ${err.message}`)
                )
            })
        })
    }

    async getDefinitions(filePath: string): Promise<ToolDefinition[]> {
        const result = await this.spawn({
            filePath,
            env: { ...process.env, FUNCTION_CALL: '' },
        })

        if (result.exitCode !== 0) {
            throw new Error(
                `Tool definition process for ${filePath} exited with code ${result.exitCode}. stderr: ${result.stderr}`
            )
        }

        let tools: ToolDefinition[]
        try {
            tools = JSON.parse(result.stdout)
            if (!Array.isArray(tools)) {
                throw new Error('Expected a JSON array')
            }
        } catch (err: any) {
            throw new Error(
                `Invalid JSON from tool definition for ${filePath}: ${err.message}\nstdout: ${result.stdout}`
            )
        }
        return tools
    }

    async executeTool(
        filePath: string,
        toolName: string,
        argsJson: string
    ): Promise<string> {
        const result = await this.spawn({
            filePath,
            env: { ...process.env, FUNCTION_CALL: toolName },
            stdin: argsJson,
        })

        if (result.exitCode !== 0) {
            throw new Error(
                `Tool execution for "${toolName}" exited with code ${result.exitCode}. stderr: ${result.stderr}`
            )
        }
        return result.stdout
    }
}

// --------------------- 有状态的 ToolRunner ---------------------
export class ToolRunner {
    private toolMap = new Map<
        string,
        { filePath: string; definition: ToolDefinition }
    >()
    private executor: ToolExecutor

    /**
     * @param executor - 工具执行器实例（默认使用 NodeToolExecutor）
     */
    constructor(executor?: ToolExecutor) {
        this.executor = executor ?? new NodeToolExecutor()
    }

    /**
     * 加载一个或多个工具文件，合并所有工具定义。
     * - 重复函数名会发出警告并忽略后续定义（以首次注册为准）。
     */
    async loadTools(filePaths: string[]): Promise<void> {
        for (const filePath of filePaths) {
            const tools = await this.executor.getDefinitions(filePath)

            for (const tool of tools) {
                const name = tool.function.name
                if (this.toolMap.has(name)) {
                    console.warn(
                        `Warning: Duplicate tool name "${name}" found in ${filePath}, ignored (already defined in ${this.toolMap.get(name)!.filePath})`
                    )
                } else {
                    this.toolMap.set(name, { filePath, definition: tool })
                }
            }
        }
    }

    /** 返回当前所有已加载工具的合并定义，可直接作为 API 请求的 tools 参数。 */
    getDefinitions(): ToolDefinition[] {
        return Array.from(this.toolMap.values()).map(v => v.definition)
    }

    /**
     * 执行一个工具调用。
     * @param toolCall - OpenAI 返回的 tool_calls 数组中的单个对象
     * @returns 工具调用结果消息
     */
    async execute({
        id,
        function: { name, arguments: argsJson },
    }: ToolCall): Promise<Message> {
        const entry = this.toolMap.get(name)
        if (!entry) {
            throw new Error(
                `Tool "${name}" is not loaded. Call loadTools first.`
            )
        }

        const stdout = await this.executor.executeTool(
            entry.filePath,
            name,
            argsJson
        )

        return {
            role: 'tool',
            tool_call_id: id,
            content: stdout,
        }
    }

    async executeAll(toolCalls: ToolCall[]): Promise<Message[]> {
        return await Promise.all(toolCalls.map(call => this.execute(call)))
    }
}
