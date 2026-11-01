import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { changedLines, findMutants, formatReport, mutate, type Result, score } from '../scripts/mutate.js'

const fixture = join(import.meta.dir, 'fixtures', 'mutate', 'tiny.ts')
const script = join(import.meta.dir, '..', 'scripts', 'mutate.ts')

// The fixture's tests, which leave some of its mutants alive on purpose: no
// age of exactly 18, no value of 0, and no plural of more than one.
const TINY_TESTS = `import { expect, test } from 'bun:test'
import { allowed, digits, firstNegative, isAdult, plural } from '../src/tiny'

test('isAdult', () => {
  expect(isAdult(30)).toBe(true)
  expect(isAdult(10)).toBe(false)
})

test('firstNegative', () => {
  expect(firstNegative([3, -2])).toBe(-2)
})

test('allowed', () => {
  expect(allowed('admin', ['admin', 'editor'])).toBe(true)
  expect(() => allowed('guest', ['admin'])).toThrow()
})

test('digits', () => {
  expect(digits(123)).toBe(3)
})

test('plural', () => {
  expect(plural(1)).toBe('one')
})
`

// Two files and one test that reaches both: a's mutant is caught, b's is not.
const TWO_FILES = {
  'src/a.ts': 'export const ready = true\n',
  'src/b.ts': 'export const positive = (n: number) => n > 0\n',
  'tests/b.test.ts': `import { expect, test } from 'bun:test'
import { ready } from '../src/a'
import { positive } from '../src/b'

test('positive', () => {
  expect(ready).toBe(true)
  expect(positive(5)).toBe(true)
  expect(positive(-5)).toBe(false)
})
`,
}

/** A repository of the given files, by default the fixture as src/tiny.ts and its tests. */
function tinyRepo(files: Record<string, string> = {}, tiny = true): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mutate-test-')))
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'tests'))
  if (tiny) {
    copyFileSync(fixture, join(root, 'src', 'tiny.ts'))
    writeFileSync(join(root, 'tests', 'tiny.test.ts'), TINY_TESTS)
  }
  for (const [file, text] of Object.entries(files)) writeFileSync(join(root, file), text)
  spawnSync('git', ['init', '--quiet'], { cwd: root })
  return root
}

const outcome = (result: Result) => `${result.line} ${result.operator} ${result.original} → ${result.replacement}: ${result.status}`

test('findMutants plants each operator at its site, and none in a throw, a template or a type', async () => {
  const mutants = await findMutants(join(import.meta.dir, '..'), ['tests/fixtures/mutate/tiny.ts'])

  expect(mutants.map((mutant) => `${mutant.line} ${mutant.operator} ${mutant.original} → ${mutant.replacement}`)).toEqual([
    '4 boundary >= → >',
    '9 skip-guard value < 0 → false',
    '9 boundary < → <=',
    '15 skip-guard !roles.some((each) => each === role) → false',
    '15 drop-not !roles.some((each) => each === role) → roles.some((each) => each === role)',
    '15 some-every some → every',
    '15 negate-eq === → !==',
    '16 bool true → false',
    '22 bool true → false',
    '25 skip-guard rest === 0 → false',
    '25 negate-eq === → !==',
    '31 skip-guard count > 1 → false',
    '31 boundary > → >=',
    '32 negate-eq === → !==',
  ])
  expect(mutants[0].source).toBe('return age >= 18')
})

