import chalk from 'chalk'

import { getModelGateway, type Config } from './config'
import type { NormalizedUsage } from './common/usage'
import { computeTokenCostCNY } from './common/pricing'
import { estimateTokens } from './utils/estimate-tokens'
import type { StreamEvent } from './types/api-adapter'

export function printWarningMessage(warn: string): void {
    console.warn(chalk.yellow.bold('! Warning ') + chalk.yellow(warn))
}

export function printExceptionMessage(err: unknown): void {
    const error = err instanceof Error ? err : new Error(String(err))

    let output: string = ''

    output += chalk.bold.red('× Exception Happens') + ' | '
    output +=
        chalk.bold.white(error.name) +
        chalk.white(': ') +
        chalk.white(error.message)

    if (error.cause) {
        const cause =
            error.cause instanceof Error
                ? error.cause
                : new Error(String(error.cause))
        output += ` (caused by ${cause.name}: ${cause.message})`
    }

    if (error.stack) {
        const frames = error.stack
            .split('\n')
            .filter(line => !line.includes('node:'))
            .slice(1, 4)
        for (const frame of frames) {
            output += chalk.gray(`\n  ${frame.trim()}`)
        }
    }

    console.error(output)
}

function formatUsageAndCostForSingleModel(
    usage: NormalizedUsage,
    config: Config
) {
    const withNumSeps = (n: number) => n.toLocaleString('en-US')

    let firstLine: string = ''
    let cost: number

    if (usage.model) {
        const modelId = usage.model
        const gateway = getModelGateway(config, modelId)

        cost = computeTokenCostCNY(usage, gateway.pricing)

        firstLine +=
            chalk.white('Model: ') +
            chalk.magenta(modelId) +
            chalk.white('  ·  Provider: ') +
            chalk.magenta(gateway.providerName)
    } else {
        firstLine += 'Model: ' + chalk.gray('(unknown)')

        cost = computeTokenCostCNY(usage, usage.model)
    }

    const costPart = isNaN(cost)
        ? ''
        : ' (' + chalk.red(`¥${cost.toFixed(6)}`) + ')'
    const cachedPart = usage.cached
        ? ` (${chalk.gray('cached ' + withNumSeps(usage.cached))}, ${Math.min(
              (usage.cached / usage.input) * 100,
              100
          ).toFixed(1)}%) `
        : ''
    const reasoningTokens = usage.thinking
    const thinkingPart = reasoningTokens
        ? ` (${chalk.magenta('thinking ' + withNumSeps(reasoningTokens))}, ${((usage.thinking / usage.output) * 100).toFixed(1)}%)`
        : ''
    const secondLine =
        chalk.white.bold('Total tokens: ') +
        chalk.yellow(withNumSeps(usage.input + usage.output)) +
        costPart +
        chalk.italic(
            '  ·  input for ' +
                chalk.blue(withNumSeps(usage.input)) +
                cachedPart +
                ', output for ' +
                chalk.blue(withNumSeps(usage.output)) +
                thinkingPart
        )
    return [firstLine, secondLine]
}

export function printFinalStatus({
    status,
    usages,
    startTime,
    config,
    toolCallCount,
    totalCost,
    timing,
    requestCount,
}: {
    status: 'ok' | 'error' | 'ctrl-c'
    usages: NormalizedUsage[]
    startTime: number
    config: Config
    toolCallCount: number
    totalCost: number
    timing?: {
        netMs: number
        outMs: number
        toolMs: number
    }
    requestCount?: number
}): void {
    let output: string = ''

    // 第一行：生成完成提示
    let firstLine = ''
    if (status === 'ok') {
        firstLine += chalk.green('✔ Generation completed.')
    } else if (status === 'error') {
        firstLine += chalk.bold.red('× Generation failed.')
    } else if (status === 'ctrl-c') {
        firstLine += chalk.red('⏹ Generation canceled by user.')
    }

    if (usages.length > 0) {
        firstLine += ' Usage details are belows:'
    }

    output += firstLine

    // 第二行：Token 总计与分类
    const secondLine = usages
        .map((u, i) =>
            formatUsageAndCostForSingleModel(u, config)
                .map((text, j) =>
                    j === 0 ? `${i + 1}. ${text}` : `   ${text}`
                )
                .join('\n')
        )
        .join('\n')

    if (usages.length > 0) {
        output += '\n' + secondLine
    }

    const elapsed = ((performance.now() - startTime) / 1000).toFixed(2)

    const timeParts = [chalk.white('Elapsed: ') + chalk.green(`${elapsed}s`)]

    if (timing) {
        timeParts.push(
            chalk.gray(
                `Net ${(timing.netMs / 1000).toFixed(1)}s` +
                    ` Output ${(timing.outMs / 1000).toFixed(1)}s` +
                    ` Tool ${(timing.toolMs / 1000).toFixed(1)}s`
            )
        )
    }

    output += '\n' + timeParts.join('  ·  ') + '\n'

    const countParts: string[] = []
    if (requestCount !== undefined && requestCount > 0) {
        countParts.push(
            chalk.white('Requests: ') + chalk.cyan(requestCount.toString())
        )
    }
    if (toolCallCount > 0) {
        countParts.push(
            chalk.white('Tool calls: ') + chalk.cyan(toolCallCount.toString())
        )
    }
    if (totalCost > 0) {
        countParts.push(
            chalk.white('Total cost: ') + chalk.red(`¥${totalCost.toFixed(6)}`)
        )
    }

    if (countParts.length > 0) {
        output += countParts.join('  ·  ') + '\n'
    }

    if (config.emitToConsole) {
        process.stderr.write(output)
    } else {
        process.stdout.write(output)
    }
}

