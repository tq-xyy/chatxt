import { readFile, writeFile, mkdir, access, constants } from 'fs/promises'
import { join, dirname } from 'path'

export interface Config {
    endpoint: string
    model: string
    apiKey: string
    thinkingEffort: string
    showThinking: boolean
    excludeHistoryToolCall: boolean
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

const configTemplate: Config = {
    endpoint: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    apiKey: '',
    thinkingEffort: 'high',
    showThinking: false,
    excludeHistoryToolCall: false,
}

/**
 * 异步加载配置，返回 Promise<Config>
 * 优先级: 运行时配置 > 配置文件 > 默认配置
 */
export async function loadConfig(
    runtimeConfig?: Partial<Config>
): Promise<Config> {
    const envApiKey = process.env.OPENAI_API_KEY || ''
    const defaultConfig: Config = {
        ...configTemplate,
        apiKey: envApiKey,
    }

    const cwd = process.cwd()
    const projectRoot = await findProjectRoot(cwd)
    if (!projectRoot) {
        return defaultConfig
    }

    const configPath = join(projectRoot, '.chatfilerc', 'config.json')
    let fileConfig: Partial<Config> = {}

    try {
        // 检查文件是否存在，若存在则读取并解析
        await access(configPath, constants.F_OK)
        const raw = await readFile(configPath, 'utf-8')
        fileConfig = JSON.parse(raw) as Partial<Config>
    } catch {
        // 文件不存在或读取失败，使用默认值
    }

    runtimeConfig = runtimeConfig || {}

    const merged: Config = {
        ...defaultConfig,
        ...fileConfig,
        ...runtimeConfig,
    }

    // apiKey 优先级：环境变量 > 配置文件
    merged.apiKey = envApiKey || fileConfig.apiKey || ''

    // 安全警告：当配置文件包含 apiKey 且未设置环境变量时
    if (fileConfig.apiKey && fileConfig.apiKey.length > 0 && !envApiKey) {
        const allowFile = join(
            projectRoot,
            '.chatfilerc',
            'allow-apikey-in-project'
        )
        try {
            await access(allowFile, constants.F_OK)
            // 标记文件存在，不发出警告
        } catch {
            console.warn(
                'Warning: API key found in .chatfilerc/config.json. ' +
                    'It is recommended to use OPENAI_API_KEY environment variable instead. ' +
                    'To suppress this warning, create .chatfilerc/allow-apikey-in-project marker file.'
            )
        }
    }

    return merged
}

/**
 * 异步初始化配置文件，返回 Promise<void>
 */
export async function initConfig(): Promise<void> {
    const cwd = process.cwd()
    const configDir = join(cwd, '.chatfilerc')
    const configPath = join(configDir, 'config.json')

    // 创建配置目录（如果不存在）
    try {
        await mkdir(configDir, { recursive: true })
    } catch {
        // 忽略目录已存在或其他错误，后续会尝试写入文件
    }

    // 检查配置文件是否已存在
    try {
        await access(configPath, constants.F_OK)
        console.error('.chatfilerc/config.json already exists.')
        return
    } catch {
        // 文件不存在，继续创建
    }

    await writeFile(configPath, JSON.stringify(configTemplate, null, 2) + '\n')
    console.log(`Created config template at ${configPath}`)
}
