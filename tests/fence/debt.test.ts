/**
 * Debt Report Tests
 *
 * The report lists every comment that turns a lint rule or a type check off,
 * with its reason, and `popweb-fence debt --check` fails when the count
 * differs from the committed ledger: a higher count until the code is fixed
 * or the owner accepts it, a lower one until `--update` records it.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { compareDebt, debtLedger, disableDirectives } from '../../src/fence/debt.js'

describe('disableDirectives', () => {
  test('reads each directive with its rules and its reason', () => {
    const source = [
      '// oxlint-disable-next-line popcomputer-web/no-sql-interpolation -- the column names are constants',
      "const report = sql.raw(columns) // eslint-disable-line no-console, no-alert -- a debugging aid",
      '/* oxlint-disable */',
      '// @ts-expect-error -- the SDK types the callback wrongly',
      '// @ts-expect-error: the SDK again',
      '// @ts-ignore',
      '// @effect-diagnostics-next-line floatingEffect:off -- the runtime owns this fiber',
      '// @effect-diagnostics-next-line floatingEffect:error',
      'const page = <div>{/* oxlint-disable-next-line jsx-a11y/alt-text -- decorative */}<img /></div>',
    ].join('\n')

    expect(disableDirectives(source, 'src/report.tsx')).toEqual([
      { file: 'src/report.tsx', line: 1, directive: 'oxlint-disable-next-line', rules: ['popcomputer-web/no-sql-interpolation'], reason: 'the column names are constants' },
      { file: 'src/report.tsx', line: 2, directive: 'eslint-disable-line', rules: ['no-console', 'no-alert'], reason: 'a debugging aid' },
      { file: 'src/report.tsx', line: 3, directive: 'oxlint-disable', rules: [], reason: null },
      { file: 'src/report.tsx', line: 4, directive: '@ts-expect-error', rules: [], reason: 'the SDK types the callback wrongly' },
      { file: 'src/report.tsx', line: 5, directive: '@ts-expect-error', rules: [], reason: 'the SDK again' },
      { file: 'src/report.tsx', line: 6, directive: '@ts-ignore', rules: [], reason: null },
      { file: 'src/report.tsx', line: 7, directive: '@effect-diagnostics-next-line', rules: ['floatingEffect'], reason: 'the runtime owns this fiber' },
      { file: 'src/report.tsx', line: 9, directive: 'oxlint-disable-next-line', rules: ['jsx-a11y/alt-text'], reason: 'decorative' },
    ])
  })

  test('skips text that only looks like a directive: strings, templates, regular expressions and prose', () => {
    const source = [
      "const a = '// oxlint-disable-next-line no-console'",
      'const b = "/* @ts-ignore */"',
      'const c = `',
      '  // @ts-expect-error inside a template',
      '  ${value /* oxlint-disable-line inside-a-substitution -- counted */}',
      '`',
      'const d = /\\/\\/ oxlint-disable/.test(text)',
      'const e = total / count // see the oxlint-disable docs',
      '// oxlint-enable no-console',
      "const f = <p>Don't use // eslint-disable here</p>",
      '// eslint-disable-next-line no-console -- after the JSX line',
      "const g = text.replace(/'/g, '') // oxlint-disable-line no-regex -- after a quote in a regular expression",
    ].join('\n')

    expect(disableDirectives(source).map(({ line, rules }) => [line, rules])).toEqual([
      [5, ['inside-a-substitution']],
      [11, ['no-console']],
      [12, ['no-regex']],
    ])
  })
})

describe('the ledger', () => {
  const at = (file: string, line: number, reason: string | null = 'why') =>
    ({ file, line, directive: 'oxlint-disable-next-line', rules: ['no-console'], reason }) as const

  test('ignores line numbers, so moving code changes nothing', () => {
    const ledger = debtLedger([at('src/a.ts', 3), at('src/b.ts', 9)])

    expect(compareDebt([at('src/b.ts', 40), at('src/a.ts', 12)], ledger)).toEqual({ count: 2, baseline: 2, added: [], removed: [] })
  })

  test('names what the code added and what it no longer holds', () => {
    const ledger = debtLedger([at('src/a.ts', 3), at('src/a.ts', 8)])
    const comparison = compareDebt([at('src/a.ts', 3), at('src/c.ts', 1, null), at('src/c.ts', 2, null)], ledger)

    expect(comparison).toMatchObject({ count: 3, baseline: 2 })
    expect(comparison.added).toEqual([at('src/c.ts', 1, null), at('src/c.ts', 2, null)])
    expect(comparison.removed).toEqual([{ file: 'src/a.ts', directive: 'oxlint-disable-next-line', rules: ['no-console'], reason: 'why' }])
  })
})