export type Phase =
    'network' | 'thinking' | 'output' | 'tool' | 'subagent' | 'done'

const PHASE_TEXT: Record<Phase, string> = {
    network: 'Requesting...',
    thinking: 'Thinking...',
    output: 'Generating Answer...',
    tool: 'Call Function...',
    subagent: 'Call Function | Sub Agent Generating...',
    done: 'Done',
}

/** 阶段前缀定宽：按最长文案对齐，避免活动行抖动 */
const PHASE_WIDTH = Math.max(...Object.values(PHASE_TEXT).map(s => s.length))

/**
 * 实时进度面板：只做阶段计时与渲染，时序由 session 的 setPhase 插桩驱动。
 * 活动行（\r + \x1b[2K 原子重绘）是唯一被擦除重绘的行；
 * 固化行以换行追加后永不擦除，自然上卷。
 */
export class ProgressPanel {
    readonly enabled: boolean

    private readonly config: Config

    private netMs = 0
    private outMs = 0
    private toolMs = 0
    private currentPhase: Phase = 'network'
    private phaseStart = 0
    private roundOutMs = 0

    // 正在执行的工具名（tool/subagent 阶段显示在活动行）
    private pendingToolNames: string[] = []

    private roundIndex = 0
    private outputCount = 0
    private totalCostAccum = 0

    private readonly startTime = performance.now()
    private lastDrawTime = 0
    private drawTimer: NodeJS.Timeout | null = null
    // 周期重绘：工具执行等无事件期间也让秒数持续走动
    private heartbeat: NodeJS.Timeout | null = null

    constructor(options: { config: Config; enabled: boolean }) {
        this.config = options.config
        this.enabled = options.enabled
        this.phaseStart = performance.now()
    }

    /** 阶段切换（由 session 插桩调用）：结算上一阶段耗时 */
    public setPhase(phase: Phase): void {
        if (!this.enabled) return
        const now = performance.now()
        this.settlePhase(now)
        this.currentPhase = phase
        this.phaseStart = now
        if (phase !== 'tool' && phase !== 'subagent') {
            this.pendingToolNames = []
        }
        this.scheduleDraw()
    }

    /** 本轮正在执行的工具名（tool 阶段显示在活动行） */
    public setPendingToolNames(names: string[]): void {
        this.pendingToolNames = names
        this.scheduleDraw()
    }

    /** 会话结束后的汇总快照（供 printFinalStatus 读取） */
    public get summary(): Readonly<{
        netMs: number
        outMs: number
        toolMs: number
        outputTokens: number
        roundCount: number
        elapsedMs: number
        totalCost: number
    }> {
        return {
            netMs: this.netMs,
            outMs: this.outMs,
            toolMs: this.toolMs,
            outputTokens: this.outputCount,
            roundCount: this.roundIndex,
            elapsedMs: performance.now() - this.startTime,
            totalCost: this.totalCostAccum,
        }
    }

    public close(): void {
        if (!this.enabled) return
        this.stopHeartbeat()
        if (this.drawTimer) {
            clearTimeout(this.drawTimer)
            this.drawTimer = null
        }
        this.eraseLine()
    }

    /** 清空活动行（不重置状态；用于异常转储前让出屏幕） */
    public clear(): void {
        if (!this.enabled) return
        this.stopHeartbeat()
        if (this.drawTimer) {
            clearTimeout(this.drawTimer)
            this.drawTimer = null
        }
        this.eraseLine()
        this.lastDrawTime = 0
    }

    public onRequestStart(): void {
        if (!this.enabled) return
        this.roundIndex += 1
        this.roundOutMs = 0
        this.setPhase('network')
    }

    /** 事件入口：只做 token 计数与 usage 记账，不在此猜测时序 */
    public onEvent(event: StreamEvent): void {
        if (!this.enabled) return
        switch (event.type) {
            case 'reasoning-delta':
                this.outputCount += estimateTokens(event.delta)
                break
            case 'content-delta':
                this.outputCount += estimateTokens(event.delta)
                break
            case 'function-call-delta':
                if (event.delta.type === 'arguments') {
                    this.outputCount += estimateTokens(event.delta.delta)
                }
                break
            case 'response-end':
                this.settlePhase(performance.now())
                this.currentPhase = 'done'
                if (event.usage) {
                    this.commitRound(event.usage)
                }
                break
            default:
                break
        }
        this.scheduleDraw()
    }

