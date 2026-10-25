/**
 * The debt report: every comment that turns a lint rule or a type check off,
 * with the reason it gives, counted against a committed ledger so the count
 * only shrinks. A directive is an Oxlint or ESLint `disable` comment, a
 * TypeScript `@ts-expect-error`, `@ts-ignore` or `@ts-nocheck`, or an Effect
 * `@effect-diagnostics` comment that lowers a rule below error.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

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

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.wrangler'])
/** Words after which a `/` starts a regular expression rather than a division. */
const BEFORE_EXPRESSION = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await'])

const LINT = /^\s*((?:oxlint|eslint)-disable(?:-next-line|-line)?)(?=\s|$)([\s\S]*)$/
const TYPESCRIPT = /^\s*(@ts-(?:expect-error|ignore|nocheck))(?![\w-])([\s\S]*)$/
const EFFECT = /^\s*(@effect-diagnostics(?:-next-line)?)(?=\s|$)([\s\S]*)$/
/** ESLint's separator between a directive and its reason: two or more dashes with space around them. */
const REASON = /(?:^|\s)-{2,}(?:\s|$)/

/** The disable directives in one file's source. */
export function disableDirectives(source: string, file = ''): DisableDirective[] {
  return comments(source).flatMap(({ text, line }) => {
    const body = text.replace(/^\*+/, '').replace(/\n\s*\*/g, '\n')
    const directive = readDirective(body)
    return directive === undefined ? [] : [{ file, line, ...directive }]
  })
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

/**
 * The comments of a JavaScript or TypeScript source, past strings, template
 * literals and regular expressions, which may hold text that looks like one.
 * A string ends at its line's end, so text it misreads, such as an
 * apostrophe in JSX, cannot hide the comments after that line.
 */
function comments(source: string): Array<{ readonly text: string; readonly line: number }> {
  const found: Array<{ readonly text: string; readonly line: number }> = []
  const templates: number[] = []
  let braces = 0
  let line = 1
  let regexAllowed = true
  let i = source.startsWith('#!') ? source.indexOf('\n') : 0

  const advanceTo = (end: number) => {
    for (let k = i; k < end; k++) if (source[k] === '\n') line++
    i = end
  }
  // From inside a template literal to its end, or to a `${`, which hands back to the code.
  const template = () => {
    while (i < source.length) {
      const c = source[i]
      if (c === '\\') {
        advanceTo(i + 2)
      } else if (c === '`') {
        i++
        regexAllowed = false
        return
      } else if (c === '$' && source[i + 1] === '{') {
        templates.push(braces)
        braces++
        i += 2
        regexAllowed = true
        return
      } else {
        advanceTo(i + 1)
      }
    }
  }

  if (i === -1) return found

  while (i < source.length) {
    const c = source[i]
    const next = source[i + 1]

    if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i)
      const close = end === -1 ? source.length : end
      found.push({ text: source.slice(i + 2, close), line })
      i = close
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      const close = end === -1 ? source.length : end
      found.push({ text: source.slice(i + 2, close), line })
      advanceTo(Math.min(close + 2, source.length))
    } else if (c === '"' || c === "'") {
      let k = i + 1
      while (k < source.length && source[k] !== c && source[k] !== '\n') k += source[k] === '\\' ? 2 : 1
      advanceTo(Math.min(k + (source[k] === c ? 1 : 0), source.length))
      regexAllowed = false
    } else if (c === '`') {
      i++
      template()
    } else if (c === '/' && regexAllowed) {
      let k = i + 1
      let inClass = false
      while (k < source.length && source[k] !== '\n' && (inClass || source[k] !== '/')) {
        if (source[k] === '\\') k++
        else if (source[k] === '[') inClass = true
        else if (source[k] === ']') inClass = false
        k++
      }
      i = source[k] === '/' ? k + 1 : i + 1
      regexAllowed = false
    } else if (c === '}' && templates.length > 0 && templates[templates.length - 1] === braces - 1) {
      templates.pop()
      braces--
      i++
      template()
    } else if (/[A-Za-z_$]/.test(c)) {
      const word = /^[\w$]+/.exec(source.slice(i, i + 64))![0]
      regexAllowed = BEFORE_EXPRESSION.has(word)
      i += word.length
    } else if (/[0-9]/.test(c)) {
      i = i + /^[\w.]+/.exec(source.slice(i, i + 64))![0].length
      regexAllowed = false
    } else {
      if (c === '\n') line++
      if (c === '{') braces++
      if (c === '}') braces--
      if (!/\s/.test(c)) regexAllowed = c !== ')' && c !== ']' && c !== '}'
      i++
    }
  }

  return found
}

/** The disable directives in an application's source files, outside its ignored paths. */
export function scanDebt(root: string, ignore: ReadonlyArray<string> = []): DisableDirective[] {
  const ignored = ignore.map(globPattern)

  return sourceFiles(root)
    .filter((file) => !ignored.some((pattern) => pattern.test(file)))
    .flatMap((file) => disableDirectives(readFileSync(join(root, file), 'utf8'), file))
}

/** The ledger to commit for these directives. */
export function debtLedger(directives: ReadonlyArray<DisableDirective>, ignore: ReadonlyArray<string> = []): DebtLedger {
  const entries = directives.map(({ file, directive, rules, reason }) => ({ file, directive, rules, reason }))
  entries.sort((a, b) => entryKey(a).localeCompare(entryKey(b)))
  return { count: entries.length, ignore, directives: entries }
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

/** A ledger read back from its JSON, or undefined when the text is not one. */
export function parseLedger(text: string): DebtLedger | undefined {
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null || !Array.isArray((value as DebtLedger).directives)) return undefined
    const ledger = value as Partial<DebtLedger>
    return { count: ledger.directives!.length, ignore: Array.isArray(ledger.ignore) ? ledger.ignore : [], directives: ledger.directives! }
  } catch {
    return undefined
  }
}

/** One directive as a line of the report: where, what it turns off, and why. */
export function describeDirective(directive: DisableDirective): string {
  const rules = directive.rules.length === 0 ? '' : ` ${directive.rules.join(', ')}`
  return `${directive.file}:${directive.line}  ${directive.directive}${rules}  ${directive.reason === null ? '(no reason given)' : `-- ${directive.reason}`}`
}

function entryKey(entry: Omit<DisableDirective, 'line'>): string {
  return JSON.stringify([entry.file, entry.directive, entry.rules, entry.reason])
}

/** The source files git tracks or would track, or every one under the root outside a repository. */
function sourceFiles(root: string): string[] {
  const git = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
  const files = git.status === 0 ? git.stdout.split('\0').filter(Boolean) : walk(root, root)

  return files.filter((file) => SOURCE_FILE.test(file) && existsSync(join(root, file))).sort()
}

function walk(root: string, directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return SKIPPED_DIRECTORIES.has(entry.name) ? [] : walk(root, path)
    return entry.isFile() || (entry.isSymbolicLink() && statSync(path).isFile()) ? [relative(root, path).replaceAll('\\', '/')] : []
  })
}

/** A path or glob as the ledger's `ignore` writes it: `*` within a segment, `**` across them; a bare name matches anywhere. */
function globPattern(glob: string): RegExp {
  const body = glob
    .split('**')
    .map((part) => part.split('*').map((text) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*'))
    .join('.*')
  return new RegExp(glob.includes('/') ? `^${body}(/|$)` : `(^|/)${body}$`)
}
