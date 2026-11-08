/**
 * Shell Reader Tests
 *
 * The reader gives each command's words as the shell does. These words are
 * checked against real bash and zsh, which print them with a harmless
 * `printf` in a directory of the test's own, and each mark stands where a
 * word holds what the reader cannot know.
 */

import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GLOB_ANY, GLOB_ONE, readScript, UNREAD, UNREAD_WORDS } from '../../src/fence/shell.js'

const words = (line: string) => readScript(line).commands.map((command) => command.words)

/** Spellings each shell gives the same words for. */
const spellings: ReadonlyArray<string> = [
  '{commit,-n} -m x',
  'x{a,b}y {a,{b,c}}',
  'HEAD@{1} {} {x} \\{a,b\\} \'{a,b}\' "{a,b}"',
  "$'\\x67\\x69t' $'a\\'b' $'\\101\\t\\x41'",
  '"a"\'b\'c a\\ b "x\\"y" "a\\$b" \'a\\b\'',
  'g\\\nit "x\\\ny"',
  'a$ "$" a#b',
  "x{1,2} a{b,c}d{e,f} '{a,b' {a,b = {}x",
  "'a\\\nb'",
]
/** bash reads `$"..."` as a translated string; zsh reads its `$` as text. */
const bashSpellings: ReadonlyArray<string> = ['x$"y" $"z"w']

const shells = ['bash', 'zsh'].filter((shell) => spawnSync(shell, ['-c', 'true']).status === 0)

describe('words', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fence-shell-'))

  test.each([...shells.flatMap((shell) => spellings.map((spelling) => [shell, spelling] as const)), ...bashSpellings.map((spelling) => ['bash', spelling] as const)])('%s gives %p the words the reader does', (shell, spelling) => {
    const run = spawnSync(shell, ['-c', `printf '%s\\0' ${spelling}`], { cwd: directory, encoding: 'utf8' })

    expect(run.status).toBe(0)
    expect(words(`printf '%s\\0' ${spelling}`)[0]?.slice(2)).toEqual(run.stdout.split('\0').slice(0, -1))
  })

  test('the directory is removed', () => {
    rmSync(directory, { recursive: true, force: true })
  })
})

describe('marks', () => {
  test('an expansion is unread text: one word quoted, maybe several unquoted', () => {
    expect(words('git "$X" $Y ${Z:-a} $(echo a) `echo b`')).toContainEqual(['git', UNREAD, UNREAD_WORDS, UNREAD_WORDS, UNREAD_WORDS, UNREAD_WORDS])
  })

  test('a glob, a tilde and zsh\'s `=command` are unread', () => {
    expect(words('ls *.ts a?c [ab]x ~/x =git')[0]).toEqual(['ls', `${GLOB_ANY}.ts`, `a${GLOB_ONE}c`, `${GLOB_ONE}x`, `${UNREAD}/x`, `${UNREAD}git`])
  })

  test('a range is unread, as the shells spell it differently', () => {
    expect(words('echo {1..3}')[0]).toEqual(['echo', UNREAD_WORDS])
  })

  test("an assignment's value is one word, globs and all", () => {
    expect(readScript('X=*.ts Y=$(date) git status').commands[1]?.assignments).toEqual([{ name: 'X', value: '*.ts' }, { name: 'Y', value: UNREAD }])
  })
})

