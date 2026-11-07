/**
 * The debt report's state machines: the comment scanner (machine 62) and the
 * ledger ratchet (machine 48). Each test is named for the transition table's
 * row it closes.
 *
 * The scanner rows give the report a source holding one live directive, which
 * Oxlint and TypeScript honour, and expect the report to count it. The
 * ratchet rows run `popweb-fence debt` in a git repository of the test's own
 * and expect every path that would lift the count over the one HEAD records,
 * without `--allow-increase`, to end refused.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { debtCommand, disableDirectives, parseLedger } from '../../src/fence/debt.js'

describe('machine 62: the debt comment scanner', () => {
  /** Each source holds one live directive, on the line given. */
  const rows: ReadonlyArray<readonly [row: string, file: string, source: string, line: number]> = [
    ['M62.T18: a backtick in JSX text', 'a.tsx', 'const A = () => <p>Press ` to open</p>\n// oxlint-disable-next-line x\nf()\n', 2],
    ['M62.T19: /* in JSX text', 'a.tsx', 'const a = <code>src/*.ts</code>\n// oxlint-disable-next-line x\nf()\n', 2],
    ['M62.T19: /* in JSX text, then @ts-ignore', 'a.tsx', 'const a = <p>5 /* 2</p>\n// @ts-ignore\nf()\n', 2],
    ['M62.T20: // in JSX text', 'a.tsx', 'const a = <a>http://x</a> // oxlint-disable-line x\n', 1],
    ['M62.T21: an apostrophe in JSX text', 'a.tsx', "const a = <p>it's</p> // oxlint-disable-line x\n", 1],
    ['M62.T21: a double quote in JSX text', 'a.tsx', 'const a = <p>say "hi</p> // oxlint-disable-line x\n', 1],
    ['M62.T21: an apostrophe in the JSX text of a .js file', 'a.js', "const a = <p>it's</p> // oxlint-disable-line x\n", 1],
    ['M62.T22: a regular expression holding a backtick after }', 'a.ts', 'function f() {}\n/`/.test(s)\n// oxlint-disable-next-line x\nf()\n', 3],
    ['M62.T22: a regular expression holding a backtick after )', 'a.ts', 'if (x) /`/.test(y)\n// @ts-ignore\nf()\n', 2],
    ['M62.T23: a regular expression holding a quote after }', 'a.ts', "function f() {\n}\n/'/.test(s) // oxlint-disable-line x\n", 3],
    ['M62.T23: a regular expression holding a double quote after )', 'a.ts', 'if (x) /"/.test(s) // oxlint-disable-line x\n', 1],
    ['M62.T24: a division after !', 'a.ts', 'const y = x! / 2 // oxlint-disable-line x\n', 1],
    ['M62.T24: a division after ++', 'a.ts', 'const y = x++ / 2 // oxlint-disable-line x\n', 1],
    ['M62.T24: a division after --', 'a.ts', 'const n = i-- / 2 // oxlint-disable-line x\n', 1],
    ['M62.T25: a division after a property named in', 'a.ts', 'const y = this.in / 2 // oxlint-disable-line x\n', 1],
    ['M62.T25: a division after a property named of', 'a.ts', 'const y = a.of / 2 // oxlint-disable-line x\n', 1],
    ['M62.T25: a division after a property named new', 'a.ts', 'const y = a.new / 2 // oxlint-disable-line x\n', 1],
    ['M62.T25: a division after a property named typeof', 'a.ts', 'const y = a.typeof / 2 // oxlint-disable-line x\n', 1],
    ['M62.T25: a division after a property named return', 'a.ts', 'const y = a.return / 2 // @ts-ignore\n', 1],
    ['M62.T26: </ before a line comment', 'a.tsx', 'function A() {\n  return <p>hi</p> // oxlint-disable-line x\n}\n', 2],
    ['M62.T26: </ before a block comment', 'a.tsx', 'function A() {\n  return <p>hi</p> /* oxlint-disable-line x */\n}\n', 2],
    ['M62.T27: a division after a non-ASCII identifier', 'a.ts', 'const y = café / 2 // oxlint-disable-line x\n', 1],
    ['M62.T29: /// @ts-ignore', 'a.ts', '/// @ts-ignore\nconst a: number = "x"\n', 1],
    ['M62.T29: /// @ts-expect-error', 'a.ts', '/// @ts-expect-error\nconst a: number = "x"\n', 1],
    ['M62.T29: //// @ts-ignore', 'a.ts', '//// @ts-ignore\nconst a: number = "x"\n', 1],
    ['M62.T29: /*/ @ts-ignore */', 'a.ts', '/*/ @ts-ignore */\nconst a: number = "x"\n', 1],
  ]

  for (const [row, file, source, line] of rows) {
    test(row, () => {
      expect(disableDirectives(source, file).map((directive) => directive.line)).toEqual([line])
    })
  }

  test('M62.T29: a slash after a space is prose, which TypeScript does not honour', () => {
    expect(disableDirectives('// / @ts-ignore\nconst a: number = "x"\n', 'a.ts')).toEqual([])
  })

  test('M62: a file the parser cannot read is refused, not counted as clean', () => {
    expect(() => disableDirectives('const a = <p>x</p> // oxlint-disable-line x\n', 'a.ts')).toThrow('a.ts:1')
  })
})

