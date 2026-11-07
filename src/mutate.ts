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
 * then runs against those that reach its line, in copies of a snapshot of the
 * working tree, each put back before every test run, so the checkout itself
 * is never edited and no run reads what another left. A mutant whose tests
 * fail is killed only when the files that failed pass without it. Exits
 * non-zero only when the score is below --fail-under.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { availableParallelism, constants as system, tmpdir, totalmem } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { Data, Effect } from 'effect'
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

/**
 * What a mutant's tests said of it: `crashed` when they gave no answer, as
 * when a signal not its timeout ended them, or the files that failed fail
 * with no mutant planted too. A crash is not counted as caught.
 */
export type Status = 'killed' | 'survived' | 'timed out' | 'crashed'

export interface Result extends Mutant {
  readonly status: Status
  /** The test files it ran against; 0 when no test reaches its line. */
  readonly tests: number
  /** Why a crashed mutant's tests gave no answer. */
  readonly crash?: string
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
  return (await readMutants(root, files)).mutants
}

/** The mutants of the given files, and the text of each that their offsets index. */
async function readMutants(root: string, files: readonly string[]): Promise<{ readonly mutants: Mutant[]; readonly sources: Map<string, string> }> {
  const mutants: Mutant[] = []
  const sources = new Map<string, string>()
  if (files.length === 0) return { mutants, sources }

  const api = new API({ cwd: root })

  try {
    const paths = files.map((file) => join(root, file))
    const snapshot = await api.updateSnapshot({ openFiles: paths })

    for (const [index, file] of files.entries()) {
      const project = await snapshot.getDefaultProjectForFile(paths[index])
      const sourceFile = await project?.program.getSourceFile(paths[index])
      if (sourceFile === undefined) throw new Error(`TypeScript could not parse ${file}.`)
      sources.set(file, sourceFile.text)
      mutants.push(...mutantsOf(file, sourceFile))
      if (project !== undefined) mutants.push(...(await effectMutantsOf(file, sourceFile, project.checker)))
    }

    return { mutants, sources }
  } finally {
    await api.close()
  }
}

/** The bytes git writes as `\` and a letter in a quoted path. */
const ESCAPES = new Map([['a', 7], ['b', 8], ['t', 9], ['n', 10], ['v', 11], ['f', 12], ['r', 13], ['"', 34], ['\\', 92]])

/**
 * A path as a diff's header writes it: git quotes one with a byte it will
 * not print as it is, as C does, and ends the line with a tab when the path
 * has a space.
 */
