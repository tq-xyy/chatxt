import type { ChatCompletionResponse } from '../types/openaiApi'

type Usage = NonNullable<ChatCompletionResponse['usage']>

export function computeTokenCostCNY(tokenUsage: Usage, model: string): number {
    if (model === 'deepseek-v4-flash') {
        return (
            (tokenUsage.prompt_cache_hit_tokens * 0.02 +
                tokenUsage.prompt_cache_miss_tokens * 1 +
                tokenUsage.completion_tokens * 2) /
            1_000_000
        )
    } else if (model === 'deepseek-v4-pro') {
        return (
            (tokenUsage.prompt_cache_hit_tokens * 0.025 +
                tokenUsage.prompt_cache_miss_tokens * 3 +
                tokenUsage.completion_tokens * 6) /
            1_000_000
        )
    } else {
        return -1.0
    }
}
