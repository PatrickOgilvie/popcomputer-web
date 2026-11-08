/**
 * The bash grammar the fence reads command lines with: web-tree-sitter's
 * runtime and tree-sitter-bash's grammar, both WebAssembly, so reading a
 * line as bash does needs no native build. Both load once, when the fence
 * loads, with top-level await, so `commandPolicy` stays synchronous.
 */
import { readFileSync } from 'node:fs'
import { setFlagsFromString } from 'node:v8'
import { Language, Parser, type Tree } from 'web-tree-sitter'

// Node compiles a hot WebAssembly function again in the background and waits
// for that compile when the process exits, some 300 ms of every hook's run.
// Its baseline compiler reads a command line fast enough, so the grammar
// compiles with that alone, and the flag goes back for what loads after it.
// Bun takes the flags and does nothing with them.
setFlagsFromString('--liftoff-only')
const parser = await (async () => {
  try {
    await Parser.init()
    const created = new Parser()
    created.setLanguage(await Language.load(readFileSync(new URL('./grammar/tree-sitter-bash.wasm', import.meta.url))))
    return created
  } finally {
    setFlagsFromString('--no-liftoff-only')
  }
})()

/** The syntax tree of a command line; the caller deletes it. */
export function parseBash(text: string): Tree {
  const tree = parser.parse(text)
  if (tree === null) throw new Error('tree-sitter returned no tree')
  return tree
}
