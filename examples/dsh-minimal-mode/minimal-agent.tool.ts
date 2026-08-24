// Minimal Agent — 复刻 DeepSeek Harness 的"极简模式"（minimal preset）
//
// 两个工具：
//   1. run_shell        —— 持久 shell（POSIX 上 bash，win32 上 pwsh），
//                          状态跨命令调用与对话保持，超时默认 5 分钟
//   2. str_replace_editor —— 精确字符串编辑（view / str_replace / create / insert）
//
// 用法：在 .chat.txt 的 USER 段写：
//   @tool(./minimal-agent.tool.ts)
//
// run_shell 的设计对照 DeepSeek Harness 的 tool-pwsh-persistent 与
// tool-bash-persistent（详见同目录 README.md）；chatxt 用 spawn 管道而非
// PTY，故省略其提示符安装与回显剥离逻辑。

import * as fs from 'fs/promises'
import * as path from 'path'
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'child_process'

// ---------------------------------------------------------------------------
// 1. 持久 shell
// ---------------------------------------------------------------------------

const isWin = process.platform === 'win32'

// 与 dsh 的默认值保持一致
const DEFAULT_TIMEOUT_MS = 300_000
const MAX_OUTPUT_CHARS = 16_000
// 缓冲上限：命令输出巨大时丢弃开头（避免无限增长），并标记 lost-prefix
const MAX_BUFFER_BYTES = 20 * 1024 * 1024

const TRUNCATED_MESSAGE =
    '<response clipped><NOTE>输出已截断。请用更窄的命令（如 ls / grep / Select-String）缩小输出范围。</NOTE>'
const LOST_PREFIX_MESSAGE =
    '<response clipped><NOTE>命令输出过长，开头部分已被丢弃，以下是最早保留的输出。</NOTE>\n'
const SHELL_RESET_MESSAGE =
    '持久 shell 已重置；下一次调用将从工作目录以全新环境开始。'

let shell: ChildProcess | null = null

// 串行队列：同一 shell 的命令必须排队执行（对照 dsh 的 serialized 模式）
let queue: Promise<void> = Promise.resolve()

// 工具子进程退出时清理持久 shell，避免泄漏孤儿进程
process.on('exit', () => {
    try {
        shell?.kill()
    } catch {
        /* empty */
    }
})
process.on('SIGTERM', () => {
    try {
        shell?.kill()
    } catch {
        /* empty */
    }
    process.exit(0)
})

function startShell(): ChildProcess {
    if (isWin) {
        // 与 dsh pwsh-local 一致：无交互、无 profile；-Command - 从 stdin 逐行执行。
        // 首发送钉死 UTF-8 编码（同 dsh 的 ENCODING_PREAMBLE）：pwsh 7 管道输出默认就是
        // UTF-8，此行为 Windows PowerShell 5.1 兜底；命令输入经 base64 已无编码歧义。
        const proc = spawn(
            'pwsh',
            ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'],
            { stdio: ['pipe', 'pipe', 'pipe'] }
        )
        proc.stdin?.write(
            '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); $OutputEncoding = [System.Text.UTF8Encoding]::new();\n'
        )
        return proc
    }
    // bash 无编码问题；noprofile/norc 与 dsh 的 bash 启动参数一致
    return spawn('bash', ['--noprofile', '--norc'], {
        stdio: ['pipe', 'pipe', 'pipe'],
    })
}

function getShell(): ChildProcess {
    if (shell && shell.exitCode === null) return shell
    const proc = startShell()
    shell = proc
    // 意外退出：清空引用，下次调用重新 spawn（dsh 的 reset 契约）
    proc.on('exit', () => {
        if (shell === proc) shell = null
    })
    return proc
}

function resetShell(): void {
    if (shell && shell.exitCode === null) {
        try {
            shell.kill()
        } catch {
            /* empty */
        }
    }
    shell = null
}

// ---------------------------------------------------------------------------
// marker 与 wrapper（对照 dsh 的 markers() / quoteFor* / wrapCommand）
// ---------------------------------------------------------------------------

interface CommandMarkers {
    start: string
    end: string
}

function markers(): CommandMarkers {
    const nonce = randomUUID()
    return {
        start: `__CHATXT_SHELL_START_${nonce}__`,
        end: `__CHATXT_SHELL_END_${nonce}:`,
    }
}

/** ANSI-C quoting：把命令体压进 $'...' 单行字符串（对照 dsh quoteForBash）。 */
function quoteForBash(value: string): string {
    return `$'${value
        .replaceAll('\\', '\\\\')
        .replaceAll("'", "\\'")
        .replaceAll('\r', '\\r')
        .replaceAll('\n', '\\n')}'`
}

/** 命令体编码：pwsh 的 stdin 逐行模式下按 Console.InputEncoding（ANSI/GBK）解码输入，
 * 直接发送中文字符命令会被损坏。用 UTF-16LE 的 base64 传输命令体（pwsh -EncodedCommand
 * 的官方思路），wrapper 全部为 ASCII，任何解码路径都无损。 */
function encodeForPwsh(command: string): string {
    return Buffer.from(command, 'utf16le').toString('base64')
}

