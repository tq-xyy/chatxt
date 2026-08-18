import { ToolCall, ToolCallChunk } from '../types/openaiApi'

/**
 * Merge chunk to tool call list **in-place**
 */
export function mergeToolCallChunks(chunks: ToolCallChunk[]): ToolCall[] {
    const toolCallList: ToolCall[] = []

    for (const chunk of chunks) {
        if (!chunk.function.name) {
            const index = toolCallList.findIndex(
                block => block.index === chunk.index
            )
            if (index === -1) {
                throw new Error(`unexcepted tool call index: ${chunk.index}`)
            }
            toolCallList[index].function.arguments += chunk.function.arguments
        } else {
            toolCallList.push(chunk as ToolCall)
        }
    }

    return toolCallList
}
