/**
 * The path policy: which files a change may touch without the owner. git's
 * hooks and config, which nobody reviews, are refused; the fence's own
 * files ask the owner. A path is normalised first, and matched without
 * regard to case, as macOS's file systems match it.
 */
import { isAbsolutePath, joinPath, normalizePath } from './path.js'
import { GLOB_ANY, GLOB_ONE, UNREAD, UNREAD_WORDS, isDynamic, isGlob, known } from './shell.js'
import type { Finding } from './verdict.js'

interface ProtectedPath {
  readonly pattern: RegExp
  /** Paths it protects, relative to an application's root, which a glob is tried against. */
  readonly examples: ReadonlyArray<string>
  readonly decision: 'deny' | 'ask'
}

const PROTECTED_PATHS: ReadonlyArray<ProtectedPath> = [
  // Files nobody reviews, whose change switches the gate or the agent's hook off: git's hooks and its config.
  { pattern: /(^|\/)\.git\/hooks(\/|$)/i, examples: ['.git/hooks/pre-commit', '.git/hooks/commit-msg', '.git/hooks/pre-push'], decision: 'deny' },
  { pattern: /(^|\/)\.git\/config$/i, examples: ['.git/config'], decision: 'deny' },
  // The mark of the owner's `--allow-increase`, by which the gate takes a raised debt ledger.
  { pattern: /(^|\/)\.git\/(?:worktrees\/[^/]+\/)?popweb-fence(\/|$)/i, examples: ['.git/popweb-fence/lint-debt.json.json'], decision: 'deny' },
  { pattern: /(^|\/)\.gitconfig$|(^|\/)\.config\/git\/config$/i, examples: [], decision: 'deny' },
  { pattern: /(^|\/)\.?lefthook-local\.ya?ml$/i, examples: ['lefthook-local.yml', '.lefthook-local.yml', 'lefthook-local.yaml'], decision: 'deny' },
  { pattern: /(^|\/)node_modules\/@popcomputer\/web\/dist\/fence(\/|$)/i, examples: ['node_modules/@popcomputer/web/dist/fence/cli.js'], decision: 'deny' },
  // The fence's own files, which the owner signs off.
  { pattern: /(^|\/)\.?lefthook\.ya?ml$/i, examples: ['lefthook.yml', '.lefthook.yml', 'lefthook.yaml'], decision: 'ask' },
  { pattern: /(^|\/)\.githooks(\/|$)/i, examples: ['.githooks/pre-commit'], decision: 'ask' },
  // The hook managers whose switches the policy refuses: husky, pre-commit, simple-git-hooks.
  { pattern: /(^|\/)\.husky(\/|$)/i, examples: ['.husky/pre-commit'], decision: 'ask' },
  { pattern: /(^|\/)\.pre-commit-config\.ya?ml$/i, examples: ['.pre-commit-config.yaml'], decision: 'ask' },
  { pattern: /(^|\/)\.?simple-git-hooks\.(?:json|[cm]?js)$/i, examples: ['.simple-git-hooks.json', 'simple-git-hooks.js'], decision: 'ask' },
  { pattern: /(^|\/)oxlint\.config\.[cm]?[jt]s$/i, examples: ['oxlint.config.ts', 'oxlint.config.js', 'oxlint.config.mjs'], decision: 'ask' },
  { pattern: /(^|\/)\.?oxlintrc\.json$/i, examples: ['.oxlintrc.json'], decision: 'ask' },
  { pattern: /(^|\/)\.claude\/settings(\.local)?\.json$/i, examples: ['.claude/settings.json', '.claude/settings.local.json'], decision: 'ask' },
  { pattern: /(^|\/)\.cursor\/hooks\.json$/i, examples: ['.cursor/hooks.json'], decision: 'ask' },
  { pattern: /(^|\/)lint-debt\.json$/i, examples: ['lint-debt.json'], decision: 'ask' },
]