/**
 * 单物理行 wrapper（对照 dsh wrapCommand 语义）：
 * - pwsh：命令体经 base64(UTF-16LE) 解码后 Invoke-Expression；$LASTEXITCODE 先清空，
 *   外部命令退出码优先，否则用 $? 映射 0/1；try/catch 把语法错误归一为失败而不炸掉 shell。
 * - bash：eval -- 执行，$? 即为退出码（bash 从管道读取时无编码转换，字节原样传递）。
 * END marker 与退出码同行（'END_nonce:' + code），解析端用 /^(\d+)\r?\n/ 提取，
 * 因此命令输出或回显中的 marker 文本永远无法伪造完成。
 */
function wrapCommand(command: string, marker: CommandMarkers): string {
    if (isWin) {
        const body = `([System.Text.Encoding]::Unicode.GetString([System.Convert]::FromBase64String('${encodeForPwsh(command)}')))`
        return `Write-Output '${marker.start}'; $LASTEXITCODE = $null; $__s = 1; try { Invoke-Expression ${body}; $__ok = $? } catch { $__ok = $false }; if ($null -ne $LASTEXITCODE) { $__s = [int]$LASTEXITCODE } else { $__s = if ($__ok) { 0 } else { 1 } }; Write-Output ('${marker.end}' + $__s)`
    }
    return `printf '%s\\n' '${marker.start}'; eval -- ${quoteForBash(command)}; __chfile_status=$?; printf '%s%s\\n' '${marker.end}' "$__chfile_status"`
}

interface CapturedOutput {
    text: string
    exitCode: number
    incomplete: boolean
}

/** 解析：END marker 后必须紧跟数字状态；找不到返回 undefined（尚未完成）。 */
function parseOutput(
    text: string,
    marker: CommandMarkers
): CapturedOutput | undefined {
    const end = text.lastIndexOf(marker.end)
    if (end < 0) return undefined
    const status = /^(\d+)\r?\n/.exec(text.slice(end + marker.end.length))?.[1]
    if (status === undefined) return undefined
    const startMarker = text.lastIndexOf(marker.start, end)
    const start = startMarker < 0 ? 0 : startMarker + marker.start.length
    return {
        text: text
            .slice(start, end)
            .replace(/^\r?\n/, '')
            .replace(/\r?\n$/, ''),
        exitCode: Number(status),
        incomplete: startMarker < 0,
    }
}

function renderCaptured(
    output: CapturedOutput | { text: string; incomplete: boolean }
): string {
    const text = output.text
    const clipped = text.length > MAX_OUTPUT_CHARS
    let rendered = clipped ? text.slice(0, MAX_OUTPUT_CHARS) : text
    if (clipped) rendered += TRUNCATED_MESSAGE
    // incomplete：START marker 丢失（缓冲截断），开头可能缺失，明确告知模型
    const lost = output.incomplete && text.length > 0
    if (lost) rendered = LOST_PREFIX_MESSAGE + rendered
    const exitCode = 'exitCode' in output ? output.exitCode : undefined
    const status =
        exitCode !== undefined && exitCode !== 0
            ? `[exit code: ${exitCode}]`
            : undefined
    if (status === undefined) return rendered
    return rendered.length === 0 ? status : `${rendered}\n${status}`
}

/** 串行队列（对照 dsh 的 serialized）。 */
function queueThen<T>(op: () => Promise<T>): Promise<T> {
    const run = queue.then(op, op)
    queue = run.then(
        () => undefined,
        () => undefined
    )
    return run
}

async function executeCommand(
    command: string,
    timeoutMs: number
): Promise<string> {
    const proc = getShell()
    const marker = markers()
    const wrapped = wrapCommand(command, marker)

    return new Promise<string>(resolve => {
        let buffer = ''
        let lostPrefix = false
        let finished = false

        const finish = (result: string) => {
            if (finished) return
            finished = true
            clearTimeout(timer)
            proc.stdout?.off('data', onStdout)
            proc.stderr?.off('data', onStderr)
            proc.off('exit', onExit)
            resolve(result)
        }

        // 超时语义（对照 dsh）：返回部分输出 + 重置 shell（下一条全新）
        const timer = setTimeout(() => {
            const partial = renderCaptured({
                text: buffer,
                incomplete: lostPrefix,
            })
            resetShell()
            finish(
                `命令超时（${Math.round(timeoutMs / 1000)} 秒）。以下为部分输出：\n${partial}\n${SHELL_RESET_MESSAGE}`
            )
        }, timeoutMs)

        // shell 意外退出：报告退出并重置
        const onExit = (
            code: number | null,
            signal: NodeJS.Signals | null
        ) => {
            const who = signal !== null ? `signal ${signal}` : `code ${code}`
            resetShell()
            finish(`[shell exited: ${who}]\n${SHELL_RESET_MESSAGE}`)
        }

        const accumulate = (chunk: Buffer) => {
            buffer += chunk.toString('utf-8')
            if (buffer.length > MAX_BUFFER_BYTES) {
                buffer = buffer.slice(-MAX_BUFFER_BYTES)
                lostPrefix = true
            }
            const parsed = parseOutput(buffer, marker)
            if (parsed) finish(renderCaptured(parsed))
        }

        const onStdout = (chunk: Buffer) => accumulate(chunk)
        const onStderr = (chunk: Buffer) => accumulate(chunk)

        proc.stdout?.on('data', onStdout)
        proc.stderr?.on('data', onStderr)
        proc.on('exit', onExit)
        proc.stdin?.write(`${wrapped}\n`)
    })
}

