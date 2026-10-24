/**
 * The command policy: what an agent's shell command may run without the
 * owner. It refuses a command that skips the commit gate, and asks the owner
 * before one that deploys, touches remote data, changes secrets, publishes a
 * package or pushes. It reads the whole command line as a shell would:
 * through quotes, `&&` chains, `sh -c`, `eval`, `npx` and `bunx`, env
 * prefixes, the package.json scripts a runner names, and the shell scripts
 * a command runs.
 */
import { readCommands, splitWords, type SimpleCommand } from './shell.js'

/** What a command or a file change breaks: the fence's own rule, or a step that needs the owner. */
export type FenceRule =
  /** It skips or switches off the git hooks that run the commit gate. Always refused. */
  | 'hook-bypass'
  /** It changes the fence: the gate, the lint configuration, the agent's hooks or the debt ledger. */
  | 'fence-change'
  /** It deploys, rolls back or deletes a Worker on Cloudflare. */
  | 'deploy'
  /** It reads or changes data on Cloudflare (remote D1, KV, R2) rather than the local copy. */
  | 'remote-data'
  /** It changes the Worker's secrets on Cloudflare. */
  | 'secret'
  /** It publishes a package to a registry. */
  | 'publish'
  /** It pushes commits to a remote. */
  | 'push'

/**
 * The policy's answer. `deny` refuses: the agent fixes what the reason
 * says. `ask` needs the owner, who approves this one command or runs it
 * themselves.
 */
export type FenceVerdict =
  | { readonly decision: 'allow' }
  | {
      readonly decision: 'ask' | 'deny'
      readonly rule: FenceRule
      /** The command, or the file, the rule is about. */
      readonly subject: string
      readonly reason: string
    }

/** What the policy reads besides the command line. */
export interface CommandPolicyOptions {
  /** The application's package.json scripts, so `bun run deploy` is read as the commands it runs. */
  readonly scripts?: Readonly<Record<string, string>>
  /** A file a command runs, such as `sh scripts/release.sh`, or undefined when it cannot be read. */
  readonly readFile?: (path: string) => string | undefined
}

type Finding = Exclude<FenceVerdict, { readonly decision: 'allow' }>

/** Scripts, substitutions and wrappers are followed this deep. */
const MAX_DEPTH = 12

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'yash'])
/** Options of a shell that take a value, before its script. */
const SHELL_VALUE_OPTIONS = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file'])

/** Commands that run the command after their own options, and those options that take a value. */
const WRAPPERS: Readonly<Record<string, { readonly values: ReadonlyArray<string>; readonly positionals?: number }>> = {
  builtin: { values: [] },
  command: { values: [] },
  exec: { values: ['-a'] },
  nohup: { values: [] },
  time: { values: ['-f', '-o', '--format', '--output'] },
  nice: { values: ['-n', '--adjustment'] },
  ionice: { values: ['-c', '-n', '-p', '-P', '-u', '--class', '--classdata'] },
  stdbuf: { values: ['-i', '-o', '-e', '--input', '--output', '--error'] },
  timeout: { values: ['-s', '-k', '--signal', '--kill-after'], positionals: 1 },
  sudo: { values: ['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-T', '-U', '--user', '--group', '--host', '--prompt', '--chdir', '--role', '--type', '--other-user'] },
  doas: { values: ['-u', '-C'] },
  chronic: { values: [] },
  unbuffer: { values: [] },
  caffeinate: { values: ['-t', '-w'] },
}
const XARGS_VALUE_OPTIONS = ['-I', '-L', '-n', '-P', '-s', '-E', '-d', '-a', '--replace', '--max-lines', '--max-args', '--max-procs', '--max-chars', '--eof', '--delimiter', '--arg-file']
/** Builtins that set variables, whose `NAME=value` arguments the commands after them see. */
const DECLARATIONS = new Set(['export', 'declare', 'typeset', 'readonly', 'local'])

/** Interpreters, and the options that give them code inline. */
const INLINE_CODE: Readonly<Record<string, ReadonlyArray<string>>> = {
  node: ['-e', '--eval', '-p', '--print'],
  bun: ['-e', '--eval', '-p', '--print'],
  python: ['-c'],
  python3: ['-c'],
  perl: ['-e', '-E'],
  ruby: ['-e'],
  php: ['-r'],
}

