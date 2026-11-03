#!/usr/bin/env bun
/**
 * `popweb-mutate`: mutation testing for the lines a change touches.
 *
 * AGENTS.md rule 12 says a new test must fail when the behaviour it covers is
 * reverted. This checks it mechanically: it plants one small bug (a mutant) at
 * a time in src/ files, runs the test files whose coverage reaches the
 * mutant's line, and reports every mutant the tests let through. Besides
 * small syntax bugs, such as a flipped comparison or a dropped guard, it
 * makes each function that returns an Effect recover from each tagged error
 * its type declares, which survives when no test makes it fail that way.
 *
 * Run from the repository's root, whose src/ holds the application:
 *
 *   bunx popweb-mutate [files...] [--base <ref>] [--fail-under <percent>]
 *                      [--workers <n>] [--timeout <seconds>]
 *
 * It runs under Bun, as `bun test` does, and reads the code with the
 * repository's own TypeScript 7.
 *
 * With no files it mutates the src/ lines changed since --base (HEAD by
 * default), committed or not; with files, every line of them. Each test file
 * that imports a mutated file runs once alone with coverage, and each mutant
 * then runs against those that reach its line, in copies of the working tree,
 * so the checkout itself is never edited. Exits non-zero only when the score
 * is below --fail-under.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  isArrowFunction,
  isBinaryExpression,
  isBlock,
  isBreakStatement,
  isCallExpression,
  isContinueStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isIfStatement,
  isInterfaceDeclaration,
  isMethodDeclaration,
  isParenthesizedExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isReturnStatement,
  isTemplateExpression,
  isThrowStatement,
  isTypeAliasDeclaration,
  isTypeNode,
  type Node,
  type SourceFile,
  type Statement,
  SyntaxKind,
} from 'typescript/unstable/ast'
// The repo's typescript is tsgo, whose compiler runs in Go; this API asks it
// for the syntax tree, and its checker for the errors an Effect declares.
import { API, type Checker } from 'typescript/unstable/async'

export type Operator =
  | 'negate-eq'
  | 'boundary'
  | 'logic'
  | 'drop-not'
  | 'bool'
  | 'skip-guard'
  | 'some-every'
  | 'swallow-tag'

/** One planted bug: the text from `start` to `end` replaced. */
export interface Mutant {
  /** Its file, relative to the repository. */
  readonly file: string
  readonly line: number
  readonly lastLine: number
  readonly start: number
  readonly end: number
  readonly original: string
  readonly replacement: string
  readonly operator: Operator
  /** Its line of source, trimmed. */
  readonly source: string
  /** What it does, where the text it replaces is too long to show. */
  readonly description?: string
}

export type Status = 'killed' | 'survived' | 'timed out'

export interface Result extends Mutant {
  readonly status: Status
  /** The test files it ran against; 0 when no test reaches its line. */
  readonly tests: number
}

export interface Run {
  readonly results: readonly Result[]
  /** Test files whose coverage reaches a mutated file. */
  readonly testFiles: number
  /** Test files left out because they fail with no mutant planted. */
  readonly failing: readonly string[]
}

export interface Options {
  /** The repository's top directory. */
  readonly root: string
  /** src/ files to mutate whole; with `base`, only their changed lines. */
  readonly files?: readonly string[]
  /** Mutate the src/ lines changed since this ref; HEAD when no files are given. */
  readonly base?: string
  readonly workers?: number
  /** Milliseconds a mutant's tests may take; by default twice their unmutated time, plus 10 seconds. */
  readonly timeout?: number
  readonly log?: (line: string) => void
}

const SWAPS = new Map<SyntaxKind, readonly [string, Operator]>([
  [SyntaxKind.EqualsEqualsEqualsToken, ['!==', 'negate-eq']],
  [SyntaxKind.ExclamationEqualsEqualsToken, ['===', 'negate-eq']],
  [SyntaxKind.LessThanToken, ['<=', 'boundary']],
  [SyntaxKind.LessThanEqualsToken, ['<', 'boundary']],
  [SyntaxKind.GreaterThanToken, ['>=', 'boundary']],
  [SyntaxKind.GreaterThanEqualsToken, ['>', 'boundary']],
  [SyntaxKind.AmpersandAmpersandToken, ['||', 'logic']],
  [SyntaxKind.BarBarToken, ['&&', 'logic']],
])

