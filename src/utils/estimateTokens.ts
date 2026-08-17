/**
 * 粗略估算中英混合文本的 token 数量（TypeScript 版）
 *
 * 规则：
 * - 中文字符（Unicode 基本汉字 \u4e00-\u9fff）：每个计 0.6 token
 * - 非中文字符（英文、数字、标点、空格等）：每个计 0.3 token
 * - 返回保留两位小数的浮点数
 *
 * @param text 输入文本
 * @returns 估算的 token 数量
 */
export function estimateTokens(text: string): number {
    // 匹配中文字符（基本汉字）
    const chineseRegex = /[\u4e00-\u9fff]/g
    const chineseMatches = text.match(chineseRegex)
    const chineseCount = chineseMatches ? chineseMatches.length : 0

    // 移除中文字符后剩余字符数
    const nonChineseText = text.replace(chineseRegex, '')
    const nonChineseCount = nonChineseText.length

    // 按比例计算
    const tokens = chineseCount * 0.6 + nonChineseCount * 0.3
    return Math.round(tokens)
}