/** The protected paths, with the directory core.hooksPath names, whose files are the gate itself. */
function protectedPaths(hooksPath: string | undefined): ReadonlyArray<ProtectedPath> {
  const directory = hooksPath === undefined ? '' : normalizePath(hooksPath.trim().replace(/^~\//, ''))
  if (directory === '' || directory === '/') return PROTECTED_PATHS

  const pattern = new RegExp(`${isAbsolutePath(hooksPath ?? '') ? '^' : '(^|/)'}${escapeRegExp(directory)}(/|$)`, 'i')
  return [...PROTECTED_PATHS, { pattern, examples: [`${directory}/pre-commit`], decision: 'ask' }]
}

/** A change to one file, by an edit (no command) or by a shell command. */
export function pathFindings(path: string, command: string | undefined, hooksPath?: string): Finding[] {
  const file = normalizePath(path)
  const matches = protectedPaths(hooksPath).filter((entry) => entry.pattern.test(file))
  const entry = matches.find((match) => match.decision === 'deny') ?? matches[0]
  return entry === undefined ? [] : [finding(entry.decision, file, command)]
}

/**
 * A file a command writes, as a word with marks: a glob is tried against
 * each protected path, and an expansion's known text is all the fence reads
 * of it. Undefined `cwd`: a `cd` the fence could not follow came before.
 */
export function writeFindings(word: string, cwd: string | undefined, command: string, hooksPath?: string): Finding[] {
  const glob = isGlob(word)

  if (!isDynamic(word) || glob) {
    const path = joinPath(cwd, word)
    if (path === undefined) {
      return [{
        decision: 'ask',
        rule: 'unreadable',
        subject: command,
        reason: `\`${command}\` writes ${displayPath(word)} in a directory a \`cd\` before it names with what the fence cannot read. Approve it only if you expected it.`,
      }]
    }
    return glob ? globFindings(path, command, hooksPath) : pathFindings(path, command, hooksPath)
  }

  const text = known(word)
  return text === '' ? [] : pathFindings(joinPath(cwd, text) ?? text, command, hooksPath)
}

/**
 * A link to `target`, as `ln` makes one: a change to the protected path it
 * leads to, or to those below the directory it leads to, which a write
 * through the link changes under a name the path policy does not know. A
 * target the link's own directory resolves is matched by its last parts.
 */
export function linkFindings(target: string, command: string, hooksPath?: string): Finding[] {
  const path = normalizePath(known(target)).toLowerCase()
  const leadsTo = (example: string) => {
    const parts = example.toLowerCase().split('/')
    return parts.some((_, end) => {
      const above = parts.slice(0, end + 1).join('/')
      return path === above || path.endsWith(`/${above}`)
    })
  }
  const led = protectedPaths(hooksPath).flatMap((entry) => entry.examples.filter(leadsTo).map((example) => finding(entry.decision, example, command)))
  return [...pathFindings(known(target), command, hooksPath), ...led]
}

/**
 * The fence's files a git pathspec, as `.`, `src` or `*.json`, covers from
 * the directory `cwd`. Magic, as `:/`, an expansion, or a directory the fence
 * cannot place covers the whole tree; git's own directory holds none.
 */
export function pathspecCovers(spec: string, cwd: string | undefined, hooksPath?: string): string[] {
  const examples = protectedPaths(hooksPath).flatMap((entry) => entry.examples).filter((example) => !/^(\.git|node_modules)\//i.test(example))
  const unknown = spec.startsWith(':') || spec.includes(UNREAD) || spec.includes(UNREAD_WORDS)
  const path = unknown ? undefined : joinPath(cwd, spec)
  if (path === undefined || path === '' || path.startsWith('..') || isAbsolutePath(path)) return examples

  // git matches a pathspec's `*` across `/`, and the files below a directory it names.
  const source = [...path].map((char) => (char === '*' || char === GLOB_ANY ? '.*' : char === '?' || char === GLOB_ONE ? '[^/]' : escapeRegExp(char))).join('')
  const pattern = new RegExp(`^${source}(/.*)?$`, 'i')
  return examples.filter((example) => pattern.test(example))
}

/** A path, or a glob, as each protected file it names: the files the path policy gives as examples. */
export function protectedFileFindings(path: string, command: string, hooksPath?: string): Finding[] {
  return globFindings(normalizePath(path), command, hooksPath)
}

/** A glob, as each protected path it could name. */
function globFindings(glob: string, command: string, hooksPath: string | undefined): Finding[] {
  const pattern = globPattern(glob)
  const entries = protectedPaths(hooksPath).flatMap((entry) => entry.examples.filter((example) => pattern.test(example)).map((example) => ({ entry, example })))
  const match = entries.find(({ entry }) => entry.decision === 'deny') ?? entries[0]
  return match === undefined ? [] : [finding(match.entry.decision, match.example, command)]
}

function globPattern(glob: string): RegExp {
  let source = ''
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]
    // A wildcard at a name's start does not match a leading dot.
    const atStart = i === 0 || glob[i - 1] === '/'
    if (char === GLOB_ANY) source += atStart ? '(?!\\.)[^/]*' : '[^/]*'
    else if (char === GLOB_ONE) source += atStart ? '[^/.]' : '[^/]'
    else source += escapeRegExp(char)
  }
  return new RegExp(`^${source}$`, 'i')
}

function finding(decision: 'deny' | 'ask', file: string, command: string | undefined): Finding {
  if (decision === 'deny') {
    const change = command === undefined ? `Changing ${file}` : `\`${command}\` changes ${file}, which`
    return {
      decision,
      rule: 'hook-bypass',
      subject: command ?? file,
      reason: `${change} switches off the commit gate or the agent's hook, and nobody reviews it. Fix what the gate reports instead; only the owner changes the gate.`,
    }
  }
  return {
    decision,
    rule: 'fence-change',
    subject: command ?? file,
    reason: `${command === undefined ? `${file} is` : `\`${command}\` changes ${file},`} part of the fence: the commit gate, the lint configuration, the agent's hooks or the debt ledger. Approve it only if you asked for this change.`,
  }
}

function displayPath(word: string): string {
  return word.replaceAll(GLOB_ANY, '*').replaceAll(GLOB_ONE, '?')
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
