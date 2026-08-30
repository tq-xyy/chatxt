import { readFile, open, stat, type FileHandle } from 'fs/promises'
import path from 'path'

export async function isFile(filePath: string): Promise<boolean> {
    try {
        const statObj = await stat(filePath)
        return statObj.isFile()
    } catch {
        return false
    }
}

/**
 * Converts an image file to a data URI (supports jpeg, png, gif, webp only).
 */
export async function imgToDataUri(filePath: string): Promise<string | false> {
    const ext = path.extname(filePath).toLowerCase()

    const mimeMap: Record<string, string> = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
    }
    const mime = mimeMap[ext]
    if (!mime) return false

    try {
        const buffer = await readFile(filePath)
        const base64 = buffer.toString('base64')
        return `data:${mime};base64,${base64}`
    } catch {
        return false
    }
}

/**
 * It reads the first 4096 bytes and attempts to decode them as UTF‑8.
 */
export async function isPlainUTF8Text(filePath: string): Promise<boolean> {
    let fileHandle: FileHandle | undefined
    try {
        fileHandle = await open(filePath, 'r')
        const buffer = Buffer.alloc(4096)
        const { bytesRead } = await fileHandle.read(
            buffer,
            0,
            buffer.length,
            0
        )
        const sample = buffer.subarray(0, bytesRead)

        if (sample.length === 0) return true

        const decoder = new TextDecoder('utf-8', { fatal: true })
        decoder.decode(sample)
        return true
    } catch {
        // Decoding error (invalid UTF‑8) or file access error → not plain text.
        return false
    } finally {
        if (fileHandle) await fileHandle.close()
    }
}
