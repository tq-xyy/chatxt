import eslint from '@eslint/js'
import { defineConfig } from 'eslint/config'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

export default defineConfig(
    { ignores: ['dist', '*ignored*'] },
    eslint.configs.recommended,
    tseslint.configs.recommended,
    prettier
)
