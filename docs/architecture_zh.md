# Chatfile 架构文档

> 此文档已过时

Chatfile 是一个"对话即文件"的命令行 AI 聊天工具。用户在 `.chat.txt` 纯文本文件中书写对话，运行 `chatfile <file>` 后，AI 的回复（含思维链、工具调用与结果）被原样追加写回同一文件。整个对话历史天然由文件本身承载，无需数据库。

- 语言：TypeScript（ESM，Node.js ≥ 22）
- 构建：esbuild 打包为单文件 `dist/cli.js`
- 运行时依赖：`commander`（CLI 解析）、`chalk`（终端着色）
- API 协议：OpenAI 兼容 `/chat/completions`（默认 DeepSeek 端点，支持流式与思维链）

---

## 目录结构总览

```
chatfile/
├── package.json              # 项目元信息与构建脚本
├── tsconfig.json             # TypeScript 配置（strict, ESNext）
├── docs/
│   ├── tool_guide_zh.md      # 工具编写指南（面向工具开发者）
│   └── architecture_zh.md    # 本文档
├── examples/
│   └── automatic_prompt_engineering/   # 示例：AI 自优化 Prompt 的工具集
└── src/
    ├── cli.ts                # CLI 入口（commander）
    ├── config.ts             # 配置加载与合并
    ├── session.ts            # 会话核心循环（ChatSession）
    ├── fileobj.ts            # .chat.txt 文件解析与写入（ChatFile）
    ├── tui.ts                # 终端 UI（进度、警告、统计）
    ├── types/
    │   └── openaiApi.ts      # OpenAI 兼容 API 类型定义
    ├── tools/
    │   ├── runner.ts         # 工具子进程管理（ToolRunner）
    │   ├── tool-runtime.ts   # 注入子进程的全局运行时
    │   ├── tool-runtime.d.ts # 全局函数类型声明
    │   ├── ipc-types.ts      # 主/子进程 IPC 消息类型
    │   └── streamhelper.ts   # 流式工具调用分片合并
    └── utils/
        ├── api.ts            # HTTP 请求封装（流式/非流式）
        ├── sseStream.ts      # SSE 流解析器
        ├── prompt.ts         # 默认系统提示词
        └── computeCost.ts    # token 用量合并与成本估算
```

---

## 核心概念

### 1. `.chat.txt` 文件格式

文件由若干"角色块"组成，每块以一行分隔符开始：

```
----- CHAT ROLE: SYSTEM -----
（系统提示词）

----- CHAT ROLE: USER -----
（用户输入，可包含指令）

----- CHAT ROLE: ASSISTANT -----
（AI 回复）

----- CHAT ROLE: THINKING -----
（思维链，仅 --show-thinking 时写入）

----- CHAT ROLE: TOOL -----
函数名 (调用ID): 参数JSON

----- CHAT ROLE: TOOLRESPONSE -----
调用ID: 结果JSON
```

首行支持 shebang（`#!/usr/bin/env chatfile`），解析时会被忽略。

### 2. 用户块内指令

仅 `USER` 块中的指令会被解析（其余角色块原样透传）：

- `@file(相对路径)`：将外部文件内容附加到该 user 消息末尾（同一文件在一次会话中只引用一次）
- `@tool(相对路径)`：声明工具文件，会话启动时加载其中注册的工具

路径相对于 `.chat.txt` 文件所在目录解析。

### 3. 工具文件

任意 Node.js 脚本（`.ts`/`.js`），通过全局函数 `serveAsTool(fn, description, jsonSchema)` 注册工具。工具文件由主进程 `fork` 为常驻子进程，通过 IPC 通信。详见 `docs/tool_guide_zh.md`。

---

## 模块详解

### `src/cli.ts` — CLI 入口

基于 commander，提供两个命令：

- `chatfile <file>`：处理指定 `.chat.txt` 文件（不存在时自动创建含默认系统提示词的模板）
    - `-m, --model`：覆盖模型名
    - `--endpoint`：覆盖 API 端点
    - `-t, --show-thinking`：将思维链写入文件
    - `--exclude-history-tool-call`：从上下文中剔除历史工具调用以节省 token
- `chatfile init-config`：在当前目录创建 `.chatfilerc/config.json` 模板

### `src/config.ts` — 配置系统

配置项：`endpoint`、`model`、`apiKey`、`thinkingEffort`、`showThinking`、`excludeHistoryToolCall`。

加载优先级：

```
运行时参数（CLI 选项） > .chatfilerc/config.json > 默认模板
```

- 配置文件通过向上查找最近的 `.chatfilerc` 目录定位（类似项目根标记）。
- `apiKey` 特殊处理：环境变量 `OPENAI_API_KEY` 优先于配置文件。
- 安全机制：若配置文件中含 apiKey 且未设置环境变量，发出警告；创建 `.chatfilerc/allow-apikey-in-project` 标记文件可抑制该警告。

