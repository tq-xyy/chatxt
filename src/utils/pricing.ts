import type { NormalizedUsage } from './computeCost'

const USD_TO_CNY = 6.74 // 2026/8/18

/**
 * 判断当前是否为 DeepSeek 高峰时段
 * 高峰时段: 北京时间 9:00-12:00、14:00-18:00
 * 北京时间 = UTC+8
 */
function isDeepSeekPeakHour(now: Date): boolean {
    const utcHour = now.getUTCHours()
    const utcMin = now.getUTCMinutes()
    const beijingMinutes = ((utcHour + 8) % 24) * 60 + utcMin

    // 9:00-12:00 → 540-720
    // 14:00-18:00 → 840-1080
    return (
        (beijingMinutes >= 540 && beijingMinutes < 720) ||
        (beijingMinutes >= 840 && beijingMinutes < 1080)
    )
}

export function computeTokenCostCNY(
    tokenUsage: NormalizedUsage,
    model: string
): number {
    const { input, output, cached } = tokenUsage
    const nonCachedInput = input - cached

    const peak = isDeepSeekPeakHour(new Date())

    // ===== DeepSeek =====
    // https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
    // 空闲时段 = 高峰时段价格的一半
    if (model === 'deepseek-v4-pro') {
        const inputPrice = peak ? 9.0 : 4.5
        const cachedPrice = peak ? 0.3 : 0.15
        const outputPrice = peak ? 27.0 : 13.5
        return (
            (cached / 1_000_000) * cachedPrice +
            (nonCachedInput / 1_000_000) * inputPrice +
            (output / 1_000_000) * outputPrice
        )
    }
    if (model === 'deepseek-v4-flash') {
        const inputPrice = peak ? 3.0 : 1.5
        const cachedPrice = peak ? 0.1 : 0.05
        const outputPrice = peak ? 9.0 : 4.5
        return (
            (cached / 1_000_000) * cachedPrice +
            (nonCachedInput / 1_000_000) * inputPrice +
            (output / 1_000_000) * outputPrice
        )
    }

    // ===== Grok 4.5 (xAI) =====
    // https://grok.docs-zh.com/zh-CN/developers/pricing  (短上下文 < 200k)
    if (model === 'grok-4.5') {
        const inputUSD = 2.0
        const cachedUSD = 0.3
        const outputUSD = 6.0
        return (
            (cached / 1_000_000) * cachedUSD * USD_TO_CNY +
            (nonCachedInput / 1_000_000) * inputUSD * USD_TO_CNY +
            (output / 1_000_000) * outputUSD * USD_TO_CNY
        )
    }

    // ===== GPT 5.6 Luna (OpenAI) =====
    if (model === 'gpt-5.6-luna') {
        const inputUSD = 0.2
        const outputUSD = 1.2
        // 未提及缓存折扣
        return (
            (input / 1_000_000) * inputUSD * USD_TO_CNY +
            (output / 1_000_000) * outputUSD * USD_TO_CNY
        )
    }

    // ===== Kimi (月之暗面) =====
    // https://platform.kimi.com
    if (model === 'kimi-k3') {
        return (input / 1_000_000) * 20 + (output / 1_000_000) * 100
    }
    if (model === 'kimi-k2.7-code') {
        return (input / 1_000_000) * 6.5 + (output / 1_000_000) * 27
    }
    if (model === 'kimi-k2.6') {
        return (input / 1_000_000) * 6.5 + (output / 1_000_000) * 27
    }

    // ===== MiMo (小米) =====
    // https://mimo.mi.com
    if (model === 'mimo-v2.5-pro') {
        return (
            (cached / 1_000_000) * 0.025 +
            (nonCachedInput / 1_000_000) * 3 +
            (output / 1_000_000) * 6
        )
    }
    if (model === 'mimo-v2.5') {
        return (
            (cached / 1_000_000) * 0.02 +
            (nonCachedInput / 1_000_000) * 1 +
            (output / 1_000_000) * 2
        )
    }

    // ===== Hy3 (腾讯混元) =====
    // https://hy.tencent.com
    if (model === 'hy3') {
        return (
            (cached / 1_000_000) * 0.25 +
            (nonCachedInput / 1_000_000) * 1 +
            (output / 1_000_000) * 4
        )
    }

    // ===== MiniMax =====
    // https://platform.minimaxi.com/docs/guides/pricing-paygo
    if (model === 'minimax-m3') {
        return (
            (cached / 1_000_000) * 0.42 +
            (nonCachedInput / 1_000_000) * 2.1 +
            (output / 1_000_000) * 8.4
        )
    }
    if (model === 'minimax-m2.7') {
        return (
            (cached / 1_000_000) * 0.42 +
            (nonCachedInput / 1_000_000) * 2.1 +
            (output / 1_000_000) * 8.4
        )
    }

    // ===== GLM (智谱) =====
    // https://open.bigmodel.cn/pricing
    // GLM-5.3 — 智谱官方未公开定价
    if (model === 'glm-5.2') {
        return (
            (cached / 1_000_000) * 2 +
            (nonCachedInput / 1_000_000) * 8 +
            (output / 1_000_000) * 28
        )
    }
    if (model === 'glm-5.1') {
        return (
            (cached / 1_000_000) * 2 +
            (nonCachedInput / 1_000_000) * 8 +
            (output / 1_000_000) * 28
        )
    }

    // unknown model
    return -1.0
}
