import { ToolCall, ToolCallChunk } from '../types/openaiApi'

/**
 * Merge chunk to tool call list **in-place**
 */
export function mergeToolCallChunks(
    toolCallList: ToolCall[],
    chunks: ToolCallChunk[]
): void {
    for (const chunk of chunks) {
        if (chunk.type === undefined) {
            const index = toolCallList.findIndex(
                block => block.index === chunk.index
            )
            if (index === -1) {
                throw new Error(`unexcepted tool call index: ${chunk.index}`)
            }
            toolCallList[index].function.arguments += chunk.function.arguments
        } else if (chunk.type === 'function') {
            toolCallList.push(chunk as ToolCall)
        }
    }
}
