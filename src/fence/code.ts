/**
 * Programs the fence reads: the strings a program's code holds, which it
 * reads as command lines, and whether the code can start a process, whose
 * command a program may build at run time where no string spells it.
 */

/** The languages whose code the fence reads, and the shell. */
export type CodeKind = 'js' | 'python' | 'perl' | 'ruby' | 'php' | 'awk' | 'applescript'

/**
 * Calls that start a process, in each language. Code that names one may run
 * a command it builds at run time, which no string of it spells out.
 */
const STARTS_PROCESS: Readonly<Record<CodeKind, RegExp>> = {
  js: /child_process|\bspawn(?:Sync)?\s*\(|(?<![.\w])exec(?:Sync|File|FileSync)?\s*\(|\bexeca\w*\s*\(|\bfork\s*\(|Bun\s*\.\s*(?:spawn|\$)|\$`|Deno\s*\.\s*(?:Command|run)\b|process\s*\.\s*binding|spawn_sync/,
  python: /\bsubprocess\b|\bos\s*\.\s*(?:system|popen|exec\w*|spawn\w*|posix_spawn\w*|fork)|\bpty\s*\.\s*spawn|\bpexpect\b|\bcommands\s*\.\s*getoutput/,
  perl: /\bsystem\b|\bexec\b|`|\bqx\b|\bopen\s*\(?[^;]*\||\bfork\b|IPC::/,
  ruby: /\bsystem\b|\bexec\b|`|%x|\bspawn\b|IO\s*\.\s*popen|Open3|PTY|\bfork\b/,
  php: /\b(?:exec|shell_exec|system|passthru|popen|proc_open|pcntl_exec)\s*\(|`/,
  // `system(...)`, `cmd | getline`, `print | cmd` and gawk's `|&`.
  awk: /\bsystem\s*\(|\|\s*getline|\|&|\bprintf?\b[^;{}\n]*?(?<!\|)\|(?!\|)/,
  // `do shell script`, Terminal's `do script` and JavaScript's `doShellScript`.
  applescript: /\bdo\s+(?:shell\s+)?script\b|\bdo(?:Shell)?Script\b/i,
}

/** Whether a program's code can start a process. */
export function startsProcess(source: string, kind: CodeKind): boolean {
  return STARTS_PROCESS[kind].test(source)
}

/** The language a file runs in: by its `#!` line, then by its extension; a shell script otherwise. */
export function codeKind(path: string, source: string): CodeKind | 'shell' {
  const shebang = /^#!.*?\b(node|bun|deno|tsx|ts-node|python[\d.]*|perl|ruby|php|[gmn]?awk|osascript|sh|bash|zsh|dash|ksh)\b/.exec(source)?.[1]
  const name = shebang ?? /\.([cm]?[jt]sx?|py|pl|rb|php|awk|applescript)$/i.exec(path)?.[1]?.toLowerCase() ?? ''

  if (/^(node|bun|deno|tsx|ts-node|[cm]?[jt]sx?)$/.test(name)) return 'js'
  if (/^(python[\d.]*|py)$/.test(name)) return 'python'
  if (name === 'perl' || name === 'pl') return 'perl'
  if (name === 'ruby' || name === 'rb') return 'ruby'
  if (name === 'php') return 'php'
  if (name.endsWith('awk')) return 'awk'
  if (name === 'osascript' || name === 'applescript') return 'applescript'
  return 'shell'
}

/**
 * What may sit between one string of a command a program runs and the next:
 * commas and brackets, as `spawnSync('git', ['commit', '-n'])` writes them,
 * or an object's `args`, `argv` or `cmd` key, as
 * `new Deno.Command('git', { args: ['commit', '-n'] })` does.
 */
const ARGUMENT_SEPARATOR = /^[\s,[\]]*(?:\{\s*(?:args|argv|cmd)\s*:[\s[]*)?$/

/** Each string literal of a program, and each run of literals in one argument list joined as a command line. */
export function commandsInCode(source: string, kind: CodeKind): string[] {
  const runs: string[][] = []
  let run: string[] = []
  let last = 0

  for (const literal of literals(source, kind)) {
    if (run.length > 0 && !ARGUMENT_SEPARATOR.test(source.slice(last, literal.start))) {
      runs.push(run)
      run = []
    }
    run.push(literal.text)
    last = literal.end
  }
  if (run.length > 0) runs.push(run)

  return runs.flatMap((strings) => (strings.length === 1 ? strings : [...strings, strings.map(quote).join(' ')]))
}

interface Literal {
  readonly text: string
  readonly start: number
  readonly end: number
}

/** The string literals of a program, past its comments: `//` and `/* *\/` in JavaScript and PHP, `#` elsewhere. */
function literals(source: string, kind: CodeKind): Literal[] {
  const found: Literal[] = []
  const slashComments = kind === 'js' || kind === 'php'
  let i = 0

  while (i < source.length) {
    const c = source[i]

    if (slashComments && c === '/' && source[i + 1] === '/') {
      i = lineEnd(source, i)
    } else if (slashComments && c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      i = end === -1 ? source.length : end + 2
    } else if (kind !== 'js' && c === '#') {
      i = lineEnd(source, i)
    } else if (c === "'" || c === '"' || c === '`') {
      const literal = readLiteral(source, i, kind)
      if (literal === undefined) i++
      else {
        found.push(literal)
        i = literal.end
      }
    } else {
      i++
    }
  }
  return found
}

/** The literal opened at `start`, or undefined for a quote that opens none, such as one a line ends before closing. */
function readLiteral(source: string, start: number, kind: CodeKind): Literal | undefined {
  const quote = source[start]
  const triple = kind === 'python' && source.startsWith(quote.repeat(3), start)
  const open = triple ? 3 : 1
  const template = quote === '`' && kind === 'js'
  let text = ''
  let i = start + open

  while (i < source.length) {
    const c = source[i]
    if (triple ? source.startsWith(quote.repeat(3), i) : c === quote) return { text, start, end: i + open }
    if (c === '\n' && !triple && quote !== '`') return undefined
    if (c === '\\') {
      text += source[i + 1] ?? ''
      i += 2
    } else if (template && c === '$' && source[i + 1] === '{') {
      // A placeholder's code stays in the text, as the shell's own `${...}`.
      const end = closingBrace(source, i + 2)
      text += source.slice(i, end + 1)
      i = end + 1
    } else {
      text += c
      i++
    }
  }
  return undefined
}

function closingBrace(source: string, from: number): number {
  let depth = 1
  for (let i = from; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return i
  }
  return source.length
}

function lineEnd(source: string, from: number): number {
  const end = source.indexOf('\n', from)
  return end === -1 ? source.length : end
}

function quote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`
}
