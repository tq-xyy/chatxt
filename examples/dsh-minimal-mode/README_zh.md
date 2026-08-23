# Minimal Agent — 复刻 DeepSeek Harness 极简模式

基于 Chatfile 工具系统实现 DeepSeek Harness（`dsh`）的 `minimal` agent preset（预设名"极简模式"）。dsh 的极简模式只有两把工具：

> 仅提供持久 bash 与 str_replace_editor 的双工具编码 Agent。

本示例用**一个工具文件** + **固定系统提示词**复刻同样的体验。

## 与 dsh 极简模式的对照

| 维度        | dsh minimal preset                                                              | 本示例                                                    |
| ----------- | ------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 系统提示词  | 固定为 `You are a helpful software engineer assistant.`，且禁止其他插件追加文本 | 在 `.chat.txt` 的 SYSTEM 段写同一句话，天然就是完整提示词 |
| 工具 1      | 持久 shell（POSIX 用 bash，win32 用 pwsh），状态跨调用保持，超时 5 分钟         | `run_shell`（模块级保存的 spawn 进程，同一实现）          |
| 工具 2      | `str_replace_editor`（view / str_replace / create / insert）                    | `str_replace_editor`（同样四种命令）                      |
| 上下文压缩  | 无                                                                              | 无（文件即历史）                                          |
| 沙箱 / 权限 | 有（workspace-write）                                                           | 无（工具直接操作文件系统，使用前请自行评估）              |

## 使用方式

### 1. 创建示例会话文件

```text
----- CHAT ROLE: SYSTEM -----
You are a helpful software engineer assistant.
----- CHAT ROLE: USER -----
@tool(./minimal-agent.tool.ts)
在 src/foo.ts 里把唯一的 "TODO" 替换成 "DONE"，然后用 git diff 确认改动
```

SYSTEM 段固定为 `You are a helpful software engineer assistant.`（与 dsh 极简模式一致），USER 段第一行 `@tool(./minimal-agent.tool.ts)` 加载两个工具。

### 2. 运行

```sh
chatfile my_session.chat.txt
```

## 工具说明

### `run_shell`

在持久 shell 中运行命令，**状态跨命令调用与对话保持**：

- POSIX：`bash`；Windows：`pwsh`
- 可选参数 `timeoutMs`，默认 300000（5 分钟），超时返回部分输出并**重置 shell**（下一条命令从全新会话开始，不会沿用坏状态）
- 描述中引导 AI：避免大量输出、长命令放后台（`sleep 10 &` / `Start-Job`）、无互联网

```json
{ "command": "ls src/", "timeoutMs": 300000 }
```

#### 实现机制（对照 DeepSeek Harness `tool-pwsh-persistent` / `tool-bash-persistent`）

每条命令被包装为**单物理行 wrapper** 写入持久 shell：

- 随机 nonce（UUID）的 START/END marker，END marker 后紧跟**同行的数字退出码**（`'END_nonce:' + code`），解析端用 `/^(\d+)\r?\n/` 提取——命令输出或回显中的 marker 文本永远无法伪造完成
- pwsh：`$LASTEXITCODE = $null` 先清除残留；`try { Invoke-Expression ... } catch` 把语法错误归一为失败而不炸掉 shell；外部命令退出码优先，否则用 `$?` 映射 0/1
- bash：`eval -- $'...'`（ANSI-C quoting 压成单行），`$?` 即退出码
- 命令体经 **base64(UTF-16LE)** 传输（pwsh 官方 `-EncodedCommand` 思路）：`-Command -` 逐行模式下 stdin 按系统 ANSI 代码页解码，直接发送中文字符命令会被损坏，base64 全 ASCII 无此问题
- 超时 / shell 意外退出 → kill 并重置，下次调用全新会话（对照 dsh 的 reset 契约）
- 同一 agent 的命令**串行排队**（对照 dsh 的 serialized）；输出超过 16,000 字符自动截断并附 `<response clipped>` 引导

> 与 dsh 的差异：dsh 的持久 shell 运行在 PTY 里（bash `-i` / pwsh 交互式），因此需要安装受控提示符、剥离 PSReadLine 回显、按 25ms 轮询 scrollback；chatfile 使用 spawn 管道（无交互回显），同样语义下更简单，采用事件驱动读取。

### `str_replace_editor`

精确字符串编辑，支持四种命令：

| 命令          | 参数                                          | 行为                                 |
| ------------- | --------------------------------------------- | ------------------------------------ |
| `view`        | `file_path`，可选 `view_range`（如 `"1:50"`） | 查看文件内容或指定行范围             |
| `str_replace` | `file_path`、`old_string`、`new_string`       | 唯一匹配替换；0 处或多处匹配返回错误 |
| `create`      | `file_path`、`new_string`                     | 创建文件；已存在则报错               |
| `insert`      | `file_path`、`line`、`new_string`             | 在指定行插入内容                     |

```json
{
    "command": "str_replace",
    "file_path": "src/foo.ts",
    "old_string": "TODO",
    "new_string": "DONE"
}
```

## 与 dsh 的差异

- **无沙箱与权限层**：dsh 默认 `workspace-write` 权限预设，本示例中工具可读写任何路径，请仅在可信环境中使用。
- **无Web UI 会话创建**：dsh 需要在 Web UI 的 `/` 菜单选择"极简模式"，chatfile 只需一行 `@tool(...)`，更贴合"对话即文件"。
- **PTY 差异**：dsh 的持久 shell 是真实 PTY（交互式 bash/pwsh），本示例是管道模式，无交互回显、无 PSReadLine，实现更简单。