### `src/session.ts` — 会话核心（ChatSession）

`ChatSession` 是整个系统的中枢，持有 `ChatFile`、`ToolRunner`、消息列表与用量统计。

主循环 `loop()` 流程：

1. 文件不存在 → 写入默认模板后退出。
2. `ChatFile.buildPrompt()` 解析文件得到 `messages` 与工具路径集合。
3. 校验最后一条消息必须是 `user` 且非空，否则提示后退出。
4. `ToolRunner.loadTools()` 加载所有工具子进程。
5. **生成循环**（`while outputFlag !== false`）：
    - 调用 `chatCompletionStream()` 发起流式请求（附带工具定义）。
    - 逐 chunk 处理（`handleChunk`）：
        - `reasoning_content` → 写入 THINKING 块（可选）
        - `content` → 写入 ASSISTANT 块
        - `tool_calls` → 写入 TOOL 块，并用 `mergeToolCallChunks` 在内存中拼装完整调用
    - `finish_reason === 'tool_calls'` → 执行工具、追加 TOOLRESPONSE 块、回到循环开头继续生成
    - 其他 `finish_reason` → 结束循环
    - 网络等异常自动重试，上限 3 次
6. 收尾：追加空 `USER` 块（方便用户下次输入）、刷新写缓冲、打印统计。

其他职责：

- `subAgentChatCompletion()`：供工具子进程代理的非流式 LLM 调用（不支持 stream/tools），token 用量并入会话总计。这是工具内 `chatCompletion()` 全局函数的后端。
- 工具调用 ID 生成：`{chatTurn}-{sumToolCall}`，保证文件中可读且唯一。
- 用量统计：累加每次响应的 `usage`（含缓存命中、思维链 token）。

### `src/fileobj.ts` — 文件对象（ChatFile）

负责 `.chat.txt` 的双向处理：

**解析方向（buildPrompt）**：

```
原始文本 → parseToBlock() → Block[] → Message[] + 工具路径集合
```

- 按角色分隔符切分为块；每行再按指令正则切分为字符串/指令组件。
- `USER` 块：展开 `@file`（读文件内容附加到消息尾部）与 `@tool`（收集工具路径）。
- `SYSTEM`/`ASSISTANT` 块：原样转为消息（指令不展开）。
- `TOOL` 块：按 `函数名 (ID): 参数` 行格式还原 `tool_calls`，挂到前一条 assistant 消息上。
- `TOOLRESPONSE` 块：按 `ID: JSON` 行格式还原 tool 消息。
- `excludeHistoryToolCall` 开启时跳过 TOOL/TOOLRESPONSE 块（省 token）。

**写入方向**：

- 所有写入先进内存缓冲，16ms 防抖批量 `appendFile`，结束时 `flushBuffer()` 强制落盘。
- `appendRoleLine()` / `appendContent()` / `appendThinkingText()` 分别对应角色分隔符、正文、思维链。

### `src/tools/` — 工具系统

采用**主进程 + fork 子进程**架构，每个工具文件一个常驻子进程。

#### `runner.ts`（ToolRunner，主进程侧）

- `loadTool()`：`fork` 工具文件，通过 `--import tool-runtime.ts` 注入运行时；等待子进程 `register` 消息（10 秒超时）；同名工具先注册者胜出并告警。
- `execute()`：为每次调用分配自增 `requestId`，经 IPC 发送 `execute` 消息，Promise 挂起等待 `result`；子进程崩溃时统一以错误 JSON 作为工具结果返回（不让会话中断）。
- `executeAll()`：`Promise.all` 并发执行同一轮的所有工具调用。
- `close()`：向所有子进程发送 `exit`。
- `forwardChatCompletion()`：将子进程的 `chatCompletion` 请求转发给 `ChatSession.subAgentChatCompletion()`，结果回传。

#### `tool-runtime.ts`（子进程侧，注入的全局运行时）

提供三个全局函数（无需 import）：

- `serveAsTool(...entries)`：注册工具并上报定义；随后进程保持存活监听调用；支持传 `null/false` 跳过条目
- `chatCompletion(request)`：在工具内调用 LLM，经 IPC 由主进程代理，用量计入会话
- `ToJSONSchema(argsDefs)`：简写参数定义（名称/描述/构造函数/可选性）→ JSON Schema

#### `ipc-types.ts` — IPC 消息协议

```
主 → 子:  execute {id, toolName, args}   |  chatCompletionResult {id, result|error}  |  exit
子 → 主:  register {tools}               |  result {id, result|error}
          chatCompletion {id, request}   |  warning {message}
```

#### `streamhelper.ts`

