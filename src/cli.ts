import { Command } from 'commander'
import { ChatSession } from './session'
import { initConfig, loadConfig } from './config'

import { version } from '../package.json'

const program = new Command()

program
    .name('chatfile')
    .description('Chatfile CLI – AI conversations as files')
    .version(version)
    .argument('<file>', '.chat.txt file to process, create if not available.')
    .option('-m, --model <model>', 'model to be used to generate')
    .option('-k, --api-key <model>', 'api key from your model provider')
    .option('--endpoint <model>', 'the endpoint of model provider')
    .option(
        '-t, --show-thinking',
        'show reasoning chain in .chat.txt (if available)'
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
                showThinking,
                excludeHistoryToolCall,
            }: {
                model?: string
                apiKey?: string
                endpoint?: string
                showThinking: boolean
                excludeHistoryToolCall: boolean
            }
        ) => {
            const config = await loadConfig({
                model,
                apikey,
                endpoint,
                showThinking,
                excludeHistoryToolCall,
            })
            const session = new ChatSession(file, config)
            await session.loop()
        }
    )

program
    .command('init-config')
    .description('Create default .chatfilerc/config.json')
    .action(async () => {
        await initConfig()
    })

program.parse()
