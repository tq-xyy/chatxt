# J-Space 认知控制套件（中文精简版）— Chatfile 示例

将 J-Space 推理时认知控制协议以中文精简版的形式接入 Chatfile，演示"选择性加载 + 账本状态外化 + 模块按需读取"的完整闭环。

## 这是什么

J-Space（原版为 [J-Space-Cognition-Suite](https://github.com/Tiger3807861189/DeepSeek-V4-J-Space-Capability-Realization-Report) 配套套件）是一套**推理时认知控制协议**：不改模型权重、不微调，仅通过文本指令让模型更好地管理自己的"工作台"——控制台上放什么、目标不熄火、思考顺序正确、状态外化、检测并恢复失败。

本示例是**中文改写精简版**（`j-space-zh/`）：

- 砍掉原版每个文件重复的 Premise 与大量研究证据（Grounding），只保留 1 句依据
- 完整保留所有可操作的协议规则（Protocol）
- 原版全套约 120KB 英文 ≈ 3 万+ token；本版约 15KB 中文 ≈ 1 万 token 内，配合中文分词更省

## 目录结构

```
j-space_cognition_suite/
├── j-space-zh/               # 中文精简版协议
│   ├── SKILL.md              # 唯一入口：前提 + 门控 + 路由 + 不变量
│   ├── modules/              # 9 个模块（按需加载）
│   └── references/           # 账本模板 + 实例
├── jspace.tool.ts            # 账本控制器（Chatfile 工具）
├── demo.chat.txt             # 演示对话
└── .gitignore                # 排除 .jspace/ 运行时状态
```

## 使用方式

新建一个 `demo.chat.txt`，内容如下。这个示例演示了一个 loop 级审计任务：

```
----- CHAT ROLE: USER -----
@tool(jspace.tool.ts)              # 1. 加载账本工具
@include(j-space-zh/SKILL.md)      # 2. 选择性注入协议入口（唯一入口）
@file(...)                         # 3. 资料（审计对象）
任务：审计 ...
```

```bash
$ chatfile examples/j-space_cognition_suite/demo.chat.txt
```

模型会按协议自动执行：声明档位 → `jspace_init` 建账本 → 子任务接缝处 `jspace_seam` 刷新 → 验证发现 `jspace_check` 登记 → 完成前 done-check。

## 工具清单（jspace.tool.ts）

| 工具                           | 对应原版 jspace.py          | 功能                                              |
| ------------------------------ | --------------------------- | ------------------------------------------------- |
| `jspace_init`                  | `note --goal --next`        | 初始化/更新账本：Goal + Next                      |
| `jspace_core`                  | `note --core [--core-slot]` | 广播枢纽条目：追加 / 槽位 1~2 显式替换            |
| `jspace_check`                 | `note --check --by`         | 登记已验证 checkpoint（结论+依据+覆盖，强制齐全） |
| `jspace_open` / `jspace_close` | `note --open/--close`       | 开放问题登记与关闭（编号永不重用）                |
| `jspace_seam`                  | `seam`                      | 接缝刷新：返回账本快照                            |
| `jspace_module`                | （原版无）                  | 按需读取模块协议，任务中途加载                    |

账本写在工具文件同目录 `.jspace/WORKSPACE.md`（五节：Goal/Core/Verified/Open/Next），跨会话存活。

## 与 Chatfile 的对接机制

| Chatfile 能力       | 承载的 J-Space 机制                        |
| ------------------- | ------------------------------------------ |
| `@include()` 指令   | 选择性加载：只注入协议入口，不灌全量       |
| `@tool()` 指令      | 账本控制器 + 模块按需读取（AI 侧自主加载） |
| `@file()` 指令      | 资料附注：协议前置、资料后置，天然分区     |
| `.jspace/` 文件     | 状态外化：账本跨会话存活，接缝重读         |
| THINKING 块（`-t`） | 内轨（稠密）与外轨（干净）天然分离         |

## 注意事项

- `@include` 只在 USER 块解析，**SYSTEM 块里写 `@include` 会把字面文本发给模型**，不要这么用
- `@include` 内容会进上下文计费：SKILL.md 约 4KB 中文，属于设计内的"入口成本"；模块不预加载，由 AI 经 `jspace_module` 按需读取
- 工具描述已引导模型"只在接缝处读写账本"，避免每轮都读（这本身就是选择性加载原则）
- 账本 `.jspace/` 是运行状态，已加入 .gitignore；删除它只会丢失账本状态，协议本身不依赖它
- 中文版砍掉了原版的科学论证细节（Grounding）与诱导技术（induction-playbook）；需要完整证据链请参考原版仓库