const BUN_BUILTINS = new Set([
  'run', 'test', 'x', 'exec', 'install', 'i', 'add', 'a', 'remove', 'rm', 'update', 'outdated', 'link', 'unlink', 'pm',
  'build', 'init', 'create', 'c', 'upgrade', 'publish', 'patch', 'patch-commit', 'audit', 'info', 'why', 'repl', 'completions', 'help',
])
const PNPM_BUILTINS = new Set([
  'add', 'install', 'i', 'remove', 'rm', 'uninstall', 'update', 'up', 'list', 'ls', 'why', 'outdated', 'link', 'unlink', 'import',
  'rebuild', 'prune', 'fetch', 'store', 'deploy', 'pack', 'init', 'create', 'env', 'setup', 'audit', 'licenses', 'patch',
  'patch-commit', 'config', 'root', 'bin', 'server', 'approve-builds', 'cache', 'catalog', 'help',
])
const YARN_BUILTINS = new Set([
  'add', 'install', 'remove', 'up', 'upgrade', 'info', 'why', 'init', 'set', 'config', 'cache', 'constraints', 'pack', 'patch',
  'plugin', 'version', 'link', 'unlink', 'explain', 'search', 'stage', 'help', 'bin',
])
const NPM_VALUE_OPTIONS = new Set(['--prefix', '-w', '--workspace', '--userconfig', '--registry', '--cache', '--loglevel', '--tag', '--otp', '--access'])
const BUN_VALUE_OPTIONS = new Set(['--cwd', '--filter', '-F', '--config', '-c', '--env-file', '--preload', '-r', '--require', '--import', '--elide-lines', '--shell', '--tsconfig-override'])
const PNPM_VALUE_OPTIONS = new Set(['-C', '--dir', '--filter', '-F', '--filter-prod', '--reporter', '--loglevel', '--workspace-concurrency'])
const YARN_VALUE_OPTIONS = new Set(['--cwd'])
const NODE_VALUE_OPTIONS = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '--env-file', '--conditions', '-C', '--input-type'])
/** `popweb-fence`, run by its bin or by its file in the package. */
const FENCE_CLI = /(^|\/)popweb-fence$|(^|\/)@popcomputer\/web\/dist\/fence\/cli\.js$/

const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix'])
/** `--no-verify`, and the abbreviations git accepts for it. */
const NO_VERIFY = /^--no-veri(?:f|fy)?$/
/** Short options of `git commit` that take a value, which `-n` cannot follow in a cluster. */
const COMMIT_VALUE_SHORT = new Set(['m', 'F', 'C', 'c', 't'])
const COMMIT_VALUE_LONG = new Set([
  '--message', '--file', '--reuse-message', '--reedit-message', '--template', '--author', '--date', '--cleanup', '--fixup',
  '--squash', '--trailer', '--pathspec-from-file',
])
const CONFIG_VALUE_OPTIONS = new Set(['-f', '--file', '--blob', '--type', '--default', '--comment', '--value'])

const WRANGLER_VALUE_OPTIONS = new Set(['-c', '--config', '-e', '--env', '--env-file', '--cwd'])
const SECRET_WRITES = new Set(['put', 'bulk', 'delete'])

/** Commands that change the files their arguments name. */
const WRITERS = new Set(['rm', 'rmdir', 'mv', 'chmod', 'chown', 'chgrp', 'truncate', 'tee', 'unlink', 'shred', 'touch'])
/** Commands that change only the file their last argument names. */
const COPIERS = new Set(['cp', 'ln', 'install', 'rsync'])

/** Files nobody reviews, whose change switches the gate or the agent's hook off. */
const UNREVIEWED_FILES = [
  /(^|\/)\.git\/hooks(\/|$)/,
  /(^|\/)\.?lefthook-local\.ya?ml$/,
  /(^|\/)node_modules\/@popcomputer\/web\/dist\/fence(\/|$)/,
]
/** The fence's own files, which the owner signs off. */
const FENCE_FILES = [
  /(^|\/)\.?lefthook\.ya?ml$/,
  /(^|\/)\.githooks(\/|$)/,
  /(^|\/)oxlint\.config\.[cm]?[jt]s$/,
  /(^|\/)\.?oxlintrc\.json$/,
  /(^|\/)\.claude\/settings(\.local)?\.json$/,
  /(^|\/)\.cursor\/hooks\.json$/,
  /(^|\/)lint-debt\.json$/,
]

/** The policy's answer for one shell command line, as an agent's hook passes it. */
export function commandPolicy(command: string, options: CommandPolicyOptions = {}): FenceVerdict {
  const inspection = new Inspection(options)
  inspection.script(command, 0)
  return strongest(inspection.findings)
}

/**
 * The policy's answer for a change to one file, as an agent's edit tool
 * passes its path: refused for git's hooks, which nobody reviews, and asked
 * of the owner for the fence's own files.
 */
export function filePolicy(path: string): FenceVerdict {
  return strongest(fileFindings(path, undefined))
}

function strongest(findings: ReadonlyArray<Finding>): FenceVerdict {
  return findings.find((finding) => finding.decision === 'deny') ?? findings[0] ?? { decision: 'allow' }
}

