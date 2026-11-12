/**
 * The debt report: every comment that turns a lint rule or a type check off,
 * with the reason it gives, counted against a committed ledger so the count
 * only shrinks. A directive is an Oxlint or ESLint `disable` comment, a
 * TypeScript `@ts-expect-error`, `@ts-ignore` or `@ts-nocheck`, or an Effect
 * `@effect-diagnostics` comment that lowers a rule below error.
 *
 * Comments come from Oxc's parser, the one Oxlint reads them with, so text in
 * JSX, a string, a template or a regular expression is never one, and a file
 * the parser cannot read is refused rather than counted as clean. The gate's
 * `--check` reads the index, the commit about to be made, and holds its ledger
 * to the one HEAD holds: a ledger counts or ignores more than HEAD's only when
 * `--allow-increase`, the owner's step, wrote it on that HEAD, as the mark it
 * leaves in git's directory shows. Git runs in the repository the working
 * directory is in, whatever `GIT_DIR` names.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import type { ParserOptions } from 'oxc-parser'

/** One comment that turns a rule or a check off. */
export interface DisableDirective {
  /** The file, relative to the application's root. */
  readonly file: string
  readonly line: number
  /** As written: `oxlint-disable-next-line`, `@ts-expect-error`, `@effect-diagnostics-next-line`. */
  readonly directive: string
  /** The rules it turns off; empty when it turns off every one, as `@ts-ignore` and a bare `oxlint-disable` do. */
  readonly rules: ReadonlyArray<string>
  /** Why, as the comment says after ` -- `; null when it does not say. */
  readonly reason: string | null
}

/** The committed count: each directive without its line, so moving code does not change it. */
export interface DebtLedger {
  readonly count: number
  /** Files the report leaves out, such as a generated `worker-configuration.d.ts`: paths or globs. */
  readonly ignore: ReadonlyArray<string>
  /** The HEAD `--allow-increase` raised the count over; the gate takes a ledger that counts or ignores more than HEAD's only when it names HEAD. */
  readonly raisedFrom?: string | undefined
  readonly directives: ReadonlyArray<Omit<DisableDirective, 'line'>>
}

/** The code's directives against the ledger's. */
export interface DebtComparison {
  readonly count: number
  readonly baseline: number
  /** Directives the ledger does not hold. */
  readonly added: ReadonlyArray<DisableDirective>
  /** Ledger entries the code no longer holds. */
  readonly removed: ReadonlyArray<Omit<DisableDirective, 'line'>>
}

/** What `--check` finds, in the order it looks. */
export type DebtCheck =
  /** No ledger to check against. */
  | { readonly _tag: 'Missing'; readonly count: number }
  /** The ledger counts or ignores more than HEAD's, and `--allow-increase` did not write it on HEAD. */
  | { readonly _tag: 'Raised'; readonly ledger: DebtLedger; readonly committed: DebtLedger }
  /** The code holds more directives than the ledger. */
  | { readonly _tag: 'Risen'; readonly comparison: DebtComparison }
  /** The code holds fewer, or different ones. */
  | { readonly _tag: 'Stale'; readonly comparison: DebtComparison }
  | { readonly _tag: 'Matches'; readonly comparison: DebtComparison }

/** What `--update` writes, or why it refuses. */
export type DebtUpdate =
  | { readonly _tag: 'Refused'; readonly comparison: DebtComparison }
  | { readonly _tag: 'Written'; readonly ledger: DebtLedger }

/** The git repository the working directory is in. */
export interface Repository {
  /** Its top level, as git names it. */
  readonly root: string
  /** HEAD's commit; undefined before the first one. */
  readonly head: string | undefined
  /** Its git directory: this worktree's own, which no commit carries. */
  readonly gitDir: string
}

/**
 * Where `--allow-increase` marks its raise of the ledger at a path: a copy of
 * the ledger it wrote, naming the HEAD it raised the count over, in the git
 * directory, which no commit carries and the command hook refuses an agent's
 * write to. A ledger's own `raisedFrom` is text anyone who writes it can forge.
 */
