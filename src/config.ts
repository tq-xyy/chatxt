import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

export interface Config {
    endpoint: string
    model: string
    apiKey: string
}

function findProjectRoot(startDir: string): string | null {
    let dir = startDir
    while (true) {
        if (existsSync(join(dir, '.chatfilerc'))) {
            return dir
        }
        const parent = dirname(dir)
        if (parent === dir) return null
        dir = parent
    }
}

const configTemplate: Config = {
    endpoint: 'https://api.deepseek.com',
    model: 'deepseek-v4-pro',
    apiKey: '',
}

export function loadConfig(): Config {
    const envApiKey = process.env.OPENAI_API_KEY || ''
    const defaultConfig: Config = {
        ...configTemplate,
        apiKey: envApiKey,
    }

    const cwd = process.cwd()
    const projectRoot = findProjectRoot(cwd)
    if (!projectRoot) {
        return defaultConfig
    }

    const configPath = join(projectRoot, '.chatfilerc', 'config.json')
    if (!existsSync(configPath)) {
        return defaultConfig
    }

    try {
        const raw = readFileSync(configPath, 'utf-8')
        const fileConfig = JSON.parse(raw) as Partial<Config>

        const merged: Config = {
            ...defaultConfig,
            ...fileConfig,
        }

        // apiKey priority: env > config file
        merged.apiKey = envApiKey || fileConfig.apiKey || ''

        // Security warning if apiKey is in config file without allow file
        if (fileConfig.apiKey && fileConfig.apiKey.length > 0 && !envApiKey) {
            const allowFile = join(
                projectRoot,
                '.chatfilerc',
                'allow-apikey-in-project'
            )
            if (!existsSync(allowFile)) {
                console.error(
                    'Warning: API key found in .chatfilerc/config.json. ' +
                        'It is recommended to use OPENAI_API_KEY environment variable instead. ' +
                        'To suppress this warning, create .chatfilerc/allow-apikey-in-project marker file.'
                )
            }
        }

        return merged
    } catch (err) {
        console.error(
            'Failed to parse config file, using defaults:',
            (err as Error).message
        )
        return defaultConfig
    }
}

export function initConfig(): void {
    const cwd = process.cwd()
    const configDir = join(cwd, '.chatfilerc')
    const configPath = join(configDir, 'config.json')

    if (!existsSync(configDir)) {
        mkdirSync(configDir, { recursive: true })
    }

    if (existsSync(configPath)) {
        console.error('.chatfilerc/config.json already exists.')
        return
    }

    writeFileSync(configPath, JSON.stringify(configTemplate, null, 2) + '\n')
    console.log(`Created config template at ${configPath}`)
}
