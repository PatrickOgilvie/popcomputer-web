/**
 * Reads a shell command line into the simple commands it runs, for the
 * command policy. tree-sitter's bash grammar parses the line, and this walks
 * the tree in the order the shell runs it: lists, pipelines, subshells,
 * groups, `if`, loops, `case`, functions, and every command and process
 * substitution, arithmetic expansion and heredoc body their words hold. It
 * reads and never runs anything.
 *
 * Each word is Literal, the text a program receives after quote removal, or
 * holds a mark where the shell would put text the reader cannot know: a `$`
 * expansion of any kind, a command or process substitution, arithmetic, a
 * tilde, a glob. It tracks no variable's value. A brace expansion of
 * literal text gives its words, as the shell does; any other is unknown.
 * What the reader cannot parse, it names in `unreadable`.
 */
import type { Node, Tree } from 'web-tree-sitter'
import { isAbsolutePath, joinPath, normalizePath } from './path.js'
import { parseBash } from './parser.js'

/** Text the reader cannot know, inside one word. */
export const UNREAD = '\u0000'
/** Text the reader cannot know, which the shell may split into several words. */
export const UNREAD_WORDS = '\u0001'
/** A glob's `*`: any names in one directory, which may be several words. */
export const GLOB_ANY = '\u0002'
/** A glob's `?` or `[...]`: one character of a name. */
export const GLOB_ONE = '\u0003'

const MARKS = [UNREAD, UNREAD_WORDS, GLOB_ANY, GLOB_ONE]
const isMark = (char: string): boolean => MARKS.includes(char)

/** A word's runs of text the reader could read, and each mark between them on its own. */
export function wordParts(word: string): string[] {
  const parts: string[] = []
  let run = ''
  for (const char of word) {
    if (!isMark(char)) {
      run += char
      continue
    }
    if (run !== '') parts.push(run)
    parts.push(char)
    run = ''
  }
  if (run !== '') parts.push(run)
  return parts
}

/** Whether a word holds text the reader cannot know. */
export const isDynamic = (word: string): boolean => [...word].some(isMark)

/** A word without the text the reader cannot know. */
export const known = (word: string): string => [...word].filter((char) => !isMark(char)).join('')

/** Whether a word's only unknown text is a glob's, which names files the fence can match. */
export const isGlob = (word: string): boolean => (word.includes(GLOB_ANY) || word.includes(GLOB_ONE)) && !word.includes(UNREAD) && !word.includes(UNREAD_WORDS)

const SHOWN: Readonly<Record<string, string>> = { [UNREAD]: '$(…)', [UNREAD_WORDS]: '$(…)', [GLOB_ANY]: '*', [GLOB_ONE]: '?' }

/** A word as a message shows it: each glob's character, and `$(…)` where an expansion was. */
export const display = (word: string): string => wordParts(word).map((part) => SHOWN[part] ?? part).join('')

/** A `NAME=value` before a command, or on its own. */
export interface Assignment {
  readonly name: string
  readonly value: string
}

/** Where a command reads its standard input from. */
export type Stdin =
  /** A heredoc or a herestring: its text, with marks. */
  | { readonly kind: 'text'; readonly text: string }
  /** `< file`. */
  | { readonly kind: 'file'; readonly path: string }
  /** The command before it in a pipeline. */
  | { readonly kind: 'pipe'; readonly from: SimpleCommand }
  /** A pipe from a compound command, such as `(echo ...) | bash`. */
  | { readonly kind: 'unreadable' }

/** One simple command, with its quotes removed. */
export interface SimpleCommand {
  readonly assignments: ReadonlyArray<Assignment>
  /** The command and its arguments, with marks. */
  readonly words: ReadonlyArray<string>
  /** The files its redirects write, with marks. */
  readonly writes: ReadonlyArray<string>
  readonly stdin: Stdin | undefined
  /** The directory it runs in, relative to where the line starts (`''`); undefined after a `cd` the reader cannot follow. */
  readonly cwd: string | undefined
}

/** What a command line runs, and what of it the reader could not read. */
export interface ShellScript {
  readonly commands: ReadonlyArray<SimpleCommand>
  readonly unreadable: ReadonlyArray<string>
}

/** Substitutions inside substitutions are read this deep. */
const MAX_NESTING = 16
/** A brace expansion gives at most this many words before it counts as unknown. */
const MAX_BRACE_WORDS = 64

