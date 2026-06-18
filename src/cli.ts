import { Command } from 'commander'
import { chatfile } from './index' // 你已有的 chatfile 函数
import { initConfig } from './config'

import { version } from '../package.json'

const program = new Command()

program
    .name('chatfile')
    .description('Chatfile CLI – AI conversations as files')
    .version(version)
    .argument('<file>', '.chat.txt file to process, create if not available.')
    .option('-q, --quiet', 'suppress all output except errors')
    .option(
        '-t, --show-thinking',
        'show reasoning chain in .chat.txt (if available)'
    )
    .action(async (file, options) => {
        // 默认行为：执行 complete 子命令
        if (!file) {
            console.error('Error: missing file argument')
            process.exit(1)
        }

        await chatfile(file, options.showThinking ?? false)
    })

program
    .command('init-config')
    .description('Create default .chatfilerc/config.json')
    .action(async () => {
        await initConfig()
    })

program.parse()
