export async function* parseSSEStream<T>(resp: Response) {
    const decoder = new TextDecoder()
    let buffer = ''

    const reader = resp.body?.getReader()

    if (!reader) {
        throw new Error(`HTTP stream reader unavailable.`)
    }

    while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed || !trimmed.startsWith('data:')) continue

            const data = trimmed.slice(5).trim()
            if (data === '[DONE]') break

            try {
                yield JSON.parse(data) as T
            } catch (err) {
                throw new Error('chunk parse as JSON failed: ' + data)
            }
        }
    }
}
