/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
/**
 * CLI binary packaging tests.
 */

import { describe, test, expect } from 'bun:test'
// oxlint-disable-next-line effecttsgo/node-builtin-import -- These integration tests use real temporary files and native paths to verify the Node CLI filesystem boundary.
import { existsSync } from 'node:fs'

describe('CLI binary packaging', () => {
  test('package.json exposes popweb executable', async () => {
    const packageJson = await import('../../package.json')
    expect(packageJson.default?.bin?.popweb).toBe('dist/cli/bin.js')
  })

  test('CLI entrypoint source file exists', () => {
    expect(existsSync('src/cli/bin.ts')).toBe(true)
  })
})

