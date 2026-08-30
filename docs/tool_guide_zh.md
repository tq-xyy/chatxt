# Chatxt 工具调用指南

Chatxt 的工具系统让你能用几行代码将任意 Node.js 能力变成 AI 可直接调用的函数。无需处理进程通信，无需引入额外依赖，只需定义业务函数，然后通过 `chatxt.runtime.exposeTool` 注册即可。

---

## `chatxt` 运行时对象

Chatxt 在运行你的工具文件之前，会注入一个全局对象 `chatxt`（无需 `require`/`import`），内含四部分 API：

### 1. `chatxt.runtime.exposeTool`

**声明**

```ts
async function exposeTool(
    tools: {
        name: string // 工具名（给 AI 调用）
        description: string // 功能描述（给 AI 看）
        parameters: JSONSchema // 参数 JSON Schema（给 AI 看）
        func: (args: any) => any // 业务函数，接收一个参数对象
    }[]
): Promise<void>
```

**功能**  
注册一个或多个工具，并通过 IPC 向主进程报告工具定义。注册后子进程保持运行，等待主进程调用。

**不再退出进程**：工具文件末尾调用 `exposeTool` 后进程不会退出，而是持续监听主进程的调用请求。之后可以在文件内自由使用 `console.log` 输出调试信息。

### 2. `chatxt.runtime.chatCompletion`

**声明**

```ts
async function chatCompletion(request: {
    messages: OpenAICompatibleMessage[]
    model?: string
    temperature?: number
    max_tokens?: number
    thinking?: { type: 'enabled' | 'disabled' }
    reasoning_effort?: 'low' | 'medium' | 'high' | 'max'
}): Promise<OpenAICompatibleResponse>
```

**功能**  
在工具函数内部调用 LLM。请求通过 IPC 发送到主进程，由主进程代理执行，token 用量会自动汇总到 Chatxt 的总计费中。

**示例**

```javascript
async function summarize({ text }) {
    const resp = await chatxt.runtime.chatCompletion({
        messages: [{ role: 'user', content: `总结：${text}` }],
    })
    return { summary: resp.choices[0].message.content }
}
```

### 3. `chatxt.helpers.convertArgsToSchema`

**声明**

```ts
function convertArgsToSchema(
    argsDefs: [
        string, // 参数名
        string, // 参数描述
        { new (...args: any[]): any }, // 类型构造函数 (String, Number, Boolean)
        { optional?: boolean }?, // 可选，是否非必填，默认必填
    ][]
): Record<string, any>
```

**功能**  
将简明的参数定义数组转换为标准 JSON Schema 对象。适合参数结构简单、类型为基础类型的场景。如果需要更复杂的描述（例如嵌套对象、数组、枚举等），可以直接手写 JSON Schema。

### 4. `chatxt.context`

工具进程的上下文信息，由主进程在 fork 时通过环境变量注入，属性只读：

```ts
const context: {
    toolPath: string // 工具文件的绝对路径
    chatFilePath: string // 当前 .chat.txt 文件的绝对路径
    chatFileDirname: string // 聊天文件所在目录的绝对路径
    chatxtVersion: string // chatxt 版本号
}
```

**功能**  
让工具代码感知自身运行环境。典型用途：

- 以 `chatxt.context.chatFileDirname` 为锚点解析相对路径（聊天文件所在目录即用户的工作目录）
- 用 `chatxt.context.toolPath` 定位工具文件旁的资源文件
- 用 `chatxt.context.chatxtVersion` 做版本兼容判断

```javascript
// 以聊天文件所在目录为基准读写文件
import { readFile } from 'fs/promises'
import * as path from 'path'

const config = JSON.parse(
    await readFile(
        path.resolve(chatxt.context.chatFileDirname, 'config.json'),
        'utf-8'
    )
)
```

## 示例一：数学计算器（使用 `convertArgsToSchema` 简写）

这个工具提供基本的算术运算，AI 可以用它来进行精确计算。

```javascript
// calculator.tool.js

function add({ a, b }) {
    return { result: a + b }
}

function multiply({ a, b }) {
    return { result: a * b }
}

function divide({ a, b }) {
    if (b === 0) {
        throw new Error('除数不能为 0')
    }
    return { result: a / b }
}

await chatxt.runtime.exposeTool([
    {
        name: 'add',
        description: '两个数相加',
        parameters: chatxt.helpers.convertArgsToSchema([
            ['a', '第一个数', Number],
            ['b', '第二个数', Number],
        ]),
        func: add,
    },
    {
        name: 'multiply',
        description: '两个数相乘',
        parameters: chatxt.helpers.convertArgsToSchema([
            ['a', '第一个数', Number],
            ['b', '第二个数', Number],
        ]),
        func: multiply,
    },
    {
        name: 'divide',
        description: '两个数相除（a 除以 b）',
        parameters: chatxt.helpers.convertArgsToSchema([
            ['a', '被除数', Number],
            ['b', '除数', Number],
        ]),
        func: divide,
    },
])
```

**对话示例**

```
----- CHAT ROLE: USER -----
@tool(calculator.tool.js) 帮我计算 (1234 + 5678) * 3.14 的结果
```

AI 会先调用 `add` 得到和，再调用 `multiply` 得到最终积。

