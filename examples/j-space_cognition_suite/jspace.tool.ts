import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// 账本存放在工具文件所在目录的 .jspace/ 下，与 .chat.txt 同目录，方便查看与 .gitignore
const LEDGER_DIR = path.join(__dirname, '.jspace')
const LEDGER_FILE = path.join(LEDGER_DIR, 'WORKSPACE.md')
const MODULES_DIR = path.join(__dirname, 'j-space-zh', 'modules')

const SECTIONS = ['Goal', 'Core', 'Verified', 'Open', 'Next'] as const

const MODULE_WHITELIST = [
    'capacity',
    'broadcast',
    'directed-focus',
    'deep-reasoning',
    'shorthand',
    'introspection',
    'self-monitoring',
    'markers',
    'empirics',
    'skill',
] as const

// ---------- 账本读写 ----------

function parseLedger(content: string): Record<string, string> {
    const sections: Record<string, string> = {}
    let current: string | null = null
    for (const line of content.split('\n')) {
        const m = line.match(/^## (\w+)$/)
        if (m && (SECTIONS as readonly string[]).includes(m[1])) {
            current = m[1]
            sections[current] = ''
        } else if (current) {
            sections[current] += line + '\n'
        }
    }
    return sections
}

function buildLedger(sections: Record<string, string>): string {
    const lines: string[] = ['# J-Space 工作台账本', '']
    for (const name of SECTIONS) {
        lines.push(`## ${name}`)
        const body = (sections[name] ?? '').trim()
        lines.push(body.length > 0 ? body : '（空）')
        lines.push('')
    }
    return lines.join('\n')
}

async function atomicWrite(content: string) {
    await mkdir(LEDGER_DIR, { recursive: true })
    const tmp = LEDGER_FILE + '.tmp'
    await writeFile(tmp, content, 'utf-8')
    await rename(tmp, LEDGER_FILE)
}

async function readLedger(): Promise<Record<string, string> | null> {
    try {
        return parseLedger(await readFile(LEDGER_FILE, 'utf-8'))
    } catch {
        return null
    }
}

async function requireLedger(): Promise<Record<string, string>> {
    const sections = await readLedger()
    if (!sections) {
        throw new Error('账本未初始化：请先调用 jspace_init 设置 Goal 与 Next')
    }
    return sections
}

function nextNumber(body: string, prefix: string): number {
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    let max = 0
    for (const m of body.matchAll(new RegExp(`${escaped}(\\d+)`, 'g'))) {
        max = Math.max(max, parseInt(m[1], 10))
    }
    return max + 1
}

function entriesOf(body: string): string[] {
    return body
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.startsWith('- '))
}

function pad(n: number): string {
    return String(n).padStart(2, '0')
}

// 条目字段限长：账本快照会进入对话上下文，超长条目会随轮次膨胀
function clip(text: string, max: number): string {
    return text.length > max ? text.slice(0, max) + '…' : text
}

// ---------- 工具函数 ----------

async function jspaceInit({ goal, next }: { goal: string; next: string }) {
    const sections = (await readLedger()) ?? {}
    sections['Goal'] = goal
    sections['Next'] = next
    await atomicWrite(buildLedger(sections))
    return {
        message: '账本已初始化（Goal/Next 已更新，Verified/Core/Open 保留）',
        ledger: buildLedger(sections),
    }
}

async function jspaceCore({
    name,
    fact,
    slot,
}: {
    name: string
    fact: string
    slot?: number
}) {
    const sections = await requireLedger()
    const entry = `- ${clip(name, 20)} — ${clip(fact, 40)}`
    const entries = entriesOf(sections['Core'] ?? '')
    if (slot !== undefined) {
        if (slot !== 1 && slot !== 2) {
            throw new Error('slot 只能为 1 或 2（Core 最多两个活条目）')
        }
        if (entries.length >= slot) {
            entries[slot - 1] = entry
        } else {
            entries.push(entry)
        }
    } else {
        if (entries.length >= 2) {
            throw new Error(
                'Core 已满（两个活条目）。请用 slot 参数指定要替换的槽位（1 或 2），不要追加第三条'
            )
        }
        entries.push(entry)
    }
    sections['Core'] = entries.join('\n')
    await atomicWrite(buildLedger(sections))
    return {
        message: slot ? `Core 槽位 ${slot} 已替换` : 'Core 已追加',
        entry,
    }
}

async function jspaceCheck({
    conclusion,
    by,
    coverage,
}: {
    conclusion: string
    by: string
    coverage: string
}) {
    const sections = await requireLedger()
    const body = sections['Verified'] ?? ''
    const num = nextNumber(body, '✓')
    const entry = `- ✓${pad(num)} ${clip(conclusion, 60)} — 验证依据：${clip(by, 40)}；覆盖范围：${clip(coverage, 40)}`
    sections['Verified'] =
        (body.trim().length > 0 ? body.trimEnd() + '\n' : '') + entry
    await atomicWrite(buildLedger(sections))
    return {
        message: `已登记 checkpoint ✓${pad(num)}`,
        entry,
    }
}

