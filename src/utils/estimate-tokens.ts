import { loadDataWithAutoExt } from './file-utils'
import { DATA_DIR } from './meta'

const PAIR_SEPARATOR = '\u0000'

function buildMergeRanks(source: string): Map<string, number> {
    const mergeRanks = new Map<string, number>()
    const lines = source.split('\n')

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        const spaceIndex = line.indexOf(' ')
        if (spaceIndex > 0) {
            mergeRanks.set(
                line.slice(0, spaceIndex) +
                    PAIR_SEPARATOR +
                    line.slice(spaceIndex + 1),
                i
            )
        }
    }
    return mergeRanks
}

const MERGE_RANKS: Map<string, number> = buildMergeRanks(
    await loadDataWithAutoExt(DATA_DIR, 'deepseek-merges' /* .txt */)
)

class MinHeap<T> {
    private items: T[] = []

    constructor(
        private readonly compare: (a: T, b: T) => number = (a, b) =>
            a < b ? -1 : a > b ? 1 : 0
    ) {}

    get size(): number {
        return this.items.length
    }

    push(value: T): void {
        const items = this.items
        items.push(value)
        let i = items.length - 1
        while (i > 0) {
            const parentIndex = (i - 1) >> 1
            if (this.compare(items[parentIndex], items[i]) <= 0) break
            const temp = items[parentIndex]
            items[parentIndex] = items[i]
            items[i] = temp
            i = parentIndex
        }
    }

    pop(): T | undefined {
        const items = this.items
        if (items.length === 0) return undefined

        const top = items[0]
        const last = items.pop() as T
        if (items.length > 0) {
            items[0] = last
            const length = items.length
            let i = 0
            while (true) {
                const leftChild = i * 2 + 1
                if (leftChild >= length) break
                const rightChild = leftChild + 1
                const smallerChild =
                    rightChild < length &&
                    this.compare(items[rightChild], items[leftChild]) < 0
                        ? rightChild
                        : leftChild
                if (this.compare(items[smallerChild], items[i]) >= 0) break
                const temp = items[i]
                items[i] = items[smallerChild]
                items[smallerChild] = temp
                i = smallerChild
            }
        }
        return top
    }
}

const BYTE_TO_CHAR_TABLE: string[] = (() => {
    const table: string[] = new Array(256)
    let nonPrintableOffset = 0
    for (let byteValue = 0; byteValue < 256; byteValue++) {
        const printable =
            (byteValue >= 0x21 && byteValue <= 0x7e) ||
            (byteValue >= 0xa1 && byteValue <= 0xac) ||
            (byteValue >= 0xae && byteValue <= 0xff)
        table[byteValue] = String.fromCharCode(
            printable ? byteValue : 0x100 + nonPrintableOffset++
        )
    }
    return table
})()

const textEncoder = new TextEncoder()

function byteLevel(input: string): string {
    const bytes = textEncoder.encode(input)
    let result = ''
    for (let i = 0; i < bytes.length; i++) {
        result += BYTE_TO_CHAR_TABLE[bytes[i]]
    }
    return result
}

// 正则的空白必须写 \p{White_Space}，不能用 JS 的 \s (\s 多算 U+FEFF、漏掉 U+0085，会让切分位置不同)
const PRE_TOKENIZE_RULES: RegExp[] = [
    /\p{N}{1,3}/gu,
    /[\u4e00-\u9fa5\u3040-\u309f\u30a0-\u30ff]+/gu,
    /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~][A-Za-z]+|[^\r\n\p{L}\p{P}\p{S}]?[\p{L}\p{M}]+| ?[\p{P}\p{S}]+[\r\n]*|[\p{White_Space}]*[\r\n]+|[\p{White_Space}]+(?![^\p{White_Space}])|[\p{White_Space}]+/gu,
]