function headerPath(field: string): string {
  const path = field.endsWith('\t') ? field.slice(0, -1) : field
  if (!path.startsWith('"')) return path

  const encoder = new TextEncoder()
  const bytes: number[] = []
  for (const [text, escape] of path.slice(1, -1).matchAll(/\\([0-3][0-7]{2}|.)|[^\\]+/gsu)) {
    if (escape === undefined) bytes.push(...encoder.encode(text))
    else if (escape.length === 3) bytes.push(Number.parseInt(escape, 8))
    else bytes.push(...(ESCAPES.has(escape) ? [ESCAPES.get(escape) ?? 0] : encoder.encode(escape)))
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

/**
 * The lines each file gained or changed, from a unified diff without
 * context. Each hunk's header says how many of the lines after it are its
 * own, so none of them is read as a header, whatever it starts with.
 */
export function changedLines(diff: string): Map<string, Set<number>> {
  const changed = new Map<string, Set<number>>()
  let lines: Set<number> | undefined
  // The lines of the hunk being read that are still to come.
  let remaining = 0

  for (const line of diff.split('\n')) {
    if (remaining > 0) {
      // "\ No newline at end of file" follows a line of the hunk, and is none.
      if (!line.startsWith('\\')) remaining--
      continue
    }

    if (line.startsWith('diff --git ')) {
      lines = undefined
    } else if (line.startsWith('+++ ')) {
      const path = headerPath(line.slice(4))
      lines = undefined
      if (path.startsWith('b/')) changed.set(path.slice(2), (lines = new Set()))
    } else {
      const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
      if (hunk === null) continue
      const [, removed = '1', start, added = '1'] = hunk
      for (let n = Number(start); n < Number(start) + Number(added); n++) lines?.add(n)
      remaining = Number(removed) + Number(added)
    }
  }

  return changed
}

const isTest = (file: string) => /\.test\.tsx?$/.test(file) && !/(^|\/)(node_modules|dist)\//.test(file)
const isSource = (file: string) => file.startsWith('src/') && /\.tsx?$/.test(file) && !file.endsWith('.d.ts') && !isTest(file)

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

/** The src/ files to mutate, each with the lines to mutate in it, or undefined for every line. */
function targetsOf(root: string, files: readonly string[], base: string | undefined): Map<string, Set<number> | undefined> {
  if (files.length > 0 && base === undefined) return new Map(files.map((file) => [file, undefined]))

  const diff = git(root, ['diff', '--unified=0', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', base ?? 'HEAD', '--', 'src'])
  const targets = new Map<string, Set<number> | undefined>(changedLines(diff))
  for (const file of git(root, ['ls-files', '-z', '--others', '--exclude-standard', '--', 'src']).split('\0')) {
    if (file !== '') targets.set(file, undefined)
  }
  for (const file of targets.keys()) {
    if (!isSource(file) || !existsSync(join(root, file)) || (files.length > 0 && !files.includes(file))) targets.delete(file)
  }
  return targets
}

/** The directories a run's copies link to rather than copy. */
const SHARED = ['node_modules', 'dist']

/**
 * What every test run of a run starts from: a snapshot of the working tree,
 * taken once, whose mutated files hold the text their mutants were read
 * from, so an edit to the checkout during the run reaches none of it.
 */
interface Tree {
  /** The checkout, whose shared directories the copies link to. */
  readonly root: string
  readonly base: string
  readonly files: readonly string[]
  /** Each directory below the top that holds a file. */
  readonly directories: ReadonlySet<string>
  readonly links: readonly string[]
}

function snapshot(root: string, base: string, listed: readonly string[], sources: ReadonlyMap<string, string>): Tree {
  const files = [...new Set([...listed, ...sources.keys()])]
  const directories = new Set<string>()
  for (const file of files) for (let directory = dirname(file); directory !== '.'; directory = dirname(directory)) directories.add(directory)

  for (const file of files) {
    mkdirSync(dirname(join(base, file)), { recursive: true })
    const text = sources.get(file)
    if (text === undefined) copyFileSync(join(root, file), join(base, file), constants.COPYFILE_FICLONE)
    else writeFileSync(join(base, file), text)
  }

  const links = SHARED.filter((name) => existsSync(join(root, name)) && !directories.has(name))
  return { root, base, files, directories, links }
}

/** One worker's copy of the snapshot, which each of its test runs may dirty. */
interface Copy {
  readonly path: string
  /** Its test runs' temporary directory, kept inside the workspace. */
  readonly temporary: string
  /** Its coverage runs' report directory. */
  readonly coverage: string
  /** The JUnit report of its last mutant run. */
  readonly report: string
  /** Each file's stamp when it was placed, to tell the ones a test run changed. */
  readonly stamps: Map<string, string>
}

const copyAt = (path: string): Copy => ({
  path,
  temporary: `${path}.tmp`,
  coverage: `${path}.coverage`,
  report: `${path}.junit.xml`,
  stamps: new Map(),
})

/** What tells a placed file from one a test run changed: a write moves its ctime, a replacement its inode. */
function stampOf(path: string): string {
  const stats = lstatSync(path)
  return `${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`
}

/**
 * Put a copy back as the snapshot has it, before each test run: what the
 * last one wrote, removed or left behind is undone, and its temporary
 * directory emptied, so no run reads what another left.
 */
function restore(tree: Tree, copy: Copy) {
  mkdirSync(copy.path, { recursive: true })
  const kept = new Set<string>()
  const visit = (directory: string) => {
    for (const entry of readdirSync(join(copy.path, directory), { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const at = join(copy.path, path)
      if (entry.isDirectory() && tree.directories.has(path)) visit(path)
      else if (entry.isFile() && copy.stamps.get(path) === stampOf(at)) kept.add(path)
      else if (entry.isSymbolicLink() && tree.links.includes(path) && readlinkSync(at) === join(tree.root, path)) kept.add(path)
      else rmSync(at, { recursive: true, force: true })
    }
  }
  visit('')

  for (const file of tree.files) {
    const at = join(copy.path, file)
    if (!kept.has(file)) {
      mkdirSync(dirname(at), { recursive: true })
      copyFileSync(join(tree.base, file), at, constants.COPYFILE_FICLONE)
      copy.stamps.set(file, stampOf(at))
    }
  }
  for (const link of tree.links) if (!kept.has(link)) symlinkSync(join(tree.root, link), join(copy.path, link))

  rmSync(copy.temporary, { recursive: true, force: true })
  mkdirSync(copy.temporary)
}

/** A file's text with a mutant planted, refused when the text is not the one its offsets were read from. */
function plant(text: string | undefined, mutant: Mutant): string {
  if (text === undefined || text.slice(mutant.start, mutant.end) !== mutant.original) {
    throw new Error(`${mutant.file}:${mutant.line} does not read ${JSON.stringify(mutant.original)} where its mutant goes.`)
  }
  return text.slice(0, mutant.start) + mutant.replacement + text.slice(mutant.end)
}

/**
 * The process that outlives a run, in a process group of its own so that what
 * ends the run's group spares it: when its input closes, as it does however
 * the run ends, SIGKILL included, it kills each test run's process group the
 * run left open and removes the workspace. Its input names the workspace
 * (`=path`) and each test run's group as it opens (`+pid`) and closes (`-pid`).
 */
const WATCHDOG = `
const { rmSync } = require('node:fs')
const { basename } = require('node:path')
const open = new Set()
let workspace = ''
let partial = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  const lines = (partial + chunk).split('\\n')
  partial = lines.pop()
  for (const line of lines) {
    if (line.startsWith('=')) workspace = line.slice(1)
    else if (line.startsWith('+')) open.add(Number(line.slice(1)))
    else open.delete(Number(line.slice(1)))
  }
})
process.stdin.on('end', () => {
  for (const pid of open) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {}
  }
  if (basename(workspace).startsWith('popweb-mutate-')) rmSync(workspace, { recursive: true, force: true })
})
`

/** A test run that could not start, as when Bun is gone or the machine has no process to spare. */
class TestRunNotStarted extends Data.TaggedError('TestRunNotStarted')<{ readonly message: string }> {}

const notStarted = (error: unknown) =>
  new TestRunNotStarted({ message: `popweb-mutate could not start bun: ${error instanceof Error ? error.message : String(error)}` })

/** The watchdog, told each line as the run goes; closed with the run, after its workspace is gone. */
const acquireWatchdog = Effect.acquireRelease(
  Effect.try({
    try: () => {
      const watchdog = spawn(process.execPath, ['-e', WATCHDOG], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] })
      // One that fails to start leaves the run unguarded, as on a machine out
      // of processes, where the run's own test runs then fail to start.
      watchdog.on('error', () => undefined)
      watchdog.stdin.on('error', () => undefined)
      watchdog.unref()
      return watchdog.stdin
    },
    catch: notStarted,
  }),
  (input) => Effect.sync(() => input.end()),
)

/** A run's directory, removed with the run, and the watchdog that removes it, with the test runs still open, should the run die first. */
interface Workspace {
  readonly path: string
  /** Tell the watchdog a test run's process group opened, or closed. */
  readonly opened: (pid: number) => void
  readonly closed: (pid: number) => void
}

const acquireWorkspace = Effect.gen(function* () {
  const watchdog = yield* acquireWatchdog
  const tell = (line: string) => {
    watchdog.write(`${line}\n`)
  }
  const path = yield* Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(join(realpathSync(tmpdir()), 'popweb-mutate-'))),
    (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
  )
  tell(`=${path}`)
  return { path, opened: (pid: number) => tell(`+${pid}`), closed: (pid: number) => tell(`-${pid}`) } satisfies Workspace
})

/** How a run of `bun test` ended. */
type Ending =
  | { readonly _tag: 'Exited'; readonly code: number }
  | { readonly _tag: 'Signalled'; readonly signal: NodeJS.Signals }
  | { readonly _tag: 'TimedOut' }

const passed = (ending: Ending) => ending._tag === 'Exited' && ending.code === 0

/** Kill a test run's whole process group, with any server it started. */
function killGroup(pid: number | undefined) {
  if (pid === undefined) return
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // It has already exited.
  }
}

/**
 * Run `bun test` in a copy, as a resource of the fiber that runs it: when
 * that fiber is interrupted, by a signal or a failing job beside it, the
 * test run's process group is killed before the fiber's interruption ends.
 */
const runTests = (workspace: Workspace, copy: Copy, args: readonly string[], timeout: number) =>
  Effect.callback<Ending, TestRunNotStarted>((resume) => {
    // A mutant really runs, with whatever the code it breaks can reach: a
    // temporary directory of the copy's own keeps what it does there, and
    // what a killed run leaves, inside this run's workspace.
    const env = { ...process.env, TMPDIR: copy.temporary, TMP: copy.temporary, TEMP: copy.temporary }
    let child: ChildProcess
    try {
      child = spawn(process.execPath, args, { cwd: copy.path, detached: true, env, stdio: 'ignore' })
    } catch (error) {
      resume(Effect.fail(notStarted(error)))
      return
    }

    const { pid } = child
    if (pid !== undefined) workspace.opened(pid)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killGroup(pid)
    }, timeout)
    const gone = new Promise<void>((done) => {
      child.once('exit', () => done())
      child.once('error', () => done())
    })
    const end = (ending: Effect.Effect<Ending, TestRunNotStarted>) => {
      clearTimeout(timer)
      killGroup(pid)
      if (pid !== undefined) workspace.closed(pid)
      resume(ending)
    }
    child.once('error', (error) => end(Effect.fail(notStarted(error))))
    child.once('exit', (code, signal) =>
      end(Effect.succeed<Ending>(timedOut ? { _tag: 'TimedOut' } : code === null ? { _tag: 'Signalled', signal: signal ?? 'SIGKILL' } : { _tag: 'Exited', code })))

    return Effect.suspend(() => {
      clearTimeout(timer)
      killGroup(pid)
      return Effect.promise(() => gone).pipe(Effect.timeoutOption('5 seconds'), Effect.asVoid)
    })
  })

