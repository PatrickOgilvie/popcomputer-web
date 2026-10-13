/**
 * The app's checks, run in order: type check, the framework's lint rules,
 * then tests. Each run is recorded in .journal.jsonl, so the framework's
 * authors can see how many tries each check took and what it reported.
 *
 * Run: bun run check
 */
import { appendFileSync } from 'node:fs'

const steps: Array<[string, string[]]> = [
  ['types', ['bunx', 'tsc', '--noEmit']],
  ['lint', ['bunx', 'oxlint']],
  ['test', ['bun', 'test']],
]

let failed = false

for (const [step, command] of steps) {
  const started = Date.now()
  const run = Bun.spawnSync(command, { stdout: 'pipe', stderr: 'pipe' })
  const output = `${run.stdout.toString()}${run.stderr.toString()}`
  const errors = (output.match(/error TS\d+|\berror\b[^\n]*popcomputer-web|^\(fail\)/gm) ?? []).length

  appendFileSync('.journal.jsonl', `${JSON.stringify({
    at: new Date().toISOString(),
    step,
    exit: run.exitCode,
    errors,
    ms: Date.now() - started,
    head: output.split('\n').filter((line) => /error|fail|✗/i.test(line)).slice(0, 30),
  })}\n`)

  process.stdout.write(output)

  if (run.exitCode !== 0) {
    failed = true
    console.error(`\ncheck: ${step} failed`)
    break
  }
}

if (!failed) console.log('\ncheck: types, lint and tests pass')
process.exit(failed ? 1 : 0)