`mergeToolCallChunks()`：流式响应中工具调用被拆成多个 chunk（首个含 `type: 'function'` 与函数名，后续仅含参数分片），此函数按 `index` 原地合并为完整 `ToolCall[]`。

### `src/utils/` — 基础设施

- `api.ts`：`requestChatCompletion()` 统一 HTTP 封装（Bearer 认证、错误解析）；`chatCompletionStream()` 强制 `stream: true` 返回原始 Response；`chatCompletion()` 非流式便捷方法
- `sseStream.ts`：异步生成器逐行解析 SSE：按 `\n` 分帧、提取 `data:`、跳过 `[DONE]`、`JSON.parse` 每个 chunk
- `prompt.ts`：默认系统提示词，核心约束是"输出将写入纯文本文件，禁用 Markdown 渲染符号"
- `computeCost.ts`：`mergeUsage()` 累加用量；`computeTokenCostCNY()` 按 deepseek-v4-flash / deepseek-v4-pro 单价估算人民币成本（未知模型返回 -1）

### `src/tui.ts` — 终端 UI

- `printWarningMessage` / `printExceptionMessage`：黄/红着色的警告与异常（异常附前 3 帧堆栈）。
- `printFinalStatus`：会话结束统计（总 token、缓存/思维链细分、耗时、预估成本、工具调用次数）。
- `ProgressReporter`：单行进度条，按阶段切换提示语（Thinking... / Generating Answer... / Call Function...），16ms 节流重绘，每秒心跳刷新。

### `src/types/openaiApi.ts` — API 类型

完整定义 OpenAI 兼容协议的消息、请求、响应与流式 chunk 类型，并包含 DeepSeek 扩展字段：

- `reasoning_content`（思维链）
- `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`（缓存计费）
- `thinking` / `reasoning_effort` 请求参数
- `finish_reason` 扩展值 `insufficient_system_resource`

---

## 整体数据流

```mermaid
flowchart TD
    A[.chat.txt 文件] -->|buildPrompt| B[Message[] + 工具路径]
    B -->|loadTools| C[ToolRunner<br/>fork 工具子进程]
    B -->|messages + tools| D[chatCompletionStream<br/>SSE 流式请求]
    D -->|chunk| E{handleChunk}
    E -->|reasoning_content| F[THINKING 块]
    E -->|content| G[ASSISTANT 块]
    E -->|tool_calls| H[TOOL 块]
    H -->|finish_reason=tool_calls| I[ToolRunner.executeAll<br/>IPC 调用子进程]
    I -->|tool 消息| J[TOOLRESPONSE 块]
    J -->|继续生成| D
    E -->|finish_reason=stop 等| K[追加 USER 块<br/>flushBuffer 落盘]
    F & G & H & J --> A
    C <-.->|chatCompletion 代理| L[ChatSession<br/>subAgentChatCompletion]
```

一次典型运行的时间线：

1. 用户在 `.chat.txt` 的 USER 块写好输入（可 `@file` 引用资料、`@tool` 声明工具）。
2. `chatfile xxx.chat.txt` 启动，解析文件、加载工具子进程。
3. 流式生成：思维链/正文/工具调用实时防抖写回文件（用户可在编辑器中实时查看）。
4. 若模型发起工具调用：并发执行，结果写入 TOOLRESPONSE 块，随后自动发起下一轮生成。
5. 循环直至模型给出最终回答，末尾追加空 USER 块等待下次输入。
6. 终端打印 token 用量、耗时与成本统计。

---

## 设计要点

- **文件即状态**：对话历史、上下文、工具声明全部在同一个纯文本文件中，可读、可 diff、可手工编辑、可版本管理。重新运行即"恢复会话"。
- **流式落盘**：生成过程中内容经 16ms 防抖缓冲实时追加到文件，中断也能保留已生成部分。
- **进程隔离的工具沙箱**：工具运行在独立子进程，崩溃不影响主会话（错误以 JSON 结果返回给模型）；工具内可自由 `console.log` 调试，输出直接透传到主进程终端。
- **LLM 代理**：工具子进程不能直接访问 API 凭据，`chatCompletion` 一律经 IPC 由主进程代理，用量统一计入会话统计。
- **token 经济**：`--exclude-history-tool-call` 可剔除历史工具调用；`@file` 同一文件去重引用；默认系统提示词强制纯文本输出避免渲染噪音。
- **容错**：API 请求失败自动重试（≤3 次）；未知工具名、工具执行异常均以结构化错误反馈给模型而非终止会话。

## 已知限制与规划（来自 TODO）

- 尚未支持主/备用模型切换。
- 计划增加 `compact` 命令以压缩上下文。
- 规划中的"自感知"能力：AI 自删聊天记录、感知资源消耗、自行编写工具、查看自身源代码与运行时长。
