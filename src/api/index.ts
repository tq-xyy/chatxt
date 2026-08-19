import type { Provider } from '../config'
import type { APIAdapter } from '../types/api-adapter'
import { OpenAICompatibleAPIAdapter } from './openai-compatible'
import { AnthropicAPIAdapter } from './anthropic'
import { OpenAIResponsesAPIAdapter } from './openai-responses'

export function createAPIAdapter(type: Provider['type']): APIAdapter {
    switch (type) {
        case 'openai-compatible':
            return new OpenAICompatibleAPIAdapter()
        case 'anthropic':
            return new AnthropicAPIAdapter()
        case 'openai-responses':
            return new OpenAIResponsesAPIAdapter()
    }
}
