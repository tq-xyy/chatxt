import { readFile, writeFile, mkdir, access, constants } from 'fs/promises'
import { join, dirname } from 'path'
import { printWarningMessage } from './tui'
import type { Pricing } from './common/pricing'
import { modelOfficalPricing } from './common/data/model-pricing'

export interface ModelConfig {
    alias?: string
    pricing?: Pricing | Pricing[]
}

export interface Provider {
    name?: string
    type: 'openai-compatible' | 'openai-responses' | 'anthropic'
    endpoint: string
    apikey: string
    models: Record<string, true | ModelConfig>
}

export interface Config {
    providers: Provider[]
    defaultModel?: string

    endpoint?: string
    model: string
    apikey?: string

    // input options
    excludeHistoryToolCall?: boolean

    // output options
    emitToConsole?: boolean
    emitThinking?: boolean
    /** unit `ms`, defaluts to 16ms, be negative will write to file immedately */
    emitInterval?: number

    // completions options
    thinkingEffort?: string
    thinkingMode?: string
    maxTokens?: number
    jsonOnly?: boolean
}

export interface ModelGateway {
    id: string
    providerName: string
    endpoint: string
    endpointType: Provider['type']
    model: string
    apikey: string
    pricing?: Pricing | Pricing[]
}

export function getModelGateway(config: Config, model: string): ModelGateway {
    if (config.endpoint && config.apikey) {
        return {
            id: model,
            providerName: config.endpoint,
            endpoint: config.endpoint,
            apikey: config.apikey,
            model,
            endpointType: 'openai-compatible',
        }
    }

    for (const provider of config.providers) {
        for (const modelId in provider.models) {
            const modelConf: ModelConfig =
                provider.models[modelId] === true
                    ? {}
                    : provider.models[modelId]

            modelConf.alias = modelConf.alias || modelId

            if (modelConf.alias !== model) {
                continue
            }

            const gateway: ReturnType<typeof getModelGateway> = {
                id: model,
                providerName: provider.name || provider.endpoint,
                endpoint: provider.endpoint,
                apikey: provider.apikey,
                endpointType: provider.type,
                model: modelId,
            }

            gateway.pricing = modelConf.pricing || modelOfficalPricing[modelId]

            return gateway
        }
    }

    throw new Error(
        `Cannot find a vaild model provider for ${model} to start chat. ` +
            'Check you if set endpoint and api key in provider.'
    )
}

/**
 * find the parent directory of .chatfilerc
 */
async function findProjectRoot(startDir: string): Promise<string | null> {
    let dir = startDir
    while (true) {
        try {
            await access(join(dir, '.chatfilerc'), constants.F_OK)
            return dir
        } catch {
            // going up
        }
        const parent = dirname(dir)
        if (parent === dir) return null // enter root dir
        dir = parent
    }
}

export async function loadConfig(
    cliConfig?: Partial<Config>
): Promise<Config> {
    const cwd = process.cwd()
    const projectRoot = await findProjectRoot(cwd)

    let fileConfig: Partial<Config> = {}

    if (projectRoot) {
        const configPath = join(projectRoot, '.chatfilerc', 'config.json')
        try {
            await access(configPath, constants.F_OK)
            const raw = await readFile(configPath, 'utf-8')
            fileConfig = JSON.parse(raw) as Partial<Config>
        } catch {
            // Use cli settings
        }
    }

    // exclude undefined items from cli settings
    cliConfig = cliConfig || {}
    cliConfig = Object.fromEntries(
        Object.entries(cliConfig).filter(([k, v]) => k && v)
    )

    const model = cliConfig.model || fileConfig.defaultModel
    if (!model) {
        throw new Error(
            'Cannot find model id to generate, you can set by ' +
                '`-m` or `--model` in CLI or use defaultModel in config file.'
        )
    }

    const merged: Config = {
        providers: [],
        ...fileConfig,
        ...cliConfig,
        model,
    }

    return merged
}

export async function initConfig(): Promise<void> {
    const configTemplate: Partial<Config> = {
        providers: [
            {
                name: 'DeepSeek',
                type: 'openai-compatible',
                endpoint: 'https://api.deepseek.com/v1',
                apikey: 'your-api-key-here',
                models: {
                    'deepseek-v4-flash': true,
                    'deepseek-v4-pro': true,
                },
            },
        ],
        defaultModel: 'deepseek-v4-flash',
    }

    const cwd = process.cwd()
    const configDir = join(cwd, '.chatfilerc')
    const configPath = join(configDir, 'config.json')

    // create .chatfilerc if not exists
    try {
        await mkdir(configDir, { recursive: true })
    } catch {
        // skip create directory
    }

    try {
        await access(configPath, constants.F_OK)
        printWarningMessage('.chatfilerc/config.json already exists.')
        return
    } catch {
        // create config if config not exists
    }

    await writeFile(configPath, JSON.stringify(configTemplate, null, 2) + '\n')
    console.log(`Created config template at ${configPath}`)
}
