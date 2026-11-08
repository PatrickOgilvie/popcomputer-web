/**
 * The bash grammar the fence ships is tree-sitter-bash's, the devDependency
 * it is copied from: tree-sitter-bash compiles on install, and no dependency
 * of the package does. Upgrading tree-sitter-bash means copying its
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

test('no dependency of the package runs a script on install, and tree-sitter-bash is only a devDependency', () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'package.json'), 'utf8')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> }
  const installScripts = (name: string) => {
    const { scripts = {} } = require(`${name}/package.json`) as { scripts?: Record<string, string> }

    return ['preinstall', 'install', 'postinstall'].filter((script) => Object.hasOwn(scripts, script))
  }

  expect(Object.keys(pkg.dependencies).sort()).toEqual(['oxc-parser', 'web-tree-sitter'])
  expect(Object.keys(pkg.dependencies).flatMap(installScripts)).toEqual([])
  expect(installScripts('tree-sitter-bash')).not.toEqual([])
  expect(pkg.devDependencies).toHaveProperty('tree-sitter-bash')
})
