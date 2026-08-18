import type { Usage } from '../types/openaiApi'

export interface NormalizedUsage {
    input: number
    output: number
    cached: number
    thinking: number
}

const isNorm = (usage: Usage | NormalizedUsage): usage is NormalizedUsage =>
    Object.prototype.hasOwnProperty.call(usage, 'input')

export function normalizeUsage(
    usage: Usage | NormalizedUsage
): NormalizedUsage {
    if (isNorm(usage)) {
        return usage
    }
    return {
        input: usage.prompt_tokens,
        output: usage.completion_tokens,
        cached:
            usage.prompt_cache_hit_tokens ||
            usage.prompt_tokens_details?.cached_tokens ||
            0,
        thinking: usage.completion_tokens_details?.reasoning_tokens || 0,
    }
}

export function mergeNormalizedUsage(
    a: NormalizedUsage,
    b: NormalizedUsage
): NormalizedUsage {
    return {
        input: a.input + b.input,
        output: a.output + b.output,
        cached: a.cached + b.cached,
        thinking: a.thinking + b.thinking,
    }
}