    /** 结算当前阶段耗时（thinking/output 同时累计进 roundOutMs 供固化行用） */
    private settlePhase(now: number): void {
        if (!this.phaseStart) return
        const elapsed = now - this.phaseStart
        this.phaseStart = 0
        switch (this.currentPhase) {
            case 'network':
                this.netMs += elapsed
                break
            case 'thinking':
            case 'output':
                this.outMs += elapsed
                this.roundOutMs += elapsed
                break
            case 'tool':
            case 'subagent':
                this.toolMs += elapsed
                break
            case 'done':
                break
        }
    }

    /** 累计成本，verbose 时追加固化行 */
    private commitRound(usage: NormalizedUsage): void {
        const model = usage.model ?? this.config.model
        const cost = computeTokenCostCNY(
            usage,
            getModelGateway(this.config, model).pricing
        )
        if (!isNaN(cost)) {
            this.totalCostAccum += cost
        }
        if (this.config.verbose) {
            this.emitCommittedLine(usage, cost)
        }
    }

    /** 固化行：apt 风格，只含 ASCII 分隔符 */
    private emitCommittedLine(usage: NormalizedUsage, cost: number): void {
        const inS = this.formatCount(usage.input)
        const outS = this.formatCount(usage.output)
        const roundSec = (this.roundOutMs / 1000).toFixed(1)
        const tps =
            this.roundOutMs > 0
                ? `${(usage.output / (this.roundOutMs / 1000)).toFixed(1)} t/s`
                : '-'
        const costS =
            !isNaN(cost) && cost > 0
                ? chalk.yellow(` ¥${cost.toFixed(4)}`)
                : ''

        const line =
            chalk.cyan.bold(`Get ${this.roundIndex}:`) +
            ` in ${inS} out ${outS} ${chalk.gray(tps + ' ' + roundSec + 's')}` +
            costS

        // 活动行不带换行符，追加前必须先擦除，否则固化行拼在同一行
        this.eraseLine()
        process.stdout.write(line + '\n')
        // 重置节流基准，让新活动行立即重绘
        this.lastDrawTime = 0
    }

    /** 节流：两次绘制间隔不小于 16ms；有活动行时启动心跳持续刷新 */
    private scheduleDraw(): void {
        if (!this.enabled) return
        if (this.roundIndex > 0 && !this.heartbeat) {
            this.heartbeat = setInterval(() => this.draw(), 100)
        }
        const now = Date.now()
        const elapsed = now - this.lastDrawTime

        if (elapsed >= 16) {
            if (this.drawTimer) {
                clearTimeout(this.drawTimer)
                this.drawTimer = null
            }
            this.draw()
            return
        }

        if (!this.drawTimer) {
            this.drawTimer = setTimeout(() => {
                this.drawTimer = null
                this.draw()
            }, 16 - elapsed)
        }
    }

    private stopHeartbeat(): void {
        if (this.heartbeat) {
            clearInterval(this.heartbeat)
            this.heartbeat = null
        }
    }

    /** 绘制活动行：`\r` + `\x1b[2K` 原子重绘 */
    private draw(): void {
        this.lastDrawTime = Date.now()
        if (this.roundIndex === 0) return

        const now = performance.now()
        const totalSec = ((now - this.startTime) / 1000).toFixed(1)
        const phaseText = PHASE_TEXT[this.currentPhase].padEnd(PHASE_WIDTH)

        // 只显示阶段 + 轮次 + 总秒数，保证 64 列内不触发终端换行
        const line =
            this.phaseColor(phaseText) +
            (this.currentPhase === 'tool' && this.pendingToolNames.length > 0
                ? ` [${this.pendingToolNames.join(', ')}]`
                : '') +
            ` ${this.roundIndex} · ${totalSec}s`

        process.stdout.write('\r\x1b[2K' + line)
    }

    private eraseLine(): void {
        process.stdout.write('\r\x1b[2K')
    }

    private phaseColor(text: string): string {
        switch (this.currentPhase) {
            case 'network':
                return chalk.blue(text)
            case 'thinking':
                return chalk.magenta(text)
            case 'output':
                return chalk.green(text)
            case 'tool':
                return chalk.cyan(text)
            case 'subagent':
                return chalk.yellow(text)
            default:
                return chalk.white(text)
        }
    }

    /** 千位紧凑格式：1.2K / 23.1K / 1.2M */
    private formatCount(n: number): string {
        if (n < 1000) return Math.round(n).toString()
        if (n < 1_000_000) {
            const v = n / 1000
            return (v >= 100 ? Math.round(v) : Math.round(v * 10) / 10) + 'K'
        }
        const v = n / 1_000_000
        return (v >= 100 ? Math.round(v) : Math.round(v * 10) / 10) + 'M'
    }
}