function markFile(repository: Repository | undefined, path: string): string | undefined {
  if (repository === undefined) return undefined
  const at = repositoryPath(repository, path)
  return at === undefined ? undefined : join(repository.gitDir, 'popweb-fence', `${encodeURIComponent(at)}.json`)
}

/** One file the parser could not read in full, so the comments after the failure are unknown. */
export interface UnreadableSource {
  readonly file: string
  readonly line: number
  readonly reason: string
}

/** Files whose comments the report cannot read: it refuses to count them as clean. */
export class UnreadableSourceError extends Error {
  readonly _tag = 'UnreadableSourceError'

  constructor(readonly sources: ReadonlyArray<UnreadableSource>) {
    super(
      `The debt report cannot read ${sources.length === 1 ? 'this file' : 'these files'}, so it cannot count ${sources.length === 1 ? 'its' : 'their'} directives:\n\n` +
        sources.map(({ file, line, reason }) => `  ${file}:${line}  ${reason}`).join('\n') +
        "\n\nFix the syntax, or add a generated file to the ledger's ignore."
    )
  }
}

/** Git failed inside a repository, so the report cannot tell what HEAD or the index holds. */
export class RepositoryUnreadableError extends Error {
  readonly _tag = 'RepositoryUnreadableError'
}

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.wrangler'])
/** Git's modes for a file's content; a symbolic link (`120000`) or a submodule (`160000`) holds none. */
const FILE_MODES = new Set(['100644', '100755'])
const MAX_GIT_OUTPUT = 1024 * 1024 * 1024

const LINT = /^\s*((?:oxlint|eslint)-disable(?:-next-line|-line)?)(?=\s|$)([\s\S]*)$/
/** TypeScript honours `@ts-ignore` and `@ts-expect-error` after any run of slashes, as `/// @ts-ignore`. */
const TYPESCRIPT = /^\/*\s*(@ts-(?:expect-error|ignore|nocheck))(?![\w-])([\s\S]*)$/
const EFFECT = /^\s*(@effect-diagnostics(?:-next-line)?)(?=\s|$)([\s\S]*)$/
/** ESLint's separator between a directive and its reason: two or more dashes with space around them. */
const REASON = /(?:^|\s)-{2,}(?:\s|$)/

// Oxc's parser is a native module: it loads on the first read, so the hook,
// which imports this module through the fence's entrypoint, loads only Node's
// built-ins.
const load = createRequire(import.meta.url)
// SAFETY: `require` returns `any`; the module it loads is oxc-parser, whose declared types these are.
const parser = (): typeof import('oxc-parser') => load('oxc-parser')

/** The disable directives in one file's source; throws `UnreadableSourceError` when the parser cannot read it. */
export function disableDirectives(source: string, file = ''): DisableDirective[] {
  const read = readSource(file, source)
  if ('unreadable' in read) throw new UnreadableSourceError([read.unreadable])
  return read.directives
}

function readSource(file: string, source: string): { readonly directives: DisableDirective[] } | { readonly unreadable: UnreadableSource } {
  const { comments, errors } = parser().parseSync(file, source, parserOptions(file))
  const [error] = errors
  if (error !== undefined) return { unreadable: { file, line: lineAt(source, error.labels[0]?.start ?? 0), reason: error.message } }

  return {
    directives: comments.flatMap(({ value, start }) => {
      const body = value.replace(/^\*+/, '').replace(/\n\s*\*/g, '\n')
      const directive = readDirective(body)
      return directive === undefined ? [] : [{ file, line: lineAt(source, start), ...directive }]
    }),
  }
}

/** JSX in a `.js` file, as Oxlint and the bundlers read it; a file with no extension, as TSX. */
function parserOptions(file: string): ParserOptions {
  if (/\.jsx?$/.test(file)) return { lang: 'jsx' }
  return SOURCE_FILE.test(file) ? {} : { lang: 'tsx' }
}