/** A mutant run's arguments: it stops at the first failure, and says which test file that was. */
const mutantRun = (copy: Copy, tests: readonly string[]) =>
  ['test', '--bail', '--reporter=junit', `--reporter-outfile=${copy.report}`, ...tests.map((test) => `./${test}`)]

/** The test files a mutant run's JUnit report says failed; all it ran when the report names none, as when a file fails to load. */
function failedTests(copy: Copy, tests: readonly string[]): readonly string[] {
  let report = ''
  try {
    report = readFileSync(copy.report, 'utf8')
  } catch {
    return tests
  }

  const failed = new Set<string>()
  for (const [suite] of report.matchAll(/<testsuite\s[^>]*>/g)) {
    const file = /\sfile="([^"]*)"/.exec(suite)?.[1]
    if (file !== undefined && Number(/\sfailures="(\d+)"/.exec(suite)?.[1]) > 0) failed.add(relative(copy.path, resolve(copy.path, file)))
  }
  const named = tests.filter((test) => failed.has(test))
  return named.length > 0 ? named : tests
}

/**
 * What a mutant's test run says of it. A failure is the mutant's only when
 * the files that failed pass with no mutant planted, run again at once in a
 * copy put back (the control); a signal not its timer says nothing of it.
 */
function verdict<E>(ending: Ending, control: Effect.Effect<Ending, E>): Effect.Effect<{ readonly status: Status; readonly crash?: string }, E> {
  switch (ending._tag) {
    case 'TimedOut':
      return Effect.succeed({ status: 'timed out' })
    case 'Signalled':
      return Effect.succeed({ status: 'crashed', crash: `ended by ${ending.signal}` })
    case 'Exited':
      if (ending.code === 0) return Effect.succeed({ status: 'survived' })
      return control.pipe(Effect.map((control) => passed(control) ? { status: 'killed' } : { status: 'crashed', crash: 'its tests fail with no mutant planted too' }))
  }
}

