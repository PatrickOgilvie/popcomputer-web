#!/usr/bin/env node
/**
 * `popweb-fence`: the agent fence's commands, run from an application's root.
 *
 *   popweb-fence hook                  Answer an agent's hook from stdin (Claude Code, Cursor, or a command line)
 *   popweb-fence debt                  List every disable directive with its reason, and count them
 *   popweb-fence debt --json           The same, as JSON
 *   popweb-fence debt --check          Fail when the commit about to be made differs from its ledger, lint-debt.json,
 *                                      or its ledger counts or ignores more than HEAD's
 *   popweb-fence debt --update         Write the ledger; refused when the count would rise
 *   popweb-fence debt --update --allow-increase
 *                                      Write it with a higher count: the owner's step
 *   --ledger <path>                    Another ledger file
 *
 * It runs under Node and Bun alike: the hook reads a command with tree-sitter's
 * bash grammar, in WebAssembly, and the debt report loads Oxc's parser when it
 * reads source.
 */
import { readFileSync, statSync } from 'node:fs'
import { debtCommand } from './debt.js'
import { answerHook } from './hook.js'

/** The hook reads a script a command runs up to this size. */
const MAX_FILE_BYTES = 256 * 1024

const [command, ...args] = process.argv.slice(2)

if (command === 'hook') {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))

  const answer = answerHook(Buffer.concat(chunks).toString('utf8'), { cwd: process.cwd(), readFile: readSmallFile })
  process.stdout.write(answer.stdout)
  process.stderr.write(answer.stderr)
  process.exitCode = answer.exitCode
} else if (command === 'debt') {
  const answer = debtCommand(args)
  process.stdout.write(answer.stdout)
  process.stderr.write(answer.stderr)
  process.exitCode = answer.exitCode
} else {
  console.error('Usage: popweb-fence hook | popweb-fence debt [--json | --check | --update [--allow-increase]] [--ledger <path>]')
  process.exitCode = command === undefined || command === '--help' || command === '-h' ? 0 : 1
}

function readSmallFile(path: string): string | undefined {
  try {
    if (!statSync(path).isFile() || statSync(path).size > MAX_FILE_BYTES) return undefined
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}
