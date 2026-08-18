import type { Config } from './config'
import type { NormalizedUsage } from './utils/usage'
import { computeTokenCostCNY } from './utils/pricing'

import chalk from 'chalk'

export function printWarningMessage(warn: string): void {
    console.warn(chalk.yellow.bold('! Warning ') + chalk.yellow(warn))
}

export function printExceptionMessage(err: unknown): void {
    const error = err instanceof Error ? err : new Error(String(err))

    console.error(chalk.bold.red('× Exception Happens.'))
    console.error(
        chalk.bold.white(error.constructor.name) +
            chalk.white(': ') +
            chalk.white(error.message)
    )

    if (error.stack) {
        const frames = error.stack.split('\n').slice(1, 4)
        for (const frame of frames) {
            console.error(chalk.gray(`  ${frame.trim()}`))
        }
    }
}

export function printFinalStatus(status: {
    usage: NormalizedUsage
    startTime: number
    config: Config
    toolCallCount: number
}): void {
    const { usage, startTime, config, toolCallCount } = status
    const elapsed = ((performance.now() - startTime) / 1000).toFixed(2)

    const fn = (n: number) => n.toLocaleString('en-US')

    // 第一行：生成完成提示
    console.log(chalk.green('✔ Generation completed.'))

    // 第二行：Token 总计与分类
    const cachedPart = usage.cached
        ? ' (' + chalk.gray('cached ') + chalk.gray(fn(usage.cached)) + ') '
        : ''
    const reasoningTokens = usage.thinking
    const thinkingPart = reasoningTokens
        ? ' (' +
          chalk.magenta('thinking ') +
          chalk.magenta(fn(reasoningTokens)) +
          ')'
        : ''
    console.log(
        chalk.white.bold('Total tokens: ') +
            chalk.yellow(fn(usage.input + usage.output)) +
            chalk.italic(
                '  ·  input for ' +
                    chalk.blue(fn(usage.input)) +
                    cachedPart +
                    ', output for ' +
                    chalk.blue(fn(usage.output)) +
                    thinkingPart
            )
    )

    // 第三行：时间、基本信息、预估花费（如果有）、工具调用次数（如果有）
    let thirdLine =
        chalk.white('Model: ') +
        config.model +
        chalk.white(' Elapsed time: ') +
        chalk.green(`${elapsed}s`)

    const cost = computeTokenCostCNY(usage, config.model)
    if (!isNaN(cost)) {
        thirdLine +=
            '  ·  ' +
            chalk.white('Estimated cost: ') +
            chalk.red(`¥${cost.toFixed(6)}`)
    }

    if (toolCallCount > 0) {
        thirdLine +=
            '  ·  ' +
            chalk.white('Total tool calls: ') +
            chalk.cyan(toolCallCount.toString())
    }
    console.log(thirdLine)
}

export class ProgressReporter {
    private totalTokens = 0
    private prompt = ''
    private startTime = 0
    private lastDrawTime = 0
    private drawTimer: NodeJS.Timeout | null = null
    private timingTimer: NodeJS.Timeout

    constructor(prompt: string = 'Generating...') {
        this.setPrompt(prompt)
        this.timingTimer = setInterval(() => this.update(0), 1000)
    }

    public close() {
        this.clear()
        clearTimeout(this.timingTimer)
    }

    public setPrompt(prompt: string) {
        this.prompt = prompt
    }

    /**
     * 更新进度，增加 token 数量并在满足条件时刷新显示
     * @param delta 本次新增的 token 数量
     */
    public update(delta: number): void {
        this.totalTokens += delta
        if (!this.startTime) {
            this.startTime = Date.now()
        }
        this.scheduleDraw()
    }

    public clear(): void {
        // 清除待执行的绘制
        if (this.drawTimer) {
            clearTimeout(this.drawTimer)
            this.drawTimer = null
        }
        process.stdout.clearLine(0)
        process.stdout.cursorTo(0)
        // 不重置累计 token 与开始时间，允许再次 update 继续
        this.lastDrawTime = 0
    }

    /**
     * 节流调度：保证两次实际绘制间隔不小于 16ms
     */
    private scheduleDraw(): void {
        const now = Date.now()
        const elapsed = now - this.lastDrawTime

        // 超过节流间隔：立即绘制并取消任何挂起定时器
        if (elapsed >= 16) {
            if (this.drawTimer) {
                clearTimeout(this.drawTimer)
                this.drawTimer = null
            }
            this.draw()
            return
        }

        // 尚未到达节流间隔且没有挂起定时器时，安排一次延迟绘制
        if (!this.drawTimer) {
            this.drawTimer = setTimeout(() => {
                this.drawTimer = null
                this.draw()
            }, 16 - elapsed)
        }
    }

    /**
     * 实际绘制进度行
     */
    private draw(): void {
        const now = Date.now()
        this.lastDrawTime = now

        // 未开始计时（例如尚未调用 update）则不绘制
        if (!this.startTime) return

        const elapsedSec = (now - this.startTime) / 1000
        const tokensPerSec = elapsedSec > 0 ? this.totalTokens / elapsedSec : 0

        const promptPart = this.prompt.padEnd(45, ' ')
        const tokensPart = chalk.yellow.bold(
            `${this.totalTokens.toString().padStart(8, ' ')} tokens`
        )
        const ratePart = chalk.green(`${tokensPerSec.toFixed(1)} t/s`)
        const timePart = chalk.gray(`${Math.floor(elapsedSec)}s`)

        const line = `${promptPart}${tokensPart} | ${ratePart} | ${timePart}`

        // 清除当前行并输出
        process.stdout.clearLine(0)
        process.stdout.cursorTo(0)
        process.stdout.write(line)
    }
}