function lineAt(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length
}

function readDirective(body: string): Omit<DisableDirective, 'file' | 'line'> | undefined {
  const lint = LINT.exec(body)
  if (lint) {
    const [rules, reason] = splitReason(lint[2])
    return { directive: lint[1], rules: rules.split(/[\s,]+/).filter(Boolean), reason }
  }

  const typescript = TYPESCRIPT.exec(body)
  if (typescript) {
    const [text, reason] = splitReason(typescript[2])
    // TypeScript takes any text after the directive as its description.
    const description = reason ?? text.replace(/^[\s:-]+/, '').trim()
    return { directive: typescript[1], rules: [], reason: description === '' ? null : description }
  }

  const effect = EFFECT.exec(body)
  if (effect) {
    const [settings, reason] = splitReason(effect[2])
    const rules = settings
      .split(/\s+/)
      .map((setting) => setting.split(':'))
      .filter(([rule, severity]) => rule !== '' && severity !== undefined && severity !== 'error')
      .map(([rule]) => rule)
    return rules.length === 0 ? undefined : { directive: effect[1], rules, reason }
  }

  return undefined
}

function splitReason(text: string): [string, string | null] {
  const match = REASON.exec(text)
  if (!match) return [text.trim(), null]

  const reason = text.slice(match.index + match[0].length).trim()
  return [text.slice(0, match.index).trim(), reason === '' ? null : reason]
}

/** Every file's directives, or `UnreadableSourceError` naming each file the parser could not read. */
function readSources(sources: ReadonlyArray<{ readonly file: string; readonly source: string }>, unreadable: ReadonlyArray<UnreadableSource> = []): DisableDirective[] {
  const reads = sources.map(({ file, source }) => readSource(file, source))
  const failures = [...unreadable, ...reads.flatMap((read) => ('unreadable' in read ? [read.unreadable] : []))]
  if (failures.length > 0) throw new UnreadableSourceError(failures)
  return reads.flatMap((read) => ('directives' in read ? read.directives : []))
}

/** The disable directives in an application's source files, as the working tree holds them, outside its ignored paths. */
export function scanDebt(root: string, ignore: ReadonlyArray<string> = []): DisableDirective[] {
  const ignored = ignoredBy(ignore)

  return readSources(
    sourceFiles(root)
      .filter((file) => !ignored(file))
      .map((file) => ({ file, source: readFileSync(join(root, file), 'utf8') }))
  )
}

/**
 * The disable directives the index holds, the commit about to be made, under
 * the root: a file staged and then deleted from the tree still counts, as it
 * enters history.
 */
export function scanStagedDebt(root: string, ignore: ReadonlyArray<string> = []): DisableDirective[] {
  const ignored = ignoredBy(ignore)
  const entries = runGit(root, ['ls-files', '--stage', '-z'])
    .stdout.toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t')
      const [mode, object, stage] = line.slice(0, tab).split(' ')
      return { mode, object, stage, file: line.slice(tab + 1) }
    })
    .filter(({ file }) => SOURCE_FILE.test(file) && !ignored(file))

  const staged = entries.filter(({ mode, stage }) => stage === '0' && FILE_MODES.has(mode))
  const contents = readObjects(root, staged.map(({ object }) => object))
  const sources = staged.flatMap(({ file }, index) => {
    const content = contents[index]
    return content === undefined ? [] : [{ file, source: content.toString('utf8') }]
  })
  const unmerged = [...new Set(entries.filter(({ stage }) => stage !== '0').map(({ file }) => file))].map((file) => ({
    file,
    line: 1,
    reason: 'unmerged: resolve the conflict and stage the file',
  }))
  const missing = staged
    .filter((_, index) => contents[index] === undefined)
    .map(({ file }) => ({ file, line: 1, reason: 'the index names an object git does not hold' }))

  return readSources(sources, [...unmerged, ...missing])
}