/** A change to one file, by an edit (no command) or by a shell command. */
function fileFindings(path: string, command: string | undefined): Finding[] {
  const file = path.replaceAll('\\', '/')
  const change = command === undefined ? `Changing ${file}` : `\`${command}\` changes ${file}, which`

  if (UNREVIEWED_FILES.some((pattern) => pattern.test(file))) {
    return [{
      decision: 'deny',
      rule: 'hook-bypass',
      subject: command ?? file,
      reason: `${change} switches off the commit gate or the agent's hook, and nobody reviews it. Fix what the gate reports instead; only the owner changes the gate.`,
    }]
  }
  if (FENCE_FILES.some((pattern) => pattern.test(file))) {
    return [{
      decision: 'ask',
      rule: 'fence-change',
      subject: command ?? file,
      reason: `${command === undefined ? `${file} is` : `\`${command}\` changes ${file},`} part of the fence: the commit gate, the lint configuration, the agent's hooks or the debt ledger. Approve it only if you asked for this change.`,
    }]
  }
  return []
}

const REASONS: Readonly<Record<Exclude<FenceRule, 'hook-bypass' | 'fence-change'>, string>> = {
  deploy: 'deploys to Cloudflare. Approve it only if you asked for this deploy.',
  'remote-data': 'reads or changes data on Cloudflare (remote D1, KV or R2), not the local copy. Approve it only if you asked for it.',
  secret: "changes the Worker's secrets on Cloudflare. Approve it only if you asked for it.",
  publish: 'publishes a package to the registry. Approve it only if you asked for this release.',
  push: 'pushes commits to the remote. Approve it only if you asked for a push.',
}

class Inspection {
  readonly findings: Finding[] = []

  constructor(private readonly options: CommandPolicyOptions) {}

  script(text: string, depth: number, via?: string): void {
    if (depth > MAX_DEPTH) return
    for (const command of readCommands(text)) this.command(command, depth, via)
  }

  private command(command: SimpleCommand, depth: number, via: string | undefined): void {
    const text = shown([...command.assignments.map(({ name, value }) => `${name}=${value}`), ...command.words])

    for (const { name, value } of command.assignments) this.environment(name, value, text, via, basename(command.words[0] ?? ''))
    for (const target of command.writes) this.findings.push(...fileFindings(target, from(`${text} > ${target}`, via)))
    this.words(command.words, command, depth, via)
  }

  private deny(subject: string, reason: string, via: string | undefined): void {
    this.findings.push({ decision: 'deny', rule: 'hook-bypass', subject: from(subject, via), reason: `\`${from(subject, via)}\` ${reason}` })
  }

  private ask(rule: FenceRule, subject: string, via: string | undefined, reason?: string): void {
    const text = from(subject, via)
    this.findings.push({ decision: 'ask', rule, subject: text, reason: `\`${text}\` ${reason ?? REASONS[rule as keyof typeof REASONS]}` })
  }

  /** An env var that switches git hooks off, before a command or exported for the ones after it. */
  private environment(name: string, value: string, subject: string, via: string | undefined, command: string): void {
    const switchesHooksOff =
      ((name === 'HUSKY' || name === 'LEFTHOOK') && /^(0|false|no|off)$/i.test(value)) ||
      ((name === 'HUSKY_SKIP_HOOKS' || name === 'SKIP_SIMPLE_GIT_HOOKS' || name === 'LEFTHOOK_EXCLUDE') && value !== '') ||
      (name === 'SKIP' && command === 'git' && value !== '') ||
      (name === 'GIT_CONFIG_PARAMETERS' && /core\.hookspath/i.test(value)) ||
      (/^GIT_CONFIG_KEY_\d+$/.test(name) && value.toLowerCase() === 'core.hookspath')

    if (switchesHooksOff) {
      this.deny(subject, `sets ${name}, which switches off the git hooks that run the commit gate. Fix what the gate reports and commit again; only the owner changes the gate.`, via)
    }
  }

