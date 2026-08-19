export interface NormalizedUsage {
    input: number
    output: number
    cached: number
    thinking: number
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
