import type { Pricing } from '../pricing'

export const USD_TO_CNY = 6.72 // 2026/8/27 update

export const modelOfficalPricing: Record<string, Pricing | Pricing[]> = {
    // https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
    'deepseek-v4-flash': [
        // off-peak
        {
            input: 1.5,
            output: 4.5,
            cached: 0.05,
            currency: 'CNY',
            limitions: [{ type: 'utc-time', from: 4, to: 6 }],
        },
        {
            input: 1.5,
            output: 4.5,
            cached: 0.05,
            currency: 'CNY',
            limitions: [{ type: 'utc-time', from: 10, to: 24 }],
        },
        // peak
        {
            input: 3.0,
            output: 9.0,
            cached: 0.1,
            currency: 'CNY',
            limitions: [{ type: 'utc-time', from: 1, to: 4 }],
        },
        {
            input: 3.0,
            output: 9.0,
            cached: 0.1,
            currency: 'CNY',
            limitions: [{ type: 'utc-time', from: 6, to: 10 }],
        },
    ],
    'deepseek-v4-flash-vision-exp': [
        // off-peak
        {
            input: 1.5,
            output: 4.5,
            cached: 0.05,
            currency: 'CNY',
            limitions: [{ type: 'utc-time', from: 4, to: 6 }],
        },
        {
            input: 1.5,
            output: 4.5,
            cached: 0.05,
            currency: 'CNY',
            limitions: [{ type: 'utc-time', from: 10, to: 24 }],
        },
        // peak
        {
            input: 3.0,
            output: 9.0,
            cached: 0.1,
            currency: 'CNY',
            limitions: [{ type: 'utc-time', from: 1, to: 4 }],
        },
        {
            input: 3.0,
            output: 9.0,
            cached: 0.1,
            currency: 'CNY',
            limitions: [{ type: 'utc-time', from: 6, to: 10 }],
        },
    ],

    'deepseek-v4-pro': [
        // off-peak
        {
            input: 4.5,
            output: 13.5,
            cached: 0.15,
            currency: 'CNY',
            limitions: [{ type: 'utc-time', from: 4, to: 6 }],
        },
        {
            input: 4.5,
            output: 13.5,
            cached: 0.15,
            currency: 'CNY',
            limitions: [{ type: 'utc-time', from: 10, to: 24 }],
        },
        // peak
        {
            input: 9.0,
            output: 27.0,
            cached: 0.3,
            currency: 'CNY',
            limitions: [{ type: 'utc-time', from: 1, to: 4 }],
        },
        {
            input: 9.0,
            output: 27.0,
            cached: 0.3,
            currency: 'CNY',
            limitions: [{ type: 'utc-time', from: 6, to: 10 }],
        },
    ],

    // https://grok.docs-zh.com/zh-CN/developers/pricing （短上下文 < 200k）
    'grok-4.6': [
        {
            input: 2.0,
            output: 6.0,
            cached: 0.3,
            currency: 'USD',
            limitions: [{ type: 'input-context', lessthan_k: 200 }],
        },
        {
            input: 4.0,
            output: 12.0,
            cached: 0.6,
            currency: 'USD',
            limitions: [{ type: 'input-context', morethan_k: 200 }],
        },
    ],
    'grok-4.5': [
        {
            input: 2.0,
            output: 6.0,
            cached: 0.3,
            currency: 'USD',
            limitions: [{ type: 'input-context', lessthan_k: 200 }],
        },
        {
            input: 4.0,
            output: 12.0,
            cached: 0.6,
            currency: 'USD',
            limitions: [{ type: 'input-context', morethan_k: 200 }],
        },
    ],

    // https://devtk.ai/zh/blog/openai-api-pricing-guide-2026/
    'gpt-5.6-luna': {
        input: 0.2,
        output: 1.2,
        cached: 0.02,
        currency: 'USD',
    },

    // https://platform.kimi.com/docs/pricing/chat
    'kimi-k3': {
        input: 20,
        output: 100,
        cached: 2,
        currency: 'CNY',
    },
    'kimi-k2.7-code': {
        input: 6.5,
        output: 27,
        cached: 1,
        currency: 'CNY',
    },
    'kimi-k2.6': {
        input: 6.5,
        output: 27,
        cached: 1.1,
        currency: 'CNY',
    },

    // https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go
    'mimo-v2.5-pro': {
        input: 3,
        output: 6,
        cached: 0.025,
        currency: 'CNY',
    },
    'mimo-v2.5': {
        input: 1,
        output: 2,
        cached: 0.02,
        currency: 'CNY',
    },

    // https://hy.tencent.com/model/open-source-model/detail?id=hy3
    hy3: {
        input: 1,
        output: 4,
        cached: 0.25,
        currency: 'CNY',
    },

    // https://platform.minimaxi.com/docs/guides/pricing-paygo
    'minimax-m3': [
        {
            input: 2.1,
            output: 8.4,
            cached: 0.42,
            currency: 'CNY',
            limitions: [{ type: 'input-context', lessthan_k: 512 }],
        },
        {
            input: 4.2,
            output: 16.8,
            cached: 0.84,
            currency: 'CNY',
            limitions: [{ type: 'input-context', morethan_k: 512 }],
        },
    ],
    'minimax-m2.7': {
        input: 2.1,
        output: 8.4,
        cached: 0.42,
        currency: 'CNY',
    },

    // https://help.aliyun.com/zh/model-studio/model-pricing
    'qwen3.8-max': {
        input: 12,
        output: 36,
        cached: 2.4,
        currency: 'CNY',
    },
    'qwen3.7-max': {
        // 限时 5 折
        input: 6,
        output: 18,
        cached: 1.2,
        currency: 'CNY',
    },
    'qwen3.7-plus': {
        // 限时 8 折
        input: 2.8,
        output: 19.2,
        cached: 0.56,
        currency: 'CNY',
    },
    'qwen3.6-plus': {
        input: 2,
        output: 12,
        cached: 12,
        currency: 'CNY',
    },

    // https://longcat.chat/platform/docs/zh/api-pay-as-you-go
    'longcat-2.0': {
        input: 2,
        output: 8,
        cached: 0.04,
        currency: 'CNY',
    },

    // https://open.bigmodel.cn/pricing
    'glm-5.3-flash': {
        // 50% off in two next weeks (start 2026/08/27)
        input: 0.4,
        output: 1.4,
        cached: 0.1,
        currency: 'CNY',
    },
    'glm-5.3': {
        input: 8,
        output: 28,
        cached: 2,
        currency: 'CNY',
    },
    'glm-5.2': {
        input: 8,
        output: 28,
        cached: 2,
        currency: 'CNY',
    },
    'glm-5.1': [
        {
            input: 6,
            output: 24,
            cached: 1.3,
            currency: 'CNY',
            limitions: [{ type: 'input-context', lessthan_k: 32 }],
        },
        {
            input: 8,
            output: 28,
            cached: 2,
            currency: 'CNY',
            limitions: [{ type: 'input-context', morethan_k: 32 }],
        },
    ],
    'glm-5-turbo': [
        {
            input: 5,
            output: 22,
            cached: 1.2,
            currency: 'CNY',
            limitions: [{ type: 'input-context', lessthan_k: 32 }],
        },
        {
            input: 7,
            output: 26,
            cached: 1.8,
            currency: 'CNY',
            limitions: [{ type: 'input-context', morethan_k: 32 }],
        },
    ],
    'glm-5': [
        {
            input: 4,
            output: 18,
            cached: 1,
            currency: 'CNY',
            limitions: [{ type: 'input-context', lessthan_k: 32 }],
        },
        {
            input: 6,
            output: 22,
            cached: 1.5,
            currency: 'CNY',
            limitions: [{ type: 'input-context', morethan_k: 32 }],
        },
    ],
    'glm-4.7': [
        {
            input: 2,
            output: 8,
            cached: 0.4,
            currency: 'CNY',
            limitions: [
                { type: 'input-context', lessthan_k: 32 },
                { type: 'output-context', lessthan_k: 0.2 },
            ],
        },
        {
            input: 3,
            output: 14,
            cached: 0.6,
            currency: 'CNY',
            limitions: [
                { type: 'input-context', lessthan_k: 32 },
                { type: 'output-context', morethan_k: 0.2 },
            ],
        },
        {
            input: 4,
            output: 16,
            cached: 0.8,
            currency: 'CNY',
            limitions: [{ type: 'input-context', morethan_k: 32 }],
        },
    ],
    'glm-4.5-air': [
        {
            input: 0.8,
            output: 2,
            cached: 0.16,
            currency: 'CNY',
            limitions: [
                { type: 'input-context', lessthan_k: 32 },
                { type: 'output-context', lessthan_k: 0.2 },
            ],
        },
        {
            input: 0.8,
            output: 6,
            cached: 0.16,
            currency: 'CNY',
            limitions: [
                { type: 'input-context', lessthan_k: 32 },
                { type: 'output-context', morethan_k: 0.2 },
            ],
        },
        {
            input: 1.2,
            output: 8,
            cached: 0.24,
            currency: 'CNY',
            limitions: [{ type: 'input-context', morethan_k: 32 }],
        },
    ],
    'glm-4.7-flashx': {
        input: 0.5,
        output: 3,
        cached: 0.1,
        currency: 'CNY',
    },
    'glm-4.7-flash': {
        input: 0,
        output: 0,
        currency: 'CNY',
    },

    'glm-5v-turbo': [
        {
            input: 5,
            output: 22,
            cached: 1.2,
            currency: 'CNY',
            limitions: [{ type: 'input-context', lessthan_k: 32 }],
        },
        {
            input: 7,
            output: 26,
            cached: 1.8,
            currency: 'CNY',
            limitions: [{ type: 'input-context', morethan_k: 32 }],
        },
    ],
    'glm-4.6v': [
        {
            input: 1,
            output: 3,
            cached: 0.2,
            currency: 'CNY',
            limitions: [{ type: 'input-context', lessthan_k: 32 }],
        },
        {
            input: 2,
            output: 6,
            cached: 0.4,
            currency: 'CNY',
            limitions: [{ type: 'input-context', morethan_k: 32 }],
        },
    ],
    'glm-4.6v-flashx': [
        {
            input: 0.15,
            output: 1.5,
            cached: 0.03,
            currency: 'CNY',
            limitions: [{ type: 'input-context', lessthan_k: 32 }],
        },
        {
            input: 0.3,
            output: 3,
            cached: 0.03,
            currency: 'CNY',
            limitions: [{ type: 'input-context', morethan_k: 32 }],
        },
    ],
    'glm-4.6v-flash': {
        input: 0,
        output: 0,
        currency: 'CNY',
    },
    'glm-4.5v': [
        {
            input: 2,
            output: 6,
            cached: 0.4,
            currency: 'CNY',
            limitions: [{ type: 'input-context', lessthan_k: 32 }],
        },
        {
            input: 4,
            output: 12,
            cached: 0.8,
            currency: 'CNY',
            limitions: [{ type: 'input-context', morethan_k: 32 }],
        },
    ],

    // GLM-4 老系列
    'glm-4-plus': { input: 5, output: 5, currency: 'CNY' },
    'glm-4-air-250414': { input: 0.5, output: 0.5, currency: 'CNY' },
    'glm-4-airx': { input: 10, output: 10, currency: 'CNY' },
    'glm-4-long': { input: 1, output: 1, currency: 'CNY' },
    'glm-4-assistant': { input: 5, output: 5, currency: 'CNY' },
    'glm-z1-air': { input: 0.5, output: 0.5, currency: 'CNY' },
    'glm-z1-airx': { input: 5, output: 5, currency: 'CNY' },
    'glm-z1-flashx': { input: 0.1, output: 0.1, currency: 'CNY' },
    'glm-4-flashx-250414': { input: 0.1, output: 0.1, currency: 'CNY' },
    'glm-4-flash-250414': { input: 0, output: 0, currency: 'CNY' },
    'glm-z1-flash': { input: 0, output: 0, currency: 'CNY' },
    'glm-ocr': { input: 0.2, output: 0.2, currency: 'CNY' },
    'glm-4v-plus-0111': { input: 4, output: 4, currency: 'CNY' },
    'glm-4v-flash': { input: 0, output: 0, currency: 'CNY' },
    'glm-4.1v-thinking-flashx': { input: 2, output: 2, currency: 'CNY' },
    'glm-4.1v-thinking-flash': { input: 0, output: 0, currency: 'CNY' },
}
