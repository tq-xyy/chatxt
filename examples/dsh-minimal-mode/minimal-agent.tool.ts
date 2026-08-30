import * as fs from 'fs/promises'
import * as path from 'path'
import { existsSync } from 'fs'
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'child_process'

// run_shell 实现机制（对照 DeepSeek Harness `tool-bash-persistent`）
// run_shell 的设计对照 DeepSeek Harness 的 tool-bash-persistent；chatxt 用 spawn 管道而非 PTY，故省略其提示符安装与回显剥离逻辑。
// 每条命令被包装为**单物理行 wrapper** 写入持久 shell：
// - 随机 nonce（UUID）的 START/END marker，END marker 后紧跟**同行的数字退出码**（`'END_nonce:' + code`），解析端用 `/^(\d+)\r?\n/` 提取——命令输出或回显中的 marker 文本永远无法伪造完成
// - 命令体先经 `bash -n -c` 静态语法校验再 `eval "$cmd"`（`$?` 即退出码）。busybox 的 `bash` 入口即 ash，从管道逐行读命令时 `eval` 内的语法错误会杀死外层 shell，预校验把这类错误归一为 exit 2 + 报错且不损伤持久会话（变量、函数定义保留）；GNU bash 下行为一致
// - ANSI-C quoting（`$'...'`）把命令体压成单行；busybox ash 的 `eval` 不接受 `--` 分隔符（会当作命令），故省略
// - shell 经 stdin 管道逐行喂命令，命令体与输出均为 UTF-8 字节原样传递（busybox-w32 Unicode 构建内部使用 UTF-8），无 pwsh 管道按 ANSI 代码页解码导致的中文损坏问题，因此不再需要 base64(UTF-16LE) 传输
// - 超时 / shell 意外退出（如命令体顶层 `exit`）→ kill 并重置，下次调用全新会话（对照 dsh 的 reset 契约）
// - 同一 agent 的命令**串行排队**（对照 dsh 的 serialized）；输出超过 16,000 字符自动截断并附 `<response clipped>` 引导
// > 与 dsh 的差异：dsh 的持久 shell 运行在 PTY 里（交互式 bash），因此需要安装受控提示符、按 25ms 轮询 scrollback；chatxt 使用 spawn 管道（无交互回显），同样语义下更简单，采用事件驱动读取。
// > BusyBox ash 与 GNU bash 的差异：本目录的 busybox-w32 build 编译时开启了 bash 兼容（`CONFIG_ASH_BASH_COMPAT`），因此 `[[ ]]`（含复合条件）、进程替换 `<( )` 均可用；但仍**不支持数组**（`arr=(...)` 报语法错误）等部分 bash 扩展。路径语义是原生的——没有 MSYS 式的 `/d/...` 转换，盘内路径用 `D:/dir` 或 `D:\\dir`；核心 applet（ls / cat / grep / sed / awk / find 等）齐全，且在 busybox shell 内可直接按 applet 名调用（如 `bash`、`sleep`），覆盖日常编码任务。若命令因语法不兼容失败，AI 会收到非零退出码并自行调整。

const isWin = process.platform === 'win32'

// 与 dsh 的默认值保持一致
const DEFAULT_TIMEOUT_MS = 300_000
const MAX_OUTPUT_CHARS = 16_000
// 缓冲上限：命令输出巨大时丢弃开头（避免无限增长），并标记 lost-prefix
const MAX_BUFFER_BYTES = 20 * 1024 * 1024

const TRUNCATED_MESSAGE =
    '<response clipped><NOTE>输出已截断。请用更窄的命令（如 ls / grep / head）缩小输出范围。</NOTE>'
const LOST_PREFIX_MESSAGE =
    '<response clipped><NOTE>命令输出过长，开头部分已被丢弃，以下是最早保留的输出。</NOTE>\n'
const SHELL_RESET_MESSAGE =
    '持久 shell 已重置；下一次调用将从工作目录以全新环境开始。'

