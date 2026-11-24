/**
 * The mutation run's machine (54) and `changedLines`' (63): each row a test
 * names was reachable once, and is not now.
 */
import { expect, test } from 'bun:test'
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { changedLines, formatReport, mutate, type Result, score } from '../../src/mutate.js'

const script = join(import.meta.dir, '..', '..', 'src', 'mutate.ts')

// Two boundary mutants, which the tests below let through when nothing else
// goes wrong: neither tests the edge.
const BOUNDS = 'export const positive = (n: number) => n > 0\nexport const small = (n: number) => n < 10\n'

/** A test file for src/b.ts, with the given lines before its assertions. */
const boundsTest = (imports: string, body: string, timeout = 5_000) => `import { expect, test } from 'bun:test'
${imports}
import { positive, small } from '../src/b'

test('bounds', async () => {
${body}
  expect(positive(5)).toBe(true)
  expect(small(5)).toBe(true)
}, ${timeout})
`

/** A repository of the given files, outside any other. */
function repo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mutate-machine-')))
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), text)
  }
  spawnSync('git', ['init', '--quiet'], { cwd: root })
  return root
}

const temporary = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)))

const outcome = (result: Result) => `${result.line} ${result.original} → ${result.replacement}: ${result.status}`

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Whether a check holds within the time given, polling. */
async function eventually(check: () => boolean, ms: number): Promise<boolean> {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await Bun.sleep(25)) if (check()) return true
  return check()
}

/** The run workspaces left in a temporary directory. */
const workspaces = (directory: string) => readdirSync(directory).filter((name) => name.startsWith('popweb-mutate-'))

/** Kill a test run a failed check left behind, and its process group. */
function reap(pidFile: string) {
  if (!existsSync(pidFile)) return
  const pid = Number(readFileSync(pidFile, 'utf8'))
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 'SIGKILL')
    } catch {
      // Gone already.
    }
  }
}

const exited = (child: ChildProcess) =>
  new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })

