// 此文件由 Chatfile 在工具子进程中注入，提供全局函数 serveAsTool 和 ToJSONSchema。

type ToolFunction = (...args: any[]) => any

interface ToolDefinition {
    name: string
    description: string
    parameters: Record<string, any>
    func: ToolFunction
}

/**
 * 注册一个或多个工具，并根据环境变量 FUNCTION_CALL 执行描述或调用操作，最后退出进程。
 * 应作为工具文件的最后一个调用（不再返回）。
 *
 * @param entries - 可变参数，每个元素为 [工具函数, 描述, JSON Schema 参数对象]
 *
 * 环境变量 FUNCTION_CALL 的行为：
 *   - 未定义（undefined）：静默退出，不做任何事。
 *   - 空字符串（''）：输出所有已注册工具的 JSON 定义列表到 stdout，然后退出。
 *   - 非空字符串：表示要执行的工具名称。从 stdin 读取 JSON 参数，调用对应函数，
 *     将函数返回值（若为 Promise 则等待）序列化为 JSON 输出到 stdout，然后退出。
 *     若出错，向 stderr 写入错误信息并以非零码退出。
 */
async function serveAsTool(
    ...entries: [ToolFunction, string, Record<string, any>][]
): Promise<never> {
    const toolDefs: ToolDefinition[] = []

    // 收集工具定义
    for (const [func, description, parameters] of entries) {
        const name = func.name || `anonymous_${toolDefs.length}`
        toolDefs.push({ name, description, parameters, func })
    }

    const functionCall = process.env.FUNCTION_CALL

    // 环境变量不存在：直接静默退出
    if (functionCall === undefined) {
        process.exit(0)
    }

    // 环境变量为空字符串：输出工具定义列表（用于描述模式）
    if (functionCall === '') {
        const descriptions = toolDefs.map(
            ({ name, description, parameters }) => ({
                type: 'function' as const,
                function: {
                    name,
                    description,
                    parameters,
                },
            })
        )
        process.stdout.write(JSON.stringify(descriptions))
        process.exit(0)
    }

    // ---- 以下为执行模式 ----
    const toolName = functionCall.trim()
    const tool = toolDefs.find(t => t.name === toolName)
    if (!tool) {
        process.stderr.write(`Error: Tool "${toolName}" not found\n`)
        process.exit(1)
    }

    // 内联的 stdin 读取辅助函数
    const readStdin = (): Promise<string> =>
        new Promise(resolve => {
            let data = ''
            // 若 stdin 是终端（如用户手动测试），直接返回空
            if (process.stdin.isTTY) {
                resolve('')
                return
            }
            process.stdin.setEncoding('utf8')
            process.stdin.on('readable', () => {
                let chunk: string | Buffer | null
                while ((chunk = process.stdin.read()) !== null) {
                    data +=
                        typeof chunk === 'string' ? chunk : chunk.toString()
                }
            })
            process.stdin.on('end', () => resolve(data))
            // 设置超时防止某些环境下 end 不触发
            setTimeout(() => resolve(data), 100)
        })

    // 读取 stdin 中的参数 JSON
    let inputJson = ''
    try {
        inputJson = await readStdin()
    } catch (err: any) {
        process.stderr.write(`Error reading stdin: ${err.message}\n`)
        process.exit(1)
    }

    let args: any
    try {
        args = JSON.parse(inputJson || '{}')
    } catch {
        process.stderr.write('Invalid JSON input\n')
        process.exit(1)
    }

    // 执行工具函数，并输出结果
    try {
        const result = tool.func(args)
        const output = result instanceof Promise ? await result : result
        process.stdout.write(JSON.stringify(output))
        process.exit(0)
    } catch (err: any) {
        // 将异常转为错误 JSON 输出
        process.stdout.write(JSON.stringify({ error: err.message }))
        process.exit(1)
    }
}

/**
 * 将简写参数定义转换为标准 JSON Schema 对象，用于工具参数声明。
 *
 * @param argsDefs - 参数定义数组，每个元素为：
 *   [参数名, 描述, 类型构造函数, 可选配置?]
 *   类型构造函数可以是 String、Number 或 Boolean。
 *   可选配置为 { optional?: boolean }，默认 required 为 true。
 * @returns 符合 OpenAI function calling 要求的 JSON Schema 对象。
 *
 * 示例：
 *   ToJSONSchema([
 *     ['city', '城市名称', String],
 *     ['date', '日期', String, { optional: true }],
 *   ])
 */
function ToJSONSchema(
    argsDefs: [
        string,
        string,
        { new (...args: any[]): any },
        { optional?: boolean }?,
    ][]
): Record<string, any> {
    const properties: Record<string, any> = {}
    const required: string[] = []

    for (const def of argsDefs) {
        const [name, description, Type, options] = def
        const optional = options?.optional ?? false

        let jsonType: string
        switch (Type) {
            case String:
                jsonType = 'string'
                break
            case Number:
                jsonType = 'number'
                break
            case Boolean:
                jsonType = 'boolean'
                break
            default:
                throw new Error(`Unsupported type for argument "${name}"`)
        }

        properties[name] = {
            type: jsonType,
            description,
        }

        if (!optional) {
            required.push(name)
        }
    }

    return {
        type: 'object',
        properties,
        required,
    }
}
