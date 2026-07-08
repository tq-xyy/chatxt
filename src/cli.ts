import { Command } from 'commander'
import { chatfile } from './index' // 你已有的 chatfile 函数
import { initConfig, loadConfig } from './config'

import { version } from '../package.json'

const program = new Command()

program
    .name('chatfile')
    .description('Chatfile CLI – AI conversations as files')
    .version(version)
    .argument('<file>', '.chat.txt file to process, create if not available.')
    .option('-m, --model <model>', 'model to be used to generate')
    .option('--endpoint <model>', 'the endpoint of model provider')
    .option(
        '-t, --show-thinking',
        'show reasoning chain in .chat.txt (if available)'
    )
    .option(
        '--exclude-history-tool-call',
        'remove history tool call from context to save tokens'
    )
    .action(async (file, options) => {
        const config = await loadConfig(options)

        await chatfile(file, config)
    })

program
    .command('init-config')
    .description('Create default .chatfilerc/config.json')
    .action(async () => {
        await initConfig()
    })

program.parse()