for (const [signal, code] of [['SIGTERM', 143], ['SIGHUP', 129]] as const) {
  test(`M54.T11: ${signal} during coverage kills the test run and removes the workspace`, async () => {
    const scratch = temporary('mutate-signal-')
    const pidFile = join(scratch, 'pid')
    const runnerTemporary = join(scratch, 'tmp')
    mkdirSync(runnerTemporary)
    const root = repo({
      'src/b.ts': BOUNDS,
      // Its coverage run waits, so the signal comes while it is open.
      'tests/b.test.ts': boundsTest(`import { writeFileSync } from 'node:fs'`, `  writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))\n  await Bun.sleep(30_000)`, 60_000),
    })

    try {
      const runner = spawn(process.execPath, [script, 'src/b.ts', '--workers', '1'], { cwd: root, env: { ...process.env, TMPDIR: runnerTemporary }, stdio: 'ignore' })
      const ended = exited(runner)
      expect(await eventually(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8') !== '', 30_000)).toBe(true)
      const pid = Number(readFileSync(pidFile, 'utf8'))

      runner.kill(signal)

      expect(await ended).toEqual({ code, signal: null })
      expect(await eventually(() => !alive(pid), 5_000)).toBe(true)
      expect(workspaces(runnerTemporary)).toEqual([])
    } finally {
      reap(pidFile)
      rmSync(root, { recursive: true, force: true })
      rmSync(scratch, { recursive: true, force: true })
    }
  }, 90_000)
}

test('M54.T11: a runner killed outright, with its process group, leaves no test run or workspace behind', async () => {
  const scratch = temporary('mutate-killed-')
  const pidFile = join(scratch, 'pid')
  const runnerTemporary = join(scratch, 'tmp')
  mkdirSync(runnerTemporary)
  const root = repo({
    'src/b.ts': BOUNDS,
    'tests/b.test.ts': boundsTest(`import { writeFileSync } from 'node:fs'`, `  writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))\n  await Bun.sleep(30_000)`, 60_000),
  })

  try {
    // In a process group of its own, as a terminal or an agent's tool runs it.
    const runner = spawn(process.execPath, [script, 'src/b.ts', '--workers', '1'], { cwd: root, detached: true, env: { ...process.env, TMPDIR: runnerTemporary }, stdio: 'ignore' })
    const ended = exited(runner)
    expect(await eventually(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8') !== '', 30_000)).toBe(true)
    const pid = Number(readFileSync(pidFile, 'utf8'))

    // No handler runs: what outlives the runner's group cleans up after it.
    const group = runner.pid
    if (group === undefined) throw new Error('The runner did not start.')
    process.kill(-group, 'SIGKILL')

    expect(await ended).toEqual({ code: null, signal: 'SIGKILL' })
    expect(await eventually(() => !alive(pid), 10_000)).toBe(true)
    expect(await eventually(() => workspaces(runnerTemporary).length === 0, 10_000)).toBe(true)
  } finally {
    reap(pidFile)
    rmSync(root, { recursive: true, force: true })
    rmSync(scratch, { recursive: true, force: true })
  }
}, 90_000)

for (const phase of ['coverage', 'mutants', 'control']) {
  test(`M54.T12: a test run that cannot start, from ${phase} on, fails the run, which leaves no workspace behind`, () => {
    const scratch = temporary('mutate-spawn-')
    const runnerTemporary = join(scratch, 'tmp')
    mkdirSync(runnerTemporary)
    // A Bun of the run's own, which the run deletes as the phase starts, as an
    // upgrade might, or the tests delete as they fail on a mutant, before its
    // control: each test run after that fails to start.
    const bun = join(scratch, 'bun')
    copyFileSync(process.execPath, bun, constants.COPYFILE_FICLONE)
    const root = repo({
      'src/b.ts': BOUNDS,
      'tests/b.test.ts': phase === 'control'
        ? boundsTest(`import { rmSync } from 'node:fs'`, `  if (positive(0)) rmSync(${JSON.stringify(bun)}, { force: true })\n  expect(positive(0)).toBe(false)`)
        : boundsTest('', ''),
    })
    const driver = join(scratch, 'drive.ts')
    writeFileSync(driver, `import { rmSync } from 'node:fs'
import { mutate } from ${JSON.stringify(script)}

// Never the Bun the suite runs on: only the copy in this test's directory.
const deletable = process.execPath.startsWith(${JSON.stringify(`${scratch}/`)})
try {
  await mutate({
    root: ${JSON.stringify(root)},
    files: ['src/b.ts'],
    workers: 1,
    log: (line) => {
      if (line.startsWith(${JSON.stringify(`${phase}:`)}) && deletable) rmSync(process.execPath)
    },
  })
  console.log('finished')
} catch (error) {
  console.log(\`failed: \${error instanceof Error ? error.message : String(error)}\`)
  process.exit(3)
}
`)

    try {
      const run = spawnSync(bun, [driver], { cwd: root, env: { ...process.env, TMPDIR: runnerTemporary }, encoding: 'utf8', timeout: 60_000 })

      expect(existsSync(bun)).toBe(false)
      expect(run.stdout).toContain('failed: ')
      expect(run.stdout).toContain('could not start')
      expect(run.status).toBe(3)
      expect(workspaces(runnerTemporary)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(scratch, { recursive: true, force: true })
    }
  }, 90_000)
}

test('M54.T19: a mutated file edited during the run is mutated as it was read', async () => {
  const root = repo({ 'src/b.ts': BOUNDS, 'tests/b.test.ts': boundsTest('', '') })

  try {
    const run = await mutate({
      root,
      files: ['src/b.ts'],
      workers: 1,
      log: (line) => {
        if (line.startsWith('coverage:')) writeFileSync(join(root, 'src', 'b.ts'), `// An edit while the run reads it.\n${BOUNDS}`)
      },
    })

    // As a run on the unedited file reports them.
    expect(run.results.map(outcome)).toEqual(['1 > → >=: survived', '2 < → <=: survived'])
    expect(score(run.results)).toBe(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)

test('M54.T22: a job that fails ends the other workers\' test runs before the run fails', async () => {
  const scratch = temporary('mutate-job-')
  const pidFile = join(scratch, 'pid')
  const copyFile = join(scratch, 'copy')
  const phase = join(scratch, 'mutating')
  const root = repo({
    'src/slow.ts': 'export const slow = (n: number) => n > 0\n',
    'src/fast.ts': 'export const one = (n: number) => n > 1\nexport const two = (n: number) => n > 2\nexport const three = (n: number) => n > 3\n',
    // The costliest, so the first job: once mutants run, it notes its pid
    // and waits.
    'tests/slow.test.ts': `import { expect, test } from 'bun:test'
import { existsSync, writeFileSync } from 'node:fs'
import { slow } from '../src/slow'

test('slow', async () => {
  if (existsSync(${JSON.stringify(phase)})) {
    writeFileSync(${JSON.stringify(copyFile)}, process.cwd())
    writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
    await Bun.sleep(30_000)
  } else {
    await Bun.sleep(500)
  }
  expect(slow(5)).toBe(true)
}, 60_000)
`,
    // Once mutants run, it waits for the slow one to start, so the next job
    // starts beside it.
    'tests/fast.test.ts': `import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { one, three, two } from '../src/fast'

test('fast', async () => {
  if (existsSync(${JSON.stringify(phase)})) {
    for (let waited = 0; !existsSync(${JSON.stringify(pidFile)}) && waited < 20_000; waited += 20) await Bun.sleep(20)
    await Bun.sleep(300)
  }
  expect([one(5), two(5), three(5)]).toEqual([true, true, true])
}, 60_000)
`,
  })

  let watching = true
  try {
    const failure = mutate({
      root,
      files: ['src/slow.ts', 'src/fast.ts'],
      workers: 2,
      timeout: 60_000,
      log: (line) => {
        if (!line.startsWith('mutants:')) return
        writeFileSync(phase, '')
        // Once the slow run is open, the next job fails: no test run can
        // start with an environment that large.
        void (async () => {
          while (watching && !existsSync(pidFile)) await Bun.sleep(10)
          if (watching) process.env.POPWEB_MUTATE_TEST_HUGE = 'x'.repeat(4 * 1024 * 1024)
        })()
      },
    })

    const error = await failure.then(() => undefined, (error: unknown) => error)

    expect(alive(Number(readFileSync(pidFile, 'utf8')))).toBe(false)
    // The workspace the copies were in.
    expect(existsSync(dirname(readFileSync(copyFile, 'utf8')))).toBe(false)
    expect(String(error)).toContain('could not start')
  } finally {
    watching = false
    delete process.env.POPWEB_MUTATE_TEST_HUGE
    reap(pidFile)
    rmSync(root, { recursive: true, force: true })
    rmSync(scratch, { recursive: true, force: true })
  }
}, 90_000)

test('M54.T28: a test that fails with no mutant planted too catches neither mutant', async () => {
  const scratch = temporary('mutate-flag-')
  const flag = join(scratch, 'flag')
  const root = repo({
    'src/b.ts': BOUNDS,
    'tests/b.test.ts': boundsTest(`import { existsSync } from 'node:fs'`, `  expect(existsSync(${JSON.stringify(flag)})).toBe(false)`),
  })

  try {
    const run = await mutate({
      root,
      files: ['src/b.ts'],
      workers: 1,
      log: (line) => {
        if (line.startsWith('mutants:')) writeFileSync(flag, '')
      },
    })

    expect(run.results.map(outcome)).toEqual(['1 > → >=: crashed', '2 < → <=: crashed'])
    expect(run.results.map((result) => result.crash)).toEqual(['its tests fail with no mutant planted too', 'its tests fail with no mutant planted too'])
    expect(score(run.results)).toBe(0)

    const report = formatReport(run)
    expect(report).toContain('score 0%: 0 killed, 0 timed out, 2 crashed, 0 survived')
    expect(report).toContain('  src/b.ts:1  boundary  > → >=  (its tests fail with no mutant planted too)')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(scratch, { recursive: true, force: true })
  }
}, 60_000)

test('M54.T28: a failure is the mutant\'s when the files that failed pass without it, whatever the others do', async () => {
  const scratch = temporary('mutate-control-')
  const flag = join(scratch, 'flag')
  const root = repo({
    'src/b.ts': BOUNDS,
    // It catches positive's mutant, and runs first, the faster.
    'tests/a.test.ts': `import { expect, test } from 'bun:test'
import { positive } from '../src/b'

test('positive', () => expect(positive(0)).toBe(false))
`,
    // Once mutants run, it fails with or without one.
    'tests/z.test.ts': boundsTest(`import { existsSync } from 'node:fs'`, `  await Bun.sleep(existsSync(${JSON.stringify(flag)}) ? 0 : 300)\n  expect(existsSync(${JSON.stringify(flag)})).toBe(false)`),
  })

  try {
    const run = await mutate({
      root,
      files: ['src/b.ts'],
      workers: 1,
      log: (line) => {
        if (line.startsWith('mutants:')) writeFileSync(flag, '')
      },
    })

    // The run on positive's mutant stops at a.test.ts, which passes without
    // it; small's fails only in z.test.ts, which fails without it too.
    expect(run.results.map(outcome)).toEqual(['1 > → >=: killed', '2 < → <=: crashed'])
    expect(run.results.map((result) => result.tests)).toEqual([2, 2])
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(scratch, { recursive: true, force: true })
  }
}, 60_000)

test('M54.T29: a test run a signal ends, not its timer, catches nothing', async () => {
  const root = repo({
    'src/b.ts': BOUNDS,
    'tests/b.test.ts': boundsTest('', `  if (process.env.POPWEB_MUTATE_TEST_KILL === '1') process.kill(process.pid, 'SIGKILL')`),
  })

  try {
    const run = await mutate({
      root,
      files: ['src/b.ts'],
      workers: 1,
      log: (line) => {
        if (line.startsWith('mutants:')) process.env.POPWEB_MUTATE_TEST_KILL = '1'
      },
    })

    expect(run.results.map(outcome)).toEqual(['1 > → >=: crashed', '2 < → <=: crashed'])
    expect(run.results.map((result) => result.crash)).toEqual(['ended by SIGKILL', 'ended by SIGKILL'])
    expect(score(run.results)).toBe(0)
  } finally {
    delete process.env.POPWEB_MUTATE_TEST_KILL
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)

test('M54.T31: what one mutant\'s tests leave in the copy is gone before the next runs', async () => {
  const scratch = temporary('mutate-left-')
  writeFileSync(join(scratch, 'sentinel'), '')
  const root = repo({
    'src/b.ts': BOUNDS,
    'data.txt': 'clean\n',
    'keep.txt': 'here\n',
    // Ignored, so each copy links to it.
    '.gitignore': 'dist\n',
    'dist/marker': '',
    // positive's mutant takes 0, and the test leaves the copy dirty when it
    // does: a file, a directory and a link added, a file changed and one
    // removed, the link to dist/ pointed elsewhere, and a file in its
    // temporary directory.
    'tests/b.test.ts': boundsTest(
      `import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'`,
      `  expect(readdirSync('.').filter((name) => ['left', 'gone', 'link'].includes(name))).toEqual([])
  expect(readFileSync('data.txt', 'utf8')).toBe('clean\\n')
  expect(existsSync('keep.txt')).toBe(true)
  expect(existsSync('dist/marker')).toBe(true)
  expect(existsSync(join(tmpdir(), 'scratch'))).toBe(false)
  if (positive(0)) {
    writeFileSync('left', '')
    mkdirSync('gone/inside', { recursive: true })
    writeFileSync('gone/inside/file', '')
    symlinkSync(${JSON.stringify(scratch)}, 'link')
    appendFileSync('data.txt', 'dirty\\n')
    rmSync('keep.txt')
    unlinkSync('dist')
    symlinkSync(${JSON.stringify(scratch)}, 'dist')
    writeFileSync(join(tmpdir(), 'scratch'), '')
  }`,
    ),
  })

  try {
    const run = await mutate({ root, files: ['src/b.ts'], workers: 1 })

    expect(run.results.map(outcome)).toEqual(['1 > → >=: survived', '2 < → <=: survived'])
    // The links went, not what they pointed to.
    expect(readdirSync(scratch)).toEqual(['sentinel'])
    expect(readdirSync(join(root, 'dist'))).toEqual(['marker'])
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(scratch, { recursive: true, force: true })
  }
}, 60_000)

test('M54.T28: a mutant that stops a file loading is killed when the file loads without it', async () => {
  const root = repo({
    // No test calls unused, so no test runs against its mutant, and the
    // broken file beside them never fails it.
    'src/ready.ts': `export const ready = true\nif (!ready) throw new Error('not ready')\nexport const half = (n: number) => n / 2\nexport function unused(n: number) {\n  return n > 1\n}\n`,
    'tests/ready.test.ts': `import { expect, test } from 'bun:test'
import { half } from '../src/ready'

test('half', () => expect(half(4)).toBe(2))
`,
    // It fails with or without a mutant, and is left out.
    'tests/broken.test.ts': `import { expect, test } from 'bun:test'\ntest('broken', () => expect(1).toBe(2))\n`,
  })

  try {
    const run = await mutate({ root, files: ['src/ready.ts'], workers: 1 })

    // Bun writes no report when a file does not load, so the control runs
    // every file the mutant's did.
    expect(run.results.map((result) => `${result.line} ${result.operator}: ${result.status}`)).toEqual([
      '1 bool: killed',
      '2 skip-guard: survived',
      '2 drop-not: killed',
      '5 boundary: unreached',
    ])
    expect(run.results.map((result) => result.tests)).toEqual([1, 1, 1, 0])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)

test('M54.T28: a failing file the report names as the run cannot read it is run again with the others', async () => {
  const root = repo({
    'src/b.ts': 'export const positive = (n: number) => n > 0\n',
    // The report escapes its name, "a&amp;b.test.ts".
    'tests/a&b.test.ts': `import { expect, test } from 'bun:test'
import { positive } from '../src/b'

test('positive', () => expect(positive(0)).toBe(false))
`,
    // It fails with or without a mutant, and is left out.
    'tests/broken.test.ts': `import { expect, test } from 'bun:test'\ntest('broken', () => expect(1).toBe(2))\n`,
  })

  try {
    const run = await mutate({ root, files: ['src/b.ts'], workers: 1 })

    expect(run.results.map(outcome)).toEqual(['1 > → >=: killed'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)

test('M54.T28: the control runs only the files that failed, not those that passed beside them', async () => {
  const scratch = temporary('mutate-passed-')
  const flag = join(scratch, 'flag')
  const root = repo({
    'src/b.ts': 'export const positive = (n: number) => n > 0\n',
    // The faster, so the first to run: it passes beside the mutant, and
    // would fail after it.
    'tests/p.test.ts': `import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { positive } from '../src/b'

test('p', () => {
  expect(existsSync(${JSON.stringify(flag)})).toBe(false)
  expect(positive(5)).toBe(true)
})
`,
    // It catches the mutant, and marks that it did.
    'tests/z.test.ts': `import { expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { positive } from '../src/b'

test('z', async () => {
  await Bun.sleep(300)
  if (positive(0)) writeFileSync(${JSON.stringify(flag)}, '')
  expect(positive(0)).toBe(false)
})
`,
  })

  try {
    const run = await mutate({ root, files: ['src/b.ts'], workers: 1 })

    expect(run.results.map(outcome)).toEqual(['1 > → >=: killed'])
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(scratch, { recursive: true, force: true })
  }
}, 60_000)

test('M63.T9: a removed line reading "-- x" and an added one reading "++ y" are not a file\'s header', () => {
  const diff = [
    'diff --git a/src/x.ts b/src/x.ts',
    'index 1111111..2222222 100644',
    '--- a/src/x.ts',
    '+++ b/src/x.ts',
    '@@ -1 +1 @@',
    '--- old',
    '+++ new',
    '@@ -9,0 +10 @@ const x = 1',
    '+added',
  ].join('\n')

  expect(changedLines(diff)).toEqual(new Map([['src/x.ts', new Set([1, 10])]]))
})

test('M63.T10: an added line reading "++ b/src/other.ts" changes no other file', () => {
  const diff = [
    'diff --git a/src/x.ts b/src/x.ts',
    '--- a/src/x.ts',
    '+++ b/src/x.ts',
    '@@ -1 +1 @@',
    '--- old',
    '+++ b/src/other.ts',
    '@@ -9,0 +10 @@',
    '+added',
    '\\ No newline at end of file',
  ].join('\n')

  expect(changedLines(diff)).toEqual(new Map([['src/x.ts', new Set([1, 10])]]))
})

test('M63.T11: a header git quotes, for a name it will not print as it is, names the file', () => {
  // As git writes a change to src/café.ts and to a name with a tab and a space.
  const diff = [
    'diff --git "a/src/caf\\303\\251.ts" "b/src/caf\\303\\251.ts"',
    'index 7898192..422c2b7 100644',
    '--- "a/src/caf\\303\\251.ts"',
    '+++ "b/src/caf\\303\\251.ts"',
    '@@ -1,0 +2 @@ a',
    '+b',
    'diff --git "a/src/t\\tb \\"q\\".ts" "b/src/t\\tb \\"q\\".ts"',
    '--- "a/src/t\\tb \\"q\\".ts"\t',
    '+++ "b/src/t\\tb \\"q\\".ts"\t',
    '@@ -3 +3 @@',
    '-c',
    '+d',
  ].join('\n')

  expect(changedLines(diff)).toEqual(new Map([['src/café.ts', new Set([2])], ['src/t\tb "q".ts', new Set([3])]]))
})

test('M63.T12: a header for a name with a space names the file, not the tab git ends it with', () => {
  const diff = [
    'diff --git a/src/a b.ts b/src/a b.ts',
    'index 7898192..422c2b7 100644',
    '--- a/src/a b.ts\t',
    '+++ b/src/a b.ts\t',
    '@@ -1,0 +2 @@ a',
    '+b',
  ].join('\n')

  expect(changedLines(diff)).toEqual(new Map([['src/a b.ts', new Set([2])]]))
})

test('M63.T11, T12: given no files, a run mutates the changed lines of files whose names git quotes or ends with a tab, and new ones',async () => {
  const root = repo({ 'src/café.ts': 'export const a = 1\n', 'src/a b.ts': 'export const b = 1\n' })
  const git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: root })

  try {
    git('add', '.')
    git('commit', '--quiet', '-m', 'Add the files')
    writeFileSync(join(root, 'src', 'café.ts'), 'export const a = 1\nexport const big = (n: number) => n > 10\n')
    writeFileSync(join(root, 'src', 'a b.ts'), 'export const b = 1\nexport const small = (n: number) => n < 10\n')
    // A new file, which git lists rather than diffs.
    writeFileSync(join(root, 'src', 'new café.ts'), 'export const none = (n: number) => n === 0\n')

    const run = await mutate({ root, workers: 1 })

    expect(run.results.map((result) => `${result.file}:${result.line} ${result.original}`).sort()).toEqual(['src/a b.ts:2 <', 'src/café.ts:2 >', 'src/new café.ts:1 ==='])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