/** Whether a statement always leaves its block: a guard's branch. */
function exits(statement: Statement): boolean {
  if (isBlock(statement)) {
    const last = statement.statements[statement.statements.length - 1]
    return last !== undefined && exits(last)
  }

  return isReturnStatement(statement) || isThrowStatement(statement) || isContinueStatement(statement) ||
    isBreakStatement(statement)
}

/** Where each line of a text starts, and the line a position is on. */
function lineIndex(text: string) {
  const lineStarts = [0]
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) lineStarts.push(index + 1)

  const lineOf = (position: number) => {
    let low = 0
    let high = lineStarts.length - 1
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (lineStarts[middle] <= position) low = middle
      else high = middle - 1
    }
    return low + 1
  }

  return { lineStarts, lineOf }
}

/** Every mutant of one parsed file. */
export function mutantsOf(file: string, sourceFile: SourceFile): Mutant[] {
  const text = sourceFile.text
  const { lineStarts, lineOf } = lineIndex(text)

  const mutants: Mutant[] = []
  const add = (start: number, end: number, replacement: string, operator: Operator) => {
    const line = lineOf(start)
    const source = text.slice(lineStarts[line - 1], lineStarts[line] ?? text.length).trim()
    mutants.push({ file, line, lastLine: lineOf(end), start, end, original: text.slice(start, end), replacement, operator, source })
  }

  const visit = (node: Node): void => {
    // Messages and types are not behaviour a test pins down.
    if (
      isThrowStatement(node) || isTemplateExpression(node) || isTypeNode(node) || isInterfaceDeclaration(node) ||
      isTypeAliasDeclaration(node)
    ) return

    if (isBinaryExpression(node)) {
      const swap = SWAPS.get(node.operatorToken.kind)
      if (swap !== undefined) add(node.operatorToken.getStart(sourceFile), node.operatorToken.end, ...swap)
    }

    if (isPrefixUnaryExpression(node) && node.operator === SyntaxKind.ExclamationToken) {
      const start = node.getStart(sourceFile)
      add(start, node.end, text.slice(start + 1, node.end), 'drop-not')
    }

    if (node.kind === SyntaxKind.TrueKeyword) add(node.getStart(sourceFile), node.end, 'false', 'bool')
    if (node.kind === SyntaxKind.FalseKeyword) add(node.getStart(sourceFile), node.end, 'true', 'bool')

    if (isIfStatement(node) && exits(node.thenStatement)) {
      add(node.expression.getStart(sourceFile), node.expression.end, 'false', 'skip-guard')
    }

    if (isCallExpression(node) && isPropertyAccessExpression(node.expression) && isIdentifier(node.expression.name)) {
      const name = node.expression.name
      const swap = name.text === 'some' ? 'every' : name.text === 'every' ? 'some' : undefined
      if (swap !== undefined) add(name.getStart(sourceFile), name.end, swap, 'some-every')
    }

    node.forEachChild((child) => {
      visit(child)
    })
  }

  visit(sourceFile)

  return mutants
}

/** A function with a body of its own. */
const isFunction = (node: Node): node is Node & { readonly body: Node } =>
  (isArrowFunction(node) || isFunctionDeclaration(node) || isFunctionExpression(node) || isMethodDeclaration(node)) &&
  node.body !== undefined

/** Whether a file imports Effect as a value, which the error-channel mutants call. */
const importsEffect = (text: string) => /import\s*\{[^}]*(?<!type\s)\bEffect\b[^}]*\}\s*from\s*'effect'/.test(text)

/**
 * The `_tag` of each error in the `E` of the `Effect<A, E, R>` a function
 * declares it returns, but a dependency's: an error a package declares, such
 * as the framework's `DatabaseError` in an application's action, is one the
 * package answers, often for a failure no test of the application makes.
 */
