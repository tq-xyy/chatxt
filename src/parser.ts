

export type ChatRole =
    | 'SYSTEM'
    | 'USER'
    | 'ASSISTANT'
    | 'THINKING'
    | 'TOOL'
    | 'PIPE'

const VALID_ROLES: ChatRole[] = [
    'SYSTEM',
    'USER',
    'ASSISTANT',
    'THINKING',
    'TOOL',
    'PIPE',
]

const ROLE_SEPARATOR_REGEX =
    /^----- CHAT ROLE: (SYSTEM|USER|ASSISTANT|THINKING|TOOL|PIPE) -----$/

export interface ChatBlock {
    role: ChatRole
    content: string
}

/**
 * Parse .chat.md content into an array of ChatBlocks.
 * Returns null on invalid format.
 */
export function parseChatFile(content: string): ChatBlock[] | null {
    const lines = content.split('\n')
    const blocks: ChatBlock[] = []
    let currentRole: ChatRole | null = null
    let currentContent: string[] = []

    for (const line of lines) {
        const match = line.match(ROLE_SEPARATOR_REGEX)

        if (match) {
            // Save previous block
            if (currentRole !== null) {
                // Remove trailing newline from content
                let contentStr = currentContent.join('\n')
                // Remove trailing empty lines
                contentStr = contentStr.replace(/\n+$/, '')
                blocks.push({ role: currentRole, content: contentStr })
            }

            currentRole = match[1] as ChatRole
            currentContent = []

            // Validate role
            if (!VALID_ROLES.includes(currentRole)) {
                return null
            }
        } else {
            if (currentRole !== null) {
                currentContent.push(line)
            } else {
                // Content before first separator - invalid
                if (line.trim() !== '') {
                    return null
                }
            }
        }
    }

    // Save last block
    if (currentRole !== null) {
        let contentStr = currentContent.join('\n')
        contentStr = contentStr.replace(/\n+$/, '')
        blocks.push({ role: currentRole, content: contentStr })
    }

    return blocks
}

