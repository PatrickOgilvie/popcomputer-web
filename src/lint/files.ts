/**
 * What a file is in an application, as its path tells: a test, a tool's
 * configuration, a script, or a page that runs in the browser. Paths are read
 * from the directory the linter runs in, the application's.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { RuleContext } from './ast.js'

/** A file's path from the directory the linter runs in, with `/` between its parts; absolute when outside it. */
export function projectPath(context: RuleContext): string {
  const path = relative(context.cwd, context.filename)
  const inside = path !== '' && !path.startsWith('..') && !isAbsolute(path)

  return (inside ? path : context.filename).split(sep).join('/')
}

const TEST_DIRECTORIES = new Set(['test', 'tests', '__tests__'])

/** `routes.test.ts`, `routes.spec.tsx`, or a test helper named `test-db.ts`. */
const TEST_NAME = /\.(test|spec)\.[cm]?[jt]sx?$|^test[-.]/

/** Whether a path names a test: by its name, or a folder of tests it sits in. */
export function isTestPath(path: string): boolean {
  const parts = path.split('/')

  return TEST_NAME.test(parts.at(-1) ?? '') || parts.slice(0, -1).some((part) => TEST_DIRECTORIES.has(part))
}

/** Whether the file is a test's: by its path, or as the file `bunfig.toml` preloads for `bun test`. */
export const isTestFile = (context: RuleContext, path: string): boolean => isTestPath(path) || isTestPreload(context)

/** Whether a path names a tool's configuration, `vite.config.ts`, a script beside the application, or declarations. */
export function isToolingPath(path: string): boolean {
  const parts = path.split('/')
  const name = parts.at(-1) ?? ''

  return /\.config\.[cm]?[jt]sx?$/.test(name) || /\.d\.[cm]?ts$/.test(name) || parts.slice(0, -1).includes('scripts')
}

/** Whether a path is a page's or its components', under `src/pages/`. */
export const isPagePath = (path: string): boolean => /(^|\/)src\/pages\//.test(path)

/**
 * Whether the file is one `bunfig.toml`'s `[test] preload` names, which runs
 * before the tests alone: the nearest `bunfig.toml` from the file's folder up
 * to the linter's decides.
 */
export function isTestPreload(context: RuleContext): boolean {
  let directory = dirname(context.filename)

  for (;;) {
    const bunfig = join(directory, 'bunfig.toml')

    if (existsSync(bunfig)) {
      return testPreloads(readFileSync(bunfig, 'utf8')).some((entry) => resolve(directory, entry) === resolve(context.filename))
    }

    const parent = dirname(directory)

    if (resolve(directory) === resolve(context.cwd) || parent === directory) return false
    directory = parent
  }
}

/** The files a `bunfig.toml` preloads for `bun test`: `[test]`'s `preload`, or `test.preload`. */
function testPreloads(toml: string): ReadonlyArray<string> {
  const table = /^\[test\][^\n]*\n([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(toml)?.[1] ?? ''
  const value = /^\s*preload\s*=\s*(\[[^\]]*\]|"[^"]*"|'[^']*')/m.exec(table)?.[1]
    ?? /^\s*test\.preload\s*=\s*(\[[^\]]*\]|"[^"]*"|'[^']*')/m.exec(toml)?.[1]

  return value === undefined ? [] : [...value.matchAll(/"([^"]*)"|'([^']*)'/g)].map((match) => match[1] ?? match[2] ?? '')
}