describe('machine 48: the ledger file', () => {
  const entry = { file: 'src/a.ts', directive: '@ts-ignore', rules: [], reason: null }

  test('M48.T30: text that is not a ledger is none, so HEAD keeps the count', () => {
    for (const text of ['not json', '1', 'null', '[]', '{}', '{"directives":{}}']) {
      expect({ text, ledger: parseLedger(text) }).toEqual({ text, ledger: undefined })
    }
  })

  test('M48.T31: a ledger whose entries are not directives is none, rather than a TypeError', () => {
    const malformed: ReadonlyArray<unknown> = [
      null,
      'src/a.ts',
      { ...entry, file: 1 },
      { directive: '@ts-ignore', rules: [], reason: null },
      { ...entry, directive: 1 },
      { ...entry, rules: 'x' },
      { ...entry, rules: [1] },
      { file: 'src/a.ts', directive: '@ts-ignore', rules: [] },
      { ...entry, reason: 1 },
    ]
    for (const bad of malformed) {
      expect({ bad, ledger: parseLedger(JSON.stringify({ directives: [entry, bad] })) }).toEqual({ bad, ledger: undefined })
    }
  })

  test('M48.T32: the count is the entries, and only strings name what it ignores and where it was raised', () => {
    expect(parseLedger(JSON.stringify({ count: 9, ignore: 'x', raisedFrom: 1, directives: [entry, { ...entry, reason: 'why' }] }))).toEqual({
      count: 2,
      ignore: [],
      directives: [entry, { ...entry, reason: 'why' }],
    })
    expect(parseLedger(JSON.stringify({ ignore: ['gen/**', 1], raisedFrom: 'abc', directives: [] }))).toEqual({
      count: 0,
      ignore: ['gen/**'],
      raisedFrom: 'abc',
      directives: [],
    })
  })
})

