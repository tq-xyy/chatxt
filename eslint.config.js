import eslint from '@eslint/js'
import { defineConfig } from 'eslint/config'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'
import { readFileSync } from 'fs'
import path from 'path'

const ignores = readFileSync(
    path.join(import.meta.dirname, '.gitignore'),
    'utf-8'
)
    .split('\n')
    .map(line => line.trim())
    .filter(line => !line.startsWith('#') && line.length > 0)

export default defineConfig(
    { ignores },
    eslint.configs.recommended,
    tseslint.configs.recommended,
    prettier
)