describe('commands', () => {
  test('substitutions run before the command that holds them, in a directory a cd in them does not change', () => {
    const { commands } = readScript('cd app && echo $(cd .. && pwd) && ls')
    expect(commands.map((command) => [command.words[0], command.cwd])).toEqual([['cd', ''], ['cd', 'app'], ['pwd', ''], ['echo', 'app'], ['ls', 'app']])
  })

  test('a redirect after a list belongs to its last command, after the cd', () => {
    const [cd, echo] = readScript('cd .git/hooks && echo x > pre-commit').commands
    expect(cd?.writes).toEqual([])
    expect(echo).toMatchObject({ writes: ['pre-commit'], cwd: '.git/hooks' })
  })

  test("a compound's redirect opens before it runs", () => {
    expect(readScript('{ cd .git/hooks; } > pre-commit').commands[0]).toMatchObject({ words: [], writes: ['pre-commit'], cwd: '' })
  })

  test('a cd it cannot follow makes the directory unknown, and a subshell keeps its own', () => {
    expect(readScript('(cd app); cd "$X"; ls').commands.map((command) => command.cwd)).toEqual(['', '', undefined])
    expect(readScript('true | cd app; ls').commands.at(-1)?.cwd).toBeUndefined()
  })

  test('a pipeline hands each command the one before it, and a heredoc its text', () => {
    const [cat, bash] = readScript('cat <<EOF | bash\ngit status\nEOF').commands
    expect(cat?.stdin).toEqual({ kind: 'text', text: 'git status\n' })
    expect(bash?.stdin).toEqual({ kind: 'pipe', from: cat })
    expect(readScript('(echo a) | sh').commands.at(-1)?.stdin).toEqual({ kind: 'unreadable' })
  })

  test('what the grammar cannot parse is named', () => {
    expect(readScript("echo 'open").unreadable).toHaveLength(1)
    expect(readScript('echo ${X@P}').unreadable[0]).toContain('@P')
    expect(readScript('cat <(true) #x').unreadable).toEqual([])
  })

  test('substitutions nest no deeper than the limit', () => {
    expect(readScript(`${'$('.repeat(20)}true${')'.repeat(20)}`).unreadable.some((what) => what.includes('nested'))).toBe(true)
  })
})

describe('heredocs', () => {
  const body = (line: string) => {
    const stdin = readScript(line).commands.find((command) => command.words[0] === 'cat')?.stdin
    return stdin?.kind === 'text' ? stdin.text : undefined
  }

  test("an unquoted body's escapes, expansions and substitutions, as the shell expands them", () => {
    // The grammar reads an indented `<<-` body as text, and refuses an escaped `$(` in `<<`'s.
    expect(body('cat <<-EOF\n\t\\$(x) \\` \\\\ a\\\nb \\z\n\tEOF')).toBe('$(x) ` \\ ab \\z\n\t')
    expect(readScript('cat <<EOF\n\\$(x)\nEOF').unreadable).toHaveLength(1)
    expect(body('cat <<EOF\n$HOME/x $1y $? ${X} $((1)) $[1] $(true) `true` a$\nEOF')).toBe(`${UNREAD}/x ${UNREAD}y ${UNREAD} ${UNREAD} ${UNREAD} ${UNREAD} ${UNREAD} ${UNREAD} a$\n`)
    expect(body("cat <<'EOF'\n$HOME\nEOF")).toBe('$HOME\n')
    expect(body('cat <<-EOF\n\t$HOME\n\tEOF')).toBe(`${UNREAD}\n\t`)
  })

  test("a body's substitutions run, and one the grammar cannot read is named", () => {
    expect(words('cat <<EOF\n$(git status) `git log` ${X:-$(git diff)}\nEOF')).toEqual([['git', 'status'], ['git', 'log'], ['git', 'diff'], ['cat']])
    expect(readScript('cat <<-EOF\n\t$(\n\tEOF').unreadable).toEqual(['an expansion in a heredoc, `$(`'])
    expect(words('cat <<-EOF\n\t$(git status) ${X:-$(git diff)} $((1)) $[1]\n\tEOF')).toEqual([['git', 'status'], ['git', 'diff'], ['cat']])
    expect(words('cat <<EOF\n`git status\nEOF')).toContainEqual(['git', 'status'])
    // A backquote escaped inside backquotes nests a substitution.
    expect(words('cat <<EOF\n`echo \\`git status\\``\nEOF')).toEqual([['git', 'status'], ['echo', UNREAD_WORDS], ['cat']])
  })

  test('what the grammar puts inside its redirect: a pipeline, a list, more redirects', () => {
    const [cat, git] = readScript('cat <<EOF > out && git status\nx\nEOF').commands
    expect(cat).toMatchObject({ words: ['cat'], writes: ['out'] })
    expect(git?.words).toEqual(['git', 'status'])
  })
})