  private words(words: ReadonlyArray<string>, command: SimpleCommand, depth: number, via: string | undefined): void {
    if (depth > MAX_DEPTH || words.length === 0) return

    const [head, ...args] = words
    const name = basename(head)
    const next = (rest: ReadonlyArray<string>) => this.words(rest, command, depth + 1, via)

    if (FENCE_CLI.test(head)) return this.fenceCli(args, words, via)
    if (name === 'env') return this.env(args, command, depth, via)
    if (name === 'command' && (args[0] === '-v' || args[0] === '-V')) return
    if (name === 'xargs') return next([...afterOptions(args, XARGS_VALUE_OPTIONS), ...splitWords(producedText(command.pipedFrom) ?? '')])
    if (Object.hasOwn(WRAPPERS, name)) {
      const wrapper = WRAPPERS[name]
      return next(this.leadingAssignments(afterOptions(args, wrapper.values).slice(wrapper.positionals ?? 0), via))
    }
    if (DECLARATIONS.has(name)) {
      for (const arg of args) this.assignmentWord(arg, shown(words), '', via)
      return
    }
    if (name === 'watch') return this.script(afterOptions(args, ['-n', '--interval']).join(' '), depth + 1, via)
    if (name === 'eval') return this.script(args.join(' '), depth + 1, via)
    if (name === 'source' || name === '.') return this.file(args[0], depth, via)
    if (SHELLS.has(name)) return this.shell(args, command, depth, via)
    if (name === 'find') return this.find(args, command, depth, via)
    if (name === 'deno' && args[0] === 'eval') return this.code(args[1] ?? '', depth, via)
    // sed -i and perl -pi edit the files they name; perl's code is read below too.
    if ((name === 'sed' || name === 'perl') && args.some((arg) => /^-[a-zA-Z]*i/.test(arg) || arg.startsWith('--in-place'))) {
      this.writes(positionals(args), words, via)
    }
    if (Object.hasOwn(INLINE_CODE, name) && name !== 'bun') return this.interpreter(name, args, depth, via)

    switch (name) {
      case 'git':
        return this.git(args, words, depth, via)
      case 'wrangler':
        return this.wrangler(args, words, via)
      case 'npx':
      case 'pnpx':
      case 'bunx':
        return this.runner(args, command, depth, via)
      case 'npm':
        return this.npm(args, words, command, depth, via)
      case 'bun':
        return this.bun(args, words, command, depth, via)
      case 'pnpm':
        return this.pnpm(args, words, command, depth, via)
      case 'yarn':
        return this.yarn(args, words, command, depth, via)
      case 'lefthook':
      case 'husky':
        if (args.includes('uninstall')) this.deny(shown(words), 'removes the git hooks that run the commit gate. Only the owner changes the gate.', via)
        return
      case 'dd':
        return this.writes(args.filter((arg) => arg.startsWith('of=')).map((arg) => arg.slice(3)), words, via)
    }

    if (WRITERS.has(name)) return this.writes(positionals(args), words, via)
    if (COPIERS.has(name)) return this.writes(positionals(args).slice(-1), words, via)
    if (head.includes('/') || head.endsWith('.sh')) this.file(head, depth, via, args)
  }