const BUSYBOX_POSSIBLE_PATH = [
    'windows/busybox.exe',
    'windows/busybox64.exe',
    'windows/busybox64u.exe',
    'windows/busybox64a.exe',
]
const BUSYBOX_SUPPORT_APPLETS = // busybox --list
    (
        '[,[[,ar,arch,ascii,ash,awk,base32,base64,basename,bash,bc,' +
        'bunzip2,busybox,bzcat,bzip2,cal,cat,cdrop,chattr,chmod,cksum,' +
        'clear,cmp,comm,cp,cpio,crc32,crond,crontab,cut,date,dc,dd,df,' +
        'diff,dirname,dos2unix,dpkg,dpkg-deb,drop,du,echo,ed,egrep,env,' +
        'expand,expr,factor,false,fgrep,find,flock,fold,free,fsync,' +
        'ftpget,ftpput,getopt,grep,groups,gunzip,gzip,hd,head,hexdump,' +
        'httpd,iconv,id,inotifyd,install,ipcalc,jn,join,kill,killall,lash,' +
        'less,link,ln,logname,ls,lsattr,lzcat,lzma,lzop,lzopcat,make,man,' +
        'md5sum,mkdir,mktemp,mv,nc,nl,nproc,od,paste,patch,pdpmake,pdrop,' +
        'pgrep,pidof,pipe_progress,pkill,printenv,printf,ps,pwd,readlink,' +
        'realpath,reset,rev,rm,rmdir,rpm,rpm2cpio,sed,seq,sh,sha1sum,sha256sum,' +
        'sha384sum,sha3sum,sha512sum,shred,shuf,sleep,sort,split,ssl_client,' +
        'stat,strings,stty,su,sum,sync,tac,tail,tar,tee,test,time,timeout,' +
        'touch,tr,true,truncate,ts,tsort,ttysize,uname,uncompress,unexpand,' +
        'uniq,unix2dos,unlink,unlzma,unlzop,unxz,unzip,uptime,usleep,uudecode,' +
        'uuencode,uuidgen,vi,watch,wc,wget,which,whoami,whois,xargs,xxd,xz,' +
        'xzcat,yes,zcat'
    ).split(',')

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

// Windows 上使用的 BusyBox for Windows（busybox-w32 项目，Unicode/UTF-8 构建），
// 其 "bash" applet 即 BusyBox ash 的 bash 兼容模式，统一了两侧的 shell 语法。
// 存放于本目录 windows/ 下（.gitignore 中，需按 README 自行放置）。

