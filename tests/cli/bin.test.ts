/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
/**
 * CLI binary packaging tests.
 */

import { describe, test, expect } from 'bun:test'
// oxlint-disable-next-line effecttsgo/node-builtin-import -- These integration tests use real temporary files and native paths to verify the Node CLI filesystem boundary.
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
// oxlint-disable-next-line effecttsgo/node-builtin-import -- These integration tests use real temporary files and native paths to verify the Node CLI filesystem boundary.
import { join } from 'node:path'
// oxlint-disable-next-line effecttsgo/node-builtin-import -- These integration tests use real temporary files and native paths to verify the Node CLI filesystem boundary.
import { pathToFileURL } from 'node:url'
import { isEntrypoint } from '../../src/cli/bin.js'

function withTemporaryDirectory(run: (directory: string) => void | Promise<void>) {
  const directory = mkdtempSync(join(import.meta.dir, '.bin-entrypoint-'))
  return Promise.resolve(run(directory)).finally(() => {
    rmSync(directory, { recursive: true, force: true })
  })
}

describe('CLI binary packaging', () => {
  test('package.json exposes popweb executable', async () => {
    const packageJson = await import('../../package.json')
    expect(packageJson.default?.bin?.popweb).toBe('dist/cli/bin.js')
  })

  test('CLI entrypoint source file exists', () => {
    expect(existsSync('src/cli/bin.ts')).toBe(true)
  })

  test('treats a symlinked executable as the entrypoint', () =>
    withTemporaryDirectory((directory) => {
      const target = join(directory, 'bin.js')
      const link = join(directory, 'popweb')
      writeFileSync(target, '')
      symlinkSync(target, link)

      expect(isEntrypoint(link, pathToFileURL(target).href)).toBe(true)
      expect(isEntrypoint(target, pathToFileURL(target).href)).toBe(true)
    }))

  test('rejects other scripts and a missing script path', () =>
    withTemporaryDirectory((directory) => {
      const target = join(directory, 'bin.js')
      const other = join(directory, 'other.js')
      writeFileSync(target, '')
      writeFileSync(other, '')

      expect(isEntrypoint(other, pathToFileURL(target).href)).toBe(false)
      expect(isEntrypoint(undefined, pathToFileURL(target).href)).toBe(false)
      expect(isEntrypoint(join(directory, 'missing.js'), pathToFileURL(target).href)).toBe(false)
    }))

  test('runs commands when Node starts it through a node_modules/.bin symlink', () =>
    withTemporaryDirectory(async (directory) => {
      const binDirectory = join(directory, 'node_modules', '.bin')
      const link = join(binDirectory, 'popweb')
      mkdirSync(binDirectory, { recursive: true })
      symlinkSync(join(import.meta.dir, '../../dist/cli/bin.js'), link)

      const child = Bun.spawn(['node', link, '--help'], { stdout: 'pipe', stderr: 'pipe' })
      const [exitCode, stdout] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
      ])

      expect(exitCode).toBe(0)
      expect(stdout).toContain('popweb - Agent-first CLI for Popcomputer Web')
    }))
})
