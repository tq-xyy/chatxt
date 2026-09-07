# Chatxt 自定义适配器（Custom Adapter）

Chatxt 通过 `APIAdapter` 接口连接模型服务。仓库内置了三种适配器（`openai-compatible`、`openai-responses`、`anthropic`）；如果你的服务不在其中，可以写一个自定义适配器，把该服务的「SSE 流式 HTTP 接口」接入 Chatxt。

文档分两部分：

1. 适配器接口：要实现的三个方法、以及它如何与 Chatxt 交互
2. 快速上手：一个最小可用的自定义适配器

---

## 适配器接口

### 适配器做什么

适配器负责两件事：

1. 把会话消息（`Message[]`）与工具定义（`ToolDef[]`）组装成目标协议的请求，发出去，返回 `Response`
2. 把该协议返回的 SSE 流翻译成 `StreamEvent` 事件发给 Chatxt

Chatxt 在两种场景各创建一次适配器：主对话（每轮生成）与工具子进程的 `chatCompletion`（工具内部调用 LLM 时）。两处共用同一接口。

### 三个方法

```ts
    buildRequest(
        config: Config,
        gateway: ModelGateway,
        messages: Message[],
        toolDefinitions: ToolDef[]
    ): Promise<Response>

    handleChunk(
        message: SSEMessage<Chunk>,
        emit: (event: StreamEvent) => Promise<void>
    ): Promise<void>

    handleStreamEnd(emit: (event: StreamEvent) => Promise<void>): Promise<void>
}
```

相关类型 `Message` / `ToolDef` / `FinishReason` / `FunctionCallDelta` 与 `APIAdapter` / `StreamEvent` 分别在 `src/types/chat-file.ts` 与 `src/types/api-adapter.ts` 中定义；`Config` / `ModelGateway` 来自 `src/config.ts`，`SSEMessage` 来自 `src/utils/sse-stream.ts`。

#### `buildRequest(config, gateway, messages, toolDefinitions): Promise<Response>`

- 组装请求并用 `fetch` 发送，返回 `Response`。
- `messages` 只读：Chatxt 持有这份数组用于后续写文件，适配器不应修改它；需要拼接原始历史时，在本地拷贝一份再转换。
- 返回前把非 2xx 响应视为错误：Chatxt 会据错误进行重试（默认至多 3 次），超过后本轮失败、不落盘并报错退出。
- **同一适配器实例会被复用**：一轮 `tool_calls` 之后会在循环开头再次调用 `buildRequest`。因此把每次 `buildRequest` 当作一次全新的请求来处理，在开头重置你维护的任何状态（用 class 字段，而不是对象方法里的 `this`）。
- `toolDefinitions` 可能为空（工具内部的 `chatCompletion` 调用没有工具）。

#### `handleChunk(message, emit): Promise<void>`

- `message` 是 SSE 流里解析好的一个数据块：`{ id?, retry?, event?, data }`，`data` 是对应协议原始数据的 JSON 解析结果（`[DONE]`、空行等结束标记已被跳过，不会出现在这里）。
- 把这块数据转换成若干个 `StreamEvent`，用 `emit(event)` 逐个发出。`emit` 返回 Promise，且事件有先后顺序，请 `await` 并按顺序发。
- 当前块没有可产出的事件时，直接返回即可。协议在数据里明确报错时直接抛出异常（与 `buildRequest` 的非 2xx 一样，会触发 Chatxt 重试，默认至多 3 次，超过后本轮失败、不落盘并报错退出）。

#### `handleStreamEnd(emit): Promise<void>`

- SSE 流读取完（正常读完或中断）后调用一次，用来发出收尾事件，典型是 `response-end`（很多协议把 usage、finish_reason 放在流的末尾，需要在流结束后补发）。
- 如果协议在流中已经发完了收尾事件，这个方法可以为空实现。
- 把收尾逻辑放在这里：`handleChunk` 可能因网络中断而提前结束，不保证一定被调用；`handleStreamEnd` 是会被调用的收尾点。状态重置仍以 `buildRequest` 为边界，而不是 `handleStreamEnd`。

### StreamEvent：适配器与 Chatxt 之间的事件

适配器全部产出归一化为以下事件，Chatxt 据此写文件、更新进度条、拼装工具调用。**事件不是可选的**——`reasoning-start`（如果这轮有思维链）、`content-start`/`content-end`、`function-call-start`/`function-call-end`、`response-start`、`response-end` 都在对应的时刻发出。

| 事件                  | 含义                         | 负载                               |
| --------------------- | ---------------------------- | ---------------------------------- |
| `response-start`      | 本轮响应开始                 | —                                  |
| `reasoning-start`     | 思维链开始（无思维链则不发） | —                                  |
| `reasoning-delta`     | 思维链增量                   | `delta: string`                    |
| `reasoning-end`       | 思维链结束                   | —                                  |
| `content-start`       | 正文开始                     | —                                  |
| `content-delta`       | 正文增量                     | `delta: string`                    |
| `content-end`         | 正文结束                     | —                                  |
| `function-call-start` | 开始输出工具调用             | —                                  |
| `function-call-delta` | 工具调用增量                 | `delta: FunctionCallDelta`（见下） |
| `function-call-end`   | 工具调用完成                 | —                                  |
| `response-end`        | 本轮结束                     | `finishReason?`、`usage?`（见下）  |

`function-call-delta` 的详情有两种形状，分别用于「声明一次调用」与「追加参数分片」：

```ts
type FunctionCallDelta =
    | {
          type: 'callee'
          index: number
          callee: string
          callId: string
          arguments?: string
      }
    | { type: 'arguments'; index: number; delta: string }
```

