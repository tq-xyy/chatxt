import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
    ChatCompletionRequest,
    ChatCompletionResponse,
} from '../../src/types/openaiApi'
import { loadConfig } from '../../src/config'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const CACHE_DIR = path.resolve(__dirname, 'cache')
const TESTS_DIR = path.resolve(__dirname, 'tests')
const PROMPT_FILE = path.join(CACHE_DIR, 'prompt.txt')

async function savePrompt({ prompt }: { prompt: string }) {
    await mkdir(CACHE_DIR, { recursive: true })
    await writeFile(PROMPT_FILE, prompt, 'utf-8')
    return { message: 'Prompt saved successfully.' }
}

async function readPrompt() {
    const content = await readFile(PROMPT_FILE, 'utf-8')
    return { prompt: content }
}

async function testPrompt() {
    const config = await loadConfig()

    const prompt = await readFile(PROMPT_FILE, 'utf-8')
    const files = await readdir(TESTS_DIR)
    const testFiles = files.filter(f => f.endsWith('.txt')).sort()

    const results = await Promise.all(
        testFiles.map(async file => {
            const input = await readFile(path.join(TESTS_DIR, file), 'utf-8')
            const body: ChatCompletionRequest = {
                model: config.model,
                messages: [
                    { role: 'system', content: prompt },
                    { role: 'user', content: input },
                ],
                thinking: { type: 'enabled' },
            }
            const startTime = performance.now()
            const resp = await fetch(`${config.endpoint}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${config.apiKey}`,
                },
                body: JSON.stringify(body),
            })
            if (!resp.ok) {
                const errorText = await resp.text()
                throw new Error(
                    `API request failed (${resp.status}): ${errorText}`
                )
            }
            const json = (await resp.json()) as ChatCompletionResponse
            const output = json.choices[0]?.message?.content ?? ''
            const generation_time = performance.now() - startTime
            return { test_id: file, input, output, generation_time }
        })
    )
    return results
}

await serveAsTool(
    [
        savePrompt,
        '将 prompt 暂存到文件, 返回成功消息',
        ToJSONSchema([['prompt', '需要暂存的 prompt 内容', String]]),
    ],
    [
        readPrompt,
        '从文件读取已暂存的 prompt 内容',
        { type: 'object', properties: {}, required: [] },
    ],
    [
        testPrompt,
        '从文件读取 prompt，对 tests/ 中每个 .txt 文件,' +
            '作为测试样例调用 LLM，返回 [{test_id, input, output, generation_time}] 数组。' +
            '调用前, 你需要确保你已经写入 prompt, 如果沿用请检测文件中是否为你期望的 prompt',
        { type: 'object', properties: {}, required: [] },
    ]
)
