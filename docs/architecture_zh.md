# Chatxt 架构文档

Chatxt 是一个"对话即文件"的命令行 AI 聊天工具。用户在 `.chat.txt` 纯文本文件中书写对话，运行 `chatxt <file>` 后，AI 的回复（含思维链、工具调用与结果）被实时追加写回同一文件。对话历史天然由文件本身承载，无需数据库。

- 语言：TypeScript（ESM，Node.js ≥ 22）；esbuild 打包为单文件 `dist/cli.js`
- 运行时依赖：`commander`（CLI 解析）、`chalk`（终端着色）
- 多 provider：通过 `APIAdapter` 接口归一化，内部统一 OpenAI Chat Completions 形状，在 adapter 边界转换为 `openai-compatible` / `openai-responses` / `anthropic` 三种 wire 格式

## 目录结构

```
src/
├── cli.ts        # CLI 入口（commander），chatxt <file> 与 init-config
├── config.ts     # 配置加载与合并（多 provider + ModelGateway 解析）
├── session.ts    # 会话核心：ChatSession 生成循环、事件处理、统计
├── fileobj.ts    # .chat.txt 解析（buildPrompt）与防抖写入
├── tui.ts        # 终端 UI：警告/异常、进度条、最终统计
├── api/          # createAPIAdapter 工厂 + 三种协议 adapter
├── types/        # APIAdapter 接口、StreamEvent、各协议类型
├── common/       # usage 归一化、pricing 计费、默认系统提示词、内置定价表
├── tools/        # 工具子进程管理（runner）、注入运行时（tool-runtime）、IPC 类型
└── utils/        # SSE 流解析、token 估算
```

## 核心概念

**`.chat.txt` 文件格式**：文件由若干"角色块"组成，每块以一行分隔符开始；首行支持 shebang（`#!/usr/bin/env chatxt`），解析时忽略。角色块依次为 `SYSTEM`（系统提示词）、`USER`（用户输入，可含指令）、`ASSISTANT`（AI 正文）、`THINKING`（思维链，仅 `--emit-thinking` 时写入）、`TOOL`（每行：函数名 (调用ID): 参数JSON）、`TOOLRESPONSE`（每行：调用ID: 结果JSON）。

**用户块内指令**（仅 `USER` 块解析，其余角色块原样透传；路径相对 `.chat.txt` 所在目录）：`@file(路径)` 把外部文件内容追加到消息尾部（同一文件一次会话只引用一次）；`@include(路径)` 把外部文件作为预设递归展开——文件内容会被重新解析为指令（支持嵌套 `@file`/`@tool`/`@include`，内部路径相对该文件所在目录解析，循环引用跳过并警告，含角色行的文件被拒绝）；`@tool(路径)` 声明工具文件，会话启动时加载。

**工具系统**：任意 Node.js 脚本（`.ts`/`.js`），通过全局对象 `chatxt` 的 `runtime.exposeTool()` 注册工具。工具文件被 `fork` 为常驻子进程，通过 IPC 与主进程通信；子进程内还可调用 `chatxt.runtime.chatCompletion()`（由主进程代理，用量计入会话）与 `chatxt.helpers.convertArgsToSchema()`（参数定义简写）。详见 `docs/tool_guide_zh.md`。

## 模块说明

### `config.ts`

配置项：`providers`（name/type/endpoint/apikey/models）、`defaultModel`、`model`、`thinkingEffort`、`thinkingMode`、`maxTokens`、`jsonOnly`、`emitThinking`、`emitToConsole`、`emitInterval`、`excludeHistoryToolCall` 等。

优先级：CLI 参数 > `.chatxtrc/config.json`（向上查找最近的 `.chatxtrc` 目录）。`getModelGateway()` 按模型 alias 匹配 provider，得到 endpoint、类型与定价；也支持旧的平铺 `endpoint + apikey` 直连方式。`initConfig()` 生成配置模板。

### `session.ts`（ChatSession）

主循环：文件不存在则写入默认模板（SYSTEM + 空 USER）退出 → `buildPrompt()` 解析出 `messages` 与工具路径 → 校验最后一条消息为 `user` 且非空 → 加载工具子进程 → 生成循环（直到 `shouldStop`）：流式请求 → 逐 chunk 转成 `StreamEvent` 交给 `onEmit`。

- `reasoning-*` → THINKING 块（可选）；`content-*` → ASSISTANT 块；`function-call-*` → TOOL 块并拼装完整调用
- `finish_reason === 'tool_calls'` → 并发执行工具、写入 TOOLRESPONSE 块，回到循环开头；其他 finish_reason → 结束循环；网络异常自动重试（≤3 次）
- 收尾：追加空 USER 块、刷新写缓冲、统计（token/耗时/成本/工具调用数）、关闭工具进程；`SIGINT` 优雅退出