function startShell(): ChildProcess {
    if (isWin) {
        let busyboxBinary: string | undefined
        for (const possible of BUSYBOX_POSSIBLE_PATH) {
            if (existsSync(path.join(import.meta.dirname, possible))) {
                busyboxBinary = path.join(import.meta.dirname, possible)
            }
        }
        if (!busyboxBinary) {
            throw new Error(
                `未找到 BusyBox\n请下载 busybox-w32 到 ${path.join(import.meta.dirname, BUSYBOX_POSSIBLE_PATH[0])}，详见 README。`
            )
        }
        // 无交互、无 profile；从 stdin 逐行读取命令。
        // busybox ash 不支持 bash 的 --noprofile/--norc，也不支持 eval --，
        // 但管道模式下本就无 rc 文件加载，UTF-8 输入输出无需额外编码设置。
        return spawn(busyboxBinary, ['bash'], {
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: chatxt.context.chatFileDirname,
        })
    }
    // bash 无编码问题；noprofile/norc 与 dsh 的 bash 启动参数一致
    return spawn('bash', ['--noprofile', '--norc'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: chatxt.context.chatFileDirname,
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
// marker 与 wrapper（对照 dsh 的 markers() / quoteForBash / wrapCommand）
// ---------------------------------------------------------------------------

interface CommandMarkers {
    start: string
    end: string
}

function markers(): CommandMarkers {
    const nonce = randomUUID()
    return {
        start: `__SHELL_START_${nonce}__`,
        end: `__SHELL_END_${nonce}:`,
    }
}

/** ANSI-C quoting：把命令体压进 $'...' 单行字符串（对照 dsh quoteForBash）。
 * busybox ash 与 bash 均支持，UTF-8 字节经管道原样传递，无编码转换问题。 */
function quoteForBash(value: string): string {
    return `$'${value
        .replaceAll('\\', '\\\\')
        .replaceAll("'", "\\'")
        .replaceAll('\r', '\\r')
        .replaceAll('\n', '\\n')}'`
}

/**
 * 单物理行 wrapper（对照 dsh wrapCommand 语义，两侧统一为 bash 语法）：
 * - 命令体先经 `bash -n -c` 静态语法校验再 eval。原因：ash 从管道逐行读命令时，
 *   `eval` 内的语法错误（未闭合引号、残缺 if/for 等）会**杀死外层 shell**；
 *   预校验把这类错误归一为 exit 2 + 报错信息，持久 shell（及其中积累的变量、
 *   函数）不受损伤。GNU bash 下 eval 语法错误本不致命，但预校验让两侧行为一致。
 * - eval 执行命令体，`$?` 即为退出码；顶层 `exit` 会退出 shell，由 onExit
 *   报告并按 dsh 的 reset 契约在下次调用重建。
 * - 注意 busybox ash 的 eval 不接受 `--` 选项分隔符（会把它当作命令），
 *   且 eval 只是拼接参数、`--` 并无必要，故省略。
 * END marker 与退出码同行（'END_nonce:' + code），解析端用 /^(\d+)\r?\n/ 提取，
 * 因此命令输出或回显中的 marker 文本永远无法伪造完成。
 */
function wrapCommand(command: string, marker: CommandMarkers): string {
    return `printf '%s\\n' '${marker.start}'; __chfile_cmd=${quoteForBash(command)}; if bash -n -c "$__chfile_cmd"; then eval "$__chfile_cmd"; __chfile_status=$?; else __chfile_status=2; printf '%s\\n' '[syntax error: 命令未执行]'; fi; unset __chfile_cmd; printf '%s%s\\n' '${marker.end}' "$__chfile_status"`
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

async function readFileLines(absPath: string): Promise<string[]> {
    const content = await fs.readFile(absPath, 'utf-8')
    return content.split('\n')
}

// 编辑结果回显片段时，替换/插入位置上下各附带的行数
const SNIPPET_CONTEXT_LINES = 3

/** 文件实际行数：以 '\n' 分割后，末尾空元素不计（文件以换行结尾时 split 会多出一个空串） */
function countLines(lines: string[]): number {
    return lines.length > 0 && lines[lines.length - 1] === ''
        ? lines.length - 1
        : lines.length
}

/** 4 位右对齐行号 + 内容，便于 AI 引用行号做后续编辑 */
function formatLines(lines: string[], startLine: number): string {
    return lines
        .map((text, i) => `${String(startLine + i).padStart(4)} | ${text}`)
        .join('\n')
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
        : path.resolve(chatxt.context.chatFileDirname, file_path)

    if (abs === chatxt.context.chatFilePath && command !== 'view') {
        return { error: `目标 ${abs} 为只读，仅支持 view 指令` }
    }

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
                    const slice = lines.slice(start - 1, end)
                    return {
                        output: `${slice.join('\n')}\n[显示第 ${start}-${start - 1 + slice.length} 行，共 ${countLines(lines)} 行]`,
                    }
                }
                return {
                    output: `${lines.join('\n')}\n[共 ${countLines(lines)} 行]`,
                }
            }

            case 'str_replace': {
                if (!old_string) return { error: 'old_string 不能为空' }
                const content = await fs.readFile(abs, 'utf-8')
                const count = content.split(old_string).length - 1
                if (count === 0) {
                    return { error: `未找到 old_string 的匹配` }
                }
                if (count > 1) {
                    // 列出各匹配的起始行号，帮助 AI 补充上下文消歧
                    const lineNumbers: number[] = []
                    let idx = content.indexOf(old_string)
                    while (idx !== -1) {
                        lineNumbers.push(
                            content.slice(0, idx).split('\n').length
                        )
                        idx = content.indexOf(
                            old_string,
                            idx + old_string.length
                        )
                    }
                    return {
                        error: `找到 ${count} 处匹配（第 ${lineNumbers.join('、')} 行），old_string 必须唯一`,
                    }
                }
                const at = content.indexOf(old_string)
                const matchLine = content.slice(0, at).split('\n').length
                // 用函数形式替换，避免 new_string 中的 $&、$1 等被 String.replace 特殊展开
                const replaced = content.replace(old_string, () => new_string)
                await fs.writeFile(abs, replaced, 'utf-8')
                const newLines = replaced.split('\n')
                const replacedSpan = new_string.split('\n').length
                const ctxStart = Math.max(
                    0,
                    matchLine - 1 - SNIPPET_CONTEXT_LINES
                )
                const snippet = newLines.slice(
                    ctxStart,
                    matchLine - 1 + replacedSpan + SNIPPET_CONTEXT_LINES
                )
                return {
                    output: `已在 ${file_path} 完成替换（匹配起始于第 ${matchLine} 行，文件共 ${countLines(newLines)} 行）。替换后片段：\n${formatLines(snippet, ctxStart + 1)}`,
                }
            }

            case 'create': {
                try {
                    await fs.access(abs)
                    return {
                        error: `文件已存在：${file_path}，请改用 str_replace`,
                    }
                } catch {
                    await fs.writeFile(abs, new_string, 'utf-8')
                    return {
                        output: `已创建 ${file_path}（共 ${countLines(new_string.split('\n'))} 行）`,
                    }
                }
            }

            case 'insert': {
                if (!line || line < 1) return { error: 'line 必须为正整数' }
                const lines = await readFileLines(abs)
                lines.splice(line - 1, 0, new_string)
                await fs.writeFile(abs, lines.join('\n'), 'utf-8')
                const insertedSpan = new_string.split('\n').length
                const ctxStart = Math.max(0, line - 1 - SNIPPET_CONTEXT_LINES)
                const snippet = lines.slice(
                    ctxStart,
                    line - 1 + insertedSpan + SNIPPET_CONTEXT_LINES
                )
                return {
                    output: `已在 ${file_path} 的第 ${line} 行插入内容（文件共 ${countLines(lines)} 行）。插入后片段：\n${formatLines(snippet, ctxStart + 1)}`,
                }
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

const runShellDesc =
    '在 bash 中运行命令。状态跨命令调用与对话持久。请避免产生大量输出的命令，长命令请放后台（如 sleep 10 &）。' +
    `文件 ${path.basename(chatxt.context.chatFilePath)} 不是多余文件，改动须用户确认。` +
    (isWin
        ? '\n当前环境为 Windows，已自动启用 BusyBox for Windows 的 bash Applet，非 PowerShell' +
          `\n支持命令 (也可以直接运行任意 Windows 二进制): ${BUSYBOX_SUPPORT_APPLETS.join(', ')}` +
          '\n请使用 `&&` 连接命令而非 `;`。如果需要平台特定功能请用 cmd /c (不要使用 cmd //c)， `pwsh -Command`。'
        : '')
await chatxt.runtime.exposeTool([
    {
        name: 'run_shell',
        description: runShellDesc,
        parameters: {
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
        func: run_shell,
    },
    {
        name: 'str_replace_editor',
        description:
            '精确编辑文件。支持 view（查看，可选行范围）/ str_replace（唯一匹配替换）/ create（创建）/ insert（按行插入）。文件路径为绝对路径或相对 cwd。',
        parameters: {
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
        func: str_replace_editor,
    },
])