test('mutate runs each mutant against the tests that reach it and reports the ones they miss', async () => {
  const root = tinyRepo({
    // It fails with no mutant planted, so its failures say nothing.
    'tests/broken.test.ts': `import { expect, test } from 'bun:test'\nimport { plural } from '../src/tiny'\ntest('broken', () => expect(plural(2)).toBe('many'))\n`,
    // It never loads the fixture, so it never runs.
    'tests/unrelated.test.ts': `import { expect, test } from 'bun:test'\ntest('unrelated', () => expect(1).toBe(1))\n`,
  })

  try {
    const run = await mutate({ root, files: ['src/tiny.ts'], workers: 3, timeout: 3000 })

    expect(run.testFiles).toBe(2)
    expect(run.failing).toEqual(['tests/broken.test.ts'])
    expect(run.results.map(outcome)).toEqual([
      '4 boundary >= → >: survived',
      '9 skip-guard value < 0 → false: killed',
      '9 boundary < → <=: survived',
      '15 skip-guard !roles.some((each) => each === role) → false: killed',
      '15 drop-not !roles.some((each) => each === role) → roles.some((each) => each === role): killed',
      '15 some-every some → every: killed',
      '15 negate-eq === → !==: killed',
      '16 bool true → false: killed',
      '22 bool true → false: killed',
      // The loop never ends.
      '25 skip-guard rest === 0 → false: timed out',
      '25 negate-eq === → !==: killed',
      '31 skip-guard count > 1 → false: survived',
      '31 boundary > → >=: killed',
      '32 negate-eq === → !==: survived',
    ])
    // No test runs for line 32's, which none reaches, though the plural test
    // reaches the line above it.
    expect(run.results.map((result) => result.tests)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0])
    expect(score(run.results)).toBe((100 * 10) / 14)

    const report = formatReport(run)
    expect(report).toContain('score 71%: 9 killed, 1 timed out, 4 survived')
    expect(report).toContain('  src/tiny.ts:4  boundary  >= → >\n      return age >= 18')
    expect(report).toContain('  src/tiny.ts:32  negate-eq  === → !==  (no test reaches this line)')
    expect(report).toContain('left out, failing with no mutant planted: tests/broken.test.ts')

    // The working tree is never edited.
    expect(readFileSync(join(root, 'src', 'tiny.ts'), 'utf8')).toBe(readFileSync(fixture, 'utf8'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)

test('mutate puts each file back before planting the next mutant', async () => {
  // Both mutants run against the one test, a's first: left in place, a's
  // would fail it while b's runs.
  const root = tinyRepo(TWO_FILES, false)

  try {
    const run = await mutate({ root, files: ['src/a.ts', 'src/b.ts'], workers: 1 })

    expect(run.results.map(outcome)).toEqual(['1 bool true → false: killed', '1 boundary > → >=: survived'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)

test('mutate, given no files, mutates only the src/ lines changed since the base', async () => {
  const root = tinyRepo()
  const git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: root })

  try {
    git('add', '.')
    git('commit', '--quiet', '-m', 'Add the fixture')
    const path = join(root, 'src', 'tiny.ts')
    writeFileSync(path, readFileSync(path, 'utf8').replace('return age >= 18', 'return age >= 21'))

    const run = await mutate({ root, workers: 1 })

    expect(run.results.map(outcome)).toEqual(['4 boundary >= → >: survived'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)

test('bun run mutate prints the report, and fails only when the score is under --fail-under', () => {
  const root = tinyRepo(TWO_FILES, false)
  const cli = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' })

  try {
    const passing = cli('src/a.ts', 'src/b.ts', '--fail-under', '50')
    expect(passing.status).toBe(0)
    expect(passing.stdout).toContain('score 50%: 1 killed, 0 timed out, 1 survived')
    expect(passing.stdout).toContain('  src/b.ts:1  boundary  > → >=\n')

    expect(cli('src/a.ts', 'src/b.ts', '--fail-under', '51').status).toBe(1)

    const wrong = cli('tests/b.test.ts')
    expect(wrong.status).toBe(2)
    expect(wrong.stderr).toContain('tests/b.test.ts is not a TypeScript file in src/.')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)

test('changedLines reads the lines each file gained from a diff without context', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -3 +3,2 @@',
    '-old',
    '+new',
    '+++ an added line that looks like a header',
    '@@ -10,2 +11,0 @@',
    '-removed',
    '-removed',
    '@@ -20 +19 @@',
    '-before',
    '+after',
    'diff --git a/src/b.ts b/src/b.ts',
    'deleted file mode 100644',
    '--- a/src/b.ts',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-removed',
  ].join('\n')

  expect(changedLines(diff)).toEqual(new Map([['src/a.ts', new Set([3, 4, 19])]]))
})