- `callee`：声明一次工具调用。`index` 是该调用的序号（用于把后续 `arguments` 分片关联到这次调用），`callee` 是工具名，`callId` 是对应协议侧生成的调用 ID。如果协议一次就给全了参数，可放进 `arguments`。
- `arguments`：本轮工具调用参数的一个分片，`delta` 是追加的字符串。

### 结束信息：finishReason 与 usage

`response-end` 携带本轮结束信息：

- `finishReason`:取下列值之一：

```ts
type FinishReason =
    | 'stop'
    | 'length'
    | 'content_filter'
    | 'tool_calls'
    | 'insufficient_system_resource'
```

- 值为 `tool_calls` 时 Chatxt 会执行本轮发出的工具，并把结果并入上下文后进入下一轮。若你的协议在「有待执行工具」时没有给出显式结束原因，也要在收尾时发成 `tool_calls`，否则工具不会被执行。
- 其他值（或省略）表示本回合结束，不再进入下一轮。
- 若你的协议支持工具：被调用的工具名、`callId`、参数分片都要通过 `function-call-*` 事件上报（见上表），否则工具不会被触发；工具的调用结果会作为后续消息进入下一轮。

- `usage`:统一计费信息：

```ts
interface NormalizedUsage {
    input: number // 输入 token 数
    output: number // 输出 token 数
    cached: number // 缓存命中的 token 数
    thinking: number // 思维链 token 数
    model?: string // 可选；用于区分不同模型的计费
}
```

- 如果你的协议把 usage 拆成多个字段（如缓存读/写分开报告），按语义合并到上面的四项里即可。
- 计费精度取决于你在配置里为该模型配置的定价;usage 缺失时成本显示为未知。

下面列出三个内置适配器各自对接的协议,可作为接入的起点(具体 wire 格式可参考 ESM 里的类型定义):

| 适配器              | 端点                          | 事件来源              | 思维链字段                                    | 工具字段                                    |
| ------------------- | ----------------------------- | --------------------- | --------------------------------------------- | ------------------------------------------- |
| `openai-compatible` | `<endpoint>/chat/completions` | Chat Completions 流式 | `delta.reasoning_content` / `delta.reasoning` | `delta.tool_calls[]`                        |
| `openai-responses`  | `<endpoint>/responses`        | Responses 流式        | `response.reasoning_text.delta` 等            | `response.output_item.added`(function_call) |
| `anthropic`         | `<endpoint>/messages`         | Anthropic 流式        | `delta.thinking`                              | `content_block_start.tool_use`              |

---

## 快速上手：一个最小自定义适配器

假设有个「极简文本」服务:`POST <endpoint>/chat`,请求体 `{ prompt }`,响应是 SSE,`data:` 行直接用纯文本片段作为内容。写一个适配器:

```ts
// custom-text.adapter.ts
import type { APIAdapter, StreamEvent } from 'chatxt/src/types/api-adapter'
import type { Config, ModelGateway } from 'chatxt/src/types/config'

interface TextChunk {
    text?: string
    done?: boolean
}

export default class CustomTextAdapter implements APIAdapter<TextChunk> {
    private started = false

    async buildRequest(config, gateway, messages, toolDefinitions) {
        this.started = false

        // 取最后一条用户消息作为 prompt
        const lastUser = [...messages].reverse().find(m => m.role === 'user')
        const prompt = lastUser?.role === 'user' ? lastUser.content : ''

        const resp = await fetch(`${gateway.endpoint}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt }),
        })

        if (!resp.ok) {
            throw new Error(`custom-text API error: HTTP ${resp.status}`)
        }
        return resp
    }

    async handleChunk(message, emit) {
        const data = message.data
        if (data.done) {
            // 流结束标记:补发 response-end(无工具、无 usage)
            await emit({ type: 'response-end' })
            return
        }
        if (data.text) {
            await emit({ type: 'response-start' })
            await emit({ type: 'content-start' })
            await emit({ type: 'content-delta', delta: data.text })
            await emit({ type: 'content-end' })
        }
    }

    async handleStreamEnd(emit) {
        // 若流中始终没有 done 标记,在这里兜底收尾
        if (!this.started) {
            await emit({ type: 'response-end' })
        }
    }
}
```

- 用了 `export default` + class,`buildRequest` 开头重置 `started`,`handleStreamEnd` 只在完全没有收到过内容时兜底发一个 `response-end`(这个示例协议没有 usage,所以不需要在 `response-end` 里带 usage)。
- 这是个最简示例:如果协议有思维链、工具或 usage,就按 1.3 / 1.4 的描述,在 `handleChunk` 里补发对应事件。

### 配置

在 `.chatxtrc/config.json` 的 `adapters` 字段声明适配器,并把某个 provider 的 `type` 指向它:

```jsonc
{
    "adapters": {
        "my-text": "./custom-text.adapter.ts",
    },
    "providers": [
        {
            "name": "MyText",
            "type": "my-text",
            "endpoint": "https://example.com/v1",
            "apikey": "your-key",
            "models": {
                "my-text-model": true,
            },
        },
    ],
    "defaultModel": "my-text-model",
}
```

- `adapters` 的 key 就是自定义 `type` 的名字;value 是模块文件路径,相对 `.chatxtrc` 所在目录解析。
- Chatxt 会用 `import()` 动态加载该模块。模块既可以用 ESM `export default`，也可以用 ESM 具名/顶层导出或 CJS `module.exports` 导出（加载逻辑先取 `default` 字段，再回退到模块本身）；建议用 `export default` 导出配好的 adapter。
- 加载后会校验 `buildRequest / handleChunk / handleStreamEnd` 三个方法,缺失则报错。
- 若你走 `--endpoint`/`--apikey` 直连(不走 providers),用 `--endpoint-type my-text` 指定自定义类型。
