import { readFile, writeFile, mkdir, access, constants } from 'fs/promises'
import { join, dirname } from 'path'
import { printWarningMessage } from './tui'
import type { Pricing } from './common/pricing'

export interface ModelConfig extends Partial<Pricing> {
    alias?: string
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

    thinkingEffort?: string
    showThinking?: boolean
    excludeHistoryToolCall?: boolean
}

export function getModelGateway(
    config: Config,
    model: string
): {
    providerName: string
    endpoint: string
    endpointType: Provider['type']
    model: string
    apikey: string
    pricing?: Pricing
} {
    if (config.endpoint && config.apikey) {
        return {
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
                    ? { alias: modelId }
                    : provider.models[modelId]

            if (modelConf.alias !== model) {
                continue
            }

            const gateway: ReturnType<typeof getModelGateway> = {
                providerName: provider.name || provider.endpoint,
                endpoint: provider.endpoint,
                apikey: provider.apikey,
                endpointType: provider.type,
                model: modelId,
            }

            if (modelConf.pricingPerMillionTokens) {
                gateway.pricing = {
                    pricingPerMillionTokens: modelConf.pricingPerMillionTokens,
                    pricingCurrency: modelConf.pricingCurrency || 'CNY',
                }
            }

            return gateway
        }
    }

    throw new Error(
        'Cannot find a vaild model provider to start chat.' +
            'Check you if set endpoint and api key in provider.'
    )
}

/**
 * 异步查找项目根目录（包含 .chatfilerc 文件夹的最近父目录）
 */
async function findProjectRoot(startDir: string): Promise<string | null> {
    let dir = startDir
    while (true) {
        try {
            await access(join(dir, '.chatfilerc'), constants.F_OK)
            return dir
        } catch {
            // 目录不存在，继续向上
        }
        const parent = dirname(dir)
        if (parent === dir) return null // 到达根目录
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

    // 创建配置目录（如果不存在）
    try {
        await mkdir(configDir, { recursive: true })
    } catch {
        // 忽略目录已存在或其他错误，后续会尝试写入文件
    }

    try {
        await access(configPath, constants.F_OK)
        printWarningMessage('.chatfilerc/config.json already exists.')
        return
    } catch {}

    await writeFile(configPath, JSON.stringify(configTemplate, null, 2) + '\n')
    console.log(`Created config template at ${configPath}`)
}
