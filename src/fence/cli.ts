#!/usr/bin/env node
/**
 * `popweb-fence`: the agent fence's commands, run from an application's root.
 *
 *   popweb-fence hook                  Answer an agent's hook from stdin (Claude Code, Cursor, or a command line)
 *   popweb-fence debt                  List every disable directive with its reason, and count them
 *   popweb-fence debt --json           The same, as JSON
 *   popweb-fence debt --check          Fail when the count differs from the ledger, lint-debt.json
 *   popweb-fence debt --update         Write the ledger; refused when the count would rise
 *   popweb-fence debt --update --allow-increase
 *                                      Write it with a higher count: the owner's step
 *   --ledger <path>                    Another ledger file
 *
 * It imports only Node's built-ins, so it runs under Node and Bun alike.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { compareDebt, debtLedger, describeDirective, parseLedger, scanDebt, type DebtLedger, type DisableDirective } from './debt.js'
import { answerHook } from './hook.js'

/** The hook reads a script a command runs up to this size. */
const MAX_FILE_BYTES = 256 * 1024
const DEFAULT_LEDGER = 'lint-debt.json'

const [command, ...args] = process.argv.slice(2)

if (command === 'hook') {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))

  const answer = answerHook(Buffer.concat(chunks).toString('utf8'), { cwd: process.cwd(), readFile: readSmallFile })
  process.stdout.write(answer.stdout)
  process.stderr.write(answer.stderr)
  process.exitCode = answer.exitCode
} else if (command === 'debt') {
  process.exitCode = debt(args)
} else {
  console.error('Usage: popweb-fence hook | popweb-fence debt [--json | --check | --update [--allow-increase]] [--ledger <path>]')
  process.exitCode = command === undefined || command === '--help' || command === '-h' ? 0 : 1
}

function debt(args: ReadonlyArray<string>): number {
  const ledgerIndex = args.indexOf('--ledger')
  const ledgerPath = ledgerIndex === -1 ? DEFAULT_LEDGER : args[ledgerIndex + 1] ?? DEFAULT_LEDGER
  const ledger = readLedger(ledgerPath)
  // A deleted ledger keeps the count, and the files it ignores, committed before it.
  const baseline = ledger ?? committedLedger(ledgerPath)
  const directives = scanDebt(process.cwd(), baseline?.ignore ?? [])
  const total = `${count(directives.length)}, ${directives.filter((directive) => directive.reason === null).length} without a reason`

  if (args.includes('--check')) return check(directives, ledger, ledgerPath)
  if (args.includes('--update')) return update(directives, baseline, ledgerPath, args.includes('--allow-increase'))

  if (args.includes('--json')) {
    console.log(JSON.stringify({ count: directives.length, directives }, null, 2))
  } else {
    for (const directive of directives) console.log(describeDirective(directive))
    console.log(`${directives.length === 0 ? '' : '\n'}${total}.`)
  }
  return 0
}

function check(directives: ReadonlyArray<DisableDirective>, ledger: DebtLedger | undefined, ledgerPath: string): number {
  if (ledger === undefined) {
    console.error(`No ${ledgerPath}. Write it with \`popweb-fence debt --update\`, which records the ${count(directives.length)} the code holds, and commit it.`)
    return 1
  }

  const comparison = compareDebt(directives, ledger)

  if (comparison.count > comparison.baseline) {
    console.error(`Lint debt rose from ${comparison.baseline} to ${count(comparison.count)} (${ledgerPath}). New since the ledger:\n`)
    for (const directive of comparison.added) console.error(`  ${describeDirective(directive)}`)
    console.error(
      '\nFix the code each rule reports instead of turning the rule off. A directive the owner accepts goes in with' +
        ' `popweb-fence debt --update --allow-increase`, which the owner runs.'
    )
    return 1
  }
  if (comparison.added.length > 0 || comparison.removed.length > 0) {
    console.error(`${ledgerPath} is out of date: the code holds ${count(comparison.count)}, the ledger ${comparison.baseline}.\n`)
    for (const entry of comparison.removed) console.error(`  - ${entry.file}  ${entry.directive} ${entry.rules.join(', ')}`.trimEnd())
    for (const directive of comparison.added) console.error(`  + ${describeDirective(directive)}`)
    console.error(`\nRun \`popweb-fence debt --update\` and commit ${ledgerPath}, so the count stays at what the code holds.`)
    return 1
  }

  console.log(`Lint debt: ${count(comparison.count)}, as ${ledgerPath} records.`)
  return 0
}

function update(directives: ReadonlyArray<DisableDirective>, baseline: DebtLedger | undefined, ledgerPath: string, allowIncrease: boolean): number {
  if (baseline !== undefined && directives.length > baseline.directives.length && !allowIncrease) {
    const added = compareDebt(directives, baseline).added
    console.error(`Lint debt only shrinks: the code holds ${count(directives.length)}, the ledger ${baseline.directives.length}. New since the ledger:\n`)
    for (const directive of added) console.error(`  ${describeDirective(directive)}`)
    console.error('\nFix the code each rule reports instead. The owner accepts a new directive with `popweb-fence debt --update --allow-increase`.')
    return 1
  }

  writeFileSync(ledgerPath, `${JSON.stringify(debtLedger(directives, baseline?.ignore ?? []), null, 2)}\n`)
  const change = baseline === undefined || baseline.directives.length === directives.length ? '' : `, ${directives.length < baseline.directives.length ? 'down' : 'up'} from ${baseline.directives.length}`
  console.log(`Wrote ${ledgerPath}: ${count(directives.length)}${change}.`)
  return 0
}

function readLedger(path: string): DebtLedger | undefined {
  try {
    return parseLedger(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

function committedLedger(path: string): DebtLedger | undefined {
  const git = spawnSync('git', ['show', `HEAD:./${path}`], { encoding: 'utf8' })
  return git.status === 0 ? parseLedger(git.stdout) : undefined
}

function readSmallFile(path: string): string | undefined {
  try {
    if (!statSync(path).isFile() || statSync(path).size > MAX_FILE_BYTES) return undefined
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function count(n: number): string {
  return `${n} disable directive${n === 1 ? '' : 's'}`
}