  /** The words after the `NAME=value` assignments `sudo` and `doas` take before a command, each checked. */
  private leadingAssignments(words: ReadonlyArray<string>, via: string | undefined): ReadonlyArray<string> {
    const start = words.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word))
    const rest = start === -1 ? [] : words.slice(start)
    for (const word of start === -1 ? words : words.slice(0, start)) this.assignmentWord(word, shown(words), basename(rest[0] ?? ''), via)
    return rest
  }

  private assignmentWord(word: string, subject: string, command: string, via: string | undefined): void {
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(word)
    if (assignment) this.environment(assignment[1], assignment[2], subject, via, command)
  }

  private writes(paths: ReadonlyArray<string>, words: ReadonlyArray<string>, via: string | undefined): void {
    for (const path of paths) this.findings.push(...fileFindings(path, from(shown(words), via)))
  }

  private fenceCli(args: ReadonlyArray<string>, words: ReadonlyArray<string>, via: string | undefined): void {
    if (args.includes('--allow-increase')) {
      this.ask('fence-change', shown(words), via, 'raises the lint debt baseline, which only shrinks without the owner. Approve it only if you accept the new disable directives.')
    }
  }

  private env(args: ReadonlyArray<string>, command: SimpleCommand, depth: number, via: string | undefined): void {
    let rest = [...args]

    while (rest.length > 0) {
      const [arg] = rest
      if (arg === '--') {
        rest = rest.slice(1)
        break
      }
      if (arg === '-S' || arg === '--split-string') {
        rest = [...splitWords(rest[1] ?? ''), ...rest.slice(2)]
      } else if (arg.startsWith('--split-string=') || (arg.startsWith('-S') && arg.length > 2)) {
        rest = [...splitWords(arg.startsWith('-S') ? arg.slice(2) : arg.slice('--split-string='.length)), ...rest.slice(1)]
      } else if (['-u', '--unset', '-C', '--chdir', '-P'].includes(arg)) {
        rest = rest.slice(2)
      } else if (arg.startsWith('-')) {
        rest = rest.slice(1)
      } else {
        break
      }
    }

    this.words(this.leadingAssignments(rest, via), command, depth + 1, via)
  }

  private shell(args: ReadonlyArray<string>, command: SimpleCommand, depth: number, via: string | undefined): void {
    let script: string | undefined
    let fromString = false

    for (let k = 0; k < args.length; k++) {
      const arg = args[k]
      if (arg === '--' || arg === '-') {
        script = args[k + 1]
        break
      }
      if (SHELL_VALUE_OPTIONS.has(arg)) {
        k++
        continue
      }
      if (/^-[a-zA-Z]+$/.test(arg) && arg.includes('c')) fromString = true
      if (/^[-+]/.test(arg)) continue
      script = arg
      break
    }

    if (fromString && script !== undefined) return this.script(script, depth + 1, via)
    if (script !== undefined) return this.file(script, depth, via)

    const input = command.input ?? producedText(command.pipedFrom)
    if (input !== undefined) this.script(input, depth + 1, via)
  }

  private find(args: ReadonlyArray<string>, command: SimpleCommand, depth: number, via: string | undefined): void {
    args.forEach((arg, index) => {
      if (!['-exec', '-execdir', '-ok', '-okdir'].includes(arg)) return
      const rest = args.slice(index + 1)
      const end = rest.findIndex((word) => word === ';' || word === '+')
      this.words(end === -1 ? rest : rest.slice(0, end), command, depth + 1, via)
    })
  }

  private interpreter(name: string, args: ReadonlyArray<string>, depth: number, via: string | undefined): void {
    const options = INLINE_CODE[name]
    const index = args.findIndex((arg) => options.includes(arg))

    if (index !== -1) return this.code(args[index + 1] ?? '', depth, via)

    const [script, ...rest] = afterOptions(args, NODE_VALUE_OPTIONS)
    if (script !== undefined) this.program(script, rest, depth, via)
  }

  /** A program a runtime runs: Wrangler's own entry, or a script whose strings are read as commands. */
  private program(path: string, args: ReadonlyArray<string>, depth: number, via: string | undefined): void {
    if (/(^|\/)wrangler(\.[cm]?js)?$|(^|\/)wrangler\/bin\/wrangler\.js$/.test(path)) {
      return this.wrangler(args, ['wrangler', ...args], via)
    }
    if (FENCE_CLI.test(path)) return this.fenceCli(args, ['popweb-fence', ...args], via)
    this.file(path, depth, via, args)
  }

  /** Inline code: each string literal, and each run of literals an argument list holds, read as a command line. */
  private code(source: string, depth: number, via: string | undefined): void {
    for (const line of commandsInCode(source)) this.script(line, depth + 1, via)
  }

  /** A file a command runs: a shell script read as one, a JavaScript or TypeScript program by its strings. */
  private file(path: string | undefined, depth: number, via: string | undefined, args: ReadonlyArray<string> = []): void {
    // A package's own files are its business, and large.
    if (path === undefined || depth >= MAX_DEPTH || /(^|\/)node_modules\//.test(path)) return
    const source = this.options.readFile?.(path)
    if (source === undefined) return

    const shebang = /^#!.*\b(node|bun|deno|tsx|ts-node)\b/.test(source) || /\.[cm]?[jt]sx?$/.test(path)
    const subject = shown([path, ...args])
    if (shebang) this.code(source, depth, from(subject, via))
    else this.script(source, depth + 1, from(subject, via))
  }

  /** `npx`, `bunx`, `pnpx`, `npm exec`, `pnpm dlx`, `yarn dlx`: the package's bin, with its version dropped. */
  private runner(args: ReadonlyArray<string>, command: SimpleCommand, depth: number, via: string | undefined): void {
    let k = 0
    for (; k < args.length; k++) {
      const arg = args[k]
      if (arg === '--') {
        k++
        break
      }
      if (arg === '-c' || arg === '--call') return this.script(args[k + 1] ?? '', depth + 1, via)
      if (arg.startsWith('--call=')) return this.script(arg.slice('--call='.length), depth + 1, via)
      if (arg === '-p' || arg === '--package') {
        k++
        continue
      }
      if (!arg.startsWith('-')) break
    }

    const [bin, ...rest] = args.slice(k)
    if (bin !== undefined) this.words([packageBin(bin), ...rest], command, depth + 1, via)
  }

  /** A package.json script a runner names, with its `pre` and `post` scripts; false when there is none. */
  private runScript(runner: string, name: string, args: ReadonlyArray<string>, depth: number, via: string | undefined): boolean {
    const scripts = this.options.scripts
    if (scripts === undefined || typeof scripts[name] !== 'string') return false

    const extra = args[0] === '--' ? args.slice(1) : args
    const label = from(shown([runner, 'run', name, ...args]), via)

    this.script(scripts[`pre${name}`] ?? '', depth + 1, label)
    this.script([scripts[name], ...extra.map(quote)].join(' '), depth + 1, label)
    this.script(scripts[`post${name}`] ?? '', depth + 1, label)
    return true
  }

  private npm(args: ReadonlyArray<string>, words: ReadonlyArray<string>, command: SimpleCommand, depth: number, via: string | undefined): void {
    const [sub, ...rest] = afterOptions(args, NPM_VALUE_OPTIONS)

    switch (sub) {
      case 'run':
      case 'run-script':
      case 'rum':
      case 'urn': {
        const [name, ...scriptArgs] = afterOptions(rest, NPM_VALUE_OPTIONS)
        if (name !== undefined) this.runScript('npm', name, scriptArgs, depth, via)
        return
      }
      case 'test':
      case 't':
      case 'tst':
        this.runScript('npm', 'test', rest, depth, via)
        return
      case 'start':
      case 'stop':
      case 'restart':
        this.runScript('npm', sub, rest, depth, via)
        return
      case 'exec':
      case 'x':
        return this.runner(rest, command, depth, via)
      case 'publish':
        return this.publish(words, via)
    }
  }

  private bun(args: ReadonlyArray<string>, words: ReadonlyArray<string>, command: SimpleCommand, depth: number, via: string | undefined): void {
    const [sub, ...rest] = afterOptions(args, BUN_VALUE_OPTIONS)
    const options = args.slice(0, args.length - rest.length - (sub === undefined ? 0 : 1))
    const eval_ = options.findIndex((arg) => INLINE_CODE.bun.includes(arg))

    if (eval_ !== -1) return this.code(args[eval_ + 1] ?? '', depth, via)
    if (sub === undefined) return
    if (sub === 'x') return this.runner(rest, command, depth, via)
    if (sub === 'publish') return this.publish(words, via)
    if (sub === 'run') {
      const [name, ...scriptArgs] = afterOptions(rest, BUN_VALUE_OPTIONS)
      if (name !== undefined) this.target('bun', name, scriptArgs, command, depth, via)
      return
    }
    if (!BUN_BUILTINS.has(sub)) this.target('bun', sub, rest, command, depth, via)
  }

  private pnpm(args: ReadonlyArray<string>, words: ReadonlyArray<string>, command: SimpleCommand, depth: number, via: string | undefined): void {
    const [sub, ...rest] = afterOptions(args, PNPM_VALUE_OPTIONS)
    if (sub === undefined) return

    if (sub === 'dlx') return this.runner(rest, command, depth, via)
    if (sub === 'exec') return this.words(afterOptions(rest, PNPM_VALUE_OPTIONS), command, depth + 1, via)
    if (sub === 'publish') return this.publish(words, via)
    if (sub === 'run') {
      const [name, ...scriptArgs] = afterOptions(rest, PNPM_VALUE_OPTIONS)
      if (name !== undefined) this.target('pnpm', name, scriptArgs, command, depth, via)
      return
    }
    if (['test', 't', 'start', 'stop', 'restart'].includes(sub)) {
      this.runScript('pnpm', sub === 't' ? 'test' : sub, rest, depth, via)
      return
    }
    if (!PNPM_BUILTINS.has(sub)) this.target('pnpm', sub, rest, command, depth, via)
  }

  private yarn(args: ReadonlyArray<string>, words: ReadonlyArray<string>, command: SimpleCommand, depth: number, via: string | undefined): void {
    const [sub, ...rest] = afterOptions(args, YARN_VALUE_OPTIONS)
    if (sub === undefined) return

    if (sub === 'dlx') return this.runner(rest, command, depth, via)
    if (sub === 'exec') return this.words(rest, command, depth + 1, via)
    if (sub === 'publish' || (sub === 'npm' && rest[0] === 'publish')) return this.publish(words, via)
    if (sub === 'workspace') return this.yarn(rest.slice(1), words, command, depth + 1, via)
    if (sub === 'node') return this.interpreter('node', rest, depth, via)
    if (sub === 'run') {
      const [name, ...scriptArgs] = rest
      if (name !== undefined) this.target('yarn', name, scriptArgs, command, depth, via)
      return
    }
    if (!YARN_BUILTINS.has(sub)) this.target('yarn', sub, rest, command, depth, via)
  }

  /** What `bun run x` and `pnpm x` name: a package.json script, a file, or a package's bin. */
  private target(runner: string, name: string, args: ReadonlyArray<string>, command: SimpleCommand, depth: number, via: string | undefined): void {
    if (this.runScript(runner, name, args, depth, via)) return
    if (/\.[cm]?[jt]sx?$|\.sh$/.test(name) || name.includes('/')) return this.program(name, args, depth, via)
    this.words([name, ...args], command, depth + 1, via)
  }

  private publish(words: ReadonlyArray<string>, via: string | undefined): void {
    if (!words.includes('--dry-run')) this.ask('publish', shown(words), via)
  }

  private git(args: ReadonlyArray<string>, words: ReadonlyArray<string>, depth: number, via: string | undefined): void {
    const subject = shown(words)
    let k = 0

    for (; k < args.length; k++) {
      const arg = args[k]
      const [option, attached] = splitOption(arg)
      if (!GIT_VALUE_OPTIONS.has(option)) {
        if (arg.startsWith('-')) continue
        break
      }
      const value = attached ?? args[++k] ?? ''
      if (option === '-c') this.config(value.split('=')[0] ?? '', value.includes('=') ? value.slice(value.indexOf('=') + 1) : undefined, subject, depth, via)
      if (option === '--config-env') this.config(value.split('=')[0] ?? '', undefined, subject, depth, via)
    }

    const [sub, ...rest] = args.slice(k)
    if (sub === undefined) return

    const end = rest.indexOf('--')
    const options = end === -1 ? rest : rest.slice(0, end)

    if (options.some((arg) => NO_VERIFY.test(arg)) || (sub === 'commit' && commitSkipsHooks(options))) {
      this.deny(subject, 'skips the git hooks that run the commit gate. Fix what the gate reports and commit again; only the owner changes the gate.', via)
      return
    }

    switch (sub) {
      case 'push':
        if (!options.includes('--dry-run') && !options.includes('-n')) this.ask('push', subject, via)
        return
      case 'config':
        return this.gitConfig(rest, subject, depth, via)
      case 'rebase':
        options.forEach((arg, index) => {
          if (arg === '-x' || arg === '--exec') this.script(options[index + 1] ?? '', depth + 1, via)
          if (arg.startsWith('--exec=')) this.script(arg.slice('--exec='.length), depth + 1, via)
        })
        return
      case 'bisect':
        if (rest[0] === 'run') this.script(rest.slice(1).map(quote).join(' '), depth + 1, via)
        return
      case 'submodule':
        if (rest.includes('foreach')) this.script(rest.slice(rest.indexOf('foreach') + 1).join(' '), depth + 1, via)
        return
    }
  }

  private gitConfig(args: ReadonlyArray<string>, subject: string, depth: number, via: string | undefined): void {
    const flags: string[] = []
    const positional: string[] = []

    for (let k = 0; k < args.length; k++) {
      const arg = args[k]
      if (arg.startsWith('-')) {
        flags.push(arg)
        if (CONFIG_VALUE_OPTIONS.has(arg)) k++
      } else {
        positional.push(arg)
      }
    }

    const verb = ['set', 'unset', 'get', 'list', 'rename-section', 'remove-section'].includes(positional[0] ?? '') ? positional.shift() : undefined
    const [key, value] = positional
    const writes =
      verb === 'set' || verb === 'unset' || value !== undefined ||
      flags.some((flag) => /^--(unset|unset-all|add|replace-all)$/.test(flag))

    if (key !== undefined && writes) this.config(key, value, subject, depth, via)
  }

  /** A git config value set for one command or for good: the hooks path, or an alias that bypasses the hooks. */
  private config(key: string, value: string | undefined, subject: string, depth: number, via: string | undefined): void {
    const name = key.toLowerCase()

    if (name === 'core.hookspath') {
      this.deny(subject, 'changes which git hooks run, which can switch off the commit gate. Only the owner changes the gate.', via)
    } else if (name.startsWith('alias.') && value !== undefined) {
      if (value.startsWith('!')) this.script(value.slice(1), depth + 1, via)
      else this.git(splitWords(value), ['git', ...splitWords(value)], depth + 1, via)
    }
  }

  private wrangler(args: ReadonlyArray<string>, words: ReadonlyArray<string>, via: string | undefined): void {
    const subject = shown(words)
    const path: string[] = []

    for (let k = 0; k < args.length && path.length < 3; k++) {
      const arg = args[k]
      if (arg.startsWith('-')) {
        if (WRANGLER_VALUE_OPTIONS.has(arg)) k++
        continue
      }
      path.push(...arg.split(':'))
    }

    const flag = (name: string) =>
      args.some((arg) => arg === name || (arg.startsWith(`${name}=`) && !/^(false|0)$/i.test(arg.slice(name.length + 1))))
    const dryRun = flag('--dry-run') || flag('--dryRun')
    const [a, b, c] = path

    const deploys = (a === 'deploy' || a === 'publish') || (a === 'versions' && (b === 'deploy' || b === 'upload')) ||
      (a === 'triggers' && b === 'deploy') || (a === 'pages' && (b === 'deploy' || b === 'publish'))

    if ((a === 'secret' && SECRET_WRITES.has(b ?? '')) || ((a === 'versions' || a === 'pages') && b === 'secret' && SECRET_WRITES.has(c ?? ''))) {
      this.ask('secret', subject, via)
    } else if (a === 'rollback' || a === 'delete' || (a === 'pages' && b === 'project' && c === 'delete')) {
      this.ask('deploy', subject, via, 'rolls back or deletes a Worker on Cloudflare. Approve it only if you asked for it.')
    } else if (deploys) {
      if (!dryRun) this.ask('deploy', subject, via)
    } else if (flag('--remote') || (a === 'd1' && b === 'time-travel' && c === 'restore') || (path.includes('delete') && !flag('--local'))) {
      // A resource's delete, such as `wrangler d1 delete`, acts on Cloudflare unless it says --local.
      this.ask('remote-data', subject, via)
    }
  }
}

