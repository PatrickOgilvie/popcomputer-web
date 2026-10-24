/**
 * Reads a shell command line into the simple commands it runs, for the
 * command policy: quotes and escapes, `&&`, `||`, `;`, pipes, subshells,
 * command substitutions, heredocs, and the variables and aliases the line
 * assigns itself. It reads and never runs anything. What it cannot know,
 * such as a variable from the environment, expands to nothing.
 */

/** A `NAME=value` before a command, or on its own. */
export interface Assignment {
  readonly name: string
  readonly value: string
}

/** One simple command, with its quotes removed and its own variables expanded. */
export interface SimpleCommand {
  readonly assignments: ReadonlyArray<Assignment>
  /** The command and its arguments. */
  readonly words: ReadonlyArray<string>
  /** The files its output is redirected to. */
  readonly writes: ReadonlyArray<string>
  /** The text of its heredoc or herestring, which it reads as input. */
  readonly input: string | undefined
  /** The command before it in a pipeline, whose output it reads. */
  readonly pipedFrom: SimpleCommand | undefined
}

interface Command {
  assignments: Assignment[]
  words: string[]
  writes: string[]
  input: string | undefined
  pipedFrom: SimpleCommand | undefined
  /** `for` and `case` heads, whose words are not a command. */
  ignored: boolean
}

/** Substitutions inside substitutions are read this deep. */
const MAX_DEPTH = 8
/** Words that begin a command without being one. */
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'esac', '!', 'function'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/
const NAME = /^[A-Za-z_][A-Za-z0-9_]*/

/** The simple commands a command line runs, in the order they appear, substitutions included. */
export function readCommands(script: string): SimpleCommand[] {
  const reader = new Reader(script, new Map(), new Map(), 0)
  reader.read()
  return reader.commands
}

/** The words of one command line, as `env -S` and an alias split them. */
export function splitWords(text: string): string[] {
  return readCommands(text)[0]?.words.slice() ?? []
}

class Reader {
  readonly commands: SimpleCommand[] = []
  private i = 0
  private current: Command = newCommand(undefined)
  private heredocs: Array<{ delimiter: string; stripTabs: boolean; command: Command }> = []

  constructor(
    private readonly text: string,
    private readonly variables: Map<string, string>,
    private readonly aliases: Map<string, string>,
    private readonly depth: number
  ) {}

  read(): void {
    const text = this.text

    while (this.i < text.length) {
      const c = text[this.i]

      if (c === ' ' || c === '\t' || c === '\r') {
        this.i++
      } else if (c === '\n') {
        this.i++
        this.finish(undefined)
        this.readHeredocs()
      } else if (c === '#') {
        this.skipLine()
      } else if (c === '\\' && text[this.i + 1] === '\n') {
        this.i += 2
      } else if (c === ';' || c === '&' || c === '|' || c === '(' || c === ')') {
        this.operator(c)
      } else if ((c === '<' || c === '>') && text[this.i + 1] === '(') {
        this.processSubstitution()
      } else if (c === '<' || c === '>') {
        this.redirection()
      } else if (/[0-9]/.test(c) && /^[0-9]+[<>]/.test(text.slice(this.i, this.i + 12))) {
        // A file descriptor before a redirection: 2>/dev/null, 2>&1.
        while (/[0-9]/.test(text[this.i])) this.i++
      } else {
        this.word()
      }
    }

    this.finish(undefined)
  }

  private operator(c: string): void {
    const next = this.text[this.i + 1]

    if (c === '&' && next === '>') {
      this.i += this.text[this.i + 2] === '>' ? 3 : 2
      this.redirectTarget()
      return
    }
    if (c === '|' && next !== '|') {
      this.i += next === '&' ? 2 : 1
      this.finish('|')
      return
    }

    this.i += (c === '&' && next === '&') || (c === '|' && next === '|') || (c === ';' && (next === ';' || next === '&')) ? 2 : 1
    this.finish(undefined)
  }

  private redirection(): void {
    const text = this.text
    const c = text[this.i]

    if (c === '<') {
      if (text.startsWith('<<<', this.i)) {
        this.i += 3
        const word = this.targetWord()
        this.current.input = (this.current.input ?? '') + word + '\n'
      } else if (text.startsWith('<<', this.i)) {
        const stripTabs = text[this.i + 2] === '-'
        this.i += stripTabs ? 3 : 2
        this.heredocs.push({ delimiter: this.targetWord(), stripTabs, command: this.current })
      } else if (text.startsWith('<>', this.i)) {
        this.i += 2
        this.redirectTarget()
      } else {
        this.i += text[this.i + 1] === '&' ? 2 : 1
        this.targetWord()
      }
      return
    }

    // >, >>, >|, >&
    this.i += text[this.i + 1] === '>' || text[this.i + 1] === '|' || text[this.i + 1] === '&' ? 2 : 1
    this.redirectTarget()
  }

  private redirectTarget(): void {
    const target = this.targetWord()
    // >&2 and >&- duplicate a descriptor rather than name a file.
    if (target !== '' && !/^[0-9]+$|^-$/.test(target)) this.current.writes.push(target)
  }