const BASELINE_TIMEOUT = 10 * 60 * 1000

/** The memory a worker's tests may use at once: each runs a whole test file, an application's with Miniflares of its own. */
const MEMORY_PER_WORKER = 4 * 1024 * 1024 * 1024

/** A worker for each share of the memory, leaving a core for everything else. */
export function defaultWorkers(cores: number, memory: number): number {
  return Math.max(1, Math.min(cores - 1, Math.floor(memory / MEMORY_PER_WORKER)))
}

/** The signals that end a run, which first kills its test runs and removes its workspace. */
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

/** The first of the signals that end a run; the next ends the process at once, as it would with no run. */
const endingSignal = Effect.callback<(typeof SIGNALS)[number]>((resume) => {
  const handlers = SIGNALS.map((signal) => [signal, () => {
    stop()
    resume(Effect.succeed(signal))
  }] as const)
  const stop = () => {
    for (const [signal, handler] of handlers) process.off(signal, handler)
  }
  for (const [signal, handler] of handlers) process.on(signal, handler)
  return Effect.sync(stop)
})

/** The run itself, as a scope: the test runs it starts and its workspace end with it, however it ends. */
const runMutants = (options: Options) =>
  Effect.gen(function* () {
    const { root, log = () => undefined } = options
    const files = options.files ?? []

    // Which lines to mutate: every line of the named files, or the changed ones.
    const targets = targetsOf(root, files, options.base)
    const read = yield* Effect.promise(() => readMutants(root, [...targets.keys()]))
    const mutants = read.mutants.filter((mutant) => {
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

    const workers = Math.max(1, Math.min(options.workers ?? defaultWorkers(availableParallelism(), totalmem()), Math.max(candidates.length, mutants.length)))

    return yield* Effect.scoped(Effect.gen(function* () {
      const space = yield* acquireWorkspace
      const tree = snapshot(root, join(space.path, 'base'), listed, read.sources)
      const copies = Array.from({ length: workers }, (_, index) => copyAt(join(space.path, `w${index}`)))
      for (const copy of copies) restore(tree, copy)

      /** Run jobs across the copies, one at a time in each; a job that fails ends the others' test runs first. */
      const pool = <T, E>(jobs: readonly T[], work: (job: T, copy: Copy) => Effect.Effect<void, E>) => {
        let next = 0
        return Effect.forEach(copies, (copy) =>
          Effect.gen(function* () {
            for (let job = jobs[next++]; job !== undefined; job = jobs[next++]) yield* work(job, copy)
          }), { concurrency: 'unbounded' })
      }

      // Coverage: each test file alone, the largest first so the slowest is not
      // left until last.
      log(`coverage: ${candidates.length} test files import a mutated file`)
      const coverage = new Map<string, { readonly passed: boolean; readonly ms: number; readonly hits: Map<string, number[]> }>()
      // The lines Bun counts in each mutated file, reached or not.
      const counted = new Map([...mutated].map((file) => [file, new Set<number>()]))
      const sizeOf = (test: string) => readFileSync(join(tree.base, test)).length
      const measure = (test: string, copy: Copy) =>
        Effect.gen(function* () {
          restore(tree, copy)
          rmSync(copy.coverage, { recursive: true, force: true })
          const started = performance.now()
          const ending = yield* runTests(space, copy, ['test', '--coverage', '--coverage-reporter=lcov', `--coverage-dir=${copy.coverage}`, `./${test}`], BASELINE_TIMEOUT)
          const ms = Math.round(performance.now() - started)

          let lcov = ''
          try {
            lcov = readFileSync(join(copy.coverage, 'lcov.info'), 'utf8')
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
              file = isAbsolute(path) ? relative(copy.path, path) : path
              lines = counted.get(file)
            } else if (line.startsWith('DA:') && lines !== undefined) {
              const [n, count] = line.slice(3).split(',').map(Number)
              lines.add(n)
              if (count > 0) push(hits, file, n)
            }
          }

          coverage.set(test, { passed: passed(ending), ms, hits })
        })
      yield* pool([...candidates].sort((a, b) => sizeOf(b) - sizeOf(a)), measure)

      // A test file can fail beside the others for the memory it lost to them,
      // and leaving it out turns what only it catches into survivors: each
      // gets the machine to itself before it is left out.
      const failedBeside = [...coverage].filter(([, entry]) => !entry.passed).map(([test]) => test)
      if (failedBeside.length > 0) log(`coverage: running ${failedBeside.length} failing test files again, one at a time`)
      for (const test of failedBeside) yield* measure(test, copies[0])

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
      yield* pool(jobs, ({ mutant, index, tests, cost }, copy) =>
        Effect.gen(function* () {
          if (tests.length === 0) {
            results[index] = { ...mutant, status: 'survived', tests: 0 }
            return
          }

          const timeout = options.timeout ?? 10_000 + 2 * cost
          restore(tree, copy)
          writeFileSync(join(copy.path, mutant.file), plant(read.sources.get(mutant.file), mutant))
          rmSync(copy.report, { force: true })
          const ending = yield* runTests(space, copy, mutantRun(copy, tests), timeout)

          const control = Effect.suspend(() => {
            const failed = failedTests(copy, tests)
            restore(tree, copy)
            return runTests(space, copy, mutantRun(copy, failed), timeout)
          })
          results[index] = { ...mutant, tests: tests.length, ...(yield* verdict(ending, control)) }
        }))

      return { results, testFiles: candidates.length, failing }
    }))
  })

/** Plant each mutant in turn and run the tests that reach it. */
export async function mutate(options: Options): Promise<Run> {
  const ended = await Effect.runPromise(
    Effect.raceFirst(
      runMutants(options).pipe(Effect.map((run) => ({ run }))),
      endingSignal.pipe(Effect.map((signal) => ({ signal }))),
    ),
  )
  // The run has killed its test runs and removed its workspace.
  if ('signal' in ended) process.exit(128 + system.signals[ended.signal])
  return ended.run
}

/** Whether a mutant's tests caught it: they failed on it, or never finished. */
const caught = (result: Result) => result.status === 'killed' || result.status === 'timed out'

/** Caught mutants, killed or timed out, as a share of all of them. */
export function score(results: readonly Result[]): number {
  return results.length === 0 ? 100 : (100 * results.filter(caught).length) / results.length
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
    return `  ${name.padEnd(width)}  ${`${Math.floor(score(group))}%`.padStart(4)}  ${group.filter(caught).length}/${group.length}`
  })
}