/** The ledger to commit for these directives. */
export function debtLedger(directives: ReadonlyArray<DisableDirective>, ignore: ReadonlyArray<string> = [], raisedFrom?: string): DebtLedger {
  const entries = directives.map(({ file, directive, rules, reason }) => ({ file, directive, rules, reason }))
  entries.sort((a, b) => entryKey(a).localeCompare(entryKey(b)))
  return raisedFrom === undefined ? { count: entries.length, ignore, directives: entries } : { count: entries.length, ignore, raisedFrom, directives: entries }
}

export function compareDebt(directives: ReadonlyArray<DisableDirective>, ledger: DebtLedger): DebtComparison {
  const remaining = new Map<string, number>()
  for (const entry of ledger.directives) remaining.set(entryKey(entry), (remaining.get(entryKey(entry)) ?? 0) + 1)

  const added = directives.filter((directive) => {
    const key = entryKey(directive)
    const left = remaining.get(key) ?? 0
    if (left > 0) remaining.set(key, left - 1)
    return left === 0
  })
  const removed = ledger.directives.filter((entry) => {
    const key = entryKey(entry)
    const left = remaining.get(key) ?? 0
    if (left > 0) remaining.set(key, left - 1)
    return left > 0
  })

  return { count: directives.length, baseline: ledger.directives.length, added, removed }
}

/** Whether a ledger counts more directives than the committed one, or leaves out files it does not. */
export function raisesDebt(ledger: DebtLedger, committed: DebtLedger): boolean {
  return ledger.directives.length > committed.directives.length || ledger.ignore.some((pattern) => !committed.ignore.includes(pattern))
}

/** Whether `--allow-increase` wrote this ledger on this HEAD: it names HEAD, as its mark does, and counts and ignores no more than the mark. */
function raisedOn(ledger: DebtLedger, head: string | undefined, mark: DebtLedger | undefined): boolean {
  return head !== undefined && ledger.raisedFrom === head && mark?.raisedFrom === head && !raisesDebt(ledger, mark)
}

/**
 * The ledger `--update` holds the count to: the working tree's, unless it
 * counts or ignores more than HEAD's without `--allow-increase` having
 * written it on HEAD, as one restored from an older commit or moved into
 * place does; then HEAD's. Without a working ledger, HEAD's.
 */
export function debtBaseline(working: DebtLedger | undefined, committed: DebtLedger | undefined, head: string | undefined, mark?: DebtLedger): DebtLedger | undefined {
  if (working === undefined || committed === undefined) return working ?? committed
  return raisesDebt(working, committed) && !raisedOn(working, head, mark) ? committed : working
}

/** The ledger `--update` writes for these directives, or its refusal when the count would rise without `allowIncrease`. */
export function updateDebt(
  directives: ReadonlyArray<DisableDirective>,
  baseline: DebtLedger | undefined,
  committed: DebtLedger | undefined,
  head: string | undefined,
  allowIncrease: boolean
): DebtUpdate {
  if (!allowIncrease && baseline !== undefined && directives.length > baseline.directives.length) {
    return { _tag: 'Refused', comparison: compareDebt(directives, baseline) }
  }

  const ledger = debtLedger(directives, baseline?.ignore ?? [])
  return { _tag: 'Written', ledger: committed !== undefined && raisesDebt(ledger, committed) ? debtLedger(directives, ledger.ignore, head) : ledger }
}

/** What `--check` finds for the code's directives, the ledger it is checked against, and HEAD's. */
export function checkDebt(
  directives: ReadonlyArray<DisableDirective>,
  ledger: DebtLedger | undefined,
  committed: DebtLedger | undefined,
  head: string | undefined,
  mark?: DebtLedger
): DebtCheck {
  if (ledger === undefined) return { _tag: 'Missing', count: directives.length }
  if (committed !== undefined && raisesDebt(ledger, committed) && !raisedOn(ledger, head, mark)) return { _tag: 'Raised', ledger, committed }

  const comparison = compareDebt(directives, ledger)
  if (comparison.count > comparison.baseline) return { _tag: 'Risen', comparison }
  if (comparison.added.length > 0 || comparison.removed.length > 0) return { _tag: 'Stale', comparison }
  return { _tag: 'Matches', comparison }
}