  private targetWord(): string {
    while (this.text[this.i] === ' ' || this.text[this.i] === '\t') this.i++
    return this.readWord(false).join(' ')
  }

  private processSubstitution(): void {
    const end = closingParen(this.text, this.i + 2)
    this.substitute(this.text.slice(this.i + 2, end))
    this.i = end + 1
  }

  private word(): void {
    const command = this.current
    const rest = this.text.slice(this.i)

    if (command.words.length === 0 && ASSIGNMENT.test(rest)) {
      const name = NAME.exec(rest)![0]
      this.i += rest.indexOf('=') + 1
      command.assignments.push({ name, value: this.readWord(false).join(' ') })
      return
    }

    const start = this.i
    const fields = this.readWord(true)
    const raw = this.text.slice(start, this.i)

    // `{` and `}` group commands wherever they stand alone, as in `f() { ...; }`.
    if (raw === '{' || raw === '}') {
      this.finish(undefined)
      return
    }
    if (command.words.length === 0) {
      if (KEYWORDS.has(raw)) {
        if (raw === 'function') command.ignored = true
        return
      }
      if (raw === 'for' || raw === 'select' || raw === 'case') command.ignored = true
      const alias = this.aliases.get(raw)
      if (alias !== undefined) {
        command.words.push(...splitWords(alias))
        return
      }
    }

    command.words.push(...fields)
  }

  /**
   * One word from the current position, as the fields it expands to: an
   * unquoted variable with spaces in it splits into several when `split`.
   */
  private readWord(split: boolean): string[] {
    const text = this.text
    const fields: string[] = ['']
    let quoted = false
    const append = (value: string) => {
      fields[fields.length - 1] += value
    }
    const appendSplit = (value: string) => {
      if (!split) return append(value)
      value.split(/[ \t\n]+/).forEach((part, index) => {
        if (index > 0) fields.push('')
        append(part)
      })
    }

    while (this.i < text.length) {
      const c = text[this.i]

      if (' \t\r\n;&|()<>'.includes(c)) break

      if (c === '\\') {
        if (text[this.i + 1] !== '\n') append(text[this.i + 1] ?? '')
        this.i += 2
        quoted = true
      } else if (c === "'") {
        const end = text.indexOf("'", this.i + 1)
        const close = end === -1 ? text.length : end
        append(text.slice(this.i + 1, close))
        this.i = close + 1
        quoted = true
      } else if (c === '"') {
        this.i++
        append(this.readDoubleQuoted())
        quoted = true
      } else if (c === '$') {
        const { value, isQuoted } = this.readDollar()
        if (isQuoted) {
          append(value)
          quoted = true
        } else {
          appendSplit(value)
        }
      } else if (c === '`') {
        this.readBackticks()
      } else {
        append(c)
        this.i++
      }
    }

    const nonEmpty = fields.filter((field) => field !== '')
    return nonEmpty.length > 0 || !quoted ? nonEmpty : ['']
  }

  private readDoubleQuoted(): string {
    const text = this.text
    let value = ''

    while (this.i < text.length && text[this.i] !== '"') {
      const c = text[this.i]

      if (c === '\\' && '$`"\\\n'.includes(text[this.i + 1] ?? '')) {
        if (text[this.i + 1] !== '\n') value += text[this.i + 1]
        this.i += 2
      } else if (c === '$') {
        value += this.readDollar(true).value
      } else if (c === '`') {
        this.readBackticks()
      } else {
        value += c
        this.i++
      }
    }

    this.i++
    return value
  }

