import eslint from '@eslint/js'
import { defineConfig } from 'eslint/config'
import prettier from 'eslint-config-prettier'
import simpleImportSort from 'eslint-plugin-simple-import-sort'
import { readFileSync } from 'fs'
import path from 'path'
import tseslint from 'typescript-eslint'

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
    {
        plugins: {
            'simple-import-sort': simpleImportSort,
        },
        rules: {
            'simple-import-sort/imports': 'error',
            'simple-import-sort/exports': 'error',
        },
    },
    prettier
)
