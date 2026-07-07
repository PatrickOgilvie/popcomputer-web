/**
 * CLI binary packaging tests.
 */

import { describe, test, expect } from 'bun:test'
import { existsSync } from 'node:fs'

describe('CLI binary packaging', () => {
  test('package.json exposes honertia executable', async () => {
    const packageJson = await import('../../package.json')
    expect(packageJson.default?.bin?.honertia).toBe('dist/cli/bin.js')
  })

  test('CLI entrypoint source file exists', () => {
    expect(existsSync('src/cli/bin.ts')).toBe(true)
  })
})