describe('popweb-fence debt', () => {
  const cli = join(import.meta.dir, '..', '..', 'src', 'fence', 'cli.ts')
  let root: string

  const write = (file: string, text: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), text)
  }
  const run = (...args: string[]) => {
    const result = spawnSync('bun', [cli, 'debt', ...args], { cwd: root, encoding: 'utf8' })
    return { status: result.status, output: `${result.stdout}${result.stderr}` }
  }
  const git = (...args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  test('lists and counts the directives, and leaves dependencies out', () => {
    root = mkdtempSync(join(tmpdir(), 'fence-debt-'))
    write('src/a.ts', '// oxlint-disable-next-line no-console -- a debugging aid\nconsole.log(1)\n')
    write('src/b.ts', '// @ts-ignore\nconst x: number = "1"\n')
    write('node_modules/pkg/index.js', '/* eslint-disable */\n')

    const { status, output } = run()

    expect(status).toBe(0)
    expect(output).toContain('src/a.ts:1  oxlint-disable-next-line no-console  -- a debugging aid')
    expect(output).toContain('src/b.ts:1  @ts-ignore  (no reason given)')
    expect(output).toContain('2 disable directives, 1 without a reason.')
    expect(output).not.toContain('node_modules')
  })

  test('--check fails when the count rises, and --update will not raise it', () => {
    root = mkdtempSync(join(tmpdir(), 'fence-debt-'))
    write('src/a.ts', '// oxlint-disable-next-line no-console -- a debugging aid\n')
    expect(run('--update').status).toBe(0)
    expect(run('--check')).toMatchObject({ status: 0 })

    write('src/b.ts', '// @ts-expect-error -- the SDK types the callback wrongly\n')
    const rose = run('--check')
    const refused = run('--update')

    expect(rose.status).toBe(1)
    expect(rose.output).toContain('Lint debt rose from 1 to 2 disable directives')
    expect(rose.output).toContain('src/b.ts:1  @ts-expect-error')
    expect(refused.status).toBe(1)
    expect(JSON.parse(readFileSync(join(root, 'lint-debt.json'), 'utf8')).count).toBe(1)

    expect(run('--update', '--allow-increase')).toMatchObject({ status: 0 })
    expect(run('--check')).toMatchObject({ status: 0 })
  })

  test('--check fails when the count falls, until --update records it', () => {
    root = mkdtempSync(join(tmpdir(), 'fence-debt-'))
    write('src/a.ts', '// oxlint-disable-next-line no-console -- a debugging aid\n// @ts-ignore -- old\n')
    run('--update')
    write('src/a.ts', '// oxlint-disable-next-line no-console -- a debugging aid\n')

    const stale = run('--check')

    expect(stale.status).toBe(1)
    expect(stale.output).toContain('lint-debt.json is out of date')
    expect(run('--update').output).toContain('1 disable directive, down from 2')
    expect(run('--check').status).toBe(0)
  })

  test("follows git's ignores, keeps the ledger's own, and keeps the committed count when the ledger is deleted", () => {
    root = mkdtempSync(join(tmpdir(), 'fence-debt-'))
    git('init', '-q')
    write('.gitignore', 'generated/\n')
    write('generated/types.ts', '/* eslint-disable */\n')
    write('worker-configuration.d.ts', '/* eslint-disable */\n')
    write('src/a.ts', '// oxlint-disable-next-line no-console -- a debugging aid\n')
    write('lint-debt.json', JSON.stringify({ count: 0, ignore: ['worker-configuration.d.ts'], directives: [] }))

    expect(run('--update', '--allow-increase').output).toContain('1 disable directive, up from 0')
    expect(JSON.parse(readFileSync(join(root, 'lint-debt.json'), 'utf8')).ignore).toEqual(['worker-configuration.d.ts'])

    git('add', '.')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'ledger')
    rmSync(join(root, 'lint-debt.json'))
    expect(run('--update').output).toContain('Wrote lint-debt.json: 1 disable directive.')

    rmSync(join(root, 'lint-debt.json'))
    write('src/b.ts', '// @ts-ignore -- new\n')
    expect(run('--update').status).toBe(1)
  })
})