/** The run as a person reads it: the score, by file and by operator, then each survivor. */
export function formatReport(run: Run): string {
  const { results } = run
  if (results.length === 0) return 'No mutants: no src/ lines to mutate.'

  const count = (status: Status) => results.filter((result) => result.status === status).length
  const survivors = results.filter((result) => result.status === 'survived')
  const timedOut = results.filter((result) => result.status === 'timed out')
  const crashed = results.filter((result) => result.status === 'crashed')
  const unreached = survivors.filter((survivor) => survivor.tests === 0).length
  const files = [...new Set(results.map((result) => result.file))]
  const left = run.failing.length

  const lines = [
    `${results.length} mutants in ${files.length === 1 ? files[0] : `${files.length} files`}, against the ${run.testFiles} test files that load ${files.length === 1 ? 'it' : 'them'}`,
    '',
    `score ${Math.floor(score(results))}%: ${count('killed')} killed, ${count('timed out')} timed out, ${crashed.length === 0 ? '' : `${crashed.length} crashed, `}${count('survived')} survived${unreached === 0 ? '' : `, ${unreached} of them on ${unreached === 1 ? 'a line' : 'lines'} no test reaches`}`,
    ...(left === 0 ? [] : [`partial: ${left === 1 ? '1 test file left out, so a mutant only it would catch' : `${left} test files left out, so a mutant only they would catch`} shows as a survivor`]),
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

  if (crashed.length > 0) {
    lines.push('', 'crashed, not counted as caught: their tests gave no answer, so run again once the cause is gone')
    for (const result of crashed) lines.push(`  ${result.file}:${result.line}  ${result.operator}  ${edit(result)}  (${result.crash})`)
  }

  if (run.failing.length > 0) {
    lines.push('', `left out, failing with no mutant planted: ${run.failing.join(', ')}`)
  }

  return lines.join('\n')
}

if (import.meta.main) {
  const usage = [
    'Usage: popweb-mutate [files...] [--base <ref>] [--fail-under <percent>] [--workers <n>] [--timeout <seconds>]',
    '',
    'Plants small bugs in the src/ lines changed since --base (HEAD by default), or in every line',
    'of the src/ files given, and lists each one no test catches. docs/mutation.md explains it.',
  ].join('\n')
  const parse = () =>
    parseArgs({
      allowPositionals: true,
      options: {
        base: { type: 'string' },
        'fail-under': { type: 'string' },
        workers: { type: 'string' },
        timeout: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    })
  let parsed: ReturnType<typeof parse>
  try {
    parsed = parse()
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n\n${usage}`)
    process.exit(2)
  }
  if (parsed.values.help === true) {
    console.log(usage)
    process.exit(0)
  }
  const { values, positionals } = parsed

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
  let run: Run
  try {
    run = await mutate({
      root,
      files,
      base: values.base,
      workers: number('workers', values.workers),
      timeout: timeout === undefined ? undefined : timeout * 1000,
      log: (line) => console.error(line),
    })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }

  console.log(formatReport(run))
  if (failUnder !== undefined && score(run.results) < failUnder) process.exitCode = 1
}