describe('redirects', () => {
  test('a write, a duplicated descriptor, an input file', () => {
    expect(readScript('echo x >& out').commands[0]?.writes).toEqual(['out'])
    expect(readScript('echo x >&2 2>&-').commands[0]?.writes).toEqual([])
    expect(readScript('bash < x.sh').commands[0]?.stdin).toEqual({ kind: 'file', path: 'x.sh' })
    expect(readScript('bash 0< x.sh').commands[0]?.stdin).toEqual({ kind: 'file', path: 'x.sh' })
    expect(readScript('bash 3< x.sh').commands[0]?.stdin).toBeUndefined()
    expect(readScript('bash < {a,b}.sh').commands[0]?.stdin).toBeUndefined()
  })

  test("a compound's input reaches the commands in it, and adds no command of its own", () => {
    const { commands, unreadable } = readScript('{ ls; } < in.txt')
    expect(commands).toEqual([{ assignments: [], words: ['ls'], writes: [], stdin: { kind: 'file', path: 'in.txt' }, cwd: '' }])
    expect(unreadable).toEqual([])
    expect(readScript('while true; do :; done > out').unreadable).toEqual([])
  })

  test('assignments on their own, several at once', () => {
    expect(readScript('X=1 HUSKY=0').commands[0]?.assignments).toEqual([{ name: 'X', value: '1' }, { name: 'HUSKY', value: '0' }])
    expect(readScript('X=').commands[0]?.assignments).toEqual([{ name: 'X', value: '' }])
  })
})

describe('directories', () => {
  const cwds = (line: string) => readScript(line).commands.map((command) => command.cwd)

  test.each([
    ['builtin cd a; ls', ['', 'a']],
    ['command cd a; ls', ['', 'a']],
    ['cd -P -- a; ls', ['', 'a']],
    ['cd; ls', ['', undefined]],
    ['cd -; ls', ['', undefined]],
    ['pushd a; ls; popd; ls', ['', 'a', 'a', undefined]],
    ['pushd +1; ls', ['', undefined]],
    ['cd /abs; ls', ['', '/abs']],
    ['cd "$X"; cd /abs; ls', ['', undefined, '/abs']],
    ['cd "$X"; cd rel; ls', ['', undefined, undefined]],
    ['cd app | true; ls', ['', '', '']],
  ] as const)('%p runs its commands in %p', (line, expected) => {
    expect(cwds(line)).toEqual([...expected])
  })
})

describe('the reader in detail', () => {
  test("`$'...'`: a NUL ends the word, a code point past Unicode is unread, an unknown escape stays", () => {
    expect(words("echo $'a\\0b' $'\\U110000' $'\\U10FFFF' $'\\q' $'\\e' $'\\c'")[0]).toEqual(['echo', 'a', UNREAD, '\u{10FFFF}', '\\q', '\x1b', '\\c'])
  })

  test('a brace expansion of more than 64 words, or with a range inside, is unread', () => {
    expect(words('echo {a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}')[0]).toEqual(['echo', UNREAD_WORDS])
    expect(words('echo {x,{a..c}}')[0]).toEqual(['echo', UNREAD_WORDS])
    expect(words('echo {x,{1..3}}')[0]).toEqual(['echo', 'x', UNREAD_WORDS])
    expect(words('echo {a,b}{a,b}{a,b}{a,b}{a,b}{a,b}')[0]).toHaveLength(65)
  })

  test('`[` opens a glob only with a `]` after a character, `=` a command only with a name after it', () => {
    expect(words('ls x[] x[a] =')[0]).toEqual(['ls', 'x[]', `x${GLOB_ONE}`, '='])
  })

  test('a line continuation joins words outside quotes and comments, and an escaped backslash does not continue', () => {
    expect(words("echo 'a\\\nb'")[0]).toEqual(['echo', 'a\\\nb'])
    expect(words('# note \\\ngit status')).toEqual([['git', 'status']])
    expect(words('echo a\\\\\ngit status')).toEqual([['echo', 'a\\'], ['git', 'status']])
  })

  test('what the grammar cannot parse, and what it leaves open, are named', () => {
    expect(readScript("echo 'open").unreadable[0]).toContain('cannot parse')
    expect(readScript('git commit -m "open').unreadable[0]).toContain('leaves open')
  })

  test('a negated command and a translated string are read', () => {
    expect(words('! git status')).toEqual([['git', 'status']])
    expect(words('git $"status"')).toEqual([['git', 'status']])
  })

  test('substitutions nest sixteen deep, and no deeper', () => {
    const nested = (depth: number) => readScript(`${'echo $('.repeat(depth)}git status${')'.repeat(depth)}`)
    expect(nested(16).commands.some((command) => command.words[0] === 'git')).toBe(true)
    expect(nested(16).unreadable).toEqual([])
    expect(nested(17).commands.some((command) => command.words[0] === 'git')).toBe(false)
    expect(nested(17).unreadable).toContainEqual(expect.stringContaining('nested more than 16'))
  })
})