async function failureTags(checker: Checker, declaration: Node): Promise<string[]> {
  const signature = await checker.getSignatureFromDeclaration(declaration)
  const returned = signature === undefined ? undefined : await checker.getReturnTypeOfSignature(signature)
  if (returned === undefined || !returned.isTypeReference() || (await returned.getSymbol())?.name !== 'Effect') return []

  const failure = (await checker.getTypeArguments(returned))[1]
  if (failure === undefined) return []

  const tags: string[] = []
  for (const member of failure.isUnionType() ? await failure.getTypes() : [failure]) {
    const declarations = (await member.getSymbol())?.declarations ?? []
    if (declarations.some((declaration) => declaration.path.includes('/node_modules/'))) continue

    const tag = await checker.getPropertyOfType(member, '_tag')
    const type = tag === undefined ? undefined : await checker.getTypeOfSymbol(tag)
    if (type?.isStringLiteralType()) tags.push(type.value)
  }

  return tags
}

/**
 * The function a callback's Effect is returned from through calls alone, as
 * `(item) => take(item).pipe(Effect.flatMap(() => take(item)))` returns its
 * callback's: its own failures flow out through that function's.
 */
function carrierOf(callback: Node): Node | undefined {
  let node = callback
  for (let parent = node.parent; parent !== undefined; node = parent, parent = parent.parent) {
    if (isFunction(parent)) return parent.body === node ? parent : undefined
    if (
      !isCallExpression(parent) && !isPropertyAccessExpression(parent) && !isParenthesizedExpression(parent) &&
      !isReturnStatement(parent) && !isBlock(parent)
    ) return undefined
  }
  return undefined
}

/**
 * The error-channel mutants of one file: for each function that returns an
 * Effect, and each tagged error it declares, the function recovers from that
 * error and succeeds. It survives when no test makes the function fail with
 * it. A callback whose failures flow out through the function it is returned
 * from, with errors that function declares, gets none of its own. Turning the
 * error into a defect is no mutant here: the error boundary answers a defect
 * that is a tagged error as it answers the failure.
 */
export async function effectMutantsOf(file: string, sourceFile: SourceFile, checker: Checker): Promise<Mutant[]> {
  const text = sourceFile.text
  if (!importsEffect(text)) return []

  const { lineStarts, lineOf } = lineIndex(text)
  const tagsOf = new Map<Node, readonly string[]>()
  const visit = async (node: Node): Promise<void> => {
    if (isFunction(node)) {
      const tags = await failureTags(checker, node)
      if (tags.length > 0) tagsOf.set(node, tags)
    }
    const children: Node[] = []
    node.forEachChild((child) => {
      children.push(child)
    })
    for (const child of children) await visit(child)
  }
  await visit(sourceFile)

  const mutants: Mutant[] = []
  for (const [declaration, tags] of tagsOf) {
    const carrier = carrierOf(declaration)
    const carried = carrier === undefined ? undefined : tagsOf.get(carrier)
    if (carried !== undefined && tags.every((tag) => carried.includes(tag))) continue

    // SAFETY: tagsOf holds only the functions isFunction kept, each with a body.
    const body = (declaration as Node & { readonly body: Node }).body
    const start = body.getStart(sourceFile)
    const original = text.slice(start, body.end)
    const line = lineOf(declaration.getStart(sourceFile))
    const source = text.slice(lineStarts[line - 1], lineStarts[line] ?? text.length).trim()

    for (const tag of tags) {
      const recover = `Effect.catchTag(${JSON.stringify(tag)}, () => Effect.succeed(undefined))`
      mutants.push({
        file,
        line,
        lastLine: lineOf(body.end),
        start,
        end: body.end,
        original,
        // A block runs in an arrow, which keeps its `this` and `arguments`.
        replacement: isBlock(body) ? `{ return (() => ${original})().pipe(${recover}) }` : `(${original}).pipe(${recover})`,
        operator: 'swallow-tag',
        source,
        description: `${tag} recovered as success`,
      })
    }
  }

  return mutants
}