/** A ledger read back from its JSON, or undefined when the text is not one. */
export function parseLedger(text: string): DebtLedger | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null || !('directives' in value) || !Array.isArray(value.directives)) return undefined

  const directives: unknown[] = value.directives
  if (!directives.every(isLedgerEntry)) return undefined
  const ignore = 'ignore' in value && Array.isArray(value.ignore) ? value.ignore.filter((pattern): pattern is string => typeof pattern === 'string') : []
  const raisedFrom = 'raisedFrom' in value && typeof value.raisedFrom === 'string' ? value.raisedFrom : undefined

  return raisedFrom === undefined ? { count: directives.length, ignore, directives } : { count: directives.length, ignore, raisedFrom, directives }
}

function isLedgerEntry(entry: unknown): entry is Omit<DisableDirective, 'line'> {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    'file' in entry &&
    typeof entry.file === 'string' &&
    'directive' in entry &&
    typeof entry.directive === 'string' &&
    'rules' in entry &&
    Array.isArray(entry.rules) &&
    entry.rules.every((rule) => typeof rule === 'string') &&
    'reason' in entry &&
    (entry.reason === null || typeof entry.reason === 'string')
  )
}

/** One directive as a line of the report: where, what it turns off, and why. */
export function describeDirective(directive: DisableDirective): string {
  const rules = directive.rules.length === 0 ? '' : ` ${directive.rules.join(', ')}`
  return `${directive.file}:${directive.line}  ${directive.directive}${rules}  ${directive.reason === null ? '(no reason given)' : `-- ${directive.reason}`}`
}

function entryKey(entry: Omit<DisableDirective, 'line'>): string {
  return JSON.stringify([entry.file, entry.directive, entry.rules, entry.reason])
}

