# Chatxt

"对话即文件"的命令行 AI 聊天工具：用户在 `.chat.txt` 纯文本文件中书写对话，AI 回复（含思维链、工具调用与结果）实时写回同一文件，对话历史天然由文件承载。

## 技术栈

- 语言：TypeScript（ESM，Node.js ≥ 22）
- 包管理：pnpm
- 构建：esbuild 打包单文件 `dist/cli.js`
- 依赖：commander（CLI 解析）、chalk（终端着色）
- API：OpenAI 兼容 `/chat/completions`（默认 DeepSeek，支持流式与思维链）

## 常用命令

```bash
pnpm install        # 安装依赖（只用 pnpm，不用 npm/yarn）
pnpm build          # 构建 dist/cli.js
pnpm typecheck      # tsc --noEmit 类型检查
pnpm lint           # prettier 格式化
chatxt <file>     # 处理 .chat.txt 文件
chatxt init-config  # 生成 .chatxtrc/config.json
```

## 编码规范

- 4 空格缩进，无分号，字符串用双引号
- 格式问题用 `pnpm lint` 自动修复，不要手调

## 注意事项（重要）

- 新会话第一个命令先执行：`[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()`（治本中文乱码）
- 长命令 / 多行逻辑写成 `./*.ignored.ps1`，用 `pwsh -NoProfile -File` 执行，输出以 UTF-8 重定向到 `*.ignored.txt` 再读取——终端反馈捕获层会丢多行命令的输出
- native 命令（git 等）中文经 `>` 重定向会乱码 → 用 `| Out-File -FilePath x -Encoding utf8`
- 命令显示"无输出"先怀疑捕获层而非执行失败：用 Test-Path / 读文件交叉确认
- 运行结束后清理临时脚本与重定向文件（`.ignored.{ps1,txt}`）：有价值的去掉 .ignored. 保留，无价值的删除

## 开发环境

- Windows 11 + PowerShell 7.6
- Node.js ≥ 22，包管理器只用 pnpm

## 对话要求

用中文思考和回答用户问题，以便利用中文分词优化，节约 tokens。（硬性要求）