/** Node types the reader walks as statements; any other is a word, or holds words. */
const STATEMENTS = new Set([
  'command', 'declaration_command', 'unset_command', 'variable_assignment', 'variable_assignments', 'redirected_statement',
  'pipeline', 'subshell', 'list', 'negated_command', 'compound_statement', 'if_statement', 'elif_clause', 'else_clause',
  'while_statement', 'for_statement', 'c_style_for_statement', 'case_statement', 'case_item', 'function_definition',
  'test_command', 'do_group', 'comment', 'ERROR',
])
const WRITE_REDIRECTS = new Set(['>', '>>', '>|', '&>', '&>>', '<>'])

/** The commands a command line runs, in the order the shell runs them, substitutions first. */
export function readScript(text: string): ShellScript {
  const reader = new Reader()
  reader.read(text, { cwd: '' })
  return { commands: reader.commands, unreadable: reader.unreadable }
}

/** The words of the first command a line holds, as `git`'s aliases are split. */
export function splitWords(text: string): string[] {
  return readScript(text).commands[0]?.words.slice() ?? []
}

/** The state a `cd` changes: one per shell, copied into each subshell. */
interface Shell {
  cwd: string | undefined
}

/** Redirects the grammar attaches to a list or a compound, which apply to its last command or to all of it. */
interface Trailing {
  readonly writes: ReadonlyArray<string>
  readonly args: ReadonlyArray<string>
  readonly stdin: Stdin | undefined
}

/** What a command's redirects add: the files they write, words the grammar put after them, its input, and what the grammar put inside a heredoc's redirect. */
interface Redirects {
  writes: string[]
  args: string[]
  stdin: Stdin | undefined
  /** `cat <<EOF | bash`: the pipeline after the heredoc's command. */
  pipes: Node[]
  /** `cat <<EOF && next`: the statement after it. */
  after: Node[]
}

/** One character of a word as it is built, kept apart until globs and braces are read. */
interface Char {
  readonly text: string
  /** Unquoted text the shell may expand: `{`, `*`, `~` and the rest. */
  readonly plain: boolean
}

class Reader {
  readonly commands: SimpleCommand[] = []
  readonly unreadable: string[] = []
  private nesting = 0
  /** The text of the tree being walked, for what comes before a comment. */
  private source = ''

  read(text: string, shell: Shell): void {
    this.walk(text, (root) => {
      if (root.hasError) this.unreadable.push(describeError(root))
      this.block(root, shell, undefined)
    })
  }

  /** Parses `text` and walks its tree, with `source` its text while it does. */
  private walk(text: string, read: (root: Node) => void): void {
    withTree(text, (root, source) => {
      const outer = this.source
      this.source = source
      try {
        read(root)
      } finally {
        this.source = outer
      }
    })
  }

  /** A statement run in `shell`; the simple command it is, when it is one. */
  private statement(node: Node, shell: Shell, stdin: Stdin | undefined, trailing?: Trailing): SimpleCommand | undefined {
    switch (node.type) {
      case 'command':
        return this.command(node, shell, stdin, trailing)
      case 'declaration_command':
      case 'unset_command':
        return this.declaration(node, shell, stdin, trailing)
      case 'variable_assignment':
      case 'variable_assignments':
        return this.emit({ assignments: this.assignments(node, shell), words: [], writes: trailing?.writes ?? [], stdin, cwd: shell.cwd })
      case 'redirected_statement':
        return this.redirected(node, shell, stdin, trailing)
      case 'pipeline':
        this.withTrailing(node, shell, trailing, () => this.pipeline(node, shell, stdin))
        return undefined
      case 'list':
        this.list(node, shell, stdin, trailing)
        return undefined
      case 'subshell': {
        const inner = { cwd: shell.cwd }
        this.withTrailing(node, shell, trailing, () => this.block(node, inner, trailing?.stdin ?? stdin))
        return undefined
      }
      case 'comment':
        this.comment(node)
        return undefined
      case 'test_command':
        for (const child of node.namedChildren) this.inner(child, shell)
        return undefined
      default:
        // Groups, conditionals, loops, `case`, functions and what the grammar could not parse.
        this.withTrailing(node, shell, trailing, () => this.block(node, shell, trailing?.stdin ?? stdin))
        return undefined
    }
  }