  /** `$name`, `${name...}`, `$(...)`, `$((...))`, `$'...'` and `$"..."`, from the `$`. */
  private readDollar(inDoubleQuotes = false): { value: string; isQuoted: boolean } {
    const text = this.text
    const next = text[this.i + 1]

    if (next === '(' && text[this.i + 2] === '(') {
      this.i = closingParen(text, closingParen(text, this.i + 3) + 1) + 1
      return { value: '', isQuoted: inDoubleQuotes }
    }
    if (next === '(') {
      const end = closingParen(text, this.i + 2)
      this.substitute(text.slice(this.i + 2, end))
      this.i = end + 1
      return { value: '', isQuoted: inDoubleQuotes }
    }
    if (next === '{') {
      const end = text.indexOf('}', this.i + 2)
      const close = end === -1 ? text.length : end
      const inner = text.slice(this.i + 2, close)
      this.i = close + 1
      return { value: this.parameter(inner), isQuoted: inDoubleQuotes }
    }
    if (next === "'" && !inDoubleQuotes) {
      this.i += 2
      return { value: this.readAnsiQuoted(), isQuoted: true }
    }
    if (next === '"' && !inDoubleQuotes) {
      this.i += 2
      return { value: this.readDoubleQuoted(), isQuoted: true }
    }

    const name = NAME.exec(text.slice(this.i + 1))
    if (name) {
      this.i += 1 + name[0].length
      return { value: this.variables.get(name[0]) ?? '', isQuoted: inDoubleQuotes }
    }
    if (next !== undefined && /[0-9@*#?$!-]/.test(next)) {
      this.i += 2
      return { value: '', isQuoted: inDoubleQuotes }
    }

    this.i++
    return { value: '$', isQuoted: true }
  }

  /** `${NAME}`, and the defaults `${NAME:-word}` and `${NAME:=word}` give when NAME is unset. */
  private parameter(inner: string): string {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-=+])(.*))?$/s.exec(inner)
    if (!match) return ''

    const [, name, operator, word = ''] = match
    const value = this.variables.get(name)
    const fallback = splitWords(word).join(' ')

    if (operator?.endsWith('+')) return value ? fallback : ''
    if (operator !== undefined && (value === undefined || (operator.startsWith(':') && value === ''))) return fallback
    return value ?? ''
  }

  private readAnsiQuoted(): string {
    const text = this.text
    const escapes: Record<string, string> = { n: '\n', t: '\t', r: '\r', e: '\x1b', a: '\x07', '\\': '\\', "'": "'", '"': '"' }
    let value = ''

    while (this.i < text.length && text[this.i] !== "'") {
      if (text[this.i] !== '\\') {
        value += text[this.i++]
        continue
      }
      const escape = text[this.i + 1] ?? ''
      const hex = /^x([0-9a-fA-F]{1,2})/.exec(text.slice(this.i + 1))
      const octal = /^([0-7]{1,3})/.exec(text.slice(this.i + 1))

      if (hex) {
        value += String.fromCharCode(Number.parseInt(hex[1], 16))
        this.i += 1 + hex[0].length
      } else if (octal) {
        value += String.fromCharCode(Number.parseInt(octal[1], 8))
        this.i += 1 + octal[0].length
      } else {
        value += escapes[escape] ?? escape
        this.i += 2
      }
    }

    this.i++
    return value
  }

  private readBackticks(): void {
    const text = this.text
    let inner = ''
    this.i++

    while (this.i < text.length && text[this.i] !== '`') {
      if (text[this.i] === '\\' && '`\\$'.includes(text[this.i + 1] ?? '')) {
        inner += text[this.i + 1]
        this.i += 2
      } else {
        inner += text[this.i++]
      }
    }

    this.i++
    this.substitute(inner)
  }

  /** The commands of a substitution run too, with the variables assigned so far. */
  private substitute(script: string): void {
    if (this.depth >= MAX_DEPTH) return
    const reader = new Reader(script, new Map(this.variables), new Map(this.aliases), this.depth + 1)
    reader.read()
    this.commands.push(...reader.commands)
  }

  private skipLine(): void {
    const end = this.text.indexOf('\n', this.i)
    this.i = end === -1 ? this.text.length : end
  }

  private readHeredocs(): void {
    for (const heredoc of this.heredocs) {
      let body = ''

      while (this.i < this.text.length) {
        const end = this.text.indexOf('\n', this.i)
        const close = end === -1 ? this.text.length : end
        const line = this.text.slice(this.i, close)
        this.i = close + 1

        if ((heredoc.stripTabs ? line.replace(/^\t+/, '') : line) === heredoc.delimiter) break
        body += line + '\n'
      }

      heredoc.command.input = (heredoc.command.input ?? '') + body
    }
    this.heredocs = []
  }

  private finish(separator: '|' | undefined): void {
    const command = this.current
    this.current = newCommand(undefined)

    if (command.ignored || (command.words.length === 0 && command.assignments.length === 0)) return

    const simple: SimpleCommand = command
    this.commands.push(simple)
    this.remember(command)
    if (separator === '|') this.current.pipedFrom = simple
  }

  /** Variables and aliases the line sets for the commands after it. */
  private remember(command: Command): void {
    const [name, ...args] = command.words

    if (name === undefined) {
      for (const { name, value } of command.assignments) this.variables.set(name, value)
    } else if (name === 'export' || name === 'declare' || name === 'typeset' || name === 'local' || name === 'readonly') {
      for (const arg of args) {
        const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(arg)
        if (assignment) this.variables.set(assignment[1], assignment[2])
      }
    } else if (name === 'unset') {
      for (const arg of args) this.variables.delete(arg)
    } else if (name === 'alias') {
      for (const arg of args) {
        const alias = /^([^=\s]+)=(.*)$/s.exec(arg)
        if (alias) this.aliases.set(alias[1], alias[2])
      }
    }
  }
}

function newCommand(pipedFrom: SimpleCommand | undefined): Command {
  return { assignments: [], words: [], writes: [], input: undefined, pipedFrom, ignored: false }
}

/** The index of the `)` that closes a `(` opened just before `start`, past quotes and nested parentheses. */
function closingParen(text: string, start: number): number {
  let depth = 1
  let i = start

  while (i < text.length) {
    const c = text[i]

    if (c === '\\') {
      i += 2
      continue
    }
    if (c === "'") {
      const end = text.indexOf("'", i + 1)
      i = end === -1 ? text.length : end + 1
      continue
    }
    if (c === '"') {
      i++
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1
      i++
      continue
    }
    if (c === '(') depth++
    if (c === ')' && --depth === 0) return i
    i++
  }

  return text.length
}
