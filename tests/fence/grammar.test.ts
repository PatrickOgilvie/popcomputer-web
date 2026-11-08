/**
 * The bash grammar the fence ships is tree-sitter-bash's, the devDependency
 * it is copied from: the package depends on web-tree-sitter alone, so an
 * install compiles nothing. Upgrading tree-sitter-bash means copying its
 * `tree-sitter-bash.wasm` into src/fence/grammar/ and its version into the
 * LICENSE beside it.
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const grammar = join(import.meta.dir, '..', '..', 'src', 'fence', 'grammar')

test("the shipped grammar is tree-sitter-bash's, with its licence and version beside it", () => {
  const manifest = require('tree-sitter-bash/package.json') as { version: string }
  const upstream = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))

  expect(readFileSync(join(grammar, 'tree-sitter-bash.wasm')).equals(upstream)).toBe(true)
  expect(readFileSync(join(grammar, 'LICENSE'), 'utf8')).toContain(`tree-sitter-bash ${manifest.version}`)
})

test('the package depends on web-tree-sitter alone, which builds nothing on install', () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'package.json'), 'utf8')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> }

  expect(Object.keys(pkg.dependencies)).toEqual(['web-tree-sitter'])
  expect(pkg.devDependencies).toHaveProperty('tree-sitter-bash')
})
