// Refer to https://www.ruanyifeng.com/blog/2017/05/server-sent_events.html
interface SSEMessage<T, E extends string> {
    id?: string
    retry?: string
    event?: E
    data: T
}

export async function* parseSSEStream<T, E extends string = string>(
    resp: Response
) {
    const decoder = new TextDecoder()
    let buffer = ''

    const reader = resp.body?.getReader()

    if (!reader) {
        throw new Error(`HTTP stream reader unavailable.`)
    }

    while (true) {
        const { done, value } = await reader.read()
        buffer += decoder.decode(value, { stream: true })
        const messages = buffer.split('\n\n')
        buffer = messages.pop() || ''

        for (const message of messages) {
            let id: string | null = null
            let event: string | null = null
            let retry: string | null = null
            let rawData: string = ''

            for (const line of message.split('\n')) {
                if (line.startsWith(':')) {
                    // skip comment.
                    continue
                }

                if (line.startsWith('id: ')) {
                    id = line.slice(4)
                }
                if (line.startsWith('event: ')) {
                    event = line.slice(7)
                }
                if (line.startsWith('retry: ')) {
                    retry = line.slice(7)
                }
                if (line.startsWith('data: ')) {
                    rawData += line.slice(6)
                }
            }

            if (rawData === '[DONE]') continue

            try {
                const data = JSON.parse(rawData) as T
                const chunk: SSEMessage<T, E> = { data }

                if (event) chunk.event = event as E
                if (id) chunk.id = id
                if (retry) chunk.retry = retry

                yield chunk
            } catch (err) {
                throw new Error(`chunk parse as JSON failed: ${rawData}`, {
                    cause: err,
                })
            }
        }

        if (done) {
            if (buffer.length > 0) {
                throw new Error(`SSE buffer is not empty when done: ${buffer}`)
            }
            break
        }
    }
}