/** The text an `echo`, `printf` or `cat <<EOF` gives the next command of a pipeline. */
function producedText(command: SimpleCommand | undefined): string | undefined {
  if (command === undefined) return undefined
  const [head, ...args] = command.words
  const name = basename(head ?? '')

  if (name === 'echo') return args.filter((arg) => !/^-[neE]+$/.test(arg)).join(' ')
  if (name === 'printf') {
    const [format = '', ...values] = args
    let index = 0
    return format.replace(/\\n/g, '\n').replace(/%[sdb]/g, () => values[index++] ?? '')
  }
  if (name === 'cat' && args.length === 0) return command.input
  return undefined
}

/** `git commit -n`, alone or in a cluster such as `-anm`, which skips the hooks as `--no-verify` does. */
function commitSkipsHooks(options: ReadonlyArray<string>): boolean {
  for (let k = 0; k < options.length; k++) {
    const arg = options[k]
    if (COMMIT_VALUE_LONG.has(arg)) {
      k++
      continue
    }
    if (!/^-[^-]/.test(arg)) continue

    for (let p = 1; p < arg.length; p++) {
      const flag = arg[p]
      if (flag === 'n') return true
      if (COMMIT_VALUE_SHORT.has(flag)) {
        if (p === arg.length - 1) k++
        break
      }
      // -S and -u take a value only attached to them.
      if (flag === 'S' || flag === 'u') break
    }
  }
  return false
}

