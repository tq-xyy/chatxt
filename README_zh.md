# Chatxt

**对话即文件 —— AI 聊天记录就是纯文本文件。**

Chatxt 是一个命令行 AI 聊天工具：你在 `.chat.txt` 纯文本文件中书写输入，运行 `chatxt <file>` 后，AI 的回复（含思维链、工具调用与结果）被实时追加写回同一文件。整个对话历史天然承载于一个可读、可 diff、可版本管理的文件中，无需数据库。

## 特性

- **文件即对话**：历史、上下文与工具声明都存放在同一个 `.chat.txt` 文件中
- **流式写回**：生成过程中内容实时落盘，中断也会保留已生成部分
- **多 provider**：统一适配器支持 OpenAI 兼容（`/chat/completions`）、OpenAI Responses（`/responses`）与 Anthropic（`/messages`）三种协议
- **工具调用**：任意 Node.js 脚本都能注册成 AI 可调用的工具，拥有独立沙箱进程与 LLM 代理
- **思维链支持**：`--emit-thinking` 可将推理过程持久化到文件
- **token 经济**：基于上下文缓存感知的成本估算、历史工具调用过滤、文件引用去重

## 环境要求

- Node.js ≥ 22
- 构建使用 pnpm

## 安装

```bash
pnpm install
pnpm build
```

构建产物为单文件 `dist/cli.js`。可通过 `node dist/cli.js` 使用，或链接全局命令：

```bash
pnpm link   # 可选：注册全局 chatxt 命令
```

## 快速开始

1. **生成配置**（或手动创建）：

```bash
chatxt init-config
```

生成 `.chatxtrc/config.json`：

```json
{
    "providers": [
        {
            "name": "DeepSeek",
            "type": "openai-compatible",
            "endpoint": "https://api.deepseek.com/v1",
            "apikey": "your-api-key-here",
            "models": {
                "deepseek-v4-flash": true,
                "deepseek-v4-pro": true
            }
        }
    ],
    "defaultModel": "deepseek-v4-flash"
}
```

2. **在 `.chat.txt` 中写下你的问题**（文件不存在时会自动创建含默认系统提示词的模板）：

```
----- CHAT ROLE: SYSTEM -----
你是一个有帮助的 AI 助手，用中文回应用户。

----- CHAT ROLE: USER -----
简单介绍下 chatxt 的设计理念。
```

3. **运行对话**：

```bash
chatxt my-chat.chat.txt
```

AI 的回答（以及思维链、工具调用与结果）会流式写入同一文件，末尾自动追加一个空 `USER` 块供你下次输入。

## CLI 选项

| 选项                          | 说明                                          |
| ----------------------------- | --------------------------------------------- |
| `-m, --model <model>`         | 覆盖模型                                      |
| `-k, --api-key <key>`         | 提供 API 密钥                                 |
| `--endpoint <url>`            | 覆盖 API 端点（直连模式）                     |
| `-t, --emit-thinking`         | 将思维链写入文件                              |
| `-e, --emit-to-console`       | 生成内容只输出到终端、不写文件（调试/e2e 用） |
| `--exclude-history-tool-call` | 从上下文中剔除历史工具调用以省 token          |
| `chatxt init-config`          | 生成 `.chatxtrc/config.json` 模板             |

## `.chat.txt` 文件格式

文件由若干"角色块"组成，每块以一行分隔符开始。首行支持 shebang（`#!/usr/bin/env chatxt`），解析时忽略。

```
----- CHAT ROLE: SYSTEM -----
（系统提示词）

----- CHAT ROLE: USER -----
（用户输入）

----- CHAT ROLE: ASSISTANT -----
（AI 回答）

----- CHAT ROLE: THINKING -----
（思维链，仅 --emit-thinking 时写入）

----- CHAT ROLE: TOOL -----
函数名 (调用ID): {"参数": "值"}

----- CHAT ROLE: TOOLRESPONSE -----
调用ID: {"结果": "..."}
```

### 指令（仅 USER 块内解析）

路径相对于 `.chat.txt` 所在目录解析。

| 指令             | 说明                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------- |
| `@file(路径)`    | 将外部文件内容追加到该 user 消息尾部（同一文件一次会话只引用一次，重复引用仅保留文件名） |
| `@include(路径)` | 每次都把外部文件内容内联进消息                                                           |
| `@tool(路径)`    | 声明工具文件，会话启动时加载其中注册的工具                                               |

示例：

```text
----- CHAT ROLE: USER -----
@tool(tools/weather.ts)
@file(report.md)
现在天气怎么样？
```

## 配置

配置从 `.chatxtrc/config.json` 加载，由工作目录向上查找定位；CLI 选项优先于配置文件。

| 字段                                                         | 说明                                                                                                                    |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `providers`                                                  | provider 列表：`name`、`type`（`openai-compatible` / `openai-responses` / `anthropic`）、`endpoint`、`apikey`、`models` |
| `models`                                                     | 模型 ID 到 `true` 或 `{ "alias": "...", "pricing": ... }` 的映射                                                        |
| `defaultModel`                                               | 未传 `-m` 时使用的默认模型                                                                                              |
| `thinkingEffort` / `thinkingMode` / `maxTokens` / `jsonOnly` | 补全参数                                                                                                                |
| `emitThinking` / `emitToConsole` / `emitInterval`            | 输出选项                                                                                                                |
| `excludeHistoryToolCall`                                     | 跳过历史工具调用以省 token                                                                                              |

## 工具系统

工具即任意 Node.js 脚本，通过全局函数 `serveAsTool` 注册。每个工具文件运行在独立的 fork 子进程中：

```js
// weather.tool.js
function getWeather({ location }) {
    return { location, temperature: 22, unit: 'celsius', condition: 'sunny' }
}

serveAsTool(
    getWeather,
    '获取指定地点的当前天气',
    ToJSONSchema([['location', '城市名', String]])
)
```

工具文件中可用的全局函数（无需 import）：

- `serveAsTool(fn, description, jsonSchema, ...)` —— 注册工具并上报定义
- `chatCompletion(request)` —— 在工具内调用 LLM（由主进程代理，用量计入会话）
- `ToJSONSchema(argsDefs)` —— 参数 JSON Schema 简写

完整指南见 [docs/tool_guide_zh.md](docs/tool_guide_zh.md)。

## 示例

- [examples/automatic_prompt_engineering](examples/automatic_prompt_engineering) —— 自动提示词工程：AI 自行测试并迭代优化 prompt
- [examples/dsh-minimal-mode](examples/dsh-minimal-mode) —— 极简编码代理（持久 shell + `str_replace_editor`）

## 开发

```bash
pnpm build       # esbuild 打包 dist/cli.js
pnpm typecheck   # tsc --noEmit 类型检查
pnpm lint        # eslint --fix && prettier -w
```

## 文档

- [docs/architecture_zh.md](docs/architecture_zh.md) —— 架构总览
- [docs/tool_guide_zh.md](docs/tool_guide_zh.md) —— 工具编写指南

## 许可证

MIT