async function run_shell({
    command,
    timeoutMs = DEFAULT_TIMEOUT_MS,
}: {
    command: string
    timeoutMs?: number
}): Promise<{ output: string } | { error: string }> {
    if (command.trim().length === 0) {
        return { error: 'command 不能为空' }
    }
    try {
        const output = await queueThen(() =>
            executeCommand(command, timeoutMs)
        )
        return { output }
    } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
    }
}

// ---------------------------------------------------------------------------
// 2. str_replace_editor
// ---------------------------------------------------------------------------

async function readFileLines(absPath: string): Promise<string[]> {
    const content = await fs.readFile(absPath, 'utf-8')
    return content.split('\n')
}

async function str_replace_editor({
    command,
    file_path,
    old_string,
    new_string = '',
    line,
    view_range,
}: {
    command: 'view' | 'str_replace' | 'create' | 'insert'
    file_path: string
    old_string?: string
    new_string?: string
    line?: number
    view_range?: string
}): Promise<{ output: string } | { error: string }> {
    const abs = path.isAbsolute(file_path)
        ? file_path
        : path.resolve(file_path)

    try {
        switch (command) {
            case 'view': {
                const lines = await readFileLines(abs)
                if (view_range) {
                    const [start, end] = view_range.split(':').map(Number)
                    if (!start || !end) {
                        return {
                            error: 'view_range 格式应为 "起始:结束"，如 "1:50"',
                        }
                    }
                    return { output: lines.slice(start - 1, end).join('\n') }
                }
                return { output: lines.join('\n') }
            }

            case 'str_replace': {
                if (!old_string) return { error: 'old_string 不能为空' }
                const content = await fs.readFile(abs, 'utf-8')
                const count = content.split(old_string).length - 1
                if (count === 0) {
                    return { error: `未找到 old_string 的匹配` }
                }
                if (count > 1) {
                    return {
                        error: `找到 ${count} 处匹配，old_string 必须唯一`,
                    }
                }
                await fs.writeFile(
                    abs,
                    content.replace(old_string, new_string),
                    'utf-8'
                )
                return { output: `已在 ${file_path} 完成替换` }
            }

            case 'create': {
                try {
                    await fs.access(abs)
                    return {
                        error: `文件已存在：${file_path}，请改用 str_replace`,
                    }
                } catch {
                    await fs.writeFile(abs, new_string, 'utf-8')
                    return { output: `已创建 ${file_path}` }
                }
            }

            case 'insert': {
                if (!line || line < 1) return { error: 'line 必须为正整数' }
                const lines = await readFileLines(abs)
                lines.splice(line - 1, 0, new_string)
                await fs.writeFile(abs, lines.join('\n'), 'utf-8')
                return { output: `已在 ${file_path} 的第 ${line} 行插入内容` }
            }

            default:
                return { error: `未知命令：${command}` }
        }
    } catch (err) {
        return {
            error: err instanceof Error ? err.message : String(err),
        }
    }
}

// ---------------------------------------------------------------------------
// 注册
// ---------------------------------------------------------------------------

serveAsTool(
    [
        run_shell,
        isWin
            ? '在 PowerShell 中运行命令。状态跨命令调用与对话持久。无互联网访问。请避免产生大量输出的命令，长命令请放后台（如 Start-Job）。'
            : '在 bash 中运行命令。状态跨命令调用与对话持久。无互联网访问。请避免产生大量输出的命令，长命令请放后台（如 sleep 10 &）。',
        {
            type: 'object',
            properties: {
                command: { type: 'string', description: '要执行的命令' },
                timeoutMs: {
                    type: 'number',
                    description: '超时时间（毫秒），默认 300000（5 分钟）',
                },
            },
            required: ['command'],
        },
    ],
    [
        str_replace_editor,
        '精确编辑文件。支持 view（查看，可选行范围）/ str_replace（唯一匹配替换）/ create（创建）/ insert（按行插入）。文件路径为绝对路径或相对 cwd。',
        {
            type: 'object',
            properties: {
                command: {
                    type: 'string',
                    enum: ['view', 'str_replace', 'create', 'insert'],
                },
                file_path: { type: 'string', description: '文件路径' },
                old_string: {
                    type: 'string',
                    description: 'str_replace 时要精确匹配的旧字符串',
                },
                new_string: {
                    type: 'string',
                    description: '替换 / 创建 / 插入的字符串',
                },
                line: {
                    type: 'number',
                    description: 'insert 时的目标行号（1 起）',
                },
                view_range: {
                    type: 'string',
                    description: 'view 时的行范围，如 "1:50"',
                },
            },
            required: ['command', 'file_path'],
        },
    ]
)
