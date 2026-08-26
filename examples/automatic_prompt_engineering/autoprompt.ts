import { readFile, writeFile, readdir, mkdir } from 'fs/promises'
import * as path from 'path'
import { fileURLToPath } from 'url'

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

async function testPrompt({
    thinking = 'enabled',
    thinking_effort,
}: { thinking?: string; thinking_effort?: string } = {}) {
    const prompt = await readFile(PROMPT_FILE, 'utf-8')
    const files = await readdir(TESTS_DIR)
    const testFiles = files.filter(f => f.endsWith('.txt')).sort()

    const model = 'hy3'

    const results = await Promise.all(
        testFiles.map(async file => {
            const input = await readFile(path.join(TESTS_DIR, file), 'utf-8')
            const startTime = performance.now()
            const json = await chatxt.runtime.chatCompletion({
                model,
                messages: [
                    { role: 'system', content: prompt },
                    { role: 'user', content: input },
                ],
                thinking: {
                    type: thinking as 'enabled' | 'disabled',
                },
                reasoning_effort: thinking_effort as
                    'high' | 'max' | undefined,
            })
            const output = json.choices[0]?.message?.content ?? ''
            const generation_time = performance.now() - startTime
            return {
                test_id: file,
                input,
                output,
                reasoning:
                    json.choices[0].message.reasoning ||
                    json.choices[0].message.reasoning_content ||
                    null,
                generation_time,
                model,
            }
        })
    )
    return results
}

async function saveAndTestPrompt(options: {
    prompt: string
    thinking?: string
    thinking_effort?: string
}) {
    const { prompt, ...generateOptions } = options
    await savePrompt({ prompt })
    return await testPrompt(generateOptions)
}

chatxt.runtime.exposeTool([
    {
        name: 'savePrompt',
        description: '将 prompt 暂存到文件, 返回成功消息',
        parameters: chatxt.helpers.convertArgsToSchema([
            ['prompt', '需要暂存的 prompt 内容', String],
        ]),
        func: savePrompt,
    },
    {
        name: 'readPrompt',
        description: '从文件读取已暂存的 prompt 内容',
        parameters: { type: 'object', properties: {}, required: [] },
        func: readPrompt,
    },
    {
        name: 'testPrompt',
        description:
            '从文件读取 prompt，对 tests/ 中每个 .txt 文件,' +
            '作为测试样例调用 LLM，返回 [{test_id, input, output, generation_time}] 数组。' +
            '调用前, 你需要确保你已经写入 prompt, 如果沿用请检测文件中是否为你期望的 prompt',
        parameters: {
            type: 'object',
            properties: {
                thinking: {
                    type: 'string',
                    description:
                        '思考模式，默认为 enabled, 可选 enabled 和 disabled',
                },
                thinking_effort: {
                    type: 'string',
                    description: '思考强度，可选 high 或 max',
                    enum: ['high', 'max'],
                },
            },
        },
        func: testPrompt,
    },
    {
        name: 'saveAndTestPrompt',
        description: '参数参见 savePrompt 和 testPrompt。',
        parameters: {
            type: 'object',
            properties: {
                prompt: {
                    type: 'string',
                    description: '要暂存的提示词',
                },
                thinking: {
                    type: 'string',
                    description:
                        '思考模式，默认为 enabled, 可选 enabled 和 disabled',
                },
                thinking_effort: {
                    type: 'string',
                    description: '思考强度，可选 high 或 max',
                    enum: ['high', 'max'],
                },
            },
            required: ['prompt', 'thinking'],
        },
        func: saveAndTestPrompt,
    },
])
