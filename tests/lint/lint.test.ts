/* oxlint-disable effecttsgo/async-function -- The test runs the Oxlint binary, a native process. */
/**
 * The framework's lint rules, run by Oxlint itself over fixtures: each line
 * of an invalid fixture names the rules it breaks in an `// expect:`
 * comment, and the valid fixture breaks none.
 *
 * The rules that read where a file sits (a test, a script, a page) run over
 * fixtures/.app, a small application's files. It is hidden because some of
 * them are named like tests, and `bun test` skips hidden folders.
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
  readonly file: string
  readonly severity: string
  readonly rule: string
  readonly line: number
  readonly message: string
}

function lint(...files: ReadonlyArray<string>): Diagnostic[] {
  // --no-ignore: Oxlint skips a hidden folder's files otherwise.
  const result = spawnSync(oxlint, ['--disable-nested-config', '--no-ignore', '--config', config, '--format', 'json', ...files], {
    cwd: fixtures,
    encoding: 'utf8',
  })
  const report: {
    diagnostics?: ReadonlyArray<{
      code: string
      message: string
      severity: string
      filename: string
      labels: ReadonlyArray<{ span: { line: number } }>
    }>
  } = JSON.parse(result.stdout || '{}')

  if (result.stderr.trim() !== '' && report.diagnostics === undefined) throw new Error(result.stderr)

  return (report.diagnostics ?? []).map((diagnostic) => ({
    file: diagnostic.filename,
    severity: diagnostic.severity,
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

/** Every file of the fixture application, from the fixtures folder. */
const appFiles = Array.from(new Bun.Glob('.app/**/*.{ts,tsx}').scanSync({ cwd: fixtures, dot: true })).sort()

/** The rules the fixture application's files expect, as `file:line rule`. */
const expectedInApp = () =>
  appFiles.flatMap((file) => expected(file).map((entry) => `${file}:${entry}`)).sort()

const foundInApp = (diagnostics: ReadonlyArray<Diagnostic>) =>
  diagnostics.map((diagnostic) => `${diagnostic.file}:${diagnostic.line} ${diagnostic.rule}`).sort()

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

  test('reports each comment that turns a framework rule off without a reason', () => {
    expect(found(lint('invalid-directives.ts'))).toEqual(expected('invalid-directives.ts').sort())
  })

  test('reports each setting that weakens a protection, as a warning', () => {
    const diagnostics = lint('invalid-security.ts')

    expect(found(diagnostics)).toEqual(expected('invalid-security.ts').sort())
    expect(new Set(diagnostics.map((diagnostic) => diagnostic.severity))).toEqual(new Set(['warning']))
  })

  test('reports each Effect built and never run', () => {
    expect(found(lint('invalid-effects.ts'))).toEqual(expected('invalid-effects.ts').sort())
  })

  test("reports by where a file sits: shared state in the Worker's modules", () => {
    expect(appFiles).toContain('.app/src/routes.test.ts')
    expect(foundInApp(lint(...appFiles))).toEqual(expectedInApp())
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
    expect(lint.rules['popcomputer-web/explain-security-loosening']).toBe('warn')
    expect(webLint({ 'explain-security-loosening': 'error' }).rules['popcomputer-web/explain-security-loosening']).toBe('error')
    expect(lint.jsPlugins).toEqual([{ name: 'popcomputer-web', specifier: '@popcomputer/web/lint' }])
  })
})
