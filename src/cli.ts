import { Command } from 'commander'
import { ChatSession } from './session'
import { initConfig, loadConfig } from './config'
import { chatxtVersion } from './utils/version'

const program = new Command()

program
    .name('chatxt')
    .description('Chatxt CLI – AI conversations as files')
    .version(chatxtVersion)
    .argument('<file>', '.chat.txt file to process, create if not available.')
    .option('-m, --model <model>', 'model to be used to generate')
    .option('-k, --api-key <model>', 'api key from your model provider')
    .option('--endpoint <model>', 'the endpoint of model provider')
    .option(
        '-t, --emit-thinking',
        'emit reasoning chain in .chat.txt (if available)'
    )
    .option(
        '-e, --emit-to-console',
        'emit the generated content to the console without writing to the .chat.txt, \n' +
            'which is useful for debug and e2e tests'
    )
    .option(
        '--exclude-history-tool-call',
        'remove history tool call from context to save tokens'
    )
    .action(
        async (
            file,
            {
                model,
                apiKey: apikey,
                endpoint,
                emitThinking,
                excludeHistoryToolCall,
                emitToConsole,
            }: {
                model?: string
                apiKey?: string
                endpoint?: string
                emitThinking: boolean
                excludeHistoryToolCall: boolean
                emitToConsole: boolean
            }
        ) => {
            const config = await loadConfig({
                model,
                apikey,
                endpoint,
                emitThinking,
                excludeHistoryToolCall,
                emitToConsole,
            })
            const session = new ChatSession(file, config)
            await session.loop()
        }
    )

program
    .command('init-config')
    .description('Create default .chatxtrc/config.json')
    .action(async () => {
        await initConfig()
    })

program.parse()