/** What `popweb-fence debt` prints, and its exit code. */
export interface DebtAnswer {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

const DEFAULT_LEDGER = 'lint-debt.json'

/**
 * `popweb-fence debt` in an application's root: it lists the directives,
 * checks the commit about to be made against its ledger (`--check`), or
 * writes the ledger (`--update`), and answers with what it prints.
 */
export function debtCommand(args: ReadonlyArray<string>, cwd: string = process.cwd()): DebtAnswer {
  try {
    return runDebtCommand(args, cwd)
  } catch (error) {
    if (error instanceof UnreadableSourceError || error instanceof RepositoryUnreadableError) return answer(1, [], [error.message])
    throw error
  }
}

function runDebtCommand(args: ReadonlyArray<string>, cwd: string): DebtAnswer {
  const ledgerIndex = args.indexOf('--ledger')
  const name = ledgerIndex === -1 ? DEFAULT_LEDGER : args[ledgerIndex + 1] ?? DEFAULT_LEDGER
  const path = resolve(cwd, name)
  // HEAD's ledger is the one every count is held to, however the path is spelled.
  const repository = findRepository(cwd)
  const head = repository?.head
  const committed = repository === undefined ? undefined : committedLedger(repository, path, cwd)
  const marking = markFile(repository, path)
  const mark = marking === undefined ? undefined : readLedger(marking)

  if (args.includes('--check')) {
    // The gate checks the commit about to be made: the index, not the working tree.
    const ledger = repository === undefined ? readLedger(path) : stagedLedger(repository, path, cwd)
    const directives = (repository === undefined ? scanDebt : scanStagedDebt)(cwd, ledger?.ignore ?? [])
    return checkAnswer(checkDebt(directives, ledger, committed, head, mark), name, repository !== undefined)
  }

  const working = readLedger(path)
  const allowIncrease = args.includes('--update') && args.includes('--allow-increase')
  // The owner's `--allow-increase` takes the working ledger as it stands; otherwise one restored or moved into place cannot lift the count over HEAD's.
  const baseline = allowIncrease ? working ?? committed : debtBaseline(working, committed, head, mark)
  const directives = scanDebt(cwd, baseline?.ignore ?? [])

  if (args.includes('--update')) {
    const update = updateDebt(directives, baseline, committed, head, allowIncrease)
    const written = updateAnswer(directives, update, baseline, name, path)
    // Only a raise over a committed ledger names HEAD, and only the owner's step marks one.
    if (allowIncrease && update._tag === 'Written' && update.ledger.raisedFrom !== undefined && marking !== undefined) {
      mkdirSync(dirname(marking), { recursive: true })
      writeFileSync(marking, `${JSON.stringify(update.ledger, null, 2)}\n`)
    }
    return written
  }
  if (args.includes('--json')) return answer(0, [JSON.stringify({ count: directives.length, directives }, null, 2)])

  const total = `${count(directives.length)}, ${directives.filter((directive) => directive.reason === null).length} without a reason`
  return answer(0, [...directives.map(describeDirective), `${directives.length === 0 ? '' : '\n'}${total}.`])
}

function checkAnswer(verdict: DebtCheck, name: string, staged: boolean): DebtAnswer {
  switch (verdict._tag) {
    case 'Missing':
      return answer(1, [], [
        `No ${name}${staged ? ' in the commit about to be made' : ''}. Write it with \`popweb-fence debt --update\`, which records the` +
          ` ${count(verdict.count)} the code holds, and commit it.`,
      ])
    case 'Raised': {
      const { ledger, committed } = verdict
      const ignored = ledger.ignore.filter((pattern) => !committed.ignore.includes(pattern))
      return answer(1, [], [
        `${name} raises the debt HEAD records: it counts ${count(ledger.directives.length)} against ${committed.directives.length}` +
          `${ignored.length === 0 ? '' : `, and leaves out ${ignored.join(', ')}`}, and \`--allow-increase\` did not write it on HEAD.\n`,
        'Run `popweb-fence debt --update`, which holds the ledger to the one HEAD records, and fix the code each rule reports.' +
          ' Only the owner raises the count, with `popweb-fence debt --update --allow-increase`.',
      ])
    }
    case 'Risen': {
      const { comparison } = verdict
      return answer(1, [], [
        `Lint debt rose from ${comparison.baseline} to ${count(comparison.count)} (${name}). New since the ledger:\n`,
        ...comparison.added.map((directive) => `  ${describeDirective(directive)}`),
        '\nFix the code each rule reports instead of turning the rule off. A directive the owner accepts goes in with' +
          ' `popweb-fence debt --update --allow-increase`, which the owner runs.',
      ])
    }
    case 'Stale': {
      const { comparison } = verdict
      return answer(1, [], [
        `${name} is out of date: the code holds ${count(comparison.count)}, the ledger ${comparison.baseline}.\n`,
        ...comparison.removed.map((entry) => `  - ${entry.file}  ${entry.directive} ${entry.rules.join(', ')}`.trimEnd()),
        ...comparison.added.map((directive) => `  + ${describeDirective(directive)}`),
        `\nRun \`popweb-fence debt --update\` and commit ${name}, so the count stays at what the code holds.`,
      ])
    }
    case 'Matches':
      return answer(0, [`Lint debt: ${count(verdict.comparison.count)}, as ${name} records.`])
  }
}

function updateAnswer(directives: ReadonlyArray<DisableDirective>, update: DebtUpdate, baseline: DebtLedger | undefined, name: string, path: string): DebtAnswer {
  if (update._tag === 'Refused') {
    const { comparison } = update
    return answer(1, [], [
      `Lint debt only shrinks: the code holds ${count(comparison.count)}, the ledger ${comparison.baseline}. New since the ledger:\n`,
      ...comparison.added.map((directive) => `  ${describeDirective(directive)}`),
      '\nFix the code each rule reports instead. The owner accepts a new directive with `popweb-fence debt --update --allow-increase`.',
    ])
  }

  writeFileSync(path, `${JSON.stringify(update.ledger, null, 2)}\n`)
  const before = baseline?.directives.length
  const change = before === undefined || before === directives.length ? '' : `, ${directives.length < before ? 'down' : 'up'} from ${before}`
  return answer(0, [`Wrote ${name}: ${count(directives.length)}${change}.`])
}

function readLedger(path: string): DebtLedger | undefined {
  try {
    return parseLedger(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** Each line as `console.log` would print it. */
function answer(exitCode: number, stdout: ReadonlyArray<string>, stderr: ReadonlyArray<string> = []): DebtAnswer {
  const text = (lines: ReadonlyArray<string>) => lines.map((line) => `${line}\n`).join('')
  return { stdout: text(stdout), stderr: text(stderr), exitCode }
}

function count(n: number): string {
  return `${n} disable directive${n === 1 ? '' : 's'}`
}

/** The repository the directory is in, or undefined outside one; throws `RepositoryUnreadableError` when git fails inside one. */
export function findRepository(cwd: string = process.cwd()): Repository | undefined {
  const args = ['rev-parse', '--show-toplevel']
  const toplevel = spawnSync('git', args, gitOptions(cwd))
  if (outsideRepository(toplevel)) return undefined

  const root = ok(toplevel, args).stdout.toString('utf8').trim()
  const gitDir = runGit(cwd, ['rev-parse', '--absolute-git-dir']).stdout.toString('utf8').trim()
  const head = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], gitOptions(cwd))
  return { root, gitDir, head: head.status === 0 ? head.stdout.toString('utf8').trim() : undefined }
}

/** The ledger HEAD holds at this path, however the path is spelled: relative, absolute, through a symbolic link, or in another case. */
export function committedLedger(repository: Repository, path: string, cwd: string = process.cwd()): DebtLedger | undefined {
  const at = repositoryPath(repository, resolve(cwd, path))
  if (repository.head === undefined || at === undefined) return undefined

  // macOS and Windows name one file in any case, and git's tree in one: the spelling HEAD holds, the exact one first.
  const names = runGit(cwd, ['ls-tree', '-z', '--name-only', '--full-tree', 'HEAD', '--', `${posix.dirname(at)}/`])
    .stdout.toString('utf8')
    .split('\0')
  const spelling = names.find((name) => name === at) ?? names.find((name) => name.toLowerCase() === at.toLowerCase())
  const [content] = spelling === undefined ? [] : readObjects(cwd, [`HEAD:${spelling}`])
  return content === undefined ? undefined : parseLedger(content.toString('utf8'))
}

/** The ledger the index holds at this path: what the commit about to be made records. */
export function stagedLedger(repository: Repository, path: string, cwd: string = process.cwd()): DebtLedger | undefined {
  const at = repositoryPath(repository, resolve(cwd, path))
  const [content] = at === undefined ? [] : readObjects(cwd, [`:${at}`])
  return content === undefined ? undefined : parseLedger(content.toString('utf8'))
}

/** A path as git's tree names it, from the repository's top level; undefined outside the repository. */
function repositoryPath(repository: Repository, path: string): string | undefined {
  const inside = relative(realPath(repository.root), realPath(path))
  // Outside the repository, or a name `git cat-file --batch` would read as two.
  if (isAbsolute(inside) || /^\.\.(?:[\\/]|$)/.test(inside) || inside.includes('\n')) return undefined
  return inside.split(sep).join('/')
}

/** The path with its symbolic links resolved, and its case as the disk holds it, as far as it exists. */
function realPath(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return dirname(path) === path ? path : join(realPath(dirname(path)), basename(path))
  }
}

/** The objects' contents, read in one `git cat-file --batch`; undefined for one git does not hold. */
function readObjects(cwd: string, names: ReadonlyArray<string>): Array<Buffer | undefined> {
  const output = runGit(cwd, ['cat-file', '--batch'], names.map((name) => `${name}\n`).join('')).stdout

  let offset = 0
  return names.map(() => {
    const end = output.indexOf(10, offset)
    // `<object> <type> <size>`, then the content; `<name> missing` for one git does not hold.
    const found = /^[0-9a-f]+ (\S+) (\d+)$/.exec(output.toString('utf8', offset, end))
    offset = end + 1
    if (found === null) return undefined

    const content = output.subarray(offset, offset + Number(found[2]))
    offset += content.length + 1
    return found[1] === 'blob' ? content : undefined
  })
}

/**
 * Git's environment for the report: none of the variables that point git at
 * another repository, work tree or object store, so `GIT_DIR=/elsewhere`
 * cannot hide HEAD's ledger. `GIT_INDEX_FILE` stays, since the commit gate
 * names the index of a `git commit -a` or `git commit <path>` with it.
 * Replacement objects are off, so `git replace` cannot show the report other
 * content than the commit records, and a path is a path, never a pattern.
 */
function gitOptions(cwd: string, input?: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_') || name === 'GIT_INDEX_FILE'))
  return { cwd, input, maxBuffer: MAX_GIT_OUTPUT, env: { ...env, GIT_NO_REPLACE_OBJECTS: '1', GIT_LITERAL_PATHSPECS: '1', LC_ALL: 'C' } }
}

function runGit(cwd: string, args: ReadonlyArray<string>, input?: string): SpawnSyncReturns<Buffer> {
  return ok(spawnSync('git', args, gitOptions(cwd, input)), args)
}

function ok(result: SpawnSyncReturns<Buffer>, args: ReadonlyArray<string>): SpawnSyncReturns<Buffer> {
  if (result.status === 0) return result
  const reason = result.error?.message ?? (result.stderr.toString('utf8').trim() || `exit ${result.status}`)
  throw new RepositoryUnreadableError(`git ${args[0]} failed, so the debt report cannot read the repository: ${reason}`)
}

/** Whether git answered that the directory is in no repository, or is not installed. */
function outsideRepository(result: SpawnSyncReturns<Buffer>): boolean {
  if (result.error !== undefined) return 'code' in result.error && result.error.code === 'ENOENT'
  return result.status !== 0 && /not a git repository/i.test(result.stderr.toString('utf8'))
}

/** The source files git tracks or would track, or every one under the root outside a repository. */
function sourceFiles(root: string): string[] {
  const args = ['ls-files', '-z', '--cached', '--others', '--exclude-standard']
  const listed = spawnSync('git', args, gitOptions(root))
  if (outsideRepository(listed)) return walk(root, root).filter((file) => SOURCE_FILE.test(file) && existsSync(join(root, file))).sort()

  // A file git tracks as a symbolic link holds its target's name, not source: the index has none to read.
  const files = ok(listed, args).stdout.toString('utf8').split('\0').filter(Boolean)
  return files.filter((file) => SOURCE_FILE.test(file) && lstatSync(join(root, file), { throwIfNoEntry: false })?.isFile() === true).sort()
}

function walk(root: string, directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return SKIPPED_DIRECTORIES.has(entry.name) ? [] : walk(root, path)
    return entry.isFile() || (entry.isSymbolicLink() && statSync(path).isFile()) ? [relative(root, path).replaceAll('\\', '/')] : []
  })
}

function ignoredBy(ignore: ReadonlyArray<string>): (file: string) => boolean {
  const patterns = ignore.map(globPattern)
  return (file) => patterns.some((pattern) => pattern.test(file))
}

/** A path or glob as the ledger's `ignore` writes it: `*` within a segment, `**` across them; a bare name matches anywhere. */
function globPattern(glob: string): RegExp {
  const body = glob
    .split('**')
    .map((part) => part.split('*').map((text) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*'))
    .join('.*')
  return new RegExp(glob.includes('/') ? `^${body}(/|$)` : `(^|/)${body}$`)
}
