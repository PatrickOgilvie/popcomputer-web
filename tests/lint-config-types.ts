/** webLint() is an Oxlint configuration, alone or spread into a larger one. */
import { defineConfig } from 'oxlint'
import { webLint } from '../src/lint/index.js'

export default defineConfig(webLint())
export const extended = defineConfig({ ...webLint({ 'no-catch-all-in-action': 'warn' }), ignorePatterns: ['dist'] })