/** The mutants of the given files, parsed by the TypeScript the repository compiles with. */
export async function findMutants(root: string, files: readonly string[]): Promise<Mutant[]> {
  if (files.length === 0) return []

  const api = new API({ cwd: root })

  try {
    const paths = files.map((file) => join(root, file))
    const snapshot = await api.updateSnapshot({ openFiles: paths })
    const mutants: Mutant[] = []

    for (const [index, file] of files.entries()) {
      const project = await snapshot.getDefaultProjectForFile(paths[index])
      const sourceFile = await project?.program.getSourceFile(paths[index])
      if (sourceFile === undefined) throw new Error(`TypeScript could not parse ${file}.`)
      mutants.push(...mutantsOf(file, sourceFile))
      if (project !== undefined) mutants.push(...(await effectMutantsOf(file, sourceFile, project.checker)))
    }

    return mutants
  } finally {
    await api.close()
  }
}

/** The lines each file gained or changed, from a unified diff without context. */
export function changedLines(diff: string): Map<string, Set<number>> {
  const changed = new Map<string, Set<number>>()
  let lines: Set<number> | undefined

  let previous = ''

  for (const line of diff.split('\n')) {
    // A file's header, not an added line that starts with '++ '.
    if (line.startsWith('+++ ') && previous.startsWith('--- ')) {
      const path = line.slice(4)
      lines = undefined
      if (path.startsWith('b/')) changed.set(path.slice(2), (lines = new Set()))
    } else if (line.startsWith('@@ ') && lines !== undefined) {
      const [, start, count = '1'] = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line) ?? []
      for (let n = Number(start); n < Number(start) + Number(count); n++) lines.add(n)
    }
    previous = line
  }

  return changed
}

const isSource = (file: string) => file.startsWith('src/') && /\.tsx?$/.test(file) && !file.endsWith('.d.ts')
const isTest = (file: string) => /\.test\.tsx?$/.test(file) && !/(^|\/)(node_modules|dist)\//.test(file)

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const values = map.get(key)
  if (values === undefined) map.set(key, [value])
  else values.push(value)
}

