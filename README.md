# Chatxt

**AI conversations as plain text files.**

Chatxt is a command-line AI chat tool where the conversation itself is the file. You write your input in a `.chat.txt` plain text file, run `chatxt <file>`, and the AI's reply — including its reasoning chain, tool calls, and tool results — is appended back to the same file in real time. Your entire chat history lives in one readable, diffable, version-controllable file. No database required.

## Highlights

- **File is the conversation** — history, context, and tool declarations all live in a single `.chat.txt` file
- **Live streaming** — replies are written back as they are generated; interrupting the process keeps what was already written
- **Multi-provider** — OpenAI-compatible (`/chat/completions`), OpenAI Responses (`/responses`), and Anthropic (`/messages`) APIs behind one unified adapter
- **Tool calling** — any Node.js script can become a tool callable by the AI, with a built-in sandboxed process model and LLM proxy
- **Thinking chain support** — reasoning content can be persisted into the file (`--emit-thinking`)
- **Token economics** — context-cache-aware cost estimation, history tool-call filtering, and de-duplicated file references

## Requirements

- Node.js ≥ 22
- pnpm for building

## Installation

```bash
pnpm install
pnpm build
```

This produces `dist/cli.js` (a single bundled file). You can then use it via `node dist/cli.js` or link the `chatxt` bin:

```bash
pnpm link   # optional: exposes the `chatxt` command globally
```

## Quick Start

1. **Create a config** (or edit one manually):

```bash
chatxt init-config
```

This generates `.chatxtrc/config.json`:

```json
{
    "providers": [
        {
            "name": "DeepSeek",
            "type": "openai-compatible",
            "endpoint": "https://api.deepseek.com/v1",
            "apikey": "your-api-key-here",
            "models": {
                "deepseek-v4-flash": true,
                "deepseek-v4-pro": true
            }
        }
    ],
    "defaultModel": "deepseek-v4-flash"
}
```

2. **Write your message** in a `.chat.txt` file (it will be created automatically with a default system prompt if missing):

```
----- CHAT ROLE: SYSTEM -----
You are a helpful assistant.

----- CHAT ROLE: USER -----
Summarize the current state of the weather in Paris.
```

3. **Run the chat:**

```bash
chatxt my-chat.chat.txt
```

The AI's answer (and any reasoning, tool calls, and results) is streamed into the same file. A new empty `USER` block is appended at the end for your next turn.

## CLI Options

| Option                        | Description                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------- |
| `-m, --model <model>`         | Override the model                                                                |
| `-k, --api-key <key>`         | Provide an API key                                                                |
| `--endpoint <url>`            | Override the API endpoint (direct connection)                                     |
| `-t, --emit-thinking`         | Write the reasoning chain into the file                                           |
| `-e, --emit-to-console`       | Print generated content to the console instead of writing to the file (debug/e2e) |
| `--exclude-history-tool-call` | Remove historical tool calls from context to save tokens                          |
| `chatxt init-config`          | Create a `.chatxtrc/config.json` template                                         |

## The `.chat.txt` Format

The file is a sequence of role blocks, each starting with a separator line. A `#!/usr/bin/env chatxt` shebang on the first line is ignored.

```
----- CHAT ROLE: SYSTEM -----
...system prompt...

----- CHAT ROLE: USER -----
...user input...

----- CHAT ROLE: ASSISTANT -----
...AI answer...

----- CHAT ROLE: THINKING -----
...reasoning chain (only with --emit-thinking)...

----- CHAT ROLE: TOOL -----
func_name (call_id): {"arg": "value"}

----- CHAT ROLE: TOOLRESPONSE -----
call_id: {"result": "..."}
```

### Directives (USER blocks only)

Paths are resolved relative to the `.chat.txt` file; directives inside an included file are resolved relative to that file.

| Directive        | Description                                                                                                                                                                                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@file(path)`    | Append the external file's content to the user message (referenced once per session; later references keep only the filename)                                                                                          |
| `@include(path)` | Expand the external file as a preset: its content is re-parsed as directives (`@file` / `@tool` / `@include`; nesting allowed, circular includes are skipped with a warning); files containing role lines are rejected |
| `@tool(path)`    | Declare a tool file to load at session start                                                                                                                                                                           |

Example:

```text
----- CHAT ROLE: USER -----
@include(presets/web-search.txt)
What is the weather like?
```

The preset (`presets/web-search.txt`) can itself declare tools and files:

```text
@tool(websearch.ts)
@file(notes.md)
```

## Configuration

Configuration is loaded from `.chatxtrc/config.json`, found by walking up from the working directory. CLI options override file config.

| Field                                                        | Description                                                                                                                |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `providers`                                                  | List of providers: `name`, `type` (`openai-compatible` / `openai-responses` / `anthropic`), `endpoint`, `apikey`, `models` |
| `models`                                                     | Map of model IDs to `true` or `{ "alias": "...", "pricing": ... }`                                                         |
| `defaultModel`                                               | Default model used when `-m` is not given                                                                                  |
| `thinkingEffort` / `thinkingMode` / `maxTokens` / `jsonOnly` | Completion options                                                                                                         |
| `emitThinking` / `emitToConsole` / `emitInterval`            | Output options                                                                                                             |
| `excludeHistoryToolCall`                                     | Skip historical tool calls to save tokens                                                                                  |

## Tools

A tool is any Node.js script that registers itself via the globally injected `chatxt` runtime object. Each tool file runs in its own forked process:

```js
// weather.tool.js
function getWeather({ location }) {
    return { location, temperature: 22, unit: 'celsius', condition: 'sunny' }
}

chatxt.runtime.exposeTool([
    {
        name: 'getWeather',
        description: 'Get the current weather for a location',
        parameters: chatxt.helpers.convertArgsToSchema([
            ['location', 'City name', String],
        ]),
        func: getWeather,
    },
])
```

Global API available in tool files (no import needed):

- `chatxt.runtime.exposeTool([{ name, description, parameters, func }])` — register tools and report definitions
- `chatxt.runtime.chatCompletion(request)` — call an LLM from inside a tool (proxied by the main process; usage is billed to the session)
- `chatxt.helpers.convertArgsToSchema(argsDefs)` — shorthand for building parameter JSON schemas

See [docs/tool_guide_zh.md](docs/tool_guide_zh.md) for the full guide.

## Examples

- [examples/automatic_prompt_engineering](examples/automatic_prompt_engineering) — automatic prompt engineering: the AI tests and iterates on prompts on its own
- [examples/dsh-minimal-mode](examples/dsh-minimal-mode) — a minimal coding agent (persistent shell + `str_replace_editor`)

## Development

```bash
pnpm build       # bundle dist/cli.js with esbuild
pnpm typecheck   # tsc --noEmit
pnpm lint        # eslint --fix && prettier -w
```

## Documentation

- [docs/architecture_zh.md](docs/architecture_zh.md) — architecture overview (Chinese)
- [docs/tool_guide_zh.md](docs/tool_guide_zh.md) — tool authoring guide (Chinese)

## License

MIT