## 示例二：文件信息查询（手写 JSON Schema）

这个工具可以获取文件的元信息，参数结构较复杂（包含枚举类型和可选字段），此时手写 JSON Schema 更合适。

```javascript
// fileinfo.tool.js

import { stat } from 'fs/promises'
import * as path from 'path'

async function file_info({ filePath, fields }) {
    const absolutePath = path.resolve(filePath)
    const stats = await stat(absolutePath)

    const result = {}
    if (fields.includes('size')) result.size = stats.size
    if (fields.includes('modified'))
        result.modified = stats.mtime.toISOString()
    if (fields.includes('created'))
        result.created = stats.birthtime.toISOString()
    if (fields.includes('isFile')) result.isFile = stats.isFile()
    if (fields.includes('isDirectory'))
        result.isDirectory = stats.isDirectory()
    return result
}

// 手写 JSON Schema，描述 fields 为字符串枚举数组
const fileInfoSchema = {
    type: 'object',
    properties: {
        filePath: {
            type: 'string',
            description: '文件或文件夹路径（相对于工作目录）',
        },
        fields: {
            type: 'array',
            description: '需要获取的信息类型',
            items: {
                type: 'string',
                enum: ['size', 'modified', 'created', 'isFile', 'isDirectory'],
            },
        },
    },
    required: ['filePath', 'fields'],
}

await chatxt.runtime.exposeTool([
    {
        name: 'file_info',
        description: '获取文件或文件夹的元信息，可指定需要返回的字段',
        parameters: fileInfoSchema,
        func: file_info,
    },
])
```

**对话示例**

```
----- CHAT ROLE: USER -----
@tool(fileinfo.tool.js) 看一下 package.json 的大小和修改时间
```

AI 会调用 `file_info({ filePath: 'package.json', fields: ['size', 'modified'] })`。

## 示例三：系统信息与当前时间（单文件多工具）

在同一个文件中可以注册多个不同用途的工具，既可以获取当前时间，也可以查询系统内存使用情况，并支持自定义命令执行。

```javascript
// system.tool.js

import { exec } from 'child_process'
import { promisify } from 'util'
const execAsync = promisify(exec)

function current_time({ timezone }) {
    const now = new Date()
    const options = { timeZone: timezone || 'Asia/Shanghai' }
    return {
        iso: now.toISOString(),
        local: now.toLocaleString('zh-CN', options),
        timezone: options.timeZone,
    }
}

function memory_usage() {
    const mem = process.memoryUsage()
    return {
        rss: (mem.rss / 1024 / 1024).toFixed(2) + ' MB',
        heapUsed: (mem.heapUsed / 1024 / 1024).toFixed(2) + ' MB',
        heapTotal: (mem.heapTotal / 1024 / 1024).toFixed(2) + ' MB',
    }
}

async function run_command({ command }) {
    const { stdout, stderr } = await execAsync(command, { timeout: 5000 })
    return { stdout: stdout.trim(), stderr: stderr.trim() }
}

await chatxt.runtime.exposeTool([
    {
        name: 'current_time',
        description: '获取当前时间，支持指定时区',
        parameters: chatxt.helpers.convertArgsToSchema([
            ['timezone', '时区，如 Asia/Shanghai', String, { optional: true }],
        ]),
        func: current_time,
    },
    {
        name: 'memory_usage',
        description: '查看当前 Node 进程的内存使用情况',
        parameters: { type: 'object', properties: {}, required: [] },
        func: memory_usage,
    },
    {
        name: 'run_command',
        description: '执行一条系统命令（最多5秒超时）',
        parameters: chatxt.helpers.convertArgsToSchema([
            ['command', '要执行的命令', String],
        ]),
        func: run_command,
    },
])
```

**对话示例**

```
----- CHAT ROLE: USER -----
@tool(system.tool.js) 现在北京时间几点？另外看看系统内存。
```

AI 会依次调用 `current_time({ timezone: 'Asia/Shanghai' })` 和 `memory_usage()`，综合给出回答。

---

## 注意事项

- **`name` 字段即工具名**：AI 通过该名字调用工具，需与模型期望的一致；重复加载同名工具会触发警告并忽略后者。
- **参数接收**：工具函数的第一个参数是一个对象，其键值由 AI 生成的 arguments JSON 决定。请确保参数 Schema 与函数实现一致。
- **异步支持**：如果函数内有异步操作，直接声明为 `async`，框架会自动 `await`。
- **错误处理**：函数内可抛出异常，框架会捕获并返回 `{ "error": "错误消息" }`。
- **调试信息**：可以在工具函数内任意使用 `console.log`，输出会直接显示在终端。
- **文件位置**：建议将工具文件放在项目目录的 `tools/` 文件夹下，通过相对路径引用（相对于 `.chat.md` 所在目录）。
- **只能在 chatxt 中运行**：`chatxt` 全局对象（含 `context`）由主进程通过环境变量与 `--import` 钩子注入，直接用 `node xxx.tool.js` 运行工具文件会因缺少 IPC 通道与上下文而抛出 FATAL 错误。

现在你已经了解了 Chatxt 工具系统的基本用法和高级技巧，可以开始编写自己的工具，享受可编程对话的乐趣了。