  /** The statements a node holds, in order, and the substitutions in its other parts. */
  private block(node: Node, shell: Shell, stdin: Stdin | undefined): void {
    for (const child of node.namedChildren) {
      if (STATEMENTS.has(child.type)) this.statement(child, shell, stdin)
      else this.inner(child, shell)
    }
  }

  /** A compound's redirects: its writes open before it runs, in the directory it starts in. */
  private withTrailing(node: Node, shell: Shell, trailing: Trailing | undefined, walk: () => void): void {
    if (trailing !== undefined && (trailing.writes.length > 0 || trailing.args.length > 0)) {
      if (trailing.args.length > 0) this.unreadable.push(`words after a redirect of \`${clip(node.text)}\``)
      this.emit({ assignments: [], words: [], writes: trailing.writes, stdin: undefined, cwd: shell.cwd })
    }
    walk()
  }

  private emit(command: SimpleCommand): SimpleCommand {
    this.commands.push(command)
    return command
  }

  private command(node: Node, shell: Shell, stdin: Stdin | undefined, trailing?: Trailing): SimpleCommand {
    const assignments: Assignment[] = []
    const words: string[] = []
    const writes: string[] = []
    const continued: Redirects = { writes, args: words, stdin: undefined, pipes: [], after: [] }
    let input = stdin
    const children = node.children

    for (let index = 0; index < children.length; index++) {
      const child = children[index]
      const field = node.fieldNameForChild(index)

      if (child.type === 'variable_assignment') {
        assignments.push(...this.assignments(child, shell))
      } else if (field === 'redirect') {
        const redirect = this.redirect(child, shell)
        writes.push(...redirect.writes)
        words.push(...redirect.args)
        continued.pipes.push(...redirect.pipes)
        continued.after.push(...redirect.after)
        input = redirect.stdin ?? input
      } else if (field === 'name') {
        words.push(...this.wordsOf(child.firstNamedChild ?? child, shell))
      } else if (field === 'argument') {
        // The grammar reads `$"..."` as the word `$` and a string.
        const next = children[index + 1]
        if (child.type === '$' && next?.startIndex === child.endIndex && next.text.startsWith('"')) {
          words.push(...this.wordsOf(next, shell))
          index++
        } else {
          words.push(...this.wordsOf(child, shell))
        }
      } else if (child.isNamed) {
        this.inner(child, shell)
      }
    }

    if (trailing !== undefined) {
      writes.push(...trailing.writes)
      words.push(...trailing.args)
      input = trailing.stdin ?? input
    }

    const command = this.emit({ assignments, words, writes, stdin: input, cwd: shell.cwd })
    changeDirectory(words, shell)
    this.continuations(continued, command, shell)
    return command
  }

  /** What the grammar put inside a heredoc's redirect, run after its command. */
  private continuations(redirects: Redirects, command: SimpleCommand | undefined, shell: Shell): void {
    for (const pipe of redirects.pipes) this.pipeline(pipe, shell, command === undefined ? { kind: 'unreadable' } : { kind: 'pipe', from: command })
    for (const next of redirects.after) this.statement(next, shell, undefined)
  }

  /** `export`, `declare`, `local`, `readonly`, `typeset` and `unset`, with each `NAME=value` as one word. */
  private declaration(node: Node, shell: Shell, stdin: Stdin | undefined, trailing?: Trailing): SimpleCommand {
    const words: string[] = []

    for (const child of node.children) {
      if (!child.isNamed) {
        if (words.length === 0) words.push(child.text)
      } else if (child.type === 'variable_assignment') {
        words.push(...this.assignments(child, shell).map(({ name, value }) => `${name}=${value}`))
      } else {
        words.push(...this.wordsOf(child, shell))
      }
    }

    return this.emit({ assignments: [], words: [...words, ...(trailing?.args ?? [])], writes: trailing?.writes ?? [], stdin: trailing?.stdin ?? stdin, cwd: shell.cwd })
  }

  private assignments(node: Node, shell: Shell): Assignment[] {
    if (node.type === 'variable_assignments') return node.namedChildren.flatMap((child) => this.assignments(child, shell))

    const name = node.childForFieldName('name')?.text ?? ''
    const value = node.childForFieldName('value')
    return [{ name, value: value === null ? '' : this.wordsOf(value, shell, true).join(' ') }]
  }

