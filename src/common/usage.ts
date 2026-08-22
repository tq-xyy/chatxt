export interface NormalizedUsage {
    input: number
    output: number
    cached: number
    thinking: number
    model?: string
}

export function mergeNormalizedUsages(
    a: NormalizedUsage | NormalizedUsage[],
    b: NormalizedUsage | NormalizedUsage[]
): NormalizedUsage[] {
    a = Array.isArray(a) ? a : [a]
    b = Array.isArray(b) ? b : [b]
    const usages = [...a, ...b]

    const usageByPricing = new Map<string | undefined, NormalizedUsage>()

    for (const usage of usages) {
        const prev = usageByPricing.get(usage.model)
        if (prev) {
            usageByPricing.set(usage.model, {
                input: prev.input + usage.input,
                output: prev.output + usage.output,
                cached: prev.cached + usage.cached,
                thinking: prev.thinking + usage.thinking,
                model: usage.model,
            })
        } else {
            usageByPricing.set(usage.model, usage)
        }
    }
    return [...usageByPricing.values()]
}