/** Each string literal of a program, and each run of literals in one argument list, as a command line. */
function commandsInCode(source: string): string[] {
  const literal = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g
  const runs: string[][] = []
  let run: string[] = []
  let last = 0

  for (const match of source.matchAll(literal)) {
    if (run.length > 0 && !/^[\s,[\]]*$/.test(source.slice(last, match.index))) {
      runs.push(run)
      run = []
    }
    run.push((match[1] ?? match[2] ?? match[3]).replace(/\\(.)/g, '$1'))
    last = match.index + match[0].length
  }
  if (run.length > 0) runs.push(run)

  return runs.flatMap((strings) => (strings.length === 1 ? strings : [...strings, strings.map(quote).join(' ')]))
}

/** The words after a command's options, past the value of each option that takes one. */
function afterOptions(args: ReadonlyArray<string>, values: ReadonlyArray<string> | ReadonlySet<string>): ReadonlyArray<string> {
  const takesValue = (arg: string) => (values instanceof Set ? values.has(arg) : (values as ReadonlyArray<string>).includes(arg))
  let k = 0

  while (k < args.length) {
    const arg = args[k]
    if (arg === '--') return args.slice(k + 1)
    if (!arg.startsWith('-') || arg === '-') break
    k += takesValue(arg) ? 2 : 1
  }
  return args.slice(k)
}

function positionals(args: ReadonlyArray<string>): ReadonlyArray<string> {
  const end = args.indexOf('--')
  return end === -1 ? args.filter((arg) => !arg.startsWith('-')) : [...args.slice(0, end).filter((arg) => !arg.startsWith('-')), ...args.slice(end + 1)]
}

function splitOption(arg: string): [string, string | undefined] {
  const index = arg.indexOf('=')
  return arg.startsWith('--') && index !== -1 ? [arg.slice(0, index), arg.slice(index + 1)] : [arg, undefined]
}

/** A package a runner names, as its bin: `wrangler@4` is `wrangler`, `@scope/tool@1` is `tool`. */
function packageBin(spec: string): string {
  const withoutVersion = spec.startsWith('@') ? spec.replace(/^(@[^/]+\/[^@]+)@.*$/, '$1') : spec.replace(/@.*$/, '')
  return basename(withoutVersion)
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function quote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`
}

function shown(words: ReadonlyArray<string>): string {
  return words.map(quote).join(' ')
}

function from(subject: string, via: string | undefined): string {
  return via === undefined ? subject : `${via}: ${subject}`
}
