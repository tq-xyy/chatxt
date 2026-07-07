# Auto Prompt Engineering — 提示词自动优化工具

基于 Chatfile 工具系统实现，让 LLM 可以自行对用户的 prompt 进行测试和迭代优化。

## 工作流程

```
用户提供 prompt + 测试样例 → AI 调用 savePrompt 暂存 → 多次修改后调用 testPrompt 评估效果 → 分析结果并继续迭代
```

## 三个工具函数 (autoprompt.ts)

| 工具         | 功能                                                                                |
| ------------ | ----------------------------------------------------------------------------------- |
| `savePrompt` | 将 prompt 写入 `cache/prompt.txt`                                                   |
| `readPrompt` | 从 `cache/prompt.txt` 读取已暂存的 prompt                                           |
| `testPrompt` | 读取 prompt，遍历 `tests/` 中所有 `.txt` 文件作为测试样例调用 LLM，返回测试结果数组 |

## 使用方式

### 准备测试样例

在 `tests/` 目录下创建 `.txt` 文件，每个文件是一个独立的测试用例，文件内容即为 user message 的输入。

例如: (文件名称随意)

```
tests/
├── simple.txt      # 简单场景
├── edge_case.txt   # 边界情况
└── complex.txt     # 复杂场景
```

### 开始对话

创建 `my_prompt_work.chat.txt` 并引用 `autoprompt.ts`:

```
----- CHAT ROLE: SYSTEM -----
你是一个有帮助的 AI 助手。

----- CHAT ROLE: USER -----
@tool(./autoprompt.ts)
请帮我优化以下 prompt，它用于一个客户支持机器人：

"你是一个客服。回答用户问题。不要用 Markdown。"

先用 savePrompt 保存，然后 readPrompt 确认已保存。
```

运行：

```bash
chatfile my_prompt_work.chat.txt
```

AI 会依次调用 `savePrompt` 暂存目标 prompt，然后引导你进行修改。当你说"测试一下当前效果"时，AI 会调用 `testPrompt` 读取 `tests/` 中的样例进行评估，并根据测试结果继续优化。

## 注意

- `cache/` 和 `tests/` 已加入 `.gitignore`，不会被提交到版本控制
- 工具函数通过 `serveAsTool` 注册，由 Chatfile 工具系统自动调度，无需手动调用