  /** `body > file`, `body < file`, `body <<EOF`: the redirects apply to the body, or to a list's last command. */
  private redirected(node: Node, shell: Shell, stdin: Stdin | undefined, outer?: Trailing): SimpleCommand | undefined {
    const redirects: Redirects = { writes: [], args: [], stdin: undefined, pipes: [], after: [] }

    for (const redirect of node.childrenForFieldName('redirect')) {
      const read = this.redirect(redirect, shell)
      redirects.writes.push(...read.writes)
      redirects.args.push(...read.args)
      redirects.stdin = read.stdin ?? redirects.stdin
      redirects.pipes.push(...read.pipes)
      redirects.after.push(...read.after)
    }
    node.children.forEach((child, index) => {
      if (child.isNamed && !['body', 'redirect'].includes(node.fieldNameForChild(index) ?? '')) this.inner(child, shell)
    })

    const body = node.childForFieldName('body')
    const trailing: Trailing = {
      writes: [...redirects.writes, ...(outer?.writes ?? [])],
      args: [...redirects.args, ...(outer?.args ?? [])],
      stdin: outer?.stdin ?? redirects.stdin,
    }
    const command =
      body === null
        ? this.emit({ assignments: [], words: trailing.args, writes: trailing.writes, stdin: trailing.stdin ?? stdin, cwd: shell.cwd })
        : this.statement(body, shell, stdin, trailing)

    // `cat <<EOF | bash`: the grammar puts the rest of the line inside the heredoc's redirect.
    this.continuations(redirects, command, shell)
    return command
  }

  private redirect(node: Node, shell: Shell): Redirects {
    const read: Redirects = { writes: [], args: [], stdin: undefined, pipes: [], after: [] }

    if (node.type === 'herestring_redirect') {
      const word = node.namedChildren.find((child) => child.type !== 'file_descriptor')
      read.stdin = { kind: 'text', text: `${word === undefined ? '' : this.wordsOf(word, shell).join(' ')}\n` }
      return read
    }
    if (node.type === 'heredoc_redirect') return this.heredoc(node, shell, read)

    const operator = node.children.find((child) => !child.isNamed)?.type ?? ''
    const descriptor = node.childForFieldName('descriptor')?.text
    const [target, ...rest] = node.childrenForFieldName('destination')
    const targets = target === undefined ? [] : this.wordsOf(target, shell)
    const extra = rest.flatMap((word) => this.wordsOf(word, shell))

    if (operator === '>' && targets.length === 1 && targets[0] === '!' && target?.type === 'word') {
      // zsh's `>!` writes the next word, where bash writes a file named `!` and passes the word on.
      this.unreadable.push('`>!`, which zsh reads as a write to the word after it and bash as a write to a file named `!`')
      read.writes.push(...extra.slice(0, 1))
    }
    read.args.push(...extra)

    if (WRITE_REDIRECTS.has(operator)) read.writes.push(...targets)
    else if (operator === '>&' && !targets.every((word) => /^\d+$|^-$/.test(word))) read.writes.push(...targets)
    else if (operator === '<' && (descriptor === undefined || descriptor === '0') && targets.length === 1) read.stdin = { kind: 'file', path: targets[0] }
    return read
  }

