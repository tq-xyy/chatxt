# Chatxt

"对话即文件"的命令行 AI 聊天工具：用户在 `.chat.txt` 纯文本文件中书写对话，AI 回复（含思维链、工具调用与结果）实时写回同一文件，对话历史天然由文件承载。

## 项目概况

### 技术栈

- 语言：TypeScript（ESM，Node.js）
- 包管理：pnpm
- 构建：esbuild 打包单文件 `dist/cli.js`
- 依赖：commander（CLI 解析）、chalk（终端着色）

### 编码规范

- 4 空格缩进，无分号，字符串用单引号
- 格式问题用 `pnpm lint` 自动修复，不要手调

### 开发环境

- Windows 11 + PowerShell 7.6
- Node.js ≥ 22 + pnpm

## 常用命令

```bash
pnpm install        # 安装依赖
pnpm typecheck      # tsc --noEmit 类型检查
pnpm lint           # prettier 格式化
```

## 终端命令运行要求

- 新命令会话第一个命令先执行：`[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()`（治本中文乱码）
- 长命令 / 多行逻辑写成 `./*.ignored.ps1`，用 `pwsh -NoProfile -File` 执行，输出以 UTF-8 重定向到 `*.ignored.txt` 再读取——终端反馈捕获层会丢多行命令的输出
- native 命令（git 等）中文经 `>` 重定向会乱码 → 用 `| Out-File -FilePath x -Encoding utf8`
- 命令显示"无输出"先怀疑捕获层而非执行失败：用 Test-Path / 读文件交叉确认
- 运行结束后清理临时脚本与重定向文件（`.ignored.{ps1,txt}`）：有价值的去掉 `.ignored.` 后保留，无价值的删除

## 注意事项

- **硬性要求**: 用中文思考和回答用户问题，以便利用中文分词优化，节约 tokens 花费。
- 回答中不要使用 mermaid 图表（渲染开销大）；尽可能用嵌套列表代替表格（更简洁）；克制使用加粗符号。
- 你的 git 权限为 _只读_。**不要** 进行 git 提交。
- 如果测试所需 API 费用较少 （估算），无需询问用户；如果较多，需要用户二次确认。
- 如果不理解项目结构，可以先去查看 `docs` 目录下的文档。
- 当用户询问某些改动如何、指出理解错误或者直接给出方向但未作具体指示时，应该进行分析。**除非用户明示**，不要落实该改动。
