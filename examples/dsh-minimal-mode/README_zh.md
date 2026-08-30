# examples/dsh-minimal-mode — 复刻 DeepSeek Harness 极简模式

基于 Chatxt 工具系统实现 DeepSeek Harness 的极简模式。DeepSeek Harness 的极简模式只有两把工具：

> 仅提供持久 bash 与 str_replace_editor 的双工具编码 Agent。

本示例用**一个工具文件** + **固定系统提示词**复刻同样的体验。

## 与 DeepSeek Harness 极简模式的对照

| 维度        | DeepSeek Harness 极简模式                                                       | 本示例                                                                    |
| ----------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 系统提示词  | 固定为 `You are a helpful software engineer assistant.`，且禁止其他插件追加文本 | 在 `.chat.txt` 的 SYSTEM 段写同一句话，天然就是完整提示词                 |
| 工具 1      | 持久 shell（POSIX 用 bash，win32 用 pwsh），状态跨调用保持，超时 5 分钟         | `run_shell`（POSIX 用 bash，Windows 用 BusyBox bash，两侧统一 bash 语法） |
| 工具 2      | `str_replace_editor`（view / str_replace / create / insert）                    | `str_replace_editor`（同样四种命令）                                      |
| 上下文压缩  | 无                                                                              | 无（文件即历史，可自行压缩）                                              |
| 沙箱 / 权限 | 有（workspace-write）                                                           | 无（工具直接操作文件系统，使用前请自行评估）                              |

## 使用方式

### 1. 创建示例会话文件

```text
----- CHAT ROLE: SYSTEM -----
@include(./dsh-minimal-code.preset.txt)

----- CHAT ROLE: USER -----
在 src/foo.ts 里把唯一的 "TODO" 替换成 "DONE"，然后用 git diff 确认改动
```

实际使用时 @include 地址 请切换为相对对话文件位置。

> Windows 依赖：需将 busybox-w32 的可执行文件（可从 <https://frippery.org/busybox/> 下载，推荐 `busybox64u.exe` 构建，或直接 `curl https://frippery.org/files/busybox/busybox64u.exe -o busybox64u.exe`）放入本目录的 `windows` 文件夹。（兼容 `busybox.exe` `busybox64.exe` `busybox64u.exe` `busybox64a.exe` 四种命名）

### 2. 运行

```sh
chatxt my_session.chat.txt
```

## 工具说明

### `run_shell`

在持久 shell 中运行命令，**状态跨命令调用与对话保持**。两侧统一为 bash 语法（AI 只需写 bash，不会再误写 PowerShell 命令）：

- POSIX：系统 `bash`（`--noprofile --norc`）
- Windows：BusyBox bash，**不依赖 PowerShell / pwsh**
- 可选参数 `timeoutMs`，默认 300000（5 分钟），超时返回部分输出并**重置 shell**（下一条命令从全新会话开始，不会沿用坏状态）

```json
{ "command": "ls src/", "timeoutMs": 300000 }
```

### `str_replace_editor`

精确字符串编辑，支持四种命令：

| 命令          | 参数                                          | 行为                                                       |
| ------------- | --------------------------------------------- | ---------------------------------------------------------- |
| `view`        | `file_path`，可选 `view_range`（如 `"1:50"`） | 查看文件内容或指定行范围，结果附总行数/范围信息            |
| `str_replace` | `file_path`、`old_string`、`new_string`       | 唯一匹配替换；0 处或多处匹配返回错误（多处时附各匹配行号） |
| `create`      | `file_path`、`new_string`                     | 创建文件（返回行数）；已存在则报错                         |
| `insert`      | `file_path`、`line`、`new_string`             | 在指定行插入内容                                           |

`str_replace` 与 `insert` 成功时返回**带行号的编辑后片段**（变更位置上下各 3 行）及文件总行数，便于 AI 直接核对改动、引用行号做后续编辑，无需再额外 `view` 一次。

```json
{
    "command": "str_replace",
    "file_path": "src/foo.ts",
    "old_string": "TODO",
    "new_string": "DONE"
}
```

## 与 DeepSeek Harness 极简模式的差异

- **无沙箱与权限层**：DeepSeek Harness 默认 `workspace-write` 权限预设，本示例中工具可读写任何路径，请仅在可信环境中使用。
- **无Web UI 会话创建**：DeepSeek Harness 需要在 Web UI 的 `/` 菜单选择"极简模式"，chatxt 只需一行 `@tool(...)`，更贴合"对话即文件"。
- **PTY 差异**：DeepSeek Harness 的持久 shell 是真实 PTY（交互式 shell：POSIX 上 bash、Windows 上 pwsh），本示例是管道模式，无交互回显，实现更简单。
- **shell 差异**：DeepSeek Harness 在 win32 上用 pwsh，本示例用 BusyBox bash。