其他职责：`subAgentChatCompletion()` 代理工具子进程的非流式 LLM 调用（不支持 stream/tools），用量并入会话总计。

### `fileobj.ts`（ChatFile）

- 解析方向：`parseToBlock()` 按角色分隔符切块（含 shebang 剥离），行内解析指令 → `Message[]` + 工具路径；`@include` 递归展开预设（校验无角色行、防循环引用、内部指令相对被包含文件解析、工具集向上合并）；TOOL/TOOLRESPONSE 块还原为 `tool_calls`/tool 消息；`excludeHistoryToolCall` 开启时跳过历史工具调用；`@file` 以绝对路径去重且每次 `buildPrompt` 重置引用集
- 写入方向：内容先进内存缓冲，`emitInterval`（默认 16ms）防抖批量 `appendFile`，`flushBuffer()` 强制落盘；`emitToConsole` 时改为输出到终端不写文件

### `api/`（适配器）

`APIAdapter` 接口：`whenParsedChat`（注入消息）、`whenReadyToRequest`（构造请求并返回 Response）、`whenRecvivedChunk`（SSE chunk → StreamEvent）。

内部统一使用与协议无关的扁平 `ToolDef`（`{ name, description, parameters }`），各 adapter 在 `whenParsedChat` 中将其转换为自身协议的 wire 格式（OpenAI 的 `{type:'function', function:{...}}` 包装、Anthropic 的 `input_schema`、Responses 的扁平 tool 定义）。三种实现：

- `openai-compatible.ts`：`/chat/completions`（DeepSeek、Zhipu 等），解析 `reasoning_content`、缓存命中、`tool_calls` 分片
- `anthropic.ts`：`/messages`（Claude、Qwen 等经 Anthropic 兼容网关），tool_result 归入 user 消息
- `openai-responses.ts`：`/responses`（GPT、Grok 等），function_call_output 项映射

### `tools/`（工具系统）

- `runner.ts`（主进程侧）：`loadTool()` fork 工具文件并通过 `--import tool-runtime.ts` 注入运行时，等待 register 消息（10s 超时）；`execute()` 为每次调用分配自增 requestId，Promise 挂起等待 result；子进程崩溃以错误 JSON 作为结果返回，不中断会话
- `tool-runtime.ts`（子进程侧）：注入 `chatxt` 运行时对象（`runtime.exposeTool` / `runtime.chatCompletion` / `helpers.convertArgsToSchema`），监听 execute 消息并回传结果
- `ipc-types.ts`：主→子 `execute | chatCompletionResult | exit`，子→主 `register | result | chatCompletion | warning | error`

### `common/`、`utils/` 与 `tui.ts`

- `usage.ts`：`NormalizedUsage`（input/output/cached/thinking/model）归一化与合并；`pricing.ts`：`computeTokenCostCNY()` 按定价表估算人民币成本（支持按 UTC 时段、上下文长度分段，见 `data/model-pricing.ts`，未知模型返回 NaN）
- `prompt.ts`：默认系统提示词，核心约束是"输出写入纯文本文件，禁用 Markdown 渲染符号"；`utils/` 提供 SSE 流解析与 token 估算
- `tui.ts`：黄/红着色警告与异常（附前 3 帧堆栈）、单行进度条（按阶段切换提示语、16ms 节流重绘）、最终统计输出

## 数据流

`.chat.txt` → `buildPrompt()` → messages + 工具路径 → 加载工具子进程 → 流式请求 → SSE chunk → `whenRecvivedChunk` → StreamEvent → 防抖写回文件；`finish_reason=tool_calls` 时经 IPC 执行工具 → TOOLRESPONSE 块 → 下一轮生成。工具内的 `chatCompletion` 经 IPC 由主进程代理。

## 设计要点

- **文件即状态**：历史、上下文、工具声明全部在同一个纯文本文件中，可读、可 diff、可手工编辑、可版本管理；重新运行即恢复会话
- **流式落盘**：生成内容经防抖缓冲实时追加，中断也能保留已生成部分
- **进程隔离的工具沙箱**：工具运行在独立子进程，崩溃不影响主会话（错误以 JSON 反馈给模型）；工具内可自由 `console.log` 调试
- **LLM 代理**：工具子进程不直接持有 API 凭据，`chatCompletion` 一律经主进程代理，用量统一计入统计
- **token 经济**：`--exclude-history-tool-call` 剔除历史工具调用；`@file` 同一文件去重；默认系统提示词强制纯文本输出
- **容错**：API 请求失败自动重试（≤3 次）；未知工具名、工具执行异常均以结构化错误反馈给模型而非终止会话