function git(root: string, args: readonly string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`)
  return result.stdout
}

/** The loader Bun reads a module with, from its extension. */
function loaderOf(file: string): 'ts' | 'tsx' | 'js' | 'jsx' | undefined {
  const extension = /\.[cm]?([jt]sx?)$/.exec(file)?.[1]
  return extension === 'ts' || extension === 'tsx' || extension === 'js' || extension === 'jsx' ? extension : undefined
}

/** Every repository file a module loads, itself included, followed through its imports. */
function importClosure(root: string, file: string, memo: Map<string, readonly string[]>): Set<string> {
  const closure = new Set<string>()
  const pending = [file]

  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (closure.has(next)) continue
    closure.add(next)

    let imports = memo.get(next)
    if (imports === undefined) {
      const loader = loaderOf(next)
      const found: string[] = []
      if (loader !== undefined) {
        let scanned: ReturnType<Bun.Transpiler['scanImports']> = []
        try {
          scanned = new Bun.Transpiler({ loader }).scanImports(readFileSync(join(root, next), 'utf8'))
        } catch {
          // Not a module Bun can read, so not one a test loads.
        }
        for (const { path } of scanned) {
          try {
            const resolved = Bun.resolveSync(path, dirname(join(root, next)))
            if (isAbsolute(resolved) && resolved.startsWith(`${root}/`) && !resolved.includes('/node_modules/')) {
              found.push(relative(root, resolved))
            }
          } catch {
            // A built-in module, or one that is not there.
          }
        }
      }
      memo.set(next, (imports = found))
    }
    pending.push(...imports)
  }

  return closure
}

/** A copy of the working tree's files, sharing node_modules and dist. */
function copyTree(root: string, files: readonly string[], target: string) {
  for (const directory of new Set(files.map(dirname))) mkdirSync(join(target, directory), { recursive: true })
  for (const file of files) copyFileSync(join(root, file), join(target, file), constants.COPYFILE_FICLONE)
  for (const shared of ['node_modules', 'dist']) {
    if (existsSync(join(root, shared))) symlinkSync(join(root, shared), join(target, shared))
  }
}

const BASELINE_TIMEOUT = 10 * 60 * 1000

/** Plant each mutant in turn and run the tests that reach it. */
export async function mutate(options: Options): Promise<Run> {
  const { root, base, log = () => undefined } = options
  const files = options.files ?? []

  // Which lines to mutate: every line of the named files, or the changed ones.
  let targets: Map<string, Set<number> | undefined>
  if (files.length > 0 && base === undefined) {
    targets = new Map(files.map((file) => [file, undefined]))
  } else {
    const diff = git(root, ['diff', '--unified=0', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', base ?? 'HEAD', '--', 'src'])
    targets = new Map(changedLines(diff))
    for (const file of git(root, ['ls-files', '--others', '--exclude-standard', '--', 'src']).split('\n')) {
      if (file !== '') targets.set(file, undefined)
    }
    for (const file of targets.keys()) {
      if (!isSource(file) || !existsSync(join(root, file)) || (files.length > 0 && !files.includes(file))) targets.delete(file)
    }
  }

  const mutants = (await findMutants(root, [...targets.keys()])).filter((mutant) => {
    const lines = targets.get(mutant.file)
    if (lines === undefined) return true
    for (let line = mutant.line; line <= mutant.lastLine; line++) if (lines.has(line)) return true
    return false
  })
  if (mutants.length === 0) return { results: [], testFiles: 0, failing: [] }

  const listed = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    .split('\0')
    .filter((file) => file !== '' && existsSync(join(root, file)))

  // Only a test file that imports a mutated file can reach it.
  const mutated = new Set(mutants.map((mutant) => mutant.file))
  const memo = new Map<string, readonly string[]>()
  const candidates = listed.filter((file) => {
    if (!isTest(file)) return false
    const closure = importClosure(root, file, memo)
    return [...mutated].some((each) => closure.has(each))
  })

  const workers = Math.max(1, Math.min(options.workers ?? availableParallelism() - 1, Math.max(candidates.length, mutants.length)))
  const workspace = mkdtempSync(join(realpathSync(tmpdir()), 'popweb-mutate-'))
  const copies = Array.from({ length: workers }, (_, index) => join(workspace, `w${index}`))
  const children = new Set<ChildProcess>()

  const kill = (child: ChildProcess) => {
    if (child.pid === undefined) return
    try {
      // The test run's whole process group, with any server it started.
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      // It has already exited.
    }
  }

  const run = (cwd: string, args: readonly string[], timeout: number) =>
    new Promise<{ code: number | null; timedOut: boolean }>((resolve) => {
      const child = spawn(process.execPath, args, { cwd, detached: true, stdio: 'ignore' })
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        kill(child)
      }, timeout)
      children.add(child)
      child.on('exit', (code) => {
        clearTimeout(timer)
        kill(child)
        children.delete(child)
        resolve({ code, timedOut })
      })
    })

  const interrupt = () => {
    for (const child of children) kill(child)
    rmSync(workspace, { recursive: true, force: true })
    process.exit(130)
  }
  process.once('SIGINT', interrupt)

  /** Run jobs across the copies, one at a time in each. */
  const pool = async <T>(jobs: readonly T[], work: (job: T, copy: string, index: number) => Promise<void>) => {
    let next = 0
    await Promise.all(copies.map(async (copy, index) => {
      for (let job = jobs[next++]; job !== undefined; job = jobs[next++]) await work(job, copy, index)
    }))
  }

  try {
    for (const copy of copies) copyTree(root, listed, copy)

    // Coverage: each test file alone, the largest first so the slowest is not
    // left until last.
    log(`coverage: ${candidates.length} test files import a mutated file`)
    const coverage = new Map<string, { readonly passed: boolean; readonly ms: number; readonly hits: Map<string, number[]> }>()
    // The lines Bun counts in each mutated file, reached or not.
    const counted = new Map([...mutated].map((file) => [file, new Set<number>()]))
    const sizeOf = (test: string) => readFileSync(join(root, test)).length
    await pool([...candidates].sort((a, b) => sizeOf(b) - sizeOf(a)), async (test, copy, index) => {
      const directory = join(workspace, `coverage-${index}`)
      rmSync(directory, { recursive: true, force: true })
      const started = performance.now()
      const { code } = await run(copy, ['test', '--coverage', '--coverage-reporter=lcov', `--coverage-dir=${directory}`, `./${test}`], BASELINE_TIMEOUT)
      const ms = Math.round(performance.now() - started)

      let lcov = ''
      try {
        lcov = readFileSync(join(directory, 'lcov.info'), 'utf8')
      } catch {
        // No coverage: the run failed before writing it.
      }

      const hits = new Map<string, number[]>()
      let file = ''
      // The lines Bun counts in the file, when it is a mutated one.
      let lines: Set<number> | undefined
      for (const line of lcov.split('\n')) {
        if (line.startsWith('SF:')) {
          const path = line.slice(3)
          file = isAbsolute(path) ? relative(copy, path) : path
          lines = counted.get(file)
        } else if (line.startsWith('DA:') && lines !== undefined) {
          const [n, count] = line.slice(3).split(',').map(Number)
          lines.add(n)
          if (count > 0) push(hits, file, n)
        }
      }

      coverage.set(test, { passed: code === 0, ms, hits })
    })

    const passing = [...coverage].filter(([, entry]) => entry.passed)
    const failing = [...coverage].filter(([, entry]) => !entry.passed).map(([test]) => test).sort()
    const msOf = new Map(passing.map(([test, entry]) => [test, entry.ms]))

    // The passing test files that reach each line of each mutated file.
    const reaching = new Map([...mutated].map((file) => [file, new Map<number, string[]>()]))
    for (const [test, entry] of passing) {
      for (const [file, byLine] of reaching) for (const line of entry.hits.get(file) ?? []) push(byLine, line, test)
    }

    /** The passing test files that reach a mutant's lines, fastest first. */
    const testsFor = (mutant: Mutant): string[] => {
      const byLine = reaching.get(mutant.file) ?? new Map<number, string[]>()
      const lines = counted.get(mutant.file) ?? new Set<number>()
      const found = new Set<string>()
      const take = (line: number) => {
        for (const test of byLine.get(line) ?? []) found.add(test)
      }
      const fastestFirst = () => [...found].sort((a, b) => (msOf.get(a) ?? 0) - (msOf.get(b) ?? 0))

      let anyCounted = false
      for (let line = mutant.line; line <= mutant.lastLine; line++) {
        take(line)
        anyCounted ||= lines.has(line)
      }
      // When Bun counts the line, the tests that reach it are all that can
      // catch the mutant, and there may be none.
      if (found.size > 0 || anyCounted) return fastestFirst()

      // Bun does not count every line, such as the middle of a statement over
      // several: take the nearest line above that it counts.
      for (let line = mutant.line - 1; line >= Math.max(1, mutant.line - 4); line--) {
        take(line)
        if (found.size > 0 || lines.has(line)) return fastestFirst()
      }

      // Nothing near it is counted: every test that reaches the file.
      for (const tests of byLine.values()) for (const test of tests) found.add(test)
      return fastestFirst()
    }

    // Mutants: the costliest first, so the slowest is not left until last.
    const jobs = mutants
      .map((mutant, index) => {
        const tests = testsFor(mutant)
        return { mutant, index, tests, cost: tests.reduce((sum, test) => sum + (msOf.get(test) ?? 0), 0) }
      })
      .sort((a, b) => b.cost - a.cost)
    log(`mutants: ${mutants.length} against ${passing.length} test files`)

    // In the order the mutants were found.
    const results: Result[] = []
    const sources = Object.fromEntries([...mutated].map((file) => [file, readFileSync(join(root, file), 'utf8')]))
    await pool(jobs, async ({ mutant, index, tests, cost }, copy) => {
      if (tests.length === 0) {
        results[index] = { ...mutant, status: 'survived', tests: 0 }
        return
      }

      const original = sources[mutant.file]
      const path = join(copy, mutant.file)
      writeFileSync(path, original.slice(0, mutant.start) + mutant.replacement + original.slice(mutant.end))
      try {
        const { code, timedOut } = await run(copy, ['test', '--bail', ...tests.map((test) => `./${test}`)], options.timeout ?? 10_000 + 2 * cost)
        results[index] = { ...mutant, status: timedOut ? 'timed out' : code === 0 ? 'survived' : 'killed', tests: tests.length }
      } finally {
        writeFileSync(path, original)
      }
    })

    return { results, testFiles: candidates.length, failing }
  } finally {
    process.off('SIGINT', interrupt)
    rmSync(workspace, { recursive: true, force: true })
  }
}

/** Caught mutants, killed or timed out, as a share of all of them. */
export function score(results: readonly Result[]): number {
  return results.length === 0 ? 100 : (100 * results.filter((result) => result.status !== 'survived').length) / results.length
}

const shorten = (text: string, length = 60) => {
  const flat = text.replace(/\s+/g, ' ')
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat
}

const edit = (mutant: Mutant) => mutant.description ?? `${shorten(mutant.original)} → ${shorten(mutant.replacement)}`

function table(results: readonly Result[], key: (result: Result) => string): string[] {
  const groups = new Map<string, Result[]>()
  for (const result of [...results].sort((a, b) => key(a).localeCompare(key(b)))) push(groups, key(result), result)
  const width = Math.max(...[...groups.keys()].map((name) => name.length))
  return [...groups].map(([name, group]) => {
    const caught = group.filter((result) => result.status !== 'survived').length
    return `  ${name.padEnd(width)}  ${`${Math.floor(score(group))}%`.padStart(4)}  ${caught}/${group.length}`
  })
}

/** The run as a person reads it: the score, by file and by operator, then each survivor. */
export function formatReport(run: Run): string {
  const { results } = run
  if (results.length === 0) return 'No mutants: no src/ lines to mutate.'

  const count = (status: Status) => results.filter((result) => result.status === status).length
  const survivors = results.filter((result) => result.status === 'survived')
  const timedOut = results.filter((result) => result.status === 'timed out')
  const files = [...new Set(results.map((result) => result.file))]

  const lines = [
    `${results.length} mutants in ${files.length === 1 ? files[0] : `${files.length} files`}, against the ${run.testFiles} test files that load ${files.length === 1 ? 'it' : 'them'}`,
    '',
    `score ${Math.floor(score(results))}%: ${count('killed')} killed, ${count('timed out')} timed out, ${count('survived')} survived`,
    '',
    'by file',
    ...table(results, (result) => result.file),
    '',
    'by operator',
    ...table(results, (result) => result.operator),
  ]

  if (survivors.length > 0) {
    lines.push('', 'survived: no test fails when this line changes')
    for (const survivor of survivors) {
      const unreached = survivor.tests === 0 ? '  (no test reaches this line)' : ''
      lines.push(`  ${survivor.file}:${survivor.line}  ${survivor.operator}  ${edit(survivor)}${unreached}`, `      ${shorten(survivor.source, 110)}`)
    }
  }

  if (timedOut.length > 0) {
    lines.push('', 'timed out, counted as caught: check none is a slow test rather than a hang')
    for (const result of timedOut) lines.push(`  ${result.file}:${result.line}  ${result.operator}  ${edit(result)}`)
  }

  if (run.failing.length > 0) {
    lines.push('', `left out, failing with no mutant planted: ${run.failing.join(', ')}`)
  }

  return lines.join('\n')
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      base: { type: 'string' },
      'fail-under': { type: 'string' },
      workers: { type: 'string' },
      timeout: { type: 'string' },
    },
  })

  const number = (name: string, value: string | undefined) => {
    if (value === undefined) return undefined
    const parsed = Number(value)
    if (!(parsed > 0)) {
      console.error(`--${name} takes a positive number, not ${value}.`)
      process.exit(2)
    }
    return parsed
  }

  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim()
  const files = positionals.map((file) => relative(root, resolve(file)))
  for (const file of files) {
    if (!isSource(file) || !existsSync(join(root, file))) {
      console.error(`${file} is not a TypeScript file in src/.`)
      process.exit(2)
    }
  }

  const failUnder = number('fail-under', values['fail-under'])
  const timeout = number('timeout', values.timeout)
  const run = await mutate({
    root,
    files,
    base: values.base,
    workers: number('workers', values.workers),
    timeout: timeout === undefined ? undefined : timeout * 1000,
    log: (line) => console.error(line),
  })

  console.log(formatReport(run))
  if (failUnder !== undefined && score(run.results) < failUnder) process.exitCode = 1
}
