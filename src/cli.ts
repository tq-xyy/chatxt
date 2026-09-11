import { Command } from 'commander'

import { type Config, initConfig, loadConfig, type Provider } from './config'
import { ChatSession } from './session'
import { chatxtVersion } from './utils/meta'

interface CliOptions {
    model?: string
    apiKey?: string
    endpoint?: string
    endpointType?: Provider['type']
    emitThinking: boolean
    excludeHistoryToolCall: boolean
    emitToConsole: boolean
    verbose: boolean
}

const program = new Command()
    .name('chatxt')
    .description('Chatxt CLI – AI conversations as files')
    .version(chatxtVersion)
    .argument('<file>', '.chat.txt file to process, create if not available.')
    .option('-m, --model <model>', 'model to be used to generate')
    .option('-k, --api-key <key>', 'api key from your model provider')
    .option('--endpoint <url>', 'the endpoint of model provider')
    .option(
        '--endpoint-type <type>',
        'the endpoint type of model provider, built-in supports `openai-compatible`, `openai-responses` and `anthropic`'
    )
    .option(
        '--no-emit-thinking',
        'disable emitting reasoning chain in .chat.txt (force if thinking unavailable)'
    )
    .option(
        '-e, --emit-to-console',
        'emit the generated content to the console without writing to the .chat.txt, which is useful for debug and e2e tests'
    )
    .option(
        '--exclude-history-tool-call',
        'remove history tool call from context to save tokens (may led to unexpected behavior)'
    )
    .option(
        '-v, --verbose',
        'print a per-round summary line for each completed API request'
    )
    .action(async (file: string, opts: CliOptions) => {
        const cliConfig: Partial<Config> = {
            model: opts.model,
            apikey: opts.apiKey,
            endpoint: opts.endpoint,
            endpointType: opts.endpointType,
            excludeHistoryToolCall: opts.excludeHistoryToolCall,
            emitToConsole: opts.emitToConsole,
            verbose: opts.verbose,

            // `--no-emit-thinking` 这类可否定选项，commander 生成的默认值是 true，
            // 永远覆盖 config.json 里的 emitThinking，因此只在显式指定时才写入。
            emitThinking:
                program.getOptionValueSource('emitThinking') === 'cli'
                    ? opts.emitThinking
                    : undefined,
        }

        const config = await loadConfig(cliConfig)
        await new ChatSession(file, config).loop()
    })

program
    .command('init-config')
    .description('Create default .chatxtrc/config.json')
    .action(initConfig)

program.parse()
