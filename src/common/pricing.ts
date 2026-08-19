import type { NormalizedUsage } from './usage'

const USD_TO_CNY = 6.74 // 2026/8/18

export interface Pricing {
    pricingPerMillionTokens: {
        input: number
        output: number
        cached: number
    }
    pricingCurrency: 'CNY' | 'USD'
}

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

// 2026/08/18
const estimatedModelPricing: Record<string, Pricing> = {
    // https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
    'deepseek-v4-flash/off-peak': {
        pricingPerMillionTokens: { input: 1.5, output: 4.5, cached: 0.05 },
        pricingCurrency: 'CNY',
    },
    'deepseek-v4-flash/peak': {
        pricingPerMillionTokens: { input: 3.0, output: 9.0, cached: 0.1 },
        pricingCurrency: 'CNY',
    },
    'deepseek-v4-pro/off-peak': {
        pricingPerMillionTokens: { input: 4.5, output: 13.5, cached: 0.15 },
        pricingCurrency: 'CNY',
    },
    'deepseek-v4-pro/peak': {
        pricingPerMillionTokens: { input: 9.0, output: 27.0, cached: 0.3 },
        pricingCurrency: 'CNY',
    },

    // https://grok.docs-zh.com/zh-CN/developers/pricing （短上下文 < 200k）
    'grok-4.5': {
        pricingPerMillionTokens: { input: 2.0, output: 6.0, cached: 0.3 },
        pricingCurrency: 'USD',
    },

    // https://devtk.ai/zh/blog/openai-api-pricing-guide-2026/
    'gpt-5.6-luna': {
        pricingPerMillionTokens: { input: 0.2, output: 1.2, cached: 0.02 },
        pricingCurrency: 'USD',
    },

    // https://platform.kimi.com
    'kimi-k3': {
        pricingPerMillionTokens: { input: 20, output: 100, cached: 2 },
        pricingCurrency: 'CNY',
    },
    'kimi-k2.7-code': {
        pricingPerMillionTokens: { input: 6.5, output: 27, cached: 1 },
        pricingCurrency: 'CNY',
    },
    'kimi-k2.6': {
        pricingPerMillionTokens: { input: 6.5, output: 27, cached: 1.1 },
        pricingCurrency: 'CNY',
    },

    // https://mimo.mi.com
    'mimo-v2.5-pro': {
        pricingPerMillionTokens: { input: 3, output: 6, cached: 0.025 },
        pricingCurrency: 'CNY',
    },
    'mimo-v2.5': {
        pricingPerMillionTokens: { input: 1, output: 2, cached: 0.02 },
        pricingCurrency: 'CNY',
    },

    // https://hy.tencent.com
    hy3: {
        pricingPerMillionTokens: { input: 1, output: 4, cached: 0.25 },
        pricingCurrency: 'CNY',
    },

    // https://platform.minimaxi.com/docs/guides/pricing-paygo
    'minimax-m3': {
        pricingPerMillionTokens: { input: 2.1, output: 8.4, cached: 0.42 },
        pricingCurrency: 'CNY',
    },
    'minimax-m2.7': {
        pricingPerMillionTokens: { input: 2.1, output: 8.4, cached: 0.42 },
        pricingCurrency: 'CNY',
    },

    // https://open.bigmodel.cn/pricing
    'glm-5.3': {
        pricingPerMillionTokens: { input: 8, output: 28, cached: 2 },
        pricingCurrency: 'CNY',
    },
    'glm-5.2': {
        pricingPerMillionTokens: { input: 8, output: 28, cached: 2 },
        pricingCurrency: 'CNY',
    },
    'glm-5.1': {
        pricingPerMillionTokens: { input: 8, output: 28, cached: 2 },
        pricingCurrency: 'CNY',
    },

    // https://help.aliyun.com/zh/model-studio/model-pricing
    'qwen3.8-max': {
        pricingPerMillionTokens: { input: 12, output: 36, cached: 2.4 },
        pricingCurrency: 'CNY',
    },
    'qwen3.7-max': {
        // 限时 5 折
        pricingPerMillionTokens: { input: 6, output: 18, cached: 1.2 },
        pricingCurrency: 'CNY',
    },
    'qwen3.7-plus': {
        // 限时 8 折
        pricingPerMillionTokens: { input: 2.8, output: 19.2, cached: 0.56 },
        pricingCurrency: 'CNY',
    },
    'qwen3.6-plus': {
        pricingPerMillionTokens: { input: 2, output: 12, cached: 12 },
        pricingCurrency: 'CNY',
    },
}

export function computeTokenCostCNY(
    tokenUsage: NormalizedUsage,
    model: string
): number
export function computeTokenCostCNY(
    tokenUsage: NormalizedUsage,
    pricing: Pricing
): number
export function computeTokenCostCNY(
    tokenUsage: NormalizedUsage,
    pricing: string | Pricing
): number
export function computeTokenCostCNY(
    tokenUsage: NormalizedUsage,
    pricing: string | Pricing
): number {
    const { input, output, cached } = tokenUsage
    const cachedInput = cached ?? 0
    const nonCachedInput = input - cachedInput

    if (typeof pricing === 'string') {
        // DeepSeek 按当前时段拼接定价键: deepseek-v4-flash/peak 等
        const resolvedModel = pricing.startsWith('deepseek-v4-')
            ? `${pricing}/${isDeepSeekPeakHour(new Date()) ? 'peak' : 'off-peak'}`
            : pricing

        pricing = estimatedModelPricing[resolvedModel]
    }

    if (!pricing) {
        return NaN
    }

    const p = pricing.pricingPerMillionTokens
    const rate = pricing.pricingCurrency === 'USD' ? USD_TO_CNY : 1

    return (
        (cachedInput / 1_000_000) * p.cached * rate +
        (nonCachedInput / 1_000_000) * p.input * rate +
        (output / 1_000_000) * p.output * rate
    )
}
