/**
 * Grade an application an agent built for an exam: run the exam's hidden
 * tests against it, lint it with the framework's rules, and summarize the
 * journal its `check` script kept. Prints a scorecard in Markdown.
 *
 * Run: bun exams/grade.ts <exam> <app directory>
 *      bun exams/grade.ts clinic ../scratchpad/dogfood13/clinic-a
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const [exam, appArgument] = process.argv.slice(2)

if (exam === undefined || appArgument === undefined) {
  console.error('Usage: bun exams/grade.ts <exam> <app directory>')
  process.exit(2)
}

const app = resolve(appArgument)
const hidden = join(import.meta.dir, exam, 'hidden.exam.ts')

if (!existsSync(hidden)) {
  console.error(`No exam named ${exam}: ${hidden} does not exist.`)
  process.exit(2)
}

// The hidden tests run beside the app's own, as `exam/hidden.exam.test.ts`.
const examDir = join(app, 'exam')
const report = join(examDir, 'junit.xml')
rmSync(examDir, { recursive: true, force: true })
mkdirSync(examDir)
copyFileSync(hidden, join(examDir, 'hidden.exam.test.ts'))

const run = spawnSync('bun', ['test', 'exam/hidden.exam.test.ts', '--timeout', '30000', '--reporter=junit', `--reporter-outfile=${report}`], {
  cwd: app,
  encoding: 'utf8',
})

interface Result {
  readonly suite: string
  readonly name: string
  readonly passed: boolean
  readonly failure: string
}

const decode = (text: string) =>
  text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

function results(): Result[] {
  if (!existsSync(report)) return []

  const xml = readFileSync(report, 'utf8')
  const found: Result[] = []

  for (const match of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attributes = match[1]
    const body = match[3] ?? ''
    const name = decode(/\bname="([^"]*)"/.exec(attributes)?.[1] ?? '')
    const suite = decode(/\bclassname="([^"]*)"/.exec(attributes)?.[1] ?? '')
    const failure = /<failure\b[^>]*?(?:message="([^"]*)")?/.exec(body)

    found.push({
      suite: suite.includes('safety') ? 'safety' : suite.includes('acceptance') ? 'acceptance' : suite,
      name,
      passed: failure === null && !/<skipped/.test(body),
      failure: failure === null ? '' : decode(failure[1] ?? '').split('\n')[0].slice(0, 160),
    })
  }

  return found
}

const graded = results()

function score(suite: string): string {
  const cases = graded.filter((result) => result.suite === suite)

  return `${cases.filter((result) => result.passed).length}/${cases.length}`
}

// The journal `check.ts` kept: how many runs each step took, and how many failed.
interface Entry {
  readonly step: string
  readonly exit: number
  readonly errors: number
}

const journalFile = join(app, '.journal.jsonl')
const journal: Entry[] = existsSync(journalFile)
  ? readFileSync(journalFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  : []

function steps(step: string): string {
  const runs = journal.filter((entry) => entry.step === step)

  return `${runs.length} runs, ${runs.filter((entry) => entry.exit !== 0).length} failed`
}

// The framework's lint rules over the app's sources, with its own configuration.
const lint = spawnSync('bunx', ['oxlint', '--format', 'json', 'src'], { cwd: app, encoding: 'utf8' })
let lintFindings: string[] = []

try {
  const parsed: { diagnostics?: ReadonlyArray<{ code: string; filename: string; labels: ReadonlyArray<{ span: { line: number } }> }> } =
    JSON.parse(lint.stdout)

  lintFindings = (parsed.diagnostics ?? []).map((diagnostic) => `${diagnostic.code} ${diagnostic.filename}:${diagnostic.labels[0]?.span.line ?? 0}`)
} catch {
  lintFindings = [`oxlint did not run: ${(lint.stderr || lint.stdout).split('\n')[0]}`]
}

// How the app uses the framework: route model binding for the records its
// paths name, and the test helpers rather than hand-rolled stand-ins.
const textOf = (patterns: ReadonlyArray<string>, exclude: (file: string) => boolean = () => false) =>
  patterns
    .flatMap((pattern) => [...new Bun.Glob(pattern).scanSync({ cwd: app })])
    .filter((file) => !file.includes('node_modules') && !file.startsWith('exam/') && !exclude(file))
    .map((file) => readFileSync(join(app, file), 'utf8'))
    .join('\n')

const isTest = (file: string) => /\.test\.tsx?$/.test(file) || /^tests?\//.test(file) || file === 'src/test-support.ts'
const sourceText = textOf(['src/**/*.ts', 'src/**/*.tsx'], isTest)
const testText = textOf(['src/**/*.ts', 'test/**/*.ts', 'tests/**/*.ts'], (file) => !isTest(file))
const pathsText = existsSync(join(app, 'src/paths.ts')) ? readFileSync(join(app, 'src/paths.ts'), 'utf8') : sourceText

const unique = (values: Iterable<string>) => [...new Set(values)].sort()
const placeholders = unique([...pathsText.matchAll(/\{(\w+)(?::\w+)?\}/g)].map((match) => match[1]))
const bound = unique([...sourceText.matchAll(/\bbound\(\s*['"](\w+)['"]/g)].map((match) => match[1]))
const plain = placeholders.filter((name) => !bound.includes(name))
const rawParams = (sourceText.match(/\.req\.param\(|\.param\(\s*['"]|\.params\(\)/g) ?? []).length
const list = (names: ReadonlyArray<string>) => (names.length === 0 ? 'none' : names.join(', '))
const uses = (pattern: RegExp) => (pattern.test(testText) ? 'yes' : 'no')

const usage = [
  `Route model binding: bound ${list(bound)}; plain parameters ${list(plain)}; raw parameter reads ${rawParams}.`,
  `Test helpers: testOAuthProvider ${uses(/\btestOAuthProvider\(/)} (own fetch stand-in ${uses(/spyOn\(\s*globalThis\s*,\s*['"]fetch['"]|globalThis\.fetch\s*=/)}), ` +
    `testD1 ${uses(/\btestD1\(/)} (own Miniflare ${uses(/new Miniflare\(/)}), testBrowser ${uses(/\btestBrowser\(/)}.`,
]

const lines = [
  `## ${exam}: ${app}`,
  '',
  `| Acceptance | Safety | Journal: types | lint | tests | Lint findings |`,
  `| --- | --- | --- | --- | --- | --- |`,
  `| ${score('acceptance')} | ${score('safety')} | ${steps('types')} | ${steps('lint')} | ${steps('test')} | ${lintFindings.length} |`,
  '',
  ...usage,
  '',
]

const failures = graded.filter((result) => !result.passed)

if (failures.length > 0) {
  lines.push('Failed:', '')
  for (const failure of failures) lines.push(`- **${failure.suite}**: ${failure.name}${failure.failure === '' ? '' : ` — ${failure.failure}`}`)
  lines.push('')
}

if (graded.length === 0) lines.push('The hidden tests did not run:', '', '```', `${run.stdout}${run.stderr}`.slice(-3000), '```', '')
if (lintFindings.length > 0) lines.push('Lint:', '', ...lintFindings.map((finding) => `- ${finding}`), '')

console.log(lines.join('\n'))