/** Split(behavior=Isolated)：命中片段各自成片，空隙也各自成片，空片段丢弃。 */
function splitIsolated(inputText: string, pattern: RegExp): string[] {
    const pieces: string[] = []
    let previousEnd = 0
    pattern.lastIndex = 0
    for (
        let match = pattern.exec(inputText);
        match;
        match = pattern.exec(inputText)
    ) {
        const start = match.index
        const end = start + match[0].length
        if (start > previousEnd) {
            pieces.push(inputText.slice(previousEnd, start))
        }
        if (end > start) {
            pieces.push(match[0])
        }
        previousEnd = end
        if (end === start) {
            pattern.lastIndex++
        }
    }
    if (previousEnd < inputText.length) {
        pieces.push(inputText.slice(previousEnd))
    }
    return pieces
}

function preTokenize(inputText: string): string[] {
    let currentPieces: string[] = [inputText]
    for (const pattern of PRE_TOKENIZE_RULES) {
        const nextPieces: string[] = []
        for (const piece of currentPieces) {
            if (!piece) continue
            for (const subPiece of splitIsolated(piece, pattern)) {
                nextPieces.push(subPiece)
            }
        }
        currentPieces = nextPieces
    }
    return currentPieces
}

// 堆的 key 用 rank * 2^21 + pos 构造，必须用乘法而非 << 21 (rank 会溢出 int32)
// pos 需小于 2^21，即单片不超过 200 万字节。
const POSITION_SHIFT = 1 << 21
const POSITION_MASK = POSITION_SHIFT - 1

/**
 * 对单个 ByteLevel 片段做 BPE，返回合并后的符号数。
 * 最小堆按 key 排序（rank 小者优先，同 rank 取左），出堆时用当前符号校验，
 * 过期条目直接跳过。每次合并只补入左右两个新 pair，整体 O(n log n)。
 */
function countBPEMerges(piece: string): number {
    const pieceLength = piece.length
    if (pieceLength <= 1) return pieceLength

    const symbols: string[] = new Array(pieceLength)
    for (let i = 0; i < pieceLength; i++) {
        symbols[i] = piece[i]
    }

    const nextIndices = new Int32Array(pieceLength)
    const prevIndices = new Int32Array(pieceLength)
    const removed = new Uint8Array(pieceLength)
    for (let i = 0; i < pieceLength; i++) {
        nextIndices[i] = i + 1 < pieceLength ? i + 1 : -1
        prevIndices[i] = i - 1
    }

    const heap = new MinHeap<number>()

    for (let i = 0; i + 1 < pieceLength; i++) {
        const rank = MERGE_RANKS.get(
            symbols[i] + PAIR_SEPARATOR + symbols[i + 1]
        )
        if (rank !== undefined) {
            heap.push(rank * POSITION_SHIFT + i)
        }
    }

    let remainingSymbols: number = pieceLength
    while (heap.size > 0) {
        const heapKey = heap.pop()!
        const position = heapKey & POSITION_MASK
        if (removed[position]) continue

        const nextPosition = nextIndices[position]
        if (nextPosition < 0) continue

        const rank = MERGE_RANKS.get(
            symbols[position] + PAIR_SEPARATOR + symbols[nextPosition]
        )
        if (
            rank === undefined ||
            rank * POSITION_SHIFT + position !== heapKey
        ) {
            continue
        }

        symbols[position] += symbols[nextPosition]
        remainingSymbols--
        removed[nextPosition] = 1

        const rightAfter = nextIndices[nextPosition]
        nextIndices[position] = rightAfter
        if (rightAfter >= 0) {
            prevIndices[rightAfter] = position
            const newRank = MERGE_RANKS.get(
                symbols[position] + PAIR_SEPARATOR + symbols[rightAfter]
            )
            if (newRank !== undefined) {
                heap.push(newRank * POSITION_SHIFT + position)
            }
        }

        const leftBefore = prevIndices[position]
        if (leftBefore >= 0) {
            const newRank = MERGE_RANKS.get(
                symbols[leftBefore] + PAIR_SEPARATOR + symbols[position]
            )
            if (newRank !== undefined) {
                heap.push(newRank * POSITION_SHIFT + leftBefore)
            }
        }
    }
    return remainingSymbols
}

export function estimateTokens(inputText: string): number {
    if (!inputText) return 0
    let tokenCount = 0
    for (const piece of preTokenize(inputText)) {
        if (piece) {
            tokenCount += countBPEMerges(byteLevel(piece))
        }
    }
    return tokenCount
}
