import type { Usage } from '../types/openaiApi'

export function mergeUsage(a: Usage, b: Usage): Usage {
    return {
        completion_tokens: a.completion_tokens + b.completion_tokens,
        prompt_tokens: a.prompt_tokens + b.prompt_tokens,
        prompt_cache_hit_tokens:
            a.prompt_cache_hit_tokens + b.prompt_cache_hit_tokens,
        prompt_cache_miss_tokens:
            a.prompt_cache_miss_tokens + b.prompt_cache_miss_tokens,
        total_tokens: a.total_tokens + b.total_tokens,
        completion_tokens_details: {
            reasoning_tokens:
                (a.completion_tokens_details?.reasoning_tokens ?? 0) +
                (b.completion_tokens_details?.reasoning_tokens ?? 0),
        },
    }
}

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
