/* oxlint-disable effecttsgo/async-function -- The test runs the Oxlint binary, a native process. */
/**
 * The framework's lint rules, run by Oxlint itself over fixtures: each line
 * of an invalid fixture names the rules it breaks in an `// expect:`
 * comment, and the valid fixture breaks none.
 */

import { beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import plugin, { PLUGIN_NAME, webLint } from '../../src/lint/index.js'

const repoRoot = join(import.meta.dir, '..', '..')
const fixtures = join(import.meta.dir, 'fixtures')
const oxlint = join(repoRoot, 'node_modules', '.bin', 'oxlint')

let config = ''

beforeAll(async () => {
  // Oxlint loads plugins in Node, which reads JavaScript: bundle the rules.
  const outdir = mkdtempSync(join(tmpdir(), 'popweb-lint-'))
  const built = await Bun.build({ entrypoints: [join(repoRoot, 'src', 'lint', 'index.ts')], outdir, target: 'node', format: 'esm' })

  if (!built.success) throw new Error(built.logs.map(String).join('\n'))

  const lint = webLint()
  config = join(outdir, 'oxlintrc.json')
  writeFileSync(config, JSON.stringify({
    categories: { correctness: 'off' },
    jsPlugins: [{ name: PLUGIN_NAME, specifier: join(outdir, 'index.js') }],
    rules: lint.rules,
  }))
})

interface Diagnostic {
  readonly rule: string
  readonly line: number
  readonly message: string
}

function lint(file: string): Diagnostic[] {
  const result = spawnSync(oxlint, ['--disable-nested-config', '--config', config, '--format', 'json', file], {
    cwd: fixtures,
    encoding: 'utf8',
  })
  const report: { diagnostics?: ReadonlyArray<{ code: string; message: string; labels: ReadonlyArray<{ span: { line: number } }> }> } =
    JSON.parse(result.stdout || '{}')

  if (result.stderr.trim() !== '' && report.diagnostics === undefined) throw new Error(result.stderr)

  return (report.diagnostics ?? []).map((diagnostic) => ({
    rule: diagnostic.code.replace(/^.*\((.*)\)$/, '$1'),
    line: diagnostic.labels[0]?.span.line ?? 0,
    message: diagnostic.message,
  }))
}

/** The rules each line's `// expect:` comment names, as `line rule` pairs. */
function expected(file: string): string[] {
  return readFileSync(join(fixtures, file), 'utf8').split('\n').flatMap((text, index) => {
    const match = /\/\/ expect: (.+)$/.exec(text)

    return match === null ? [] : match[1].trim().split(/\s+/).map((rule) => `${index + 1} ${rule}`)
  })
}

const found = (diagnostics: ReadonlyArray<Diagnostic>) => diagnostics.map((diagnostic) => `${diagnostic.line} ${diagnostic.rule}`).sort()

describe('@popcomputer/web/lint', () => {
  test('reports each database mistake on its line', () => {
    expect(found(lint('invalid-database.ts'))).toEqual(expected('invalid-database.ts').sort())
  })

  test('reports each action mistake on its line', () => {
    expect(found(lint('invalid-actions.ts'))).toEqual(expected('invalid-actions.ts').sort())
  })

  test('reports each binding that does not say who may load its record', () => {
    expect(found(lint('invalid-bindings.ts'))).toEqual(expected('invalid-bindings.ts').sort())
  })

  test('accepts the patterns the framework documents', () => {
    expect(lint('valid.ts')).toEqual([])
  })

  test('every message names what to use instead', () => {
    for (const [name, rule] of Object.entries(plugin.rules)) {
      for (const message of Object.values(rule.meta.messages)) {
        expect({ name, teaches: /\b(use|read|run|call|answer|provide|return|handle|scope|build|register)\b|yield\*/i.test(message) })
          .toEqual({ name, teaches: true })
      }
    }
  })

  test('webLint turns every rule on, with the severities given', () => {
    const lint = webLint({ 'no-catch-all-in-action': 'warn' })

    expect(Object.keys(lint.rules)).toHaveLength(Object.keys(plugin.rules).length)
    expect(lint.rules['popcomputer-web/no-catch-all-in-action']).toBe('warn')
    expect(lint.rules['popcomputer-web/no-unscoped-write']).toBe('error')
    expect(lint.jsPlugins).toEqual([{ name: 'popcomputer-web', specifier: '@popcomputer/web/lint' }])
  })
})