describe('machine 48: the debt ledger ratchet', () => {
  const cli = join(import.meta.dir, '..', '..', 'src', 'fence', 'cli.ts')
  // Neither git nor the command sees this process's GIT_ variables, such as a commit gate's GIT_INDEX_FILE.
  const inherited = Object.entries(process.env).filter(([name]) => name.startsWith('GIT_'))
  const environment = (): Record<string, string | undefined> => ({ ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' })
  const roots: string[] = []

  beforeAll(() => {
    for (const [name] of inherited) delete process.env[name]
  })
  afterAll(() => {
    for (const [name, value] of inherited) process.env[name] = value
  })
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  /** Runs with these variables set, as a command line's prefix sets them. */
  function withEnvironment<A>(variables: Record<string, string>, run: () => A): A {
    const before = Object.keys(variables).map((name) => [name, process.env[name]] as const)
    Object.assign(process.env, variables)
    try {
      return run()
    } finally {
      for (const [name, value] of before) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  }

  const DIRECTIVE = '// oxlint-disable-next-line no-console -- a debugging aid\n'
  const ANOTHER = '// @ts-expect-error -- the SDK types the callback wrongly\n'

  /** A repository whose first commit holds these files, by default `src/a.ts` with one directive, and their ledger. */
  function repository(files: Record<string, string> = { 'src/a.ts': DIRECTIVE }) {
    const root = mkdtempSync(join(tmpdir(), 'fence-debt-machine-'))
    roots.push(root)
    const git = (...args: string[]) => {
      const result = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], {
        cwd: root,
        encoding: 'utf8',
        env: environment(),
      })
      return { status: result.status, output: `${result.stdout}${result.stderr}` }
    }
    const write = (file: string, text: string) => {
      mkdirSync(dirname(join(root, file)), { recursive: true })
      writeFileSync(join(root, file), text)
    }
    const debt = (args: ReadonlyArray<string>, options: { readonly env?: Record<string, string>; readonly cwd?: string } = {}) => {
      const answer = withEnvironment(options.env ?? {}, () => debtCommand(args, options.cwd ?? root))
      return { status: answer.exitCode, output: `${answer.stdout}${answer.stderr}` }
    }
    const ledger = (file = 'lint-debt.json') => JSON.parse(readFileSync(join(root, file), 'utf8'))
    const commit = (message: string) => {
      git('add', '-A')
      return git('commit', '-qm', message)
    }

    git('init', '-q', '-b', 'main')
    for (const [file, text] of Object.entries(files)) write(file, text)
    // The first ledger has no count before it to go up or down from.
    expect(debt(['--update']).output).toMatch(/^Wrote lint-debt\.json: \d+ disable directives?\.\n$/)
    expect(commit('first').status).toBe(0)

    return { root, git, write, debt, ledger, commit }
  }

  test('M48.T17: a directive the old scanner missed fails --check', () => {
    const repo = repository()
    repo.write('src/view.tsx', `export const View = () => <p>Press \` to open</p>\n${DIRECTIVE}console.log(1)\n`)
    repo.git('add', '-A')

    const checked = repo.debt(['--check'])

    expect(checked.status).toBe(1)
    expect(checked.output).toContain('Lint debt rose from 1 to 2 disable directives (lint-debt.json)')
    expect(checked.output).toContain('src/view.tsx:2  oxlint-disable-next-line no-console')
  }, 30_000)

  test('M48.T13: --check passes when the commit about to be made matches its ledger', () => {
    const repo = repository()

    expect(repo.debt(['--check'])).toEqual({ status: 0, output: 'Lint debt: 1 disable directive, as lint-debt.json records.\n' })
  }, 30_000)

  test('M48.T12: --check fails when the commit holds fewer directives than its ledger', () => {
    const repo = repository()
    repo.write('src/a.ts', 'export const a = 1\n')
    repo.git('add', '-A')

    const checked = repo.debt(['--check'])

    expect(checked.status).toBe(1)
    expect(checked.output).toContain('lint-debt.json is out of date: the code holds 0 disable directives, the ledger 1')
    expect(checked.output).toContain('  - src/a.ts  oxlint-disable-next-line no-console')
  }, 30_000)

  test('M48.T18: a ledger lowered and not yet committed holds the count down', () => {
    const repo = repository({ 'src/a.ts': DIRECTIVE, 'src/b.ts': ANOTHER })
    rmSync(join(repo.root, 'src', 'b.ts'))
    expect(repo.debt(['--update']).output).toContain('1 disable directive, down from 2')

    repo.write('src/c.ts', '// @ts-ignore -- a different one takes the freed place\n')

    expect(repo.debt(['--update']).status).toBe(1)
    expect(repo.ledger().count).toBe(1)
  }, 30_000)

  test('M48.T15: the list and --json write nothing, with or without --allow-increase', () => {
    const repo = repository()

    expect(repo.debt([])).toEqual({
      status: 0,
      output: 'src/a.ts:1  oxlint-disable-next-line no-console  -- a debugging aid\n\n1 disable directive, 0 without a reason.\n',
    })
    expect(JSON.parse(repo.debt(['--json']).output)).toMatchObject({ count: 1, directives: [{ file: 'src/a.ts', line: 1 }] })
    repo.write('src/b.ts', ANOTHER)
    expect(repo.debt(['--allow-increase']).output).toContain('2 disable directives, 0 without a reason.')
    expect(repo.ledger().count).toBe(1)
  }, 30_000)

  test('M48.T36: outside a repository the report reads the working tree, and never the ledger as source', () => {
    const root = mkdtempSync(join(tmpdir(), 'fence-debt-outside-'))
    roots.push(root)
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'a.ts'), DIRECTIVE)

    expect(debtCommand(['--update'], root)).toEqual({ exitCode: 0, stdout: 'Wrote lint-debt.json: 1 disable directive.\n', stderr: '' })
    // The ledger now beside the source is JSON, which no parser reads as a program.
    expect(debtCommand(['--update'], root)).toEqual({ exitCode: 0, stdout: 'Wrote lint-debt.json: 1 disable directive.\n', stderr: '' })
    expect(debtCommand(['--check'], root).exitCode).toBe(0)
  }, 30_000)

  test('M48.T36: without git the report reads the working tree, as outside a repository', () => {
    const repo = repository()

    const listed = withEnvironment({ PATH: join(repo.root, 'no-git-here') }, () => debtCommand([], repo.root))

    expect(listed.exitCode).toBe(0)
    expect(listed.stdout).toContain('1 disable directive, 0 without a reason.')
  }, 30_000)

  test('M48: git failing inside a repository is refused, not read as no repository', () => {
    const repo = repository()
    writeFileSync(join(repo.root, '.git', 'index'), 'not an index')

    for (const args of [['--check'], ['--update']]) {
      const answer = repo.debt(args)
      expect({ args, status: answer.status }).toEqual({ args, status: 1 })
      expect(answer.output).toContain('so the debt report cannot read the repository: fatal:')
    }
  }, 30_000)

  test('M48: a file the parser cannot read fails --check, --update and the list, naming it', () => {
    const repo = repository()
    repo.write('src/broken.ts', 'export const a = (\n')
    repo.git('add', '-A')

    for (const args of [['--check'], ['--update'], []]) {
      const answer = repo.debt(args)
      expect({ args, status: answer.status }).toEqual({ args, status: 1 })
      expect(answer.output).toContain('src/broken.ts:2')
    }
  }, 30_000)

  test('M48: a source file tracked as a symbolic link holds no source, in the tree or the index', () => {
    const repo = repository()
    symlinkSync('/* oxlint-disable */', join(repo.root, 'src', 'link.ts'))
    repo.git('add', '-A')

    expect(repo.debt(['--update']).output).toBe('Wrote lint-debt.json: 1 disable directive.\n')
    expect(repo.debt(['--check']).status).toBe(0)
  }, 30_000)

  test('M48.T25: a --ledger outside the repository has no committed count to hold it to', () => {
    const repo = repository()
    const elsewhere = mkdtempSync(join(tmpdir(), 'fence-debt-ledger-'))
    roots.push(elsewhere)
    repo.write('src/b.ts', ANOTHER)

    expect(repo.debt(['--update', '--ledger', join(elsewhere, 'o.json')]).status).toBe(0)
    expect(JSON.parse(readFileSync(join(elsewhere, 'o.json'), 'utf8')).count).toBe(2)
  }, 30_000)

  test('M48.T22: a ledger deleted from the index fails --check, though --update writes the file again', () => {
    const repo = repository()
    expect(repo.git('rm', '-q', '-f', 'lint-debt.json').status).toBe(0)
    expect(repo.debt(['--update']).status).toBe(0)

    const checked = repo.debt(['--check'])

    expect(checked.status).toBe(1)
    expect(checked.output).toContain('No lint-debt.json in the commit about to be made')
  }, 30_000)

  test('M48.T23: --ledger spelled absolute, through a symbolic link or in another case keeps the count HEAD records', () => {
    const repo = repository()
    repo.write('src/b.ts', ANOTHER)
    expect(repo.git('rm', '-q', '-f', 'lint-debt.json').status).toBe(0)
    const link = join(mkdtempSync(join(tmpdir(), 'fence-debt-link-')), 'app')
    roots.push(dirname(link))
    symlinkSync(repo.root, link)

    const spellings = [join(repo.root, 'lint-debt.json'), `${repo.root}/./lint-debt.json`, join(link, 'lint-debt.json'), 'LINT-DEBT.json', 'src/../lint-debt.json']
    for (const spelling of spellings) {
      const updated = repo.debt(['--update', '--ledger', spelling])
      expect({ spelling, status: updated.status }).toEqual({ spelling, status: 1 })
      expect(updated.output).toContain('Lint debt only shrinks: the code holds 2 disable directives, the ledger 1')
    }
    expect(existsSync(join(repo.root, 'lint-debt.json'))).toBe(false)
  }, 30_000)

  test('M48.T23: an application in a subdirectory keeps the count HEAD records', () => {
    const repo = repository()
    repo.write('app/src/a.ts', DIRECTIVE)
    expect(repo.debt(['--update'], { cwd: join(repo.root, 'app') }).status).toBe(0)
    expect(repo.commit('app').status).toBe(0)
    repo.write('app/src/b.ts', ANOTHER)
    rmSync(join(repo.root, 'app', 'lint-debt.json'))

    for (const spelling of ['lint-debt.json', join(repo.root, 'app', 'lint-debt.json')]) {
      expect(repo.debt(['--update', '--ledger', spelling], { cwd: join(repo.root, 'app') }).status).toBe(1)
    }
    expect(repo.debt(['--update'], { cwd: join(repo.root, 'app'), env: { GIT_CEILING_DIRECTORIES: repo.root } }).status).toBe(1)
  }, 30_000)

  test('M48.T24: GIT_DIR and the variables like it cannot hide the count HEAD records', () => {
    const repo = repository()
    const elsewhere = mkdtempSync(join(tmpdir(), 'fence-debt-elsewhere-'))
    roots.push(elsewhere)
    expect(spawnSync('git', ['init', '-q'], { cwd: elsewhere, env: environment() }).status).toBe(0)
    repo.write('src/b.ts', ANOTHER)
    rmSync(join(repo.root, 'lint-debt.json'))

    const environments: ReadonlyArray<Record<string, string>> = [
      { GIT_DIR: '/nonexistent' },
      { GIT_DIR: join(elsewhere, '.git') },
      { GIT_DIR: join(elsewhere, '.git'), GIT_WORK_TREE: repo.root },
    ]
    for (const env of environments) {
      const updated = repo.debt(['--update'], { env })
      expect({ env, status: updated.status }).toEqual({ env, status: 1 })
    }
    expect(existsSync(join(repo.root, 'lint-debt.json'))).toBe(false)
  }, 30_000)

  test('M48.T26: a ledger restored from an older commit cannot lift the count', () => {
    const repo = repository({ 'src/a.ts': DIRECTIVE, 'src/b.ts': ANOTHER })
    rmSync(join(repo.root, 'src', 'b.ts'))
    expect(repo.debt(['--update']).output).toContain('1 disable directive, down from 2')
    expect(repo.commit('lower the count').status).toBe(0)

    repo.write('src/b.ts', ANOTHER)
    expect(repo.git('checkout', 'HEAD~1', '--', 'lint-debt.json').status).toBe(0)
    repo.git('add', '-A')

    const checked = repo.debt(['--check'])
    expect(checked.status).toBe(1)
    expect(checked.output).toContain('lint-debt.json raises the debt HEAD records: it counts 2 disable directives against 1')
    expect(repo.debt(['--update']).status).toBe(1)
    expect(repo.ledger().count).toBe(2)
  }, 30_000)

  test('M48.T27: a ledger written elsewhere and moved into place cannot lift the count', () => {
    const repo = repository()
    repo.write('src/b.ts', ANOTHER)
    expect(repo.debt(['--update', '--ledger', 'o.json']).status).toBe(0)
    repo.git('add', '-A')
    expect(repo.git('mv', '-f', 'o.json', 'lint-debt.json').status).toBe(0)

    expect(repo.debt(['--check']).status).toBe(1)
    expect(repo.debt(['--update']).status).toBe(1)
  }, 30_000)

  test('M48.T27: a ledger moved into place that leaves out more files cannot lift the count', () => {
    const repo = repository()
    repo.write('src/b.ts', ANOTHER)
    repo.write('o.json', JSON.stringify({ count: 1, ignore: ['src/b.ts'], directives: repo.ledger().directives }))
    repo.git('add', '-A')
    expect(repo.git('mv', '-f', 'o.json', 'lint-debt.json').status).toBe(0)

    const checked = repo.debt(['--check'])
    expect(checked.status).toBe(1)
    expect(checked.output).toContain('and leaves out src/b.ts')
    expect(repo.debt(['--update']).status).toBe(1)
  }, 30_000)

  test('M48.T28: --check reads the index, so a directive staged and then deleted from the tree is counted', () => {
    const repo = repository()
    const gate = join(repo.root, '.git', 'hooks', 'pre-commit')
    writeFileSync(gate, `#!/bin/sh\nexec bun ${JSON.stringify(cli)} debt --check\n`)
    chmodSync(gate, 0o755)
    repo.write('src/b.ts', ANOTHER)
    expect(repo.git('add', 'src/b.ts').status).toBe(0)
    rmSync(join(repo.root, 'src', 'b.ts'))

    const checked = repo.debt(['--check'])
    const committed = repo.git('commit', '-qm', 'a directive the tree no longer shows')

    expect(checked.status).toBe(1)
    expect(checked.output).toContain('src/b.ts:1  @ts-expect-error')
    expect(committed.status).not.toBe(0)
    expect(repo.git('rev-list', '--count', 'HEAD').output.trim()).toBe('1')
  }, 30_000)

  test('M48.T28: the gate reads the index a partial commit is made from', () => {
    const repo = repository()
    const gate = join(repo.root, '.git', 'hooks', 'pre-commit')
    writeFileSync(gate, `#!/bin/sh\nexec bun ${JSON.stringify(cli)} debt --check\n`)
    chmodSync(gate, 0o755)
    repo.write('src/a.ts', `${DIRECTIVE}${ANOTHER}`)
    repo.write('src/c.ts', 'export const c = 1\n')
    repo.git('add', 'src/c.ts')

    expect(repo.git('commit', '-qm', 'only src/a.ts', '--', 'src/a.ts').status).not.toBe(0)
    expect(repo.git('commit', '-qam', 'everything').status).not.toBe(0)
    expect(repo.git('rev-list', '--count', 'HEAD').output.trim()).toBe('1')
  }, 30_000)

  test('M48.T6: the owner raises the count with --allow-increase, which records the HEAD it raised it over', () => {
    const repo = repository()
    const gate = join(repo.root, '.git', 'hooks', 'pre-commit')
    writeFileSync(gate, `#!/bin/sh\nexec bun ${JSON.stringify(cli)} debt --check\n`)
    chmodSync(gate, 0o755)
    const head = repo.git('rev-parse', 'HEAD').output.trim()
    repo.write('src/b.ts', ANOTHER)

    expect(repo.debt(['--update', '--allow-increase']).output).toContain('2 disable directives, up from 1')
    expect(repo.ledger()).toMatchObject({ count: 2, raisedFrom: head })
    expect(repo.commit('the owner accepts a second directive').status).toBe(0)

    // The next ledger that does not raise the count drops the mark.
    repo.write('src/c.ts', 'export const c = 1\n')
    expect(repo.debt(['--update']).status).toBe(0)
    expect(repo.ledger().raisedFrom).toBeUndefined()
    expect(repo.commit('more code').status).toBe(0)
  }, 30_000)

  test('M48.T26: a raised ledger restored from before its commit names another HEAD, and is refused', () => {
    const repo = repository()
    repo.write('src/b.ts', ANOTHER)
    expect(repo.debt(['--update', '--allow-increase']).status).toBe(0)
    expect(repo.commit('the owner accepts a second directive').status).toBe(0)
    rmSync(join(repo.root, 'src', 'b.ts'))
    expect(repo.debt(['--update']).status).toBe(0)
    expect(repo.commit('lower the count').status).toBe(0)

    repo.write('src/b.ts', ANOTHER)
    expect(repo.git('checkout', 'HEAD~1', '--', 'lint-debt.json').status).toBe(0)
    repo.git('add', '-A')

    expect(repo.ledger().raisedFrom).toBeString()
    expect(repo.debt(['--check']).status).toBe(1)
  }, 30_000)
})