async function jspaceOpen({
    question,
    settled_by,
}: {
    question: string
    settled_by: string
}) {
    const sections = await requireLedger()
    const body = sections['Open'] ?? ''
    const num = nextNumber(body, '?')
    const entry = `- ?${pad(num)} ${clip(question, 60)} — 判定：${clip(settled_by, 40)}`
    sections['Open'] =
        (body.trim().length > 0 ? body.trimEnd() + '\n' : '') + entry
    await atomicWrite(buildLedger(sections))
    return {
        message: `已登记开放问题 ?${pad(num)}`,
        entry,
    }
}

async function jspaceClose({ id }: { id: number }) {
    const sections = await requireLedger()
    const body = sections['Open'] ?? ''
    const target = `?${pad(id)}`
    const lines = body.split('\n').filter(l => !l.includes(target))
    if (lines.join('\n').trim() === body.trim()) {
        throw new Error(`未找到开放条目 ${target}`)
    }
    sections['Open'] = lines.join('\n')
    await atomicWrite(buildLedger(sections))
    return {
        message: `已关闭 ${target}（编号永不重用）`,
    }
}

async function jspaceSeam() {
    const sections = await requireLedger()
    return {
        message:
            '接缝刷新：重读以下账本，对照 Goal 检查进度，确认 Next 仍是当前下一步',
        ledger: buildLedger(sections),
    }
}

async function jspaceModule({ name }: { name: string }) {
    if (!(MODULE_WHITELIST as readonly string[]).includes(name)) {
        throw new Error(
            `未知模块：${name}。可用模块：${MODULE_WHITELIST.join(', ')}`
        )
    }
    const file =
        name === 'skill'
            ? path.join(__dirname, 'j-space-zh', 'SKILL.md')
            : path.join(MODULES_DIR, `${name}.md`)
    const content = await readFile(file, 'utf-8')
    return { module: name, content }
}

// ---------- 注册 ----------

serveAsTool(
    [
        jspaceInit,
        '初始化或更新 J-Space 工作台账本：设置 Goal（"做完"意味着什么）与 Next（唯一的下一动作）。' +
            'loop 级任务开始时必须调用；账本已存在时保留 Verified/Core/Open 只更新 Goal/Next。' +
            '返回完整账本。',
        ToJSONSchema([
            ['goal', 'Goal：一句话描述"做完"意味着什么', String],
            ['next', 'Next：唯一的下一动作，永不为空', String],
        ]),
    ],
    [
        jspaceCore,
        '维护账本 Core 广播枢纽条目（格式：名字 — 使它关键的那一个事实）。' +
            '不加 slot = 追加新条目（Core 最多两个活条目，满了会报错）；' +
            '传 slot=1 或 2 = 显式替换该活槽位（核心变化时用单点替换）。' +
            '返回新条目，不回传完整账本；需要全貌时调用 jspace_seam。',
        ToJSONSchema([
            ['name', '共享核心的名字（压缩为规范词或短语）', String],
            ['fact', '使它关键的那一个事实', String],
            [
                'slot',
                '要替换的活槽位（1 或 2），省略则追加',
                Number,
                { optional: true },
            ],
        ]),
    ],
    [
        jspaceCheck,
        '登记已验证 checkpoint（只追加，编号递增）：结论 + 验证依据 + 覆盖范围三者必须齐全。' +
            '子任务验证通过、约束成立、阶段完成时调用。' +
            '各字段超长会被截断；返回新条目，不回传完整账本；需要全貌时调用 jspace_seam。',
        ToJSONSchema([
            ['conclusion', '现在成立的东西（结论）', String],
            ['by', '验证依据：什么确立的它', String],
            ['coverage', '覆盖范围：验证覆盖了什么、没覆盖什么', String],
        ]),
    ],
    [
        jspaceOpen,
        '登记开放问题（只追加，编号递增）：问题 + 判定它的最便宜可证伪测试。' +
            '推导停止产出新约束、或需要验证的未知量时调用。' +
            '各字段超长会被截断；返回新条目，不回传完整账本；需要全貌时调用 jspace_seam。',
        ToJSONSchema([
            ['question', '开放的问题', String],
            ['settled_by', '判定：能证伪它的最便宜测试', String],
        ]),
    ],
    [
        jspaceClose,
        '关闭开放问题：传编号（如 1 对应 ?01）。编号永不重用。返回确认，不回传完整账本。',
        ToJSONSchema([['id', '开放问题的编号（不含 ? 前缀）', Number]]),
    ],
    [
        jspaceSeam,
        '接缝刷新：在每个子任务完成、即将调用其他工具、即将写文件、准备输出时调用。' +
            '返回完整账本快照，用于重读 Goal/Core/Verified/Open/Next。',
        { type: 'object', properties: {}, required: [] },
    ],
    [
        jspaceModule,
        '按需读取 J-Space 中文协议模块（capacity/broadcast/directed-focus/deep-reasoning/' +
            'shorthand/introspection/self-monitoring/markers/empirics/skill）的完整内容。' +
            '当任务遇到路由表中的症状、需要模块协议时调用；只加载当前需要的模块。',
        ToJSONSchema([['name', '模块名', String]]),
    ]
)
