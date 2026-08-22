import type { NormalizedUsage } from './usage'
import { modelOfficalPricing, USD_TO_CNY } from './data/model-pricing'

type Limition =
    | {
          type: 'utc-time'
          /** unit: hours (1-24) */
          from: number
          /** unit: hours (1-24), must be large than `from` */
          to: number
      }
    | {
          type: 'input-context'
          // All or any is ok
          /** unit: `K` */
          morethan_k?: number
          /** unit: `K` */
          lessthan_k?: number
      }
    | {
          type: 'output-context'
          // All or any is ok
          /** unit: `K` */
          morethan_k?: number
          /** unit: `K` */
          lessthan_k?: number
      }

export interface Pricing {
    input: number
    output: number
    /** by default equals to `input` */
    cached?: number

    /** defaults to `USD` */
    currency: 'USD' | 'CNY'

    /** limitions are contacted by AND operations */
    limitions?: Limition[]
}

export function computeTokenCostCNY(
    tokenUsage: NormalizedUsage,
    pricing: string | Pricing | Pricing[] | undefined
): number {
    const { input, output } = tokenUsage
    const cachedInput = Math.min(tokenUsage.cached ?? 0, input)
    const nonCachedInput = input - cachedInput

    if (typeof pricing === 'string') {
        pricing = modelOfficalPricing[pricing]
    }

    if (Array.isArray(pricing)) {
        const pricingCases = [...pricing]
        pricing = undefined
        for (const pricingCase of pricingCases) {
            let useCase: boolean = true
            if (pricingCase.limitions) {
                for (const limit of pricingCase.limitions) {
                    if (limit.type === 'utc-time') {
                        const nowHours = new Date().getUTCHours()
                        if (nowHours < limit.from || nowHours >= limit.to) {
                            useCase = false
                        }
                    } else if (limit.type === 'input-context') {
                        const context = tokenUsage.input
                        if (limit.lessthan_k && context >= limit.lessthan_k) {
                            useCase = false
                        }
                        if (limit.morethan_k && context < limit.morethan_k) {
                            useCase = false
                        }
                    } else if (limit.type === 'output-context') {
                        const context = tokenUsage.output
                        if (limit.lessthan_k && context >= limit.lessthan_k) {
                            useCase = false
                        }
                        if (limit.morethan_k && context < limit.morethan_k) {
                            useCase = false
                        }
                    }
                }
            }
            if (useCase) {
                pricing = pricingCase
                break
            }
        }
    }

    if (!pricing) {
        return NaN
    }

    const rate = pricing.currency === 'USD' ? USD_TO_CNY : 1

    return (
        (cachedInput / 1_000_000) * (pricing.cached || pricing.input) * rate +
        (nonCachedInput / 1_000_000) * pricing.input * rate +
        (output / 1_000_000) * pricing.output * rate
    )
}