  /** A heredoc: its body, read as the shell expands it unless its delimiter is quoted, and what the grammar put inside it. */
  private heredoc(node: Node, shell: Shell, read: Redirects): Redirects {
    const start = node.children.find((child) => child.type === 'heredoc_start')?.text ?? ''
    const text = node.children.find((child) => child.type === 'heredoc_body')?.text ?? ''

    if (/[$`]/.test(start)) this.unreadable.push(`a heredoc whose delimiter, \`${clip(start)}\`, holds an expansion`)
    read.stdin = { kind: 'text', text: /['"\\]/.test(start) ? text : this.heredocBody(text, shell) }

    node.children.forEach((child, index) => {
      const field = node.fieldNameForChild(index)
      if (child.type === 'pipeline') read.pipes.push(child)
      else if (field === 'right') read.after.push(child)
      else if (field === 'redirect') {
        const inner = this.redirect(child, shell)
        read.writes.push(...inner.writes)
        read.args.push(...inner.args)
      }
    })
    return read
  }

  /**
   * An unquoted heredoc's body, as the shell expands it: each `$(...)`,
   * backquote, `${...}` and `$((...))` judged, and a mark in its place.
   */
  private heredocBody(body: string, shell: Shell): string {
    let text = ''
    let i = 0

    while (i < body.length) {
      const c = body[i]
      const next = body[i + 1] ?? ''

      if (c === '\\') {
        if (next === '\n') i += 2
        else if ('$`\\'.includes(next) && next !== '') {
          text += next
          i += 2
        } else {
          text += c
          i++
        }
      } else if (c === '`') {
        const end = closingBacktick(body, i + 1)
        this.nested(unescapeBackticks(body.slice(i + 1, end), false), shell)
        text += UNREAD
        i = end + 1
      } else if (c === '$' && (next === '(' || next === '{' || next === '[')) {
        const length = this.leadingExpansion(body.slice(i), shell)
        text += UNREAD
        i = length === undefined ? body.length : i + length
      } else if (c === '$' && /[A-Za-z_0-9@*#?$!-]/.test(next)) {
        text += UNREAD
        i += 2
        while (/^[A-Za-z_0-9]$/.test(body[i] ?? '') && /[A-Za-z_]/.test(next)) i++
      } else {
        text += c
        i++
      }
    }
    return text
  }

  /** The length of the `$(...)`, `${...}` or `$((...))` that starts `text`, its commands judged; undefined when the grammar cannot read it. */
  private leadingExpansion(text: string, shell: Shell): number | undefined {
    let length: number | undefined

    this.walk(`: ${text}`, (root) => {
      const argument = root.firstNamedChild?.childForFieldName('argument')
      const node = argument?.type === 'concatenation' ? argument.firstNamedChild : argument
      if (node?.startIndex !== 2 || node.hasError) return
      this.inner(node, shell)
      length = node.endIndex - 2
    })
    if (length === undefined) this.unreadable.push(`an expansion in a heredoc, \`${clip(text)}\``)
    return length
  }

  /** A backquoted command, read as its own line in a subshell. */
  private nested(text: string, shell: Shell): void {
    if (!this.enter()) return
    this.read(text, { cwd: shell.cwd })
    this.nesting--
  }

  private pipeline(node: Node, shell: Shell, stdin: Stdin | undefined): void {
    let from: SimpleCommand | undefined | null = null
    const statements = node.namedChildren.filter((child) => STATEMENTS.has(child.type))

    statements.forEach((child, index) => {
      // Each command of a pipeline runs in a subshell; zsh runs the last in the shell itself.
      const inner = { cwd: shell.cwd }
      const input: Stdin | undefined = from === null ? stdin : from === undefined ? { kind: 'unreadable' } : { kind: 'pipe', from }
      from = this.statement(child, inner, input)
      if (index === statements.length - 1 && inner.cwd !== shell.cwd) shell.cwd = undefined
    })
    for (const child of node.namedChildren) if (!STATEMENTS.has(child.type)) this.inner(child, shell)
  }

  private list(node: Node, shell: Shell, stdin: Stdin | undefined, trailing?: Trailing): void {
    const statements = node.namedChildren
    statements.forEach((child, index) => {
      if (STATEMENTS.has(child.type)) this.statement(child, shell, stdin, index === statements.length - 1 ? trailing : undefined)
      else this.inner(child, shell)
    })
  }

  /** The substitutions anywhere in a node that is not a statement. */
  private inner(node: Node, shell: Shell): void {
    switch (node.type) {
      case 'command_substitution':
      case 'process_substitution':
        return this.substitution(node, shell)
      case 'ERROR':
        return void this.statement(node, shell, undefined)
      case 'expansion':
        this.expansion(node)
        break
      case 'comment':
        return this.comment(node)
      case 'word':
      case 'regex':
        // The grammar leaves a backquote, and `${X#...}`'s `$(...)`, in an operand's text; the shell runs them.
        if (/`|\$[({[]/.test(node.text)) this.heredocBody(node.text, shell)
        return
    }
    this.block(node, shell, undefined)
  }

  /**
   * `$(...)`, a backquote or `<(...)`: commands run in a subshell. A
   * backquote's text is read as the shell reads it, with its `` \` ``, `\$`
   * and `\\` (and inside `"..."` its `\"`) unescaped first.
   */
  private substitution(node: Node, shell: Shell): void {
    // A backquote the line leaves open makes the line unreadable, whatever its text.
    if (node.firstChild?.type === '`') return this.nested(unescapeBackticks(node.text.slice(1, -1), inDoubleQuotes(node)), shell)
    if (!this.enter()) return
    this.block(node, { cwd: shell.cwd }, undefined)
    this.nesting--
  }

  private enter(): boolean {
    if (this.nesting >= MAX_NESTING) {
      this.unreadable.push(`substitutions nested more than ${MAX_NESTING} deep`)
      return false
    }
    this.nesting++
    return true
  }

  /** `${X@P}` runs the substitutions a value holds, as a prompt does. */
  private expansion(node: Node): void {
    if (/@P\s*\}$/.test(node.text)) this.unreadable.push(`\`${clip(node.text)}\`, which runs the commands a value holds`)
  }

  /** A `#` the grammar read as a comment's start where the shell reads it as part of a word. */
  private comment(node: Node): void {
    const before = this.source[node.startIndex - 1]
    if (before !== undefined && !/[\s;&|()<>]/.test(before)) this.unreadable.push(`a \`#\` inside a word, \`${clip(node.text)}\``)
  }

  /** A word node as the words the shell gives it: one, or several for a brace expansion. */
  private wordsOf(node: Node, shell: Shell, assignment = false): string[] {
    const chars: Char[] = []
    // An assignment's value is not split into words.
    this.pieces(node, shell, chars, assignment)
    return assignment ? [chars.map((char) => char.text).join('')] : expandWord(chars)
  }

  /** The characters a word node gives, quoted or not, with a mark for each expansion. */
  private pieces(node: Node, shell: Shell, out: Char[], quoted: boolean): void {
    const mark = (text: string): void => void out.push({ text, plain: false })

    switch (node.type) {
      case 'word':
        return unescape(node.text, out)
      case 'number':
      case 'variable_name':
        return void out.push(...[...node.text].map((text) => ({ text, plain: true })))
      case 'raw_string':
        return quotedText(node.text.slice(1, -1), out)
      case 'string':
        return this.string(node, shell, out)
      case 'translated_string':
        for (const child of node.namedChildren) this.string(child, shell, out)
        return
      case 'ansi_c_string': {
        const value = decodeAnsiC(node.text.slice(2, -1))
        return value === undefined ? mark(UNREAD) : quotedText(value, out)
      }
      case 'simple_expansion':
        return mark(quoted ? UNREAD : UNREAD_WORDS)
      case 'expansion':
        this.expansion(node)
        for (const child of node.namedChildren) this.inner(child, shell)
        return mark(quoted ? UNREAD : UNREAD_WORDS)
      case 'command_substitution':
        this.substitution(node, shell)
        return mark(quoted ? UNREAD : UNREAD_WORDS)
      case 'process_substitution':
        this.substitution(node, shell)
        return mark(UNREAD)
      case 'brace_expression':
        return mark(UNREAD_WORDS)
      case 'extglob_pattern':
        return mark(GLOB_ANY)
      case 'concatenation':
        return this.concatenation(node, shell, out, quoted)
      case 'ERROR':
        this.statement(node, shell, undefined)
        return mark(UNREAD)
    }
    if (!node.isNamed) return unescape(node.text, out)
    this.inner(node, shell)
    mark(quoted ? UNREAD : UNREAD_WORDS)
  }

  /** The parts of a word, and any text between them the grammar left out, such as a lone `$`. */
  private concatenation(node: Node, shell: Shell, out: Char[], quoted: boolean): void {
    let at = node.startIndex
    const children = node.children

    children.forEach((child, index) => {
      unescape(node.text.slice(at - node.startIndex, child.startIndex - node.startIndex), out)
      const next = children[index + 1]
      if (child.type === '$' && next?.type === 'string' && next.startIndex === child.endIndex) {
        at = child.endIndex
        return
      }
      this.pieces(child, shell, out, quoted)
      at = child.endIndex
    })
    unescape(node.text.slice(at - node.startIndex), out)
  }

  /** `"..."`: its text, with `\$`, `` \` ``, `\"`, `\\` and line continuations read, and its expansions marked. */
  private string(node: Node, shell: Shell, out: Char[]): void {
    // The text between the quotes; a closing quote the line leaves out is named by describeError.
    const text = node.text.replace(/"$/, '')
    let at = 1

    for (const child of node.namedChildren) {
      quotedText(decodeDoubleQuoted(text.slice(at, child.startIndex - node.startIndex)), out)
      if (child.type === 'string_content') quotedText(decodeDoubleQuoted(child.text), out)
      else this.pieces(child, shell, out, true)
      at = child.endIndex - node.startIndex
    }
    quotedText(decodeDoubleQuoted(text.slice(at)), out)
  }
}

/** Parses `text`, with each line continuation outside quotes joined first, as the shell joins it before it splits words. */
function withTree(text: string, read: (root: Node, source: string) => void): void {
  let tree: Tree = parseBash(text)
  let source = text

  try {
    const joined = joinContinuations(tree.rootNode, text)
    if (joined !== text) {
      tree.delete()
      tree = parseBash(joined)
      source = joined
    }
    read(tree.rootNode, source)
  } finally {
    tree.delete()
  }
}

/** `text` without the backslash-newlines the shell removes: those outside quotes, comments and heredoc bodies. */
function joinContinuations(root: Node, text: string): string {
  let joined = ''
  let at = 0

  for (let i = text.indexOf('\\\n'); i !== -1; i = text.indexOf('\\\n', i + 2)) {
    let backslashes = 0
    while (text[i - 1 - backslashes] === '\\') backslashes++
    if (backslashes % 2 === 1) continue

    let node: Node | null = root.descendantForIndex(i, i + 1)
    let quoted = false
    for (; node !== null; node = node.parent) {
      if (['raw_string', 'ansi_c_string', 'string', 'comment', 'heredoc_body', 'heredoc_content'].includes(node.type)) quoted = true
    }
    if (quoted) continue

    joined += text.slice(at, i)
    at = i + 2
  }
  return at === 0 ? text : joined + text.slice(at)
}

function describeError(root: Node): string {
  const [error] = root.descendantsOfType('ERROR')
  return error === undefined ? 'a quote, a bracket or a keyword the line leaves open' : `\`${clip(error.text)}\`, which the shell's grammar cannot parse`
}

/** A `cd`, `pushd` or `popd` moves the shell; one the reader cannot follow makes the directory unknown. */
function changeDirectory(words: ReadonlyArray<string>, shell: Shell): void {
  const [first, ...rest] = words
  const [head, ...args] = first === 'builtin' || first === 'command' ? rest : words

  if (head === 'popd') shell.cwd = undefined
  if (head !== 'cd' && head !== 'pushd') return

  let k = 0
  while (/^-[LPe@]+$/.test(args[k] ?? '')) k++
  if (args[k] === '--') k++
  const target = args[k]

  shell.cwd =
    target === undefined || target === '-' || isDynamic(target) || /^[+-]\d+$/.test(target)
      ? undefined
      : isAbsolutePath(target)
        ? normalizePath(target)
        : joinPath(shell.cwd, target)
}

/** A word's characters, with backslash escapes quoting the character after them. */
function unescape(text: string, out: Char[]): void {
  let escaped = false
  for (const char of text) {
    if (escaped) {
      if (char !== '\n') out.push({ text: char, plain: false })
      escaped = false
    } else if (char === '\\') {
      escaped = true
    } else {
      out.push({ text: char, plain: true })
    }
  }
}

function quotedText(text: string, out: Char[]): void {
  for (const char of text) out.push({ text: char, plain: false })
}

function decodeDoubleQuoted(text: string): string {
  return text.replace(/\\([$`"\\\n])/g, (_, char: string) => (char === '\n' ? '' : char))
}

const ANSI_ESCAPES: Readonly<Record<string, string>> = {
  a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?',
}

/** `$'...'`'s text, as bash 4.2 and later and zsh decode it; undefined for an escape they read differently. */
function decodeAnsiC(text: string): string | undefined {
  let value = ''

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '\\') {
      value += text[i]
      continue
    }
    const rest = text.slice(i + 1)
    const escape = /^(?:x([0-9a-fA-F]{1,2})|u([0-9a-fA-F]{1,4})|U([0-9a-fA-F]{1,8})|([0-7]{1,3})|c(.))/s.exec(rest)

    if (escape !== null) {
      const [whole, hex, unicode, longUnicode, octal, control] = escape
      const digits = hex ?? unicode ?? longUnicode
      const code = control !== undefined ? control.toUpperCase().charCodeAt(0) & 0x1f : digits !== undefined ? Number.parseInt(digits, 16) : Number.parseInt(octal ?? '0', 8)
      if (code > 0x10ffff) return undefined
      // The shell ends the word at a NUL.
      if (code === 0) return value
      value += String.fromCodePoint(code)
      i += whole.length
    } else if (Object.hasOwn(ANSI_ESCAPES, rest[0] ?? '')) {
      value += ANSI_ESCAPES[rest[0]]
      i++
    } else {
      value += '\\'
    }
  }
  return value
}

function closingBacktick(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === '\\') i++
    else if (text[i] === '`') return i
  }
  return text.length
}

/** A backquote's text as the shell runs it; inside `"..."`, `\"` is a quote too. */
function unescapeBackticks(text: string, quoted: boolean): string {
  return text.replace(quoted ? /\\([`$\\"])/g : /\\([`$\\])/g, '$1')
}

/** Whether a node is inside `"..."`, not counting quotes around a `$(...)` that holds it, whose text the shell reads afresh. */
function inDoubleQuotes(node: Node): boolean {
  for (let at = node.parent; at !== null; at = at.parent) {
    if (at.type === 'string') return true
    if (at.type === 'command_substitution') return false
  }
  return false
}

/**
 * A word's characters as the words the shell gives: brace expansions of
 * literal text expanded, then a tilde, zsh's `=command` and globs marked.
 */
function expandWord(chars: ReadonlyArray<Char>): string[] {
  const words = expandBraces(chars)
  if (words === undefined) return [UNREAD_WORDS]
  return words.map(markWord)
}

const isPlain = (char: Char | undefined, text: string) => char !== undefined && char.plain && char.text === text

function expandBraces(chars: ReadonlyArray<Char>): Char[][] | undefined {
  for (let open = 0; open < chars.length; open++) {
    if (!isPlain(chars[open], '{')) continue

    let depth = 0
    let close = -1
    const commas: number[] = []
    for (let j = open; j < chars.length && close === -1; j++) {
      if (isPlain(chars[j], '{')) depth++
      else if (isPlain(chars[j], '}') && --depth === 0) close = j
      else if (depth === 1 && isPlain(chars[j], ',')) commas.push(j)
    }
    if (close === -1) continue

    if (commas.length === 0) {
      // `{1..5}` and `{a..e}` give words the shells spell differently; `{x}` stays as it is.
      if (/^[^{}]+\.\.[^{}]+$/.test(chars.slice(open + 1, close).map((char) => char.text).join(''))) return undefined
      continue
    }

    const words: Char[][] = []
    const bounds = [open, ...commas, close]
    for (let k = 0; k + 1 < bounds.length; k++) {
      const expanded = expandBraces([...chars.slice(0, open), ...chars.slice(bounds[k] + 1, bounds[k + 1]), ...chars.slice(close + 1)])
      if (expanded === undefined) return undefined
      words.push(...expanded)
      if (words.length > MAX_BRACE_WORDS) return undefined
    }
    return words
  }
  return [chars.slice()]
}

function markWord(chars: ReadonlyArray<Char>): string {
  const parts = chars.map((char) => char.text)

  // `~` and `~user` give a home directory; zsh's `=git` gives git's path.
  if (isPlain(chars[0], '~')) {
    let end = chars.findIndex((char) => isPlain(char, '/'))
    if (end === -1) end = chars.length
    parts.splice(0, end, UNREAD, ...Array<string>(end - 1).fill(''))
  } else if (isPlain(chars[0], '=') && chars.length > 1) {
    parts[0] = UNREAD
  }

  for (let i = 0; i < chars.length; i++) {
    if (isPlain(chars[i], '*')) parts[i] = GLOB_ANY
    else if (isPlain(chars[i], '?')) parts[i] = GLOB_ONE
    else if (isPlain(chars[i], '[')) {
      const close = chars.findIndex((char, j) => j > i + 1 && isPlain(char, ']'))
      if (close !== -1) {
        parts.splice(i, close - i + 1, GLOB_ONE, ...Array<string>(close - i).fill(''))
        i = close
      }
    }
  }
  return parts.join('')
}

function clip(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > 60 ? `${line.slice(0, 57)}...` : line
}
