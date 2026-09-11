import { join } from 'path'
import { pathToFileURL } from 'url'

import type { Config, Provider } from '../config'
import type { APIAdapter } from '../types/api-adapter'
import { AnthropicAPIAdapter } from './anthropic'
import { OpenAICompatibleAPIAdapter } from './openai-compatible'
import { OpenAIResponsesAPIAdapter } from './openai-responses'

export async function createAPIAdapter(
    type: Provider['type'],
    config: Config
): Promise<APIAdapter> {
    switch (type) {
        case 'openai-compatible':
            return new OpenAICompatibleAPIAdapter()
        case 'anthropic':
            return new AnthropicAPIAdapter()
        case 'openai-responses':
            return new OpenAIResponsesAPIAdapter()
    }

    if (config.adapters[type]) {
        const imported: unknown = await import(
            pathToFileURL(
                join(config.projectRoot, '.chatxtrc', config.adapters[type])
            ).href
        )

        const CustomAdapter = (
            imported &&
            typeof imported === 'object' &&
            'default' in imported &&
            imported.default
                ? imported.default
                : imported
        ) as new () => APIAdapter

        if (
            !CustomAdapter ||
            typeof CustomAdapter.prototype.buildRequest !== 'function' ||
            typeof CustomAdapter.prototype.handleChunk !== 'function' ||
            typeof CustomAdapter.prototype.handleStreamEnd !== 'function'
        ) {
            throw new Error(
                `invaild adapter ${type} from ${config.adapters[type]} ` +
                    '(not implemented interfaces completely)'
            )
        }
        return new CustomAdapter()
    }
    throw new Error(
        `unknown adapter \`${type}\`, check your \`adapters\` field in your config.`
    )
}
