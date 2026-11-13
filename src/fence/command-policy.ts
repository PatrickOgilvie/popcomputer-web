/**
 * The command policy: what an agent's shell command may run without the
 * owner. It refuses a command that skips the commit gate, and asks the owner
 * before one that deploys, touches remote data, changes secrets, publishes a
 * package or pushes. It reads the command line as bash does, with
 * tree-sitter's bash grammar, and judges every command the tree holds:
 * lists, pipelines, subshells, substitutions, heredocs, `sh -c`, `eval` and
 * `trap` strings, wrappers such as `env`, `sudo`, `npx` and `xargs`, the
 * package.json scripts a runner names, and the scripts and programs a
 * command runs. It fails closed: what it cannot read where it matters, such
 * as a command name an expansion gives or a script it cannot open, goes to
 * the owner.
 */
import { codeKind, commandsInCode, startsProcess, stringsInCode, writesFiles, type CodeKind } from './code.js'
import { linkFindings, pathFindings, pathspecCovers, protectedFileFindings, writeFindings } from './file-policy.js'
import { joinPath, parentPath } from './path.js'
import { GLOB_ANY, GLOB_ONE, UNREAD, UNREAD_WORDS, display, isDynamic, known, readScript, splitWords, wordParts, type SimpleCommand } from './shell.js'
import { strongest, type FenceRule, type FenceVerdict, type Finding } from './verdict.js'

export type { FenceRule, FenceVerdict } from './verdict.js'

/** What the policy reads besides the command line. */
export interface CommandPolicyOptions {
  /** The application's package.json scripts, so `bun run deploy` is read as the commands it runs. */
  readonly scripts?: Readonly<Record<string, string>>
  /**
   * A file a command runs or reads, such as `sh scripts/release.sh` or
   * another directory's package.json, by its path from where the command
   * line starts; undefined when it is missing or too large to read.
   */
  readonly readFile?: (path: string) => string | undefined
  /** The directory git's `core.hooksPath` names, whose files are the gate itself. */
  readonly hooksPath?: string
}

/** Scripts, substitutions and wrappers are followed this deep; deeper asks the owner. */
const MAX_DEPTH = 12

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'yash'])

/** A command's options: short ones as letters, long ones by name, each taking a value or not. */
interface OptionSpec {
  readonly flags?: string
  readonly values?: string
  readonly longFlags?: ReadonlyArray<string>
  readonly longValues?: ReadonlyArray<string>
  /** Words it reads before the command it runs, as `timeout`'s duration. */
  readonly positionals?: number
  /** `nice -5`: a number as an option. */
  readonly numeric?: boolean
}

/** Commands that run the command after their options. An option not listed asks the owner. */
const WRAPPERS: Readonly<Record<string, OptionSpec>> = {
  builtin: {},
  command: { flags: 'p' },
  exec: { flags: 'cl', values: 'a' },
  nohup: {},
  noglob: {},
  nocorrect: {},
  // zsh runs `- command` as a login command.
  '-': {},
  time: { flags: 'pqvalh', values: 'fo', longFlags: ['--verbose', '--quiet', '--append', '--portability'], longValues: ['--format', '--output'] },
  nice: { values: 'n', longValues: ['--adjustment'], numeric: true },
  ionice: { flags: 't', values: 'cnpPu', longValues: ['--class', '--classdata', '--pid', '--pgid', '--uid'] },
  stdbuf: { values: 'ioe', longValues: ['--input', '--output', '--error'] },
  timeout: { flags: 'fpv', values: 'sk', longFlags: ['--foreground', '--preserve-status', '--verbose'], longValues: ['--signal', '--kill-after'], positionals: 1 },
  sudo: {
    flags: 'AbEHKknPSBN',
    values: 'ugpCrtTU',
    longFlags: ['--askpass', '--background', '--preserve-env', '--set-home', '--non-interactive', '--preserve-groups', '--stdin', '--bell', '--reset-timestamp'],
    longValues: ['--user', '--group', '--prompt', '--close-from', '--role', '--type', '--command-timeout', '--other-user'],
  },
  doas: { flags: 'n', values: 'u' },
  chronic: { flags: 'dev' },
  unbuffer: { flags: 'p' },
  caffeinate: { flags: 'dimsu', values: 'tw' },
  setsid: { flags: 'cfw', longFlags: ['--ctty', '--fork', '--wait'] },
  repeat: { positionals: 1 },
}
const ENV_OPTIONS: OptionSpec = { flags: 'i0v', values: 'uP', longFlags: ['--ignore-environment', '--null', '--debug'], longValues: ['--unset'] }
const XARGS_OPTIONS: OptionSpec = {
  flags: '0rtpxoile',
  values: 'nLPsEdaIJ',
  longFlags: ['--null', '--no-run-if-empty', '--verbose', '--interactive', '--exit', '--open-tty', '--replace'],
  longValues: ['--max-args', '--max-lines', '--max-procs', '--max-chars', '--eof', '--delimiter', '--arg-file', '--process-slot-var'],
}
/** `npx`, `bunx`, `pnpx`, `npm exec`, `pnpm dlx`, `yarn dlx` and `bun x`. */
const RUNNER_OPTIONS: OptionSpec = {
  flags: 'yqs',
  values: 'pcw',
  longFlags: ['--yes', '--no', '--quiet', '--silent', '--no-install', '--ignore-existing', '--prefer-offline', '--prefer-online', '--offline', '--workspaces', '--include-workspace-root', '--bun', '--verbose', '--no-color', '--shell-mode'],
  longValues: ['--package', '--call', '--cache', '--registry', '--userconfig', '--prefix', '--workspace', '--node-options', '--shell', '--script-shell', '--loglevel'],
}
const SHELL_OPTIONS: OptionSpec = {
  flags: 'abcefhiklmnprstuvxBCEHPT',
  values: 'oO',
  longFlags: ['--login', '--norc', '--noprofile', '--posix', '--restricted', '--verbose', '--noediting', '--no-config', '--private', '--interactive', '--no-execute', '--help', '--version'],
  longValues: ['--rcfile', '--init-file', '--command', '--init-command'],
}
const FISH_OPTIONS: OptionSpec = {
  flags: 'ilnPNvh',
  values: 'cCdofp',
  longFlags: ['--login', '--interactive', '--no-execute', '--no-config', '--private', '--print-rusage-self', '--help', '--version'],
  longValues: ['--command', '--init-command', '--debug', '--debug-output', '--features', '--profile', '--profile-startup'],
}
/** `script`, BSD's (`script [file [command...]]`) and util-linux's (`script -c command [file]`) alike. */
const SCRIPT_OPTIONS: OptionSpec = {
  flags: 'adeFfkpqrhV',
  values: 'tTBIOmoEc',
  longFlags: ['--append', '--return', '--flush', '--force', '--quiet', '--help', '--version'],
  longValues: ['--command', '--echo', '--log-io', '--log-in', '--log-out', '--log-timing', '--logging-format', '--output-limit', '--timing'],
}
/** GNU's and BSD's `patch`. */
const PATCH_OPTIONS: OptionSpec = {
  flags: 'bcCeEfglnNRstTuvZ',
  values: 'BDdFiopVrYz',
  longFlags: [
    '--dry-run', '--check', '--forward', '--reverse', '--force', '--batch', '--silent', '--quiet', '--backup', '--ignore-whitespace', '--unified',
    '--context', '--normal', '--ed', '--remove-empty-files', '--posix', '--verbose', '--binary', '--merge', '--follow-symlinks', '--set-time',
    '--set-utc', '--no-backup-if-mismatch', '--backup-if-mismatch',
  ],
  longValues: [
    '--input', '--strip', '--directory', '--output', '--reject-file', '--prefix', '--suffix', '--basename-prefix', '--fuzz', '--get', '--ifdef',
    '--version-control', '--quoting-style', '--read-only', '--reject-format',
  ],
}
const FLOCK_OPTIONS: OptionSpec = {
  flags: 'sxeunoFhV',
  values: 'wEc',
  longFlags: ['--shared', '--exclusive', '--unlock', '--nonblock', '--nb', '--close', '--no-fork', '--verbose', '--help', '--version'],
  longValues: ['--wait', '--timeout', '--conflict-exit-code', '--command'],
}
/** BSD's and macOS's `lockf [-knsw] [-t seconds] file command [arguments]`. */
const LOCKF_OPTIONS: OptionSpec = { flags: 'knsw', values: 't' }
const SSH_OPTIONS: OptionSpec = { flags: '46AaCfGgKkMNnqsTtVvXxYy', values: 'BbcDEeFIiJLlmOoPpQRSWw' }
/** `-o` settings whose command ssh runs here, and the one it runs on the host. */
const SSH_COMMANDS = /^(proxycommand|localcommand|knownhostscommand|remotecommand)\s*[=\s]\s*(.*)$/is
const AWK_OPTIONS: OptionSpec = {
  flags: 'bcCdDghLMnNoOpPrsStVY',
  values: 'fFveEilW',
  longFlags: [
    '--posix', '--lint', '--traditional', '--sandbox', '--re-interval', '--characters-as-bytes', '--debug', '--dump-variables', '--profile',
    '--pretty-print', '--optimize', '--no-optimize', '--bignum', '--use-lc-numeric', '--non-decimal-data', '--gen-pot', '--copyright',
    '--version', '--help', '--csv',
  ],
  longValues: ['--file', '--exec', '--field-separator', '--assign', '--source', '--include', '--load'],
}
/** `xcrun`'s options, whole words; after one of `finds`, it names a tool rather than run it. */
const XCRUN = {
  flags: ['-l', '--log', '-v', '--verbose', '-n', '--no-cache', '-k', '--kill-cache', '-r', '--run'],
  values: ['-sdk', '--sdk', '-toolchain', '--toolchain'],
  finds: ['-f', '--find', '--show-sdk-path', '--show-sdk-version', '--show-sdk-build-version', '--show-sdk-platform-path', '--show-sdk-platform-version', '--version', '-h', '--help'],
}
const DOTENV_FLAGS = ['--no-expand', '--debug', '--quiet', '-o', '--override']
/** concurrently's options that take a value; any other word is a command line. */
const CONCURRENTLY_VALUES = [
  '-n', '--names', '--name-separator', '-s', '--success', '-c', '--prefix-colors', '-p', '--prefix', '-l', '--prefix-length', '-t',
  '--timestamp-format', '-m', '--max-processes', '--kill-signal', '--restart-tries', '--restart-after', '--default-input-target', '--hide',
]
/** Command lines parallel runs, or concurrently's `npm:` scripts it expands, read at most this many. */
const MAX_RUNS = 64
/** Variables naming a program git, or the pager and editor it starts, runs: each a command line, as `-c diff.external` is. */
const GIT_PROGRAMS = new Set([
  'GIT_EXTERNAL_DIFF', 'GIT_SSH_COMMAND', 'GIT_SSH', 'GIT_PROXY_COMMAND', 'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_PAGER', 'PAGER', 'MANPAGER',
  'LESSOPEN', 'GIT_EDITOR', 'GIT_SEQUENCE_EDITOR', 'EDITOR', 'VISUAL',
])
/**
 * Builtins that evaluate a word as arithmetic or a variable's name, as
 * `unset 'a[$(cmd)]'` and `let` do, or set a value later evaluated so, as
 * `read` and `printf -v` do: a command substitution in it runs.
 */
const EVALUATES = new Set(['let', 'unset', 'declare', 'typeset', 'local', 'export', 'readonly', 'read', 'mapfile', 'readarray', 'test', '[', 'printf'])
/** Builtins that set variables, whose `NAME=value` arguments the commands after them see. */
const DECLARATIONS = new Set(['export', 'declare', 'typeset', 'readonly', 'local'])

/** Interpreters: the language they run, and their options that give code inline or take a value. */
interface Interpreter {
  readonly kind: CodeKind
  /** Short options whose value is code: the rest of the cluster, or the next word. */
  readonly inline: string
  readonly inlineLong?: ReadonlyArray<string>
  /** Short options that take a value, attached or the next word. */
  readonly values?: string
  /** Short options whose value, if any, is the rest of the cluster, as perl's `-i.bak`. */
  readonly attached?: string
  readonly longValues?: ReadonlyArray<string>
  /** An option after which the next word is a module, not a file, as python's `-m`. */
  readonly module?: string
  /** An option whose value is the script file, as php's `-f`. */
  readonly file?: string
}
const NODE: Interpreter = {
  kind: 'js',
  inline: 'ep',
  inlineLong: ['--eval', '--print'],
  values: 'rC',
  longValues: ['--require', '--import', '--loader', '--experimental-loader', '--env-file', '--conditions', '--input-type', '--title', '--watch-path', '--test-name-pattern', '--test-reporter', '--test-reporter-destination'],
}
const TS_NODE_VALUES = ['--require', '--project', '--compiler-options', '--compiler', '--ignore', '--cwd', '--scope-dir']
const TS_NODE_DEV: Interpreter = {
  ...NODE,
  values: 'rPOCI',
  longValues: [...TS_NODE_VALUES, '--watch', '--ignore-watch', '--debounce', '--interval', '--dir', '--cache-directory'],
}
const INTERPRETERS: Readonly<Record<string, Interpreter>> = {
  node: NODE,
  'node-dev': NODE,
  tsx: NODE,
  'ts-node': { ...NODE, values: 'rPOCI', longValues: TS_NODE_VALUES },
  'ts-node-esm': { ...NODE, values: 'rPOCI' },
  'ts-node-dev': TS_NODE_DEV,
  tsnd: TS_NODE_DEV,
  'babel-node': {
    ...NODE,
    values: 'rioxwb',
    longValues: ['--require', '--ignore', '--only', '--extensions', '--plugins', '--presets', '--config-file', '--root-mode', '--env-name'],
  },
  esno: NODE,
  esrun: NODE,
  'vite-node': { kind: 'js', inline: '', values: 'r', longValues: ['--root', '--config', '--mode'] },
  jiti: { kind: 'js', inline: '' },
  python: { kind: 'python', inline: 'c', values: 'WX', module: 'm' },
  perl: { kind: 'perl', inline: 'eE', values: 'IMmF', attached: 'il0xdC' },
  ruby: { kind: 'ruby', inline: 'e', values: 'IrCEF', attached: 'ilx0W' },
  php: { kind: 'php', inline: 'r', values: 'dc', file: 'f' },
  osascript: { kind: 'applescript', inline: 'e', values: 'ls' },
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
/** Each package manager's options before its command that take a value, and those that name the package's directory. */
const NPM_VALUES = { values: ['--prefix', '-C', '-w', '--workspace', '--userconfig', '--registry', '--cache', '--loglevel', '--tag', '--otp', '--access'], directory: ['--prefix', '-C'] }
const BUN_VALUES = { values: ['--cwd', '--filter', '-F', '--config', '-c', '--env-file', '--preload', '-r', '--require', '--import', '--elide-lines', '--shell', '--tsconfig-override'], directory: ['--cwd'] }
const PNPM_VALUES = { values: ['-C', '--dir', '--prefix', '--filter', '-F', '--filter-prod', '--reporter', '--loglevel', '--workspace-concurrency'], directory: ['-C', '--dir', '--prefix'] }
const YARN_VALUES = { values: ['--cwd'], directory: ['--cwd'] }

/** `popweb-fence`, run by its bin or by its file, in the package or in its own repository. */
const FENCE_CLI = /(^|\/)popweb-fence$|(^|\/)fence\/cli\.[cm]?[jt]s$/
/** Wrangler, run by its bin, by the file its bin is, or by the file its package's `main` names. */
const WRANGLER_ENTRY = /(^|\/)wrangler(\.[cm]?js)?$|(^|\/)wrangler\/(?:bin|wrangler-dist)\/[^/]+\.[cm]?js$/

/** `--no-verify`, and the abbreviations git accepts for it. */
const NO_VERIFY = /^--no-veri(?:f|fy)?$/
/** Short options of `git commit` that take a value, which `-n` cannot follow in a cluster. */
const COMMIT_VALUE_SHORT = new Set(['m', 'F', 'C', 'c', 't'])
const COMMIT_VALUE_LONG = new Set([
  '--message', '--file', '--reuse-message', '--reedit-message', '--template', '--author', '--date', '--cleanup', '--fixup',
  '--squash', '--trailer', '--pathspec-from-file',
])
const CONFIG_VALUE_OPTIONS = new Set(['-f', '--file', '--blob', '--type', '--default', '--comment', '--value'])

/** git's own commands, which an alias never shadows; any other may be an alias the fence cannot see. */
const GIT_COMMANDS = new Set([
  'add', 'am', 'annotate', 'apply', 'archimport', 'archive', 'backfill', 'bisect', 'blame', 'branch', 'bugreport', 'bundle', 'cat-file',
  'check-attr', 'check-ignore', 'check-mailmap', 'check-ref-format', 'checkout', 'checkout-index', 'cherry', 'cherry-pick', 'citool', 'clean',
  'clone', 'column', 'commit', 'commit-graph', 'commit-tree', 'config', 'count-objects', 'credential', 'credential-cache', 'credential-store',
  'cvsexportcommit', 'cvsimport', 'cvsserver', 'daemon', 'describe', 'diagnose', 'diff', 'diff-files', 'diff-index', 'diff-pairs', 'diff-tree',
  'difftool', 'fast-export', 'fast-import', 'fetch', 'fetch-pack', 'filter-branch', 'fmt-merge-msg', 'for-each-ref', 'for-each-repo',
  'format-patch', 'fsck', 'fsck-objects', 'gc', 'get-tar-commit-id', 'grep', 'gui', 'hash-object', 'help', 'hook', 'http-backend',
  'http-fetch', 'http-push', 'imap-send', 'index-pack', 'init', 'init-db', 'instaweb', 'interpret-trailers', 'last-modified', 'log',
  'ls-files', 'ls-remote', 'ls-tree', 'mailinfo', 'mailsplit', 'maintenance', 'merge', 'merge-base', 'merge-file', 'merge-index',
  'merge-octopus', 'merge-one-file', 'merge-ours', 'merge-recursive', 'merge-resolve', 'merge-subtree', 'merge-tree', 'mergetool', 'mktag',
  'mktree', 'multi-pack-index', 'mv', 'name-rev', 'notes', 'p4', 'pack-objects', 'pack-redundant', 'pack-refs', 'patch-id', 'prune',
  'prune-packed', 'pull', 'push', 'quiltimport', 'range-diff', 'read-tree', 'rebase', 'receive-pack', 'reflog', 'refs', 'remote', 'repack',
  'replace', 'replay', 'repo', 'request-pull', 'rerere', 'reset', 'restore', 'rev-list', 'rev-parse', 'revert', 'rm', 'send-email',
  'send-pack', 'shell', 'shortlog', 'show', 'show-branch', 'show-index', 'show-ref', 'sparse-checkout', 'stage', 'stash', 'status',
  'stripspace', 'submodule', 'subtree', 'svn', 'switch', 'symbolic-ref', 'tag', 'unpack-file', 'unpack-objects', 'update-index',
  'update-ref', 'update-server-info', 'upload-archive', 'upload-pack', 'var', 'verify-commit', 'verify-pack', 'verify-tag', 'version',
  'whatchanged', 'worktree', 'write-tree',
])

/** git's global options that take a value. */
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix', '--list-cmds', '--attr-source'])

/** A git command's options, by what they take: nothing, a value attached or in the next word, or only an attached one. */
interface GitOptions {
  readonly flags: ReadonlySet<string>
  readonly values: ReadonlySet<string>
  readonly attached: ReadonlySet<string>
  readonly shortFlags: string
  readonly shortValues: string
  /** Short options whose value, if any, is the rest of their cluster, as `-S`'s key. */
  readonly shortAttached: string
}
/** The options `git cherry-pick` and `git revert` share that take no value; `--no-no-commit` is `--commit`. */
const SEQUENCER_FLAGS = [
  '--quit', '--continue', '--abort', '--skip', '--no-cleanup', '--no-commit', '--commit', '--no-no-commit', '--edit', '--no-edit', '--signoff',
  '--no-signoff', '--no-mainline', '--rerere-autoupdate', '--no-rerere-autoupdate', '--no-strategy', '--no-strategy-option', '--no-gpg-sign',
]
const SEQUENCER_VALUES = ['--cleanup', '--mainline', '--strategy', '--strategy-option']

/**
 * git's dangerous surface, as data: each way a git command can get past the
 * commit gate, with what the policy answers.
 */
const GIT_SURFACE = {
  /** Global options that point git at another repository or program, whose hooks are not the gate. */
  elsewhere: new Set(['--git-dir', '--work-tree', '--exec-path', '--super-prefix']),
  /** Settings, for one command (`-c`, `--config-env`, `GIT_CONFIG_*`) or for good (`git config`). */
  settings: [
    { key: /^core\.hookspath$/, finding: 'deny', reason: 'changes which git hooks run, which can switch off the commit gate. Only the owner changes the gate.' },
    { key: /^alias\./, finding: 'alias', reason: '' },
    { key: /^include\.path$|^includeif\..+\.path$/, finding: 'ask', reason: 'includes another git config file, which can move the hooks or switch them off. Approve it only if you expected it.' },
    {
      key: /^(user\.|color\.|advice\.|column\.|log\.|maintenance\.)|^(init\.defaultbranch|core\.quotepath|core\.autocrlf|core\.safecrlf|commit\.gpgsign|tag\.gpgsign|pull\.rebase|pull\.ff|push\.default|push\.autosetupremote|merge\.conflictstyle|diff\.noprefix|diff\.renames|protocol\.version|safe\.directory)$/,
      finding: 'none',
      reason: '',
    },
  ],
  /** Any other setting, for one command. */
  otherSetting: { finding: 'ask', reason: 'sets a git setting for this command, which can move the hooks or name a program git runs. Approve it only if you expected it.' },
  /** Settings `git config` may write for good that name a program git runs. */
  programs: /^(core\.(fsmonitor|pager|editor|sshcommand|askpass|worktree)|sequence\.editor|diff\.external|credential\.helper|gpg\.program|uploadpack\.packobjectshook|init\.templatedir)$|^(filter|diff|merge|pager)\./,
  /**
   * Commands that commit without the pre-commit hook, and their options with
   * which they make no commit. Where git reads a command's options in pairs,
   * `makesNoCommit` reads them as git does too.
   */
  commitsWithoutHook: {
    pull: [],
    merge: ['--abort', '--quit', '--no-commit'],
    'cherry-pick': ['--abort', '--quit', '--no-commit', '-n'],
    revert: ['--abort', '--quit', '--no-commit', '-n'],
    am: ['--abort', '--quit', '--show-current-patch'],
    rebase: ['--abort', '--quit', '--show-current-patch', '--edit-todo'],
  } as Readonly<Record<string, ReadonlyArray<string>>>,
  /**
   * The options of the commands that commit without the hook and whose
   * options git reads in pairs, the last of each winning. Any other may be
   * one of a pair, as `--no-no-commit` is `--commit`, or abbreviate one, as
   * `--no-f` does `--no-ff`, or one that takes the next word, as `--mess`
   * does `--message`.
   */
  pairedOptions: {
    merge: {
      flags: new Set([
        '--stat', '--no-stat', '--summary', '--no-summary', '--compact-summary', '--no-compact-summary', '--no-log', '--squash', '--no-squash',
        '--commit', '--no-commit', '--edit', '--no-edit', '--no-cleanup', '--ff', '--no-ff', '--ff-only', '--rerere-autoupdate',
        '--no-rerere-autoupdate', '--verify-signatures', '--no-verify-signatures', '--no-strategy', '--no-strategy-option', '--no-message',
        '--no-into-name', '--verbose', '--no-verbose', '--quiet', '--no-quiet', '--abort', '--no-abort', '--quit', '--no-quit', '--continue',
        '--no-continue', '--allow-unrelated-histories', '--no-allow-unrelated-histories', '--progress', '--no-progress', '--no-gpg-sign',
        '--autostash', '--no-autostash', '--overwrite-ignore', '--no-overwrite-ignore', '--signoff', '--no-signoff', '--verify',
      ]),
      values: new Set(['--cleanup', '--strategy', '--strategy-option', '--message', '--file', '--into-name']),
      attached: new Set(['--log', '--gpg-sign']),
      shortFlags: 'neqv',
      shortValues: 'mFsX',
      shortAttached: 'S',
    },
    'cherry-pick': {
      flags: new Set([
        ...SEQUENCER_FLAGS, '--ff', '--no-ff', '--allow-empty', '--no-allow-empty', '--allow-empty-message', '--no-allow-empty-message',
        '--keep-redundant-commits', '--no-keep-redundant-commits',
      ]),
      values: new Set([...SEQUENCER_VALUES, '--empty']),
      attached: new Set(['--gpg-sign']),
      shortFlags: 'nesx',
      shortValues: 'mX',
      shortAttached: 'S',
    },
    revert: {
      flags: new Set([...SEQUENCER_FLAGS, '--reference', '--no-reference']),
      values: new Set(SEQUENCER_VALUES),
      attached: new Set(['--gpg-sign']),
      shortFlags: 'nes',
      shortValues: 'mX',
      shortAttached: 'S',
    },
  } as Readonly<Record<string, GitOptions>>,
  /** Commands that send commits to a remote. */
  pushes: new Set(['push', 'send-pack', 'http-push']),
  /** Commands that write a commit by hand, which runs none of the hooks. */
  commitWriters: new Set(['commit-tree', 'fast-import']),
  /** Commands that change the files they name, and their options that take a value. */
  writesPaths: {
    rm: ['--pathspec-from-file'],
    mv: [],
    checkout: ['-b', '-B', '--orphan', '--conflict', '--pathspec-from-file'],
    restore: ['-s', '--source', '--conflict', '--pathspec-from-file'],
    clean: ['-e', '--exclude'],
    reset: ['--pathspec-from-file'],
    'update-index': [],
    'checkout-index': [],
  } as Readonly<Record<string, ReadonlyArray<string>>>,
} as const

/** The setting that moves git's hooks, as `-c` names it before its value. */
const HOOKS_PATH = 'core.hooksPath'
/**
 * The words that, in place of one the fence cannot read, would make a command
 * a way around the commit gate: git, its commit, commit's `-n`, which skips
 * the hooks only there, and the setting that moves them.
 */
const GATE_WORDS: ReadonlyArray<string> = ['git', 'commit', '-n', HOOKS_PATH]
/** The same, for an unquoted expansion, which the shell may split into several words, as `$(echo git commit)`. */
const GATE_RUNS: ReadonlyArray<ReadonlyArray<string>> = [['git', 'commit'], ['commit', '-n'], ['git', 'commit', '-n']]
/** The words that, in place of one the fence cannot read, would make a command one the owner approves. */
const OWNER_WORDS: ReadonlyArray<string> = ['wrangler', 'deploy', 'push', 'publish', 'secret', '--remote', '--allow-increase']
/** Whether a word is one of those, or names the hooks setting, as `-c core.hooksPath=` does. */
const namesGate = (word: string) => GATE_WORDS.includes(word) || word.toLowerCase().includes(HOOKS_PATH.toLowerCase())
/** How many unread words of one command take another reading at once: git, its commit and the flag. */
const MAX_REREAD = 3
/** How many unread words of one command are read otherwise; the rest are read as the shell's own expansion. */
const MAX_UNREAD_WORDS = 6

const WRANGLER_VALUE_OPTIONS = new Set([
  '-c', '--config', '-e', '--env', '--env-file', '--cwd', '--name', '--compatibility-date', '--compatibility-flag', '--compatibility-flags',
  '--main', '--outdir', '--outfile', '--route', '--routes', '--var', '--define', '--alias', '--triggers', '--schedule', '--schedules',
  '--assets', '--site', '--tsconfig', '--message', '--tag', '--account-id', '--log-level', '--persist-to', '--port', '--ip',
  '--inspector-port', '--binding', '--namespace-id', '--database', '--command', '--file', '--output', '--timestamp', '--bookmark',
  '--version-id', '--percentage', '--branch', '--project-name', '--commit-hash', '--commit-message', '--metafile', '--host',
  '--local-protocol', '--upstream-protocol', '--jurisdiction', '--ttl', '--expiration', '--expiration-ttl', '--metadata', '--prefix',
  '--limit', '--cursor', '--batch-size', '--table', '--location',
])
const WRANGLER_FLAGS = new Set([
  '--dry-run', '--dryRun', '--remote', '--local', '--preview', '--json', '--yes', '-y', '--force', '--help', '-h', '--version', '-v',
  '--minify', '--keep-vars', '--latest', '--no-bundle', '--node-compat', '--legacy-env', '--persist', '--live-reload', '--test-scheduled',
])
const SECRET_WRITES = new Set(['put', 'bulk', 'delete'])

/** Commands that change the files their arguments name. */
const WRITERS = new Set(['rm', 'rmdir', 'mv', 'chmod', 'chown', 'chgrp', 'truncate', 'tee', 'unlink', 'shred', 'touch'])
/** Commands that change only the file their last argument names, or the directory `-t` names. */
const COPIERS = new Set(['cp', 'ln', 'install', 'rsync'])

/** Directories whose files the path policy protects, which `find` may reach below its start path. */
const PROTECTED_DIRECTORIES = ['.git/hooks', '.git', '.githooks', '.husky', '.claude', '.cursor']

/** Command names the policy reads by name, which a path to them, as `"$ROOT"/node_modules/.bin/git`, is read as. */
const READ_BY_NAME = new Set([
  ...Object.keys(WRAPPERS), ...Object.keys(INTERPRETERS), ...SHELLS, ...DECLARATIONS, ...WRITERS, ...COPIERS,
  'env', 'xargs', 'eval', 'source', '.', 'trap', 'coproc', 'alias', 'shopt', 'su', 'watch', 'find', 'sed', 'deno', 'bun', 'bunx',
  'npx', 'pnpx', 'npm', 'pnpm', 'yarn', 'git', 'wrangler', 'lefthook', 'husky', 'dd', 'curl', 'wget', 'tar', 'unzip', 'popweb-fence',
  'arch', 'xcrun', 'script', 'cross-env', 'cross-env-shell', 'dotenv', 'flock', 'concurrently', 'parallel', 'ssh', 'awk', 'gawk', 'mawk', 'nawk',
  'patch', 'lockf',
])
/** Commands that print, search or ignore their arguments and run none of them, as `grep -rn git commit` does. */
const RUNS_NONE = new Set([
  'echo', 'print', 'printf', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'which', 'whence', 'where', 'whereis', 'type', 'man', 'whatis',
  'apropos', 'info', 'help', 'tldr', 'true', 'false', ':',
])
/**
 * Names the policy reads that only a shell runs, as no program file has
 * them: a program that runs its arguments runs none of these, and `.` and
 * `-` among its arguments are a directory and its input.
 */
const SHELL_ONLY = new Set(['.', '-', 'source', 'eval', 'trap', 'exec', 'builtin', 'coproc', 'shopt', 'export', 'declare', 'typeset', 'readonly', 'local', 'noglob', 'nocorrect', 'repeat'])
/** The shell's reserved words, which name no program: `X=1 time {` runs a command named `{`, which fails. */
const RESERVED_WORDS = new Set(['{', '}', '!', '[[', ']]', 'if', 'then', 'else', 'elif', 'fi', 'case', 'esac', 'for', 'select', 'while', 'until', 'do', 'done', 'in', 'function'])

/** The policy's answer for one shell command line, as an agent's hook passes it. */
export function commandPolicy(command: string, options: CommandPolicyOptions = {}): FenceVerdict {
  const inspection = new Inspection(options)
  inspection.script(command, { depth: 0, via: undefined, inCode: false, cwd: '' })
  return strongest(inspection.findings)
}

/**
 * The policy's answer for a change to one file, as an agent's edit tool
 * passes its path: refused for git's hooks and config, which nobody
 * reviews, and asked of the owner for the fence's own files.
 */
export function filePolicy(path: string, options: Pick<CommandPolicyOptions, 'hooksPath'> = {}): FenceVerdict {
  return strongest(pathFindings(path, undefined, options.hooksPath))
}

const REASONS: Readonly<Record<Exclude<FenceRule, 'hook-bypass' | 'fence-change' | 'unreadable'>, string>> = {
  deploy: 'deploys to Cloudflare. Approve it only if you asked for this deploy.',
  'remote-data': 'reads or changes data on Cloudflare (remote D1, KV or R2), not the local copy. Approve it only if you asked for it.',
  secret: "changes the Worker's secrets on Cloudflare. Approve it only if you asked for it.",
  publish: 'publishes a package to the registry. Approve it only if you asked for this release.',
  push: 'pushes commits to the remote. Approve it only if you asked for a push.',
}

/** Where a command is read: how deep, on the way from which script, and in which directory. */
interface Context {
  readonly depth: number
  readonly via: string | undefined
  /** A program's string, read as a command line: only the rules' own findings count, not what the fence cannot read. */
  readonly inCode: boolean
  /** Where the command runs, from where the line starts; undefined after a `cd` the fence cannot follow. */
  readonly cwd: string | undefined
  /** `find`'s matches, which `{}` stands for in the command its `-exec` runs. */
  readonly found?: FindMatches
}

interface FindMatches {
  readonly starts: ReadonlyArray<string>
  readonly names: ReadonlyArray<string>
}

const deeper = (context: Context, via = context.via): Context => ({ ...context, depth: context.depth + 1, via })

class Inspection {
  readonly findings: Finding[] = []
  /** Aliases the line defines, by name, which bash with `expand_aliases` and zsh run in place of the command. */
  private readonly aliases = new Map<string, string>()
  /** git aliases `git config` sets on the line, by name, which git runs in place of a command it does not have. */
  private readonly gitAliases = new Map<string, string>()

  /**
   * @param reading The files and package scripts being read on the way to
   * this command, so one that names itself, as a deploy script's "run bun run
   * deploy again" does, is read once.
   * @param probing Whether this reads one reading of a command whose words
   * an expansion gives, whose probes read no further readings.
   */
  constructor(
    private readonly options: CommandPolicyOptions,
    private readonly reading = new Set<string>(),
    private readonly probing = false
  ) {}

  /** A command line; `context.inCode` when it is a program's string, whose placeholders are its own. */
  script(text: string, context: Context): void {
    const { commands, unreadable } = readScript(text)

    for (const what of unreadable) this.unreadable(firstLine(text), what, context)
    for (const command of commands) {
      this.command(command, { ...context, cwd: command.cwd === undefined ? undefined : joinPath(context.cwd, command.cwd) })
    }
  }

  private command(command: SimpleCommand, context: Context): void {
    const words = command.words
    const text = shown([...command.assignments.map(({ name, value }) => `${name}=${display(value)}`), ...words.map(display)])

    for (const { name, value } of command.assignments) this.environment(name, value, text, context, words[0] ?? '')
    for (const target of command.writes) this.write(target, `${text} > ${display(target)}`, context)
    this.words(words, command, context)
    // A program's string that names neither git, its commit, `-n` nor the
    // hooks setting is a message, as a deploy script's `${name} isn't set
    // yet`, or a command built at run time, which the fence cannot read: its
    // placeholders are not read as the gate's words.
    if (words.some(isDynamic) && (!context.inCode || words.some((word) => namesGate(known(word))))) this.readings(words, command, context)
  }

  /** Read `key` (a file, or a package script) unless it is already being read on the way here. */
  private once(key: string, read: () => void): void {
    if (this.reading.has(key)) return
    this.reading.add(key)
    try {
      read()
    } finally {
      this.reading.delete(key)
    }
  }

  /**
   * A command some of whose words come from what the fence cannot read, as
   * `git $(echo commit) -n`'s subcommand does. Each such word is read as each
   * of the words that would make the command skip the commit gate in its
   * place, a few at once, and a command one of those readings refuses is
   * refused: it may be that command. Then each is read, one at a time, as
   * each word that would make it one the owner approves.
   */
  private readings(words: ReadonlyArray<string>, command: SimpleCommand, context: Context): void {
    let unread = 0
    const choices = words.map((word): ReadonlyArray<ReadonlyArray<string>> => {
      const read = known(word) === '' ? [] : [known(word)]
      if (!isDynamic(word) || unread++ >= MAX_UNREAD_WORDS) return [read]

      return [
        read,
        ...GATE_WORDS.filter((target) => couldRead(word, target)).map((target) => [target]),
        ...(wordParts(word).every((part) => part === UNREAD_WORDS || part === GLOB_ANY || part === GLOB_ONE) ? GATE_RUNS : []),
        ...clusterReading(word),
        ...hooksPathReading(word),
      ]
    })
    const subject = shown(words.map(display))
    const tried = new Set<string>()

    for (const reading of readings(choices)) {
      const key = reading.join(UNREAD)
      if (tried.has(key)) continue
      tried.add(key)

      const probe = this.probe(reading, command, context)
      if (probe.some((finding) => finding.decision === 'deny')) {
        this.deny(subject, `may run \`${shown(reading)}\`, which skips the git hooks that run the commit gate: the fence cannot read what a substitution or a variable in it gives. Write the command out in full.`, context)
        return
      }
    }
    if (context.inCode) return

    for (const index of words.flatMap((word, at) => (isDynamic(word) ? [at] : []))) {
      for (const target of OWNER_WORDS.filter((candidate) => couldRead(words[index], candidate))) {
        const reading = words.flatMap((other, at) => (at === index ? [target] : known(other) === '' ? [] : [known(other)]))
        const found = this.probe(reading, command, context).find((finding) => finding.rule !== 'unreadable')
        if (found !== undefined) {
          this.findings.push({
            decision: found.decision,
            rule: found.rule,
            subject: from(subject, context.via),
            reason: `\`${from(subject, context.via)}\` may run \`${shown(reading)}\`, which needs the owner: the fence cannot read what a substitution or a variable in it gives. Approve it only if you expected it.`,
          })
          return
        }
      }
    }
  }

  /** What one reading of a command's words would be answered with. */
  private probe(words: ReadonlyArray<string>, command: SimpleCommand, context: Context): ReadonlyArray<Finding> {
    const probe = new Inspection(this.options, this.reading, true)
    probe.words(words, command, context)
    return probe.findings
  }

  private deny(subject: string, reason: string, context: Context): void {
    this.findings.push({ decision: 'deny', rule: 'hook-bypass', subject: from(subject, context.via), reason: `\`${from(subject, context.via)}\` ${reason}` })
  }

  private ask(rule: FenceRule, subject: string, context: Context, reason?: string): void {
    const text = from(subject, context.via)
    this.findings.push({ decision: 'ask', rule, subject: text, reason: `\`${text}\` ${reason ?? REASONS[rule as keyof typeof REASONS]}` })
  }

  /** Something the fence cannot read where it matters: the owner reads it. A program's string is no command the fence must read. */
  private unreadable(subject: string, what: string, context: Context): void {
    if (context.inCode) return
    this.ask('unreadable', subject, context, `holds ${what}; the fence cannot read it, so the owner decides. Approve it only if you expected it.`)
  }

  private tooDeep(subject: string, context: Context): void {
    this.unreadable(subject, `commands nested more than ${MAX_DEPTH} levels deep`, context)
  }

  /** An env var that switches git hooks off or points git elsewhere, before a command or exported for the ones after it. */
  private environment(name: string, value: string, subject: string, context: Context, command: string): void {
    if (holdsSubstitution(value)) this.unreadable(subject, `${name}'s value, whose command substitution bash runs where it evaluates the value: in arithmetic, a subscript or PS4`, context)
    const dynamic = isDynamic(value)
    const switchesHooksOff =
      ((name === 'HUSKY' || name === 'LEFTHOOK') && (dynamic || /^(0|false|no|off)$/i.test(value))) ||
      ((name === 'HUSKY_SKIP_HOOKS' || name === 'SKIP_SIMPLE_GIT_HOOKS' || name === 'LEFTHOOK_EXCLUDE') && value !== '') ||
      (name === 'SKIP' && basename(command) === 'git' && value !== '') ||
      (name === 'GIT_CONFIG_PARAMETERS' && (dynamic || /core\.hookspath/i.test(value))) ||
      (/^GIT_CONFIG_KEY_\d+$/.test(name) && (dynamic || value.toLowerCase() === 'core.hookspath'))

    if (switchesHooksOff) {
      return this.deny(subject, `sets ${name}, which switches off the git hooks that run the commit gate. Fix what the gate reports and commit again; only the owner changes the gate.`, context)
    }
    // The alias a GIT_CONFIG_KEY names is used, if at all, by a command the fence does not pair with its value.
    if (/^GIT_CONFIG_KEY_\d+$/.test(name)) {
      if (!value.toLowerCase().startsWith('alias.')) return this.gitSetting(value.toLowerCase(), undefined, undefined, [], subject, context)
      return this.ask('hook-bypass', subject, context, `sets the git alias ${value}, which the fence does not follow. Approve it only if you expected it.`)
    }
    if (name === 'GIT_CONFIG_PARAMETERS' && value !== '') {
      return this.ask('hook-bypass', subject, context, `sets ${name}, which gives git settings that can move the hooks or name a program git runs. Approve it only if you expected it.`)
    }
    if (['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG'].includes(name) && value !== '/dev/null') {
      return this.ask('hook-bypass', subject, context, `sets ${name}, which points git at another config file, one that can move the hooks or switch them off. Approve it only if you expected it.`)
    }
    // git reads its global config from $XDG_CONFIG_HOME/git/config and $HOME/.gitconfig.
    if ((name === 'HOME' || name === 'XDG_CONFIG_HOME') && value !== '') {
      return this.ask('hook-bypass', subject, context, `sets ${name}, which points git at another global config file, one that can move the hooks or switch them off. Approve it only if you expected it.`)
    }
    if (GIT_PROGRAMS.has(name) && value !== '') {
      if (isDynamic(value)) return this.unreadable(subject, `${name}, a program git runs, which an expansion gives`, context)
      return this.script(value, deeper(context))
    }
    if (['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_EXEC_PATH'].includes(name)) {
      return this.ask('hook-bypass', subject, context, `sets ${name}, which points git at another repository or program, whose hooks are not the commit gate. Approve it only if you expected it.`)
    }
    // A shell runs BASH_ENV's script before its own, node the modules NODE_OPTIONS requires, and every program a preloaded library.
    const loads =
      (['BASH_ENV', 'ENV', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES'].includes(name) && value !== '') ||
      (name === 'NODE_OPTIONS' && /(^|\s)(-r|--require|--import|--loader|--experimental-loader)\b/.test(value))
    if (loads) this.unreadable(subject, `${name}, which runs code the fence does not read before the command`, context)
  }

  private words(words: ReadonlyArray<string>, command: SimpleCommand, context: Context): void {
    if (words.length === 0) return
    if (context.depth > MAX_DEPTH) return this.tooDeep(shown(words.map(display)), context)

    const [head, ...args] = words
    if (isDynamic(head)) return this.dynamicCommand(words, command, context)

    const name = basename(head)
    const subject = shown(words.map(display))
    const next = (rest: ReadonlyArray<string>) => this.words(rest, command, deeper(context))

    if (FENCE_CLI.test(head)) return this.fenceCli(args, words, context)
    if (EVALUATES.has(name) && (name !== 'printf' || args.includes('-v'))) this.evaluated(name, args, command, subject, context)
    if (this.aliases.has(head)) this.script(`${this.aliases.get(head)} ${scriptOf(args)}`, deeper(context))
    if (Object.hasOwn(INTERPRETERS, interpreterName(name))) {
      // perl -pi and ruby -i edit the files they name; their code is read too.
      if (['perl', 'ruby'].includes(name) && args.some((arg) => /^-[a-zA-Z]*i/.test(arg))) this.writes(positionals(args), subject, context)
      return this.interpreter(interpreterName(name), args, command, subject, context)
    }
    if (Object.hasOwn(WRAPPERS, name)) {
      if (name === 'command' && (args[0] === '-v' || args[0] === '-V')) return
      const parsed = parseOptions(args, WRAPPERS[name])
      if ('unknown' in parsed) return this.unreadable(subject, unknownOption(name, parsed.unknown), context)
      return next(this.leadingAssignments(parsed.rest, subject, context))
    }
    if (DECLARATIONS.has(name)) {
      for (const arg of args) this.assignmentWord(arg, subject, '', context)
      return
    }
    if (SHELLS.has(name)) return this.shell(name, args, command, subject, context)
    if (WRITERS.has(name)) return this.writes(positionals(args), subject, context)
    if (COPIERS.has(name)) return this.copier(name, args, subject, context)

    switch (name) {
      case 'env':
        return this.env(args, command, subject, context)
      case 'xargs':
        return this.xargs(args, command, subject, context)
      case 'eval':
        if (args.some(isDynamic)) this.unreadable(subject, 'a string to evaluate that an expansion gives', context)
        return this.script(args.map(evalText).join(' '), deeper(context))
      case 'trap':
        return this.trap(args, subject, context)
      case 'coproc':
        return next(args[1] === '{' || args[1] === '(' ? args.slice(2) : args[0] === '{' || args[0] === '(' ? args.slice(1) : args)
      case 'alias':
        return this.alias(args, subject, context)
      case 'shopt':
        if (args.includes('expand_aliases')) this.unreadable(subject, "`expand_aliases`, which runs aliases the fence does not follow", context)
        return
      case 'watch':
        return this.script(afterOptions(args, ['-n', '--interval']).map(evalText).join(' '), deeper(context))
      case 'source':
      case '.':
        return this.file(args[0], 'shell', context, args.slice(1))
      case 'su':
        return this.su(args, subject, context)
      case 'find':
        return this.find(args, command, subject, context)
      case 'sed':
        if (args.some((arg) => /^-[a-zA-Z]*i/.test(arg) || arg.startsWith('--in-place'))) this.writes(positionals(args), subject, context)
        return
      case 'deno':
        return this.deno(args, command, subject, context)
      case 'git':
        return this.git(args, words, context, command)
      case 'wrangler':
        return this.wrangler(args, words, context)
      case 'npx':
      case 'pnpx':
      case 'bunx':
        return this.runner(args, command, subject, context)
      case 'npm':
        return this.npm(args, words, command, context)
      case 'bun':
        return this.bun(args, words, command, subject, context)
      case 'pnpm':
        return this.pnpm(args, words, command, context)
      case 'yarn':
        return this.yarn(args, words, command, subject, context)
      case 'lefthook':
      case 'husky':
        if (args.includes('uninstall')) this.deny(subject, 'removes the git hooks that run the commit gate. Only the owner changes the gate.', context)
        return
      case 'dd':
        return this.writes(args.filter((arg) => arg.startsWith('of=')).map((arg) => arg.slice(3)), subject, context)
      case 'curl':
        return this.writes(curlOutputs(args), subject, context)
      case 'wget':
        return this.writes(wgetOutputs(args), subject, context)
      case 'tar':
        return this.writes(tarWrites(args), subject, context)
      case 'unzip':
        return this.writes(unzipWrites(args), subject, context)
      case 'arch':
        return this.arch(args, command, subject, context)
      case 'xcrun':
        return this.xcrun(args, command, subject, context)
      case 'script':
        return this.typescript(args, command, subject, context)
      case 'cross-env':
        return next(this.leadingAssignments(args[0] === '--' ? args.slice(1) : args, subject, context))
      case 'cross-env-shell':
        return this.script(this.leadingAssignments(args, subject, context).map(evalText).join(' '), deeper(context))
      case 'dotenv':
        return this.dotenv(args, command, subject, context)
      case 'flock':
        return this.flock(args, command, subject, context)
      case 'lockf':
        return this.lockf(args, command, subject, context)
      case 'concurrently':
        return this.concurrently(args, subject, context)
      case 'parallel':
        return this.parallel(args, command, subject, context)
      case 'ssh':
        return this.ssh(args, subject, context)
      case 'awk':
      case 'gawk':
      case 'mawk':
      case 'nawk':
        return this.awk(args, subject, context)
      case 'patch':
        return this.patch(args, command, subject, context)
    }

    if (head.includes('/') || head.endsWith('.sh')) return this.program(head, args, command, context)
    if (!EVALUATES.has(name) && !RUNS_NONE.has(name) && !RESERVED_WORDS.has(name)) this.unknownProgram(head, args, command, subject, context)
  }

  /**
   * A program the policy does not know, which may run the command its
   * arguments give, as `timeout`, `op run --` and `docker exec` do: from the
   * first argument naming a program the policy reads, the arguments are read
   * as that command, in an inspection of their own. When the fence would not
   * allow that command on its own, it asks the owner; when it would, the
   * program adds nothing. A program's strings are read for the rules alone.
   */
  private unknownProgram(program: string, args: ReadonlyArray<string>, command: SimpleCommand, subject: string, context: Context): void {
    if (context.inCode) return
    const start = args.findIndex((arg) => !isDynamic(arg) && READ_BY_NAME.has(interpreterName(basename(arg))) && !SHELL_ONLY.has(basename(arg)))
    if (start === -1) return

    const run = args.slice(start)
    const inner = new Inspection(this.options, this.reading, this.probing)
    inner.words(run, command, deeper(context))
    // One reading of an expansion's words per command line: a reading's own probes do not read them again.
    if (run.some(isDynamic) && !this.probing) inner.readings(run, command, deeper(context))
    const answer = strongest(inner.findings)
    if (answer.decision === 'allow') return

    const verdict = answer.decision === 'deny' ? 'refuses' : 'asks the owner about'
    this.ask(
      'unreadable',
      subject,
      context,
      `gives \`${display(program)}\`, a program the fence does not know, the arguments \`${shown(run.map(display))}\`, which it may run as a command; on its own the fence ${verdict} that command. Approve it only if you expected it.`
    )
  }

  /** macOS's `arch`: its `-arm64`-style names, `-arch name`, `-d name` and `-e NAME=value`, then the command. */
  private arch(args: ReadonlyArray<string>, command: SimpleCommand, subject: string, context: Context): void {
    const assignments: string[] = []
    let k = 0
    for (; k < args.length && args[k].startsWith('-'); k++) {
      if (args[k] === '-arch' || args[k] === '-d') k++
      else if (args[k] === '-e') assignments.push(args[++k] ?? '')
    }
    for (const word of assignments) this.assignmentWord(word, subject, basename(args[k] ?? ''), context)
    this.words(args.slice(k), command, deeper(context))
  }

  private xcrun(args: ReadonlyArray<string>, command: SimpleCommand, subject: string, context: Context): void {
    const parsed = wordOptions(args, [...XCRUN.flags, ...XCRUN.finds], XCRUN.values)
    if ('unknown' in parsed) return this.unreadable(subject, unknownOption('xcrun', parsed.unknown), context)
    if (parsed.seen.some((option) => XCRUN.finds.includes(option))) return
    this.words(parsed.rest, command, deeper(context))
  }

  /** `script`: the file it writes what the command prints to, and the command, after the file or as `-c`'s string. */
  private typescript(args: ReadonlyArray<string>, command: SimpleCommand, subject: string, context: Context): void {
    const parsed = parseOptions(args, SCRIPT_OPTIONS)
    if ('unknown' in parsed) return this.unreadable(subject, unknownOption('script', parsed.unknown), context)

    const [file, ...run] = parsed.rest
    if (file !== undefined) this.write(file, subject, context)
    const string = parsed.values.get('-c') ?? parsed.values.get('--command')
    if (string === undefined) return this.words(run, command, deeper(context))
    if (isDynamic(string)) return this.unreadable(subject, 'a command for script that an expansion gives', context)
    this.script(string, deeper(context))
  }

  /** dotenv-cli: its `-v NAME=value` assignments, then the command, after `--` or its options. */
  private dotenv(args: ReadonlyArray<string>, command: SimpleCommand, subject: string, context: Context): void {
    const end = args.indexOf('--')
    const options = end === -1 ? args : args.slice(0, end)
    let k = 0

    for (; k < options.length && options[k].startsWith('-'); k++) {
      const option = options[k]
      if (option === '-v') this.assignmentWord(options[++k] ?? '', subject, '', context)
      else if (option === '-e' || option === '-p') k++
      else if (option === '-c') {
        // `-c` takes an environment's name when a word follows it, which before `--` may be the command's.
        if (end === -1) return this.unreadable(subject, "`-c`, which may take the command's first word as an environment's name", context)
        if (!(options[k + 1] ?? '-').startsWith('-')) k++
      } else if (!DOTENV_FLAGS.includes(option)) {
        return this.unreadable(subject, unknownOption('dotenv', option), context)
      }
    }
    this.words([...options.slice(k), ...(end === -1 ? [] : args.slice(end + 1))], command, deeper(context))
  }

  /** `flock`: the lock file, then the command, or `-c`'s string. */
  private flock(args: ReadonlyArray<string>, command: SimpleCommand, subject: string, context: Context): void {
    const parsed = parseOptions(args, FLOCK_OPTIONS)
    if ('unknown' in parsed) return this.unreadable(subject, unknownOption('flock', parsed.unknown), context)

    const [, ...run] = parsed.rest
    const [option, value] = splitOption(run[0] ?? '')
    const string = parsed.values.get('-c') ?? parsed.values.get('--command') ?? (option === '-c' || option === '--command' ? value ?? run[1] : undefined)
    if (string === undefined) return this.words(run, command, deeper(context))
    if (isDynamic(string)) return this.unreadable(subject, 'a command for flock that an expansion gives', context)
    this.script(string, deeper(context))
  }

  /**
   * `lockf`: the lock file, which it creates and, unless `-k` keeps it,
   * removes once the command ends, then the command.
   */
  private lockf(args: ReadonlyArray<string>, command: SimpleCommand, subject: string, context: Context): void {
    const parsed = parseOptions(args, LOCKF_OPTIONS)
    if ('unknown' in parsed) return this.unreadable(subject, unknownOption('lockf', parsed.unknown), context)

    const [file, ...run] = parsed.rest
    if (file !== undefined) this.write(file, subject, context)
    this.words(run, command, deeper(context))
  }

  /** concurrently: each word that is not an option or its value is a command line, and `npm:name` a package.json script. */
  private concurrently(args: ReadonlyArray<string>, subject: string, context: Context): void {
    for (let k = 0; k < args.length; k++) {
      const [name, value] = splitOption(args[k])
      if (CONCURRENTLY_VALUES.includes(name)) {
        if (value === undefined) k++
      } else if (!args[k].startsWith('-')) {
        const shorthand = /^(npm|yarn|pnpm|bun):(.+)$/.exec(args[k])
        if (shorthand !== null && shorthand[2].includes('*')) this.unreadable(subject, `\`${args[k]}\`, whose wildcard names scripts the fence does not list`, context)
        else this.script(shorthand === null ? evalText(args[k]) : `${shorthand[1]} run ${shorthand[2]}`, deeper(context))
      }
    }
  }

  /**
   * GNU parallel: its command with each input after it, or in place of `{}`,
   * or each input alone when it names no command. Its options are many, and
   * the fence reads none: the command may start at any word before `:::`.
   */
  private parallel(args: ReadonlyArray<string>, command: SimpleCommand, subject: string, context: Context): void {
    const separator = /^:{3,4}\+?$/
    const first = args.findIndex((arg) => separator.test(arg))
    const head = first === -1 ? args : args.slice(0, first)
    const groups: string[][] = []

    for (const arg of first === -1 ? [] : args.slice(first)) {
      if (arg.startsWith('::::')) return this.unreadable(subject, 'the files `::::` names, whose lines parallel runs', context)
      if (separator.test(arg)) groups.push([])
      else groups[groups.length - 1].push(evalText(arg))
    }
    if (first === -1) {
      const text = this.stdinText(command, context)
      if (text === null) return this.unreadable(subject, 'the lines it reads from a pipe or a file, which parallel runs', context)
      groups.push((text ?? '').split('\n').filter((line) => line.trim() !== ''))
    }

    const starts = [...head.flatMap((word, at) => (word.startsWith('-') ? [] : [at])), head.length]
    const inputs = product(groups, Math.floor(MAX_RUNS / starts.length))
    if (inputs === undefined) return this.unreadable(subject, `more than ${MAX_RUNS} command lines parallel runs`, context)
    for (const input of inputs) {
      for (const start of starts) {
        const words = head.slice(start).map(evalText)
        const line = words.some((word) => word.includes('{}')) ? words.map((word) => word.replaceAll('{}', input.join(' '))) : [...words, ...input]
        this.script(line.join(' '), deeper(context))
      }
    }
  }

  /** ssh: the commands its `-o` settings run here, and the command it runs on the host, whose words only the rules read. */
  private ssh(args: ReadonlyArray<string>, subject: string, context: Context): void {
    const parsed = parseOptions(args, SSH_OPTIONS)
    if ('unknown' in parsed) return this.unreadable(subject, unknownOption('ssh', parsed.unknown), context)

    const remote = { ...deeper(context), inCode: true }
    for (const [option, value] of parsed.all) {
      const setting = option === '-o' ? SSH_COMMANDS.exec(value) : null
      if (setting !== null) this.script(evalText(setting[2]), setting[1].toLowerCase() === 'remotecommand' ? remote : deeper(context))
    }
    const [, ...run] = parsed.rest
    this.script(run.map(evalText).join(' '), remote)
  }

  /** awk: its program, inline or in the files `-f` names, read as code. */
  private awk(args: ReadonlyArray<string>, subject: string, context: Context): void {
    const parsed = parseOptions(args, AWK_OPTIONS)
    if ('unknown' in parsed) return this.unreadable(subject, unknownOption('awk', parsed.unknown), context)

    const given = (...options: string[]) => parsed.all.filter(([option]) => options.includes(option)).map(([, value]) => value)
    const files = given('-f', '--file', '-E', '--exec')
    const inline = given('-e', '--source')
    const [programs, inputs] = files.length + inline.length === 0 ? [parsed.rest.slice(0, 1), parsed.rest.slice(1)] : [inline, parsed.rest]

    for (const program of programs) {
      if (isDynamic(program)) this.unreadable(subject, 'a program for awk that an expansion gives', context)
      else this.code(program, 'awk', subject, context)
    }
    for (const file of files) this.file(file, 'awk', context)
    // gawk's inplace extension writes each file it reads.
    if (given('-i', '--include').some((name) => /^inplace(\.awk)?$/.test(name))) this.writes(inputs, subject, context)
  }

  /** `patch`: the files its patch names, the original file it is given, and its output and reject files. */
  private patch(args: ReadonlyArray<string>, command: SimpleCommand, subject: string, context: Context): void {
    const parsed = parseOptions(args, PATCH_OPTIONS)
    if ('unknown' in parsed) return this.unreadable(subject, unknownOption('patch', parsed.unknown), context)
    if (['--dry-run', '--check', '-C'].some((flag) => parsed.flags.has(flag))) return

    const directory = parsed.values.get('-d') ?? parsed.values.get('--directory')
    const at = directory === undefined ? context : { ...context, cwd: isDynamic(directory) ? undefined : joinPath(context.cwd, directory) }
    this.writes(parsed.all.filter(([name]) => ['-o', '--output', '-r', '--reject-file'].includes(name)).map(([, value]) => value), subject, context)
    const [original, file] = parsed.rest
    if (original !== undefined) this.write(original, subject, at)
    this.patchWrites(parsed.values.get('-i') ?? parsed.values.get('--input') ?? file, command, subject, context, at)
  }

  /** The files a patch changes, in the directory `at` names: those its headers name, read from its file or the command's input. */
  private patchWrites(file: string | undefined, command: SimpleCommand | undefined, subject: string, context: Context, at: Context): void {
    const text = file !== undefined && file !== '-' ? this.readPath(file, context) ?? null : command === undefined ? null : this.stdinText(command, context)
    if (text === null) return this.unreadable(subject, 'a patch the fence cannot read, which changes the files it names', context)
    this.writes(patchedPaths(text ?? ''), subject, at)
  }

  /**
   * A command whose name holds what the fence cannot read. A path whose
   * last part it can read, as `"$ROOT"/node_modules/.bin/git`, is read by that
   * name when the policy reads the name; any other asks the owner.
   */
  private dynamicCommand(words: ReadonlyArray<string>, command: SimpleCommand, context: Context): void {
    const [head, ...args] = words
    const tail = head.slice(Math.max(...[UNREAD, UNREAD_WORDS, GLOB_ANY, GLOB_ONE].map((mark) => head.lastIndexOf(mark))) + 1)
    const name = tail.includes('/') ? basename(tail) : ''

    if (READ_BY_NAME.has(name)) return this.words([name, ...args], command, context)
    if (name !== '' && /(^|\/)node_modules\//.test(known(head))) return
    this.unreadable(shown(words.map(display)), 'a command name that an expansion or a glob gives', context)
  }

  /** A builtin that evaluates its words, or the value it reads, as arithmetic or a subscript, where a command substitution in them runs. */
  private evaluated(name: string, args: ReadonlyArray<string>, command: SimpleCommand, subject: string, context: Context): void {
    // What `read`, `mapfile` and `readarray` read on their input.
    const input = this.stdinText(command, context)
    if (args.some(holdsSubstitution) || (typeof input === 'string' && holdsSubstitution(input))) {
      this.unreadable(subject, 'a word or a value holding a command substitution, which bash runs where it evaluates it as arithmetic or a subscript', context)
    }
  }

  /** The words after the `NAME=value` assignments `env`, `sudo` and `doas` take before a command, each checked. */
  private leadingAssignments(words: ReadonlyArray<string>, subject: string, context: Context): ReadonlyArray<string> {
    const start = words.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word))
    const rest = start === -1 ? [] : words.slice(start)
    for (const word of start === -1 ? words : words.slice(0, start)) this.assignmentWord(word, subject, basename(rest[0] ?? ''), context)
    return rest
  }

  private assignmentWord(word: string, subject: string, command: string, context: Context): void {
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(word)
    if (assignment) this.environment(assignment[1], assignment[2], subject, context, command)
  }

  private writes(paths: ReadonlyArray<string>, subject: string, context: Context): void {
    for (const path of paths) this.write(path, subject, context)
  }

  /** A file a command writes; `{}` in what `find -exec` runs stands for each file it finds. */
  private write(path: string, subject: string, context: Context): void {
    if (context.found !== undefined && path.includes('{}')) return this.findWrites(context.found, subject, context)
    this.findings.push(...writeFindings(path, context.cwd, from(subject, context.via), this.options.hooksPath))
  }

  /**
   * `cp`, `ln`, `install` and `rsync` change their last argument, or the
   * files they put in the directory `-t` names. A link, as `ln` and `cp -s`
   * or `-l` make, changes what it leads to as well, whose files a write
   * through it reaches under a name the path policy does not know.
   */
  private copier(name: string, args: ReadonlyArray<string>, subject: string, context: Context): void {
    const files = positionals(args)
    const target = args.flatMap((arg, index) => (arg === '-t' ? [args[index + 1] ?? ''] : arg.startsWith('--target-directory=') ? [arg.slice(19)] : []))[0]
    const links = name === 'ln' || (name === 'cp' && args.some((arg) => arg === '--link' || arg === '--symbolic-link' || /^-[a-zA-Z]*[ls]/.test(arg)))
    if (links) {
      // The link's own name is checked too, as the file it writes.
      for (const source of files.filter((file) => file !== target)) this.findings.push(...linkFindings(source, from(subject, context.via), this.options.hooksPath))
    }
    if (target === undefined) return this.writes(files.slice(-1), subject, context)
    this.writes([target, ...files.filter((file) => file !== target).map((file) => `${target}/${basename(file)}`)], subject, context)
  }

  private fenceCli(args: ReadonlyArray<string>, words: ReadonlyArray<string>, context: Context): void {
    if (args.some((arg) => arg.startsWith('--allow-increase'))) {
      this.ask('fence-change', shown(words), context, 'raises the lint debt baseline, which only shrinks without the owner. Approve it only if you accept the new disable directives.')
    }
  }

  private env(args: ReadonlyArray<string>, command: SimpleCommand, subject: string, context: Context): void {
    const parsed = parseOptions(args[0] === '-' ? args.slice(1) : args, ENV_OPTIONS)
    if ('unknown' in parsed) return this.unreadable(subject, unknownOption('env', parsed.unknown), context)
    this.words(this.leadingAssignments(parsed.rest, subject, context), command, deeper(context))
  }

  /** `xargs`: the command it runs with the words its input gives, or with what the fence cannot read in their place. */
  private xargs(args: ReadonlyArray<string>, command: SimpleCommand, subject: string, context: Context): void {
    const parsed = parseOptions(args, XARGS_OPTIONS)
    if ('unknown' in parsed) return this.unreadable(subject, unknownOption('xargs', parsed.unknown), context)

    const replace = parsed.values.get('-I') ?? parsed.values.get('-J') ?? (parsed.flags.has('-i') || parsed.flags.has('--replace') ? '{}' : undefined)
    // Input from a file (`-a`), split other than at blanks (`-0`, `-d`), or with quotes xargs reads its own way, is input the fence cannot read.
    const elsewhere = ['-a', '--arg-file', '-0', '--null', '-d', '--delimiter'].some((option) => parsed.flags.has(option) || parsed.values.has(option))
    const text = elsewhere ? null : this.stdinText(command, context)
    const input = text === undefined ? '' : text !== null && !/['"\\]/.test(text) ? text : null
    const run = parsed.rest.length > 0 ? parsed.rest : ['echo']
    const runs: string[][] =
      typeof replace === 'string'
        ? (input === null ? [UNREAD] : input.split('\n').filter((line) => line.trim() !== '')).map((line) => run.map((word) => word.replaceAll(replace, line)))
        : [[...run, ...(input === null ? [UNREAD_WORDS] : input.split(/\s+/).filter((word) => word !== ''))]]

    for (const words of runs) {
      this.words(words, command, deeper(context))
      if (words.some(isDynamic)) this.readings(words, command, deeper(context))
    }
  }

  private trap(args: ReadonlyArray<string>, subject: string, context: Context): void {
    const rest = args[0] === '--' ? args.slice(1) : args
    const [action] = rest
    // One word is a signal to reset; `-` resets, `-p` and `-l` list.
    if (action === undefined || rest.length < 2 || action.startsWith('-')) return
    this.script(evalText(action), deeper(context))
  }

  private alias(args: ReadonlyArray<string>, subject: string, context: Context): void {
    const definitions = args.map((arg) => /^([^=\s]+)=(.*)$/s.exec(arg)).filter((match) => match !== null)
    if (definitions.length === 0) return

    this.unreadable(subject, 'an alias, which bash runs after `shopt -s expand_aliases` and zsh on the lines after it', context)
    for (const [, name, value] of definitions) {
      if (!isDynamic(value)) this.aliases.set(name, value)
    }
  }

  private su(args: ReadonlyArray<string>, subject: string, context: Context): void {
    const index = args.findIndex((arg) => arg === '-c' || arg === '--command' || arg.startsWith('--command='))
    if (index === -1) return
    const script = args[index].startsWith('--command=') ? args[index].slice(10) : args[index + 1]
    if (script !== undefined) this.script(evalText(script), deeper(context))
  }

  /** A shell: the string `-c` gives, the script it reads from its input, or the file it runs. */
  private shell(name: string, args: ReadonlyArray<string>, command: SimpleCommand, subject: string, context: Context): void {
    // `+o name`, `+O name` and `+x` turn options off; they run nothing.
    const options = args.filter((arg, index) => !/^\+[a-zA-Z]+$/.test(arg) && !/^\+[oO]$/.test(args[index - 1] ?? ''))
    const parsed = parseOptions(options, name === 'fish' ? FISH_OPTIONS : SHELL_OPTIONS)
    if ('unknown' in parsed) return this.unreadable(subject, unknownOption(name, parsed.unknown), context)

    const option = (key: string) => parsed.values.get(key) ?? (parsed.flags.has(key) ? '' : undefined)
    if (option('-O') === 'expand_aliases' || option('-o') === 'expand_aliases') this.unreadable(subject, '`expand_aliases`, which runs aliases the fence does not follow', context)
    if (option('-n') !== undefined && name !== 'fish') return

    // fish's `-c` and `-C` take the command as their value; the other shells' `-c` reads it from the first word.
    const fromString = name !== 'fish' && option('-c') !== undefined
    const scripts = [parsed.values.get('--command'), parsed.values.get('--init-command'), parsed.values.get('-c'), parsed.values.get('-C'), fromString ? parsed.rest[0] : undefined]
      .filter((script) => script !== undefined)

    for (const script of scripts) {
      if (isDynamic(script)) this.unreadable(subject, `a script for ${name} that an expansion gives`, context)
      else this.script(script, deeper(context))
    }
    if (fromString || scripts.length > 0) return

    const [file, ...rest] = parsed.rest
    if (option('-s') !== undefined || file === undefined || file === '-') return this.stdinScript(command, 'shell', subject, context)
    this.file(file, 'shell', context, rest)
  }

  /** The text a command reads on its input: undefined for none, null when the fence cannot read it. */
  private stdinText(command: SimpleCommand, context: Context): string | undefined | null {
    const stdin = command.stdin
    if (stdin === undefined) return undefined
    if (stdin.kind === 'text') return isDynamic(stdin.text) ? null : stdin.text
    if (stdin.kind === 'pipe') return producedText(stdin.from, (from) => this.stdinText(from, context))
    if (stdin.kind === 'file') return this.readPath(stdin.path, context) ?? null
    return null
  }

  /** A script a shell or an interpreter reads on its input. */
  private stdinScript(command: SimpleCommand, kind: CodeKind | 'shell', subject: string, context: Context): void {
    const text = this.stdinText(command, context)
    if (text === undefined) return
    if (text === null) return this.unreadable(subject, 'a script it reads from a pipe or a file', context)
    if (kind === 'shell') this.script(text, deeper(context))
    else this.code(text, kind, subject, context)
  }

  private find(args: ReadonlyArray<string>, command: SimpleCommand, subject: string, context: Context): void {
    let k = 0
    while (/^-[HLP]$|^-O\d$/.test(args[k] ?? '')) k++
    if (args[k] === '-D') k += 2
    const starts: string[] = []
    for (; k < args.length && !/^[-(!)]/.test(args[k]); k++) starts.push(args[k])

    const found: FindMatches = {
      starts: starts.length > 0 ? starts : ['.'],
      names: args.flatMap((arg, index) => (/^-i?(name|path|wholename)$/.test(arg) ? [args[index + 1] ?? ''] : [])),
    }

    args.forEach((arg, index) => {
      if (['-exec', '-execdir', '-ok', '-okdir'].includes(arg)) {
        const rest = args.slice(index + 1)
        const end = rest.findIndex((word) => word === ';' || word === '+')
        const words = end === -1 ? rest : rest.slice(0, end)
        this.words(words, command, { ...deeper(context), found })
      }
      if (['-fprint', '-fprint0', '-fprintf', '-fls'].includes(arg)) this.write(args[index + 1] ?? '', subject, context)
    })
    if (args.includes('-delete')) this.findWrites(found, subject, context)
  }

  /**
   * The files `find` deletes or hands its `-exec`: those under its start
   * paths whose names its tests match, tried in the start path itself and in
   * each directory the fence protects files in.
   */
  private findWrites(found: FindMatches, subject: string, context: Context): void {
    const at = { ...context, found: undefined }

    for (const start of found.starts) {
      if (found.names.length === 0) this.write(start, subject, at)
      for (const name of found.names) {
        const glob = name.replace(/\[[^\]]+\]/g, GLOB_ONE).replaceAll('*', GLOB_ANY).replaceAll('?', GLOB_ONE)
        this.write(`${start}/${glob}`, subject, at)
        for (const directory of PROTECTED_DIRECTORIES) {
          const path = joinPath(context.cwd, `${start}/${directory}/${glob}`)
          if (path !== undefined) this.findings.push(...protectedFileFindings(path, from(subject, context.via), this.options.hooksPath))
        }
      }
    }
  }

  /** An interpreter: its inline code, the script file it runs, or the program it reads on its input. */
  private interpreter(name: string, args: ReadonlyArray<string>, command: SimpleCommand, subject: string, context: Context): void {
    const spec = INTERPRETERS[name]
    const parsed = interpreterArgs(args, spec)

    for (const code of parsed.code) {
      if (isDynamic(code)) this.unreadable(subject, `code for ${name} that an expansion gives`, context)
      else this.code(code, spec.kind, subject, context)
    }
    if (parsed.code.length > 0 || parsed.module) return
    if (parsed.runScript !== undefined) return this.target(name, parsed.runScript, parsed.rest, command, context.cwd, context)
    if (parsed.file !== undefined) return this.program(parsed.file, parsed.rest, command, context, spec.kind)
    this.stdinScript(command, spec.kind, subject, context)
  }

  /**
   * A program a command runs by its path: Wrangler's own entry, the fence's
   * CLI, a bin the policy reads by name, a package's other files, which the
   * fence does not read, by the command their arguments may give, or a script
   * read for its strings.
   */
  private program(path: string, args: ReadonlyArray<string>, command: SimpleCommand, context: Context, kind?: CodeKind): void {
    if (WRANGLER_ENTRY.test(path)) return this.wrangler(args, ['wrangler', ...args], context)
    if (FENCE_CLI.test(path)) return this.fenceCli(args, ['popweb-fence', ...args], context)
    const bin = /(?:^|\/)node_modules\/\.bin\/([^/]+)$/.exec(path)?.[1] ?? ''
    if (READ_BY_NAME.has(bin)) return this.words([bin, ...args], command, deeper(context))
    if (/(^|\/)node_modules\//.test(known(path))) return this.unknownProgram(path, args, command, shown([path, ...args].map(display)), context)
    this.file(path, kind, context, args)
  }

  /**
   * Code: each string and each run of strings an argument list holds, read
   * as a command line, and any call that starts a process. A file's strings
   * are named by the file they come from.
   */
  private code(source: string, kind: CodeKind, subject: string, context: Context, inFile = false): void {
    const strings = { ...deeper(context, inFile ? from(subject, context.via) : context.via), inCode: true }
    for (const line of commandsInCode(source, kind)) this.script(line, strings)
    // perl's `">file"` names the file after the mode.
    if (writesFiles(source, kind)) for (const text of stringsInCode(source, kind)) this.write(text.replace(/^\s*[+<>|]+\s*/, ''), subject, context)
    if (startsProcess(source, kind)) {
      this.ask('unreadable', subject, context, 'runs code that starts a process, whose command a program can build at run time where the fence cannot read it. Approve it only if you expected it.')
    }
  }

  /** A file's text by its path from where the line starts, or undefined. */
  private readPath(path: string, context: Context): string | undefined {
    if (isDynamic(path)) return undefined
    const resolved = joinPath(context.cwd, path)
    return resolved === undefined ? undefined : this.options.readFile?.(resolved === '' ? '.' : resolved)
  }

  /** A file a command runs: a shell script read as one, a program by its strings and calls. */
  private file(path: string | undefined, kind: CodeKind | 'shell' | undefined, context: Context, args: ReadonlyArray<string> = []): void {
    if (path === undefined) return
    const subject = shown([path, ...args].map(display))
    // A package's own files are its business, and large.
    if (/(^|\/)node_modules\//.test(known(path))) return

    const resolved = joinPath(context.cwd, path)
    const source = this.readPath(path, context)
    if (source === undefined) {
      return this.unreadable(subject, `\`${display(path)}\`, a script the fence cannot open: its path holds an expansion, or it is missing, not a file, too large, or in a directory a \`cd\` it cannot follow names`, context)
    }

    const language = kind ?? codeKind(path, source)
    const via = from(subject, context.via)
    this.once(`file:${resolved}`, () => {
      if (language === 'shell') this.script(source, { ...deeper(context, via), inCode: false })
      else this.code(source, language, subject, context, true)
    })
  }

  /** `npx`, `bunx`, `pnpx`, `npm exec`, `pnpm dlx`, `yarn dlx`: the package's bin, with its version dropped. */
  private runner(args: ReadonlyArray<string>, command: SimpleCommand, subject: string, context: Context): void {
    const parsed = parseOptions(args, RUNNER_OPTIONS)
    if ('unknown' in parsed) return this.unreadable(subject, unknownOption('the runner', parsed.unknown), context)

    const call = parsed.values.get('-c') ?? parsed.values.get('--call')
    if (call !== undefined) return isDynamic(call) ? this.unreadable(subject, 'a command to call that an expansion gives', context) : this.script(call, deeper(context))
    if (parsed.flags.has('--shell-mode')) return this.script(parsed.rest.map(evalText).join(' '), deeper(context))

    const [bin, ...rest] = parsed.rest
    if (bin !== undefined) this.words([isDynamic(bin) ? bin : packageBin(bin), ...rest], command, deeper(context))
  }

  /** The package.json scripts of a directory: its own, or the nearest above it, as the runners find them. */
  private scriptsAt(directory: string): Readonly<Record<string, string>> | undefined {
    let at: string | undefined = directory
    for (let step = 0; at !== undefined && step < 16; step++, at = parentPath(at)) {
      if (at === '') return this.options.scripts
      const manifest = this.options.readFile?.(`${at}/package.json`)
      if (manifest !== undefined) return packageScripts(manifest) ?? {}
    }
    return undefined
  }

  /** A package.json script a runner names, with its `pre` and `post` scripts, run in its package's directory; false when there is none. */
  private runScript(runner: string, name: string, args: ReadonlyArray<string>, directory: string, context: Context): boolean {
    const scripts = this.scriptsAt(directory)
    if (scripts === undefined || typeof scripts[name] !== 'string') return false

    const extra = args[0] === '--' ? args.slice(1) : args
    const label = from(shown([runner, 'run', name, ...args.map(display)]), context.via)
    const inPackage: Context = { ...deeper(context, label), cwd: directory }

    this.once(`script:${directory}:${name}`, () => {
      this.script(scripts[`pre${name}`] ?? '', inPackage)
      this.script([scripts[name], scriptOf(extra)].join(' '), inPackage)
      this.script(scripts[`post${name}`] ?? '', inPackage)
    })
    return true
  }

  /** What `bun run x`, `pnpm x` and `node --run x` name: a package.json script, a file, or a package's bin. */
  private target(runner: string, name: string, args: ReadonlyArray<string>, command: SimpleCommand, directory: string | undefined, context: Context): void {
    const subject = shown([runner, name, ...args].map(display))
    if (directory === undefined) return this.unreadable(subject, "a package.json script, in a directory a `cd` the fence cannot follow names", context)
    if (this.runScript(runner, name, args, directory, context)) return
    if (/\.[cm]?[jt]sx?$|\.sh$/.test(name) || name.includes('/')) return this.program(name, args, command, context)
    this.words([name, ...args], command, deeper(context))
  }

  private npm(args: ReadonlyArray<string>, words: ReadonlyArray<string>, command: SimpleCommand, context: Context): void {
    const { sub, rest, directory } = packageCommand(args, NPM_VALUES, context.cwd)

    switch (sub) {
      case 'run':
      case 'run-script':
      case 'rum':
      case 'urn': {
        const [name, ...scriptArgs] = afterOptions(rest, NPM_VALUES.values)
        if (name !== undefined) this.target('npm', name, scriptArgs, command, directory, context)
        return
      }
      case 'test':
      case 't':
      case 'tst':
      case 'start':
      case 'stop':
      case 'restart':
        if (directory === undefined) return this.target('npm', sub, rest, command, directory, context)
        this.runScript('npm', sub.startsWith('t') ? 'test' : sub, rest, directory, context)
        return
      case 'exec':
      case 'x':
        return this.runner(rest, command, shown(words.map(display)), context)
      case 'publish':
        return this.publish(words, context)
    }
  }

  private bun(args: ReadonlyArray<string>, words: ReadonlyArray<string>, command: SimpleCommand, subject: string, context: Context): void {
    const inline = interpreterArgs(args, { kind: 'js', inline: 'ep', inlineLong: ['--eval', '--print'], values: 'Fcr', longValues: BUN_VALUES.values }).code
    for (const code of inline) {
      if (isDynamic(code)) this.unreadable(subject, 'code for bun that an expansion gives', context)
      else this.code(code, 'js', subject, context)
    }
    if (inline.length > 0) return

    const { sub, rest, directory } = packageCommand(args, BUN_VALUES, context.cwd)
    if (sub === undefined) return
    if (sub === 'x') return this.runner(rest, command, subject, context)
    if (sub === 'publish') return this.publish(words, context)
    if (sub === 'run') {
      const run = packageCommand(rest, BUN_VALUES, directory)
      if (run.sub !== undefined) this.target('bun', run.sub, run.rest, command, run.directory, context)
      return
    }
    if (!BUN_BUILTINS.has(sub)) this.target('bun', sub, rest, command, directory, context)
  }

  private pnpm(args: ReadonlyArray<string>, words: ReadonlyArray<string>, command: SimpleCommand, context: Context): void {
    const { sub, rest, directory } = packageCommand(args, PNPM_VALUES, context.cwd)
    if (sub === undefined) return

    if (sub === 'dlx') return this.runner(rest, command, shown(words.map(display)), context)
    if (sub === 'publish') return this.publish(words, context)
    if (sub === 'run') {
      const run = packageCommand(rest, PNPM_VALUES, directory)
      if (run.sub !== undefined) this.target('pnpm', run.sub, run.rest, command, run.directory, context)
      return
    }
    if (['test', 't', 'start', 'stop', 'restart'].includes(sub)) return this.target('pnpm', sub === 't' ? 'test' : sub, rest, command, directory, context)
    if (!PNPM_BUILTINS.has(sub)) this.target('pnpm', sub, rest, command, directory, context)
  }

  private yarn(args: ReadonlyArray<string>, words: ReadonlyArray<string>, command: SimpleCommand, subject: string, context: Context): void {
    const { sub, rest, directory } = packageCommand(args, YARN_VALUES, context.cwd)
    if (sub === undefined) return

    if (sub === 'dlx') return this.runner(rest, command, subject, context)
    if (sub === 'publish' || (sub === 'npm' && rest[0] === 'publish')) return this.publish(words, context)
    if (sub === 'workspace') return this.yarn(rest.slice(1), words, command, subject, deeper(context))
    if (sub === 'run') {
      const [name, ...scriptArgs] = rest
      if (name !== undefined) this.target('yarn', name, scriptArgs, command, directory, context)
      return
    }
    if (!YARN_BUILTINS.has(sub)) this.target('yarn', sub, rest, command, directory, context)
  }

  /** `deno run`, `deno eval` and `deno task`, whose tasks in deno.json the fence does not read. */
  private deno(args: ReadonlyArray<string>, command: SimpleCommand, subject: string, context: Context): void {
    const [sub, ...rest] = args
    if (sub === 'eval') {
      const [code] = afterOptions(rest, ['--ext', '--config', '-c', '--import-map', '--location'])
      if (code === undefined) return
      return isDynamic(code) ? this.unreadable(subject, 'code for deno that an expansion gives', context) : this.code(code, 'js', subject, context)
    }
    if (sub === 'task') return this.unreadable(subject, 'a deno task, which runs a command from deno.json the fence does not read', context)
    if (sub === 'run' || (sub !== undefined && /\.[cm]?[jt]sx?$/.test(sub))) {
      const [file, ...scriptArgs] = sub === 'run' ? afterOptions(rest, ['-c', '--config', '--import-map', '--lock', '--cert', '--location', '--seed', '--ext', '-L', '--log-level']) : args
      if (file !== undefined) this.program(file, scriptArgs, command, context, 'js')
    }
  }

  private publish(words: ReadonlyArray<string>, context: Context): void {
    if (!words.includes('--dry-run')) this.ask('publish', shown(words.map(display)), context)
  }

  private git(args: ReadonlyArray<string>, words: ReadonlyArray<string>, context: Context, command?: SimpleCommand): void {
    const subject = shown(words.map(display))
    const settings: Array<readonly [string, string | undefined]> = []
    let cwd = context.cwd
    let k = 0

    for (; k < args.length; k++) {
      const arg = args[k]
      const [option, attached] = splitOption(arg)
      if (GIT_SURFACE.elsewhere.has(option) && (attached !== undefined || option !== '--exec-path')) {
        this.ask('hook-bypass', subject, context, `points git at another repository or program with \`${option}\`, whose hooks are not the commit gate. Approve it only if you expected it.`)
      }
      if (!GIT_VALUE_OPTIONS.has(option)) {
        if (arg.startsWith('-')) continue
        break
      }
      const value = attached ?? args[++k] ?? ''
      if (option === '-C') cwd = isDynamic(value) ? undefined : joinPath(cwd, value)
      if (option === '-c') settings.push([value.split('=')[0] ?? '', value.includes('=') ? value.slice(value.indexOf('=') + 1) : ''])
      if (option === '--config-env') settings.push([value.split('=')[0] ?? '', UNREAD])
    }

    const [sub, ...rest] = args.slice(k)
    const at = { ...context, cwd }
    for (const [key, value] of settings) this.gitSetting(key.toLowerCase(), value, sub, rest, subject, at)
    if (sub === undefined) return

    const end = rest.indexOf('--')
    const options = end === -1 ? rest : rest.slice(0, end)

    if (options.some((arg) => NO_VERIFY.test(arg)) || (sub === 'commit' && commitSkipsHooks(options))) {
      return this.deny(subject, 'skips the git hooks that run the commit gate. Fix what the gate reports and commit again; only the owner changes the gate.', context)
    }
    if (!GIT_COMMANDS.has(sub)) {
      const alias = this.gitAliases.get(sub.toLowerCase())
      if (alias !== undefined) return this.gitAlias(alias, rest, subject, at)
      if (commitSkipsHooks(options)) {
        return this.ask('unreadable', subject, context, `may run an alias of \`git commit\` the fence cannot see, set outside the line, where \`-n\` skips the git hooks that run the commit gate. Approve it only if you expected it.`)
      }
    }
    if (GIT_SURFACE.commitWriters.has(sub) || (sub === 'hash-object' && writesCommitObject(options))) {
      return this.deny(subject, 'writes a commit by hand, which runs none of the git hooks that run the commit gate. Commit with `git commit`, which runs them.', context)
    }
    if (Object.hasOwn(GIT_SURFACE.commitsWithoutHook, sub) && !makesNoCommit(sub, options)) {
      this.ask('hook-bypass', subject, context, `makes or brings in commits without the pre-commit hook that runs the commit gate. Approve it only if you expected it.`)
    }
    if (GIT_SURFACE.pushes.has(sub)) {
      if (!options.includes('--dry-run') && !(sub === 'push' && options.includes('-n'))) this.ask('push', subject, context)
      return
    }
    const moved = branchMove(sub, rest)
    if (moved !== undefined) {
      this.ask('hook-bypass', subject, context, `moves a branch to ${moved}, whose commits the commit gate may never have checked. Approve it only if you expected it.`)
    }
    // A commit in another repository runs its hooks, not this gate's, and a fetch brings it here.
    if (sub === 'commit' && /^\.\.(\/|$)/.test(cwd ?? '')) {
      this.ask('hook-bypass', subject, context, "commits in a directory outside this one, another repository's, whose hooks are not this commit gate. Approve it only if you expected it.")
    }
    if (Object.hasOwn(GIT_SURFACE.writesPaths, sub)) {
      return this.gitWrites(sub, rest, positionals(afterValues(rest, GIT_SURFACE.writesPaths[sub])), command, subject, at)
    }

    switch (sub) {
      case 'config':
        return this.gitConfig(rest, subject, at)
      case 'apply':
        return this.gitApply(rest, command, subject, at)
      case 'read-tree':
        if (!options.includes('-n') && !options.includes('--dry-run')) {
          this.ask('fence-change', subject, context, "replaces the index with a tree's files, the fence's own among them. Approve it only if you expected it.")
        }
        return
      case 'rebase':
        options.forEach((arg, index) => {
          if (arg === '-x' || arg === '--exec') this.script(options[index + 1] ?? '', deeper(context))
          if (arg.startsWith('--exec=')) this.script(arg.slice('--exec='.length), deeper(context))
        })
        return
      case 'bisect':
        if (rest[0] === 'run') this.script(scriptOf(rest.slice(1)), deeper(context))
        return
      case 'submodule':
        if (rest.includes('foreach')) this.script(rest.slice(rest.indexOf('foreach') + 1).map(evalText).join(' '), deeper(context))
        return
    }
  }

  /**
   * A git command that writes the files it names, from the index, HEAD, or
   * another commit, whose files a pathspec such as `.` covers: the ledger
   * restored from an older commit lifts the count the gate holds it to.
   */
  private gitWrites(sub: string, args: ReadonlyArray<string>, files: ReadonlyArray<string>, command: SimpleCommand | undefined, subject: string, context: Context): void {
    const prefix = sub === 'checkout-index' ? (args.find((arg) => arg.startsWith('--prefix='))?.slice('--prefix='.length) ?? '') : ''
    // `--cacheinfo <mode>,<object>,<path>`.
    const named = sub === 'update-index' ? files.flatMap((file) => file.split(',')) : files
    this.writes(named.map((file) => `${prefix}${file}`), subject, context)
    if (prefix !== '' && args.some((arg) => arg === '-a' || arg === '--all')) this.write(`${prefix}${GLOB_ANY}`, subject, context)

    if (args.includes('--stdin') || args.includes('--index-info')) {
      const text = command === undefined ? null : this.stdinText(command, context)
      if (text === null) return this.unreadable(subject, 'the paths it reads from its input', context)
      this.writes((text ?? '').split('\n').map((line) => `${prefix}${line.slice(line.indexOf('\t') + 1)}`), subject, context)
    }

    const source = commitSource(sub, args, files)
    const covered = source?.specs.flatMap((spec) => pathspecCovers(spec, context.cwd, this.options.hooksPath))[0]
    if (source !== undefined && covered !== undefined) {
      this.ask('fence-change', subject, context, `writes the files it names from \`${display(source.commit)}\`, ${covered} among them, which is part of the fence. Approve it only if you expected it.`)
    }
  }

  /** `git apply`: the files its patches name, unless it only reports on them. */
  private gitApply(args: ReadonlyArray<string>, command: SimpleCommand | undefined, subject: string, context: Context): void {
    if (args.some((arg) => ['--check', '--stat', '--numstat', '--summary'].includes(arg)) && !args.includes('--apply')) return
    const directory = args.find((arg) => arg.startsWith('--directory='))?.slice('--directory='.length)
    const at = directory === undefined ? context : { ...context, cwd: isDynamic(directory) ? undefined : joinPath(context.cwd, directory) }
    const patches = positionals(args)
    for (const patch of patches.length === 0 ? [undefined] : patches) this.patchWrites(patch, command, subject, context, at)
  }

  /** A git setting given for one command, by `-c`, `--config-env` or `GIT_CONFIG_KEY_n`; an alias is read where the command uses it. */
  private gitSetting(key: string, value: string | undefined, sub: string | undefined, args: ReadonlyArray<string>, subject: string, context: Context): void {
    const setting = GIT_SURFACE.settings.find((entry) => entry.key.test(key)) ?? GIT_SURFACE.otherSetting
    if (setting.finding === 'none') return
    if (setting.finding === 'deny') return this.deny(subject, setting.reason, context)
    if (setting.finding === 'ask') return this.ask('hook-bypass', subject, context, setting.reason)
    if (value !== undefined && sub === key.slice('alias.'.length)) this.gitAlias(value, args, subject, context)
  }

  /** An alias's command, with the arguments it is used with: a `!` alias is a shell command, any other a git command. */
  private gitAlias(value: string, args: ReadonlyArray<string>, subject: string, context: Context): void {
    if (isDynamic(value)) return this.unreadable(subject, 'a git alias whose command an expansion gives', context)
    if (value.startsWith('!')) return this.script(`${value.slice(1)} ${scriptOf(args)}`, deeper(context))
    const words = [...splitWords(value), ...args]
    this.git(words, ['git', ...words], deeper(context))
  }

  private gitConfig(args: ReadonlyArray<string>, subject: string, context: Context): void {
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

    const verb = ['set', 'unset', 'get', 'list', 'rename-section', 'remove-section', 'edit'].includes(positional[0] ?? '') ? positional.shift() : undefined
    const [key = '', value] = positional
    const name = key.toLowerCase()

    if (verb === 'edit' || flags.includes('--edit') || flags.includes('-e')) {
      return this.ask('hook-bypass', subject, context, 'opens the git config in an editor, where a change can move the hooks or switch them off. Approve it only if you expected it.')
    }
    if (verb === 'remove-section' || verb === 'rename-section' || flags.includes('--remove-section') || flags.includes('--rename-section')) {
      if (name === 'core' || name.startsWith('core.')) this.deny(subject, 'removes or renames git\'s core section, which holds core.hooksPath and so the commit gate. Only the owner changes the gate.', context)
      return
    }

    const unsets = verb === 'unset' || flags.some((flag) => /^--unset(-all)?$/.test(flag))
    const writes = unsets || verb === 'set' || value !== undefined || flags.some((flag) => /^--(add|replace-all)$/.test(flag))
    if (key === '' || !writes) return

    const setting = GIT_SURFACE.settings.find((entry) => entry.key.test(name))
    if (setting?.finding === 'deny') return this.deny(subject, setting.reason, context)
    if (setting?.finding === 'alias' && value !== undefined) {
      if (!unsets) this.gitAliases.set(name.slice('alias.'.length), value)
      return this.gitAlias(value, [], subject, context)
    }
    if (setting?.finding === 'ask') return this.ask('hook-bypass', subject, context, setting.reason)
    if (GIT_SURFACE.programs.test(name) && !unsets) {
      this.ask('hook-bypass', subject, context, 'writes a git setting that names a program git runs, which can do anything a command can. Approve it only if you expected it.')
    }
  }

  private wrangler(args: ReadonlyArray<string>, words: ReadonlyArray<string>, context: Context): void {
    const subject = shown(words.map(display))
    const flag = (name: string) =>
      args.some((arg) => arg === name || (arg.startsWith(`${name}=`) && !/^(false|0)$/i.test(arg.slice(name.length + 1))))
    const dryRun = flag('--dry-run') || flag('--dryRun')

    // An option the fence does not know is read both as a flag and as taking the next word.
    for (const [a, b, c] of wranglerPaths(args, 0, [], [], { budget: 32 })) {
      const deploys = (a === 'deploy' || a === 'publish') || (a === 'versions' && (b === 'deploy' || b === 'upload')) ||
        (a === 'triggers' && b === 'deploy') || (a === 'pages' && (b === 'deploy' || b === 'publish'))

      if ((a === 'secret' && SECRET_WRITES.has(b ?? '')) || ((a === 'versions' || a === 'pages') && b === 'secret' && SECRET_WRITES.has(c ?? ''))) {
        return this.ask('secret', subject, context)
      } else if (a === 'rollback' || a === 'delete' || (a === 'pages' && b === 'project' && c === 'delete')) {
        return this.ask('deploy', subject, context, 'rolls back or deletes a Worker on Cloudflare. Approve it only if you asked for it.')
      } else if (deploys) {
        if (!dryRun) return this.ask('deploy', subject, context)
      } else if (flag('--remote') || (a === 'd1' && b === 'time-travel' && c === 'restore') || ([a, b, c].includes('delete') && !flag('--local'))) {
        // A resource's delete, such as `wrangler d1 delete`, acts on Cloudflare unless it says --local.
        return this.ask('remote-data', subject, context)
      }
    }
  }
}

/** The command paths `wrangler`'s arguments may name, up to three parts each. */
function wranglerPaths(args: ReadonlyArray<string>, start: number, path: ReadonlyArray<string>, out: string[][], limit: { budget: number }): string[][] {
  let parts = [...path]
  for (let k = start; k < args.length && parts.length < 3; k++) {
    const arg = args[k]
    if (!arg.startsWith('-')) {
      parts = [...parts, ...arg.split(':')]
      continue
    }
    const [name, value] = splitOption(arg)
    if (value !== undefined || WRANGLER_FLAGS.has(name)) continue
    if (WRANGLER_VALUE_OPTIONS.has(name)) {
      k++
      continue
    }
    if (limit.budget-- > 0 && args[k + 1] !== undefined && !args[k + 1].startsWith('-')) wranglerPaths(args, k + 2, parts, out, limit)
  }
  out.push(parts)
  return out
}

/** Options a command reads, and the words after them; or the first one it does not know. */
type ParsedOptions =
  | {
      readonly rest: ReadonlyArray<string>
      readonly flags: ReadonlySet<string>
      /** The last value each option was given. */
      readonly values: ReadonlyMap<string, string>
      /** Every value each option was given, in order. */
      readonly all: ReadonlyArray<readonly [string, string]>
    }
  | { readonly unknown: string }

function parseOptions(args: ReadonlyArray<string>, spec: OptionSpec): ParsedOptions {
  const flags = new Set<string>()
  const all: Array<readonly [string, string]> = []
  let k = 0

  while (k < args.length) {
    const arg = args[k]
    if (arg === '--') {
      k++
      break
    }
    if (arg === '-' || !arg.startsWith('-')) break
    if (spec.numeric === true && /^-\d+$/.test(arg)) {
      k++
      continue
    }
    if (arg.startsWith('--')) {
      const [name, value] = splitOption(arg)
      if (spec.longFlags?.includes(name)) {
        flags.add(name)
        k++
      } else if (spec.longValues?.includes(name) && (value !== undefined || args[k + 1] !== undefined)) {
        all.push([name, value ?? args[k + 1]])
        k += value === undefined ? 2 : 1
      } else {
        return { unknown: arg }
      }
      continue
    }

    let consumed = 1
    for (let p = 1; p < arg.length; p++) {
      const letter = arg[p]
      if (spec.flags?.includes(letter)) {
        flags.add(`-${letter}`)
        continue
      }
      if (!spec.values?.includes(letter)) return { unknown: arg }
      const attached = arg.slice(p + 1)
      const value = attached === '' ? args[k + 1] : attached
      if (value === undefined) return { unknown: arg }
      all.push([`-${letter}`, value])
      if (attached === '') consumed = 2
      break
    }
    k += consumed
  }

  return { rest: args.slice(Math.min(args.length, k + (spec.positionals ?? 0))), flags, values: new Map(all), all }
}

/** Options spelled as whole words, as `xcrun -sdk macosx`: the words after them, and the options seen; or the first one it does not know. */
function wordOptions(
  args: ReadonlyArray<string>,
  flags: ReadonlyArray<string>,
  values: ReadonlyArray<string>
): { readonly rest: ReadonlyArray<string>; readonly seen: ReadonlyArray<string> } | { readonly unknown: string } {
  const seen: string[] = []
  let k = 0
  for (; k < args.length && args[k].startsWith('-'); k++) {
    if (args[k] === '--') return { rest: args.slice(k + 1), seen }
    const [name, value] = splitOption(args[k])
    if (!flags.includes(name) && !values.includes(name)) return { unknown: args[k] }
    seen.push(name)
    if (values.includes(name) && value === undefined) k++
  }
  return { rest: args.slice(k), seen }
}

/** Each way to take one word from each group, or undefined when there are more than `limit`. */
function product(groups: ReadonlyArray<ReadonlyArray<string>>, limit: number): string[][] | undefined {
  let combinations: string[][] = [[]]
  for (const group of groups) {
    combinations = combinations.flatMap((combination) => group.map((word) => [...combination, word]))
    if (combinations.length > limit) return undefined
  }
  return combinations
}

/** An interpreter's arguments: the code its options give, the module it runs, the file, or none of them (its input). */
function interpreterArgs(args: ReadonlyArray<string>, spec: Interpreter): { code: string[]; module: boolean; file?: string; runScript?: string; rest: ReadonlyArray<string> } {
  const code: string[] = []

  for (let k = 0; k < args.length; k++) {
    const arg = args[k]
    if (arg === '-') return { code, module: false, rest: args.slice(k + 1) }
    if (!arg.startsWith('-')) return { code, module: false, file: arg, rest: args.slice(k + 1) }
    if (arg.startsWith('--')) {
      const [name, value] = splitOption(arg)
      if (spec.inlineLong?.includes(name)) code.push(value ?? args[++k] ?? '')
      else if (spec.kind === 'js' && name === '--run') return { code, module: false, runScript: value ?? args[k + 1], rest: args.slice(value === undefined ? k + 2 : k + 1) }
      else if (spec.longValues?.includes(name) && value === undefined) k++
      continue
    }
    for (let p = 1; p < arg.length; p++) {
      const letter = arg[p]
      const attached = arg.slice(p + 1)
      if (spec.inline.includes(letter)) {
        // `node -pe code`: the letters after it give code too, from the next word.
        const own = attached !== '' && ![...attached].every((other) => spec.inline.includes(other))
        code.push(own ? attached : args[++k] ?? '')
        // python's -c ends its options: the words after it are the code's arguments.
        if (spec.kind === 'python') return { code, module: false, rest: args.slice(k + 1) }
        break
      }
      if (spec.module === letter) return { code, module: true, rest: [] }
      if (spec.file === letter) return { code, module: false, file: attached !== '' ? attached : args[k + 1], rest: args.slice(attached !== '' ? k + 1 : k + 2) }
      if (spec.values?.includes(letter)) {
        if (attached === '') k++
        break
      }
      if (spec.attached?.includes(letter)) break
    }
  }
  return { code, module: false, rest: [] }
}

/** A package manager's command after its own options, and the package directory `--cwd`, `--prefix` or `-C` names. */
function packageCommand(
  args: ReadonlyArray<string>,
  spec: { readonly values: ReadonlyArray<string>; readonly directory: ReadonlyArray<string> },
  cwd: string | undefined
): { sub: string | undefined; rest: ReadonlyArray<string>; directory: string | undefined } {
  let directory = cwd
  let k = 0

  for (; k < args.length; k++) {
    const arg = args[k]
    if (!arg.startsWith('-') || arg === '-') break
    const [name, attached] = splitOption(arg)
    if (!spec.values.includes(name)) continue
    const value = attached ?? args[++k] ?? ''
    if (spec.directory.includes(name)) directory = isDynamic(value) ? undefined : joinPath(directory, value)
  }

  return { sub: args[k], rest: args.slice(k + 1), directory }
}

/** The text an `echo`, `printf` or `cat` gives the next command of a pipeline: null when the fence cannot know it. */
function producedText(command: SimpleCommand, stdinOf: (command: SimpleCommand) => string | undefined | null): string | null {
  if (command.words.some(isDynamic) || command.writes.length > 0) return null
  const [head, ...args] = command.words
  const name = basename(head ?? '')

  if (name === 'echo') {
    let k = 0
    for (; k < args.length && /^-[neE]+$/.test(args[k]); k++) if (args[k].includes('e')) return null
    const words = args.slice(k)
    // zsh's echo reads backslash escapes, as bash's does with xpg_echo.
    if (words.some((word) => word.includes('\\'))) return null
    return `${words.join(' ')}\n`
  }
  if (name === 'printf') {
    const [format, ...values] = args
    // Only `%s`, `%%` and `\n` are read; any other format or escape gives text the fence does not work out.
    if (format === undefined || format.startsWith('-') || /[%\\]/.test(format.replace(/%%|%s|\\n/g, ''))) return null
    const fields = (format.match(/%s/g) ?? []).length
    let text = ''
    let index = 0
    do {
      text += format.replace(/%[s%]|\\n/g, (spec) => (spec === '%s' ? values[index++] ?? '' : spec === '%%' ? '%' : '\n'))
    } while (fields > 0 && index < values.length)
    return text
  }
  if (name === 'cat' && (args.length === 0 || (args.length === 1 && args[0] === '-'))) {
    const input = stdinOf(command)
    return input === undefined ? '' : input
  }
  return null
}

/** A package.json's scripts. */
export function packageScripts(text: string): Record<string, string> | undefined {
  try {
    const manifest: unknown = JSON.parse(text)
    const scripts = typeof manifest === 'object' && manifest !== null ? (manifest as { scripts?: unknown }).scripts : undefined
    if (typeof scripts !== 'object' || scripts === null || Array.isArray(scripts)) return undefined
    return Object.fromEntries(Object.entries(scripts).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  } catch {
    return undefined
  }
}

/** curl's short options that take a value, which ends a cluster of them. */
const CURL_VALUES = 'AbcCdDeEFHKmPQrtTuUwxXyYz'

/** The files curl writes: `-o`'s, and with `-O` each URL's last part. */
function curlOutputs(args: ReadonlyArray<string>): string[] {
  const outputs: string[] = []
  let remote = false
  args.forEach((arg, index) => {
    const [name, value] = splitOption(arg)
    if (name === '--output') outputs.push(value ?? args[index + 1] ?? '')
    else if (name === '--remote-name' || name === '--remote-name-all') remote = true
    else if (/^-[a-zA-Z]/.test(arg)) {
      for (const [p, letter] of Array.from(arg.slice(1)).entries()) {
        if (letter === 'O') remote = true
        if (letter === 'o') outputs.push(arg.slice(p + 2) || (args[index + 1] ?? ''))
        if (letter === 'o' || CURL_VALUES.includes(letter)) break
      }
    }
  })
  return remote ? [...outputs, ...args.filter((arg) => /^[a-z]+:\/\//i.test(arg)).map((url) => basename(url.replace(/[?#].*$/, '')))] : outputs
}

function wgetOutputs(args: ReadonlyArray<string>): string[] {
  let document: string | undefined
  let prefix = ''
  args.forEach((arg, index) => {
    const [name, value] = splitOption(arg)
    if (arg === '-O' || name === '--output-document') document = value ?? args[index + 1]
    else if (arg.startsWith('-O') && arg.length > 2) document = arg.slice(2)
    if (arg === '-P' || name === '--directory-prefix') prefix = `${value ?? args[index + 1] ?? ''}/`
  })
  if (document !== undefined) return [document]
  return args.filter((arg) => /^[a-z]+:\/\//i.test(arg)).map((url) => `${prefix}${basename(url.replace(/[?#].*$/, '')) || 'index.html'}`)
}

/** The files `tar` extracts by name, in the directory `-C` names, and the archive it creates. */
function tarWrites(args: ReadonlyArray<string>): string[] {
  const [first = ''] = args
  const mode = /^-?[A-Za-z]+$/.test(first) ? first.replace(/^-/, '') : ''
  const extract = mode.includes('x') || args.includes('--extract') || args.includes('--get')
  const create = /[cru]/.test(mode) || args.some((arg) => /^--(create|append|update)$/.test(arg))
  let archive: string | undefined
  let directory = ''
  const members: string[] = []

  for (let k = mode === '' ? 0 : 1; k < args.length; k++) {
    const arg = args[k]
    const [name, value] = splitOption(arg)
    if (arg === '-C' || name === '--directory') directory = `${value ?? args[++k] ?? ''}/`
    else if (arg === '-f' || name === '--file') archive = value ?? args[++k]
    else if (/^-[A-Za-z]*f$/.test(arg)) archive = args[++k]
    else if (!arg.startsWith('-')) members.push(arg)
  }
  if (archive === undefined && mode.includes('f')) archive = members.shift()
  return [...(extract ? members.map((member) => `${directory}${member}`) : []), ...(create && archive !== undefined ? [archive] : [])]
}

function unzipWrites(args: ReadonlyArray<string>): string[] {
  let directory = ''
  const files: string[] = []
  for (let k = 0; k < args.length; k++) {
    if (args[k] === '-d') directory = `${args[++k] ?? ''}/`
    else if (args[k] === '-x') break
    else if (!args[k].startsWith('-')) files.push(args[k])
  }
  return files.slice(1).map((member) => `${directory}${member}`)
}

/** What the fence says of an option it does not read, or a word an expansion gives where a command reads its options. */
function unknownOption(command: string, word: string): string {
  return isDynamic(word) ? `\`${display(word)}\`, a word an expansion gives where ${command} reads its options` : `\`${word}\`, an option of ${command} the fence does not read`
}

/** A python, perl or ruby by its versioned name. */
function interpreterName(name: string): string {
  return /^python[\d.]*$/.test(name) ? 'python' : name
}

/** Whether text the shell does not expand where it is set holds a command substitution, which it runs where it evaluates the text. */
function holdsSubstitution(text: string): boolean {
  return /\$\(|`/.test(known(text))
}

/** Whether a word with unread parts could be `target`, its unread parts giving whatever text it needs. */
function couldRead(word: string, target: string): boolean {
  const pattern = wordParts(word).map((part) => (isDynamic(part) ? '[^]*' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('')
  return new RegExp(`^${pattern}$`).test(target)
}

/** A short-option cluster an unread part ends, `-a$(...)` as `-an`: `git commit`'s `-n` among them. */
function clusterReading(word: string): ReadonlyArray<ReadonlyArray<string>> {
  const [first = ''] = wordParts(word)
  const before = isDynamic(first) ? '' : first
  return /^-[A-Za-z]*$/.test(before) ? [[`${before}n`]] : []
}

/** `-c`'s `name=value` whose unread name could be `core.hooksPath`, as `"$(...)"=/dev/null`. */
function hooksPathReading(word: string): ReadonlyArray<ReadonlyArray<string>> {
  const equals = word.indexOf('=')
  return equals !== -1 && couldRead(word.slice(0, equals), HOOKS_PATH) ? [[`${HOOKS_PATH}${known(word.slice(equals))}`]] : []
}

/**
 * Each reading of a command's words, the first choice of each word being
 * how the shell reader read it: at most `MAX_REREAD` words read otherwise.
 */
function* readings(choices: ReadonlyArray<ReadonlyArray<ReadonlyArray<string>>>): Generator<ReadonlyArray<string>> {
  const open = choices.flatMap((options, at) => (options.length > 1 ? [at] : []))

  function* pick(from: number, picked: ReadonlyArray<readonly [number, ReadonlyArray<string>]>): Generator<ReadonlyArray<readonly [number, ReadonlyArray<string>]>> {
    yield picked
    if (picked.length === MAX_REREAD) return
    for (let k = from; k < open.length; k++) {
      for (const option of choices[open[k]].slice(1)) yield* pick(k + 1, [...picked, [open[k], option]])
    }
  }

  for (const picked of pick(0, [])) {
    const words = choices.map((options) => options[0])
    for (const [at, option] of picked) words[at] = option
    yield words.flat()
  }
}

/** Commits a branch already holds: HEAD, its ancestors, and where HEAD was before the last reset or merge. */
const CHECKED_COMMIT = /^(?:HEAD|@)(?:[~^]\d*)*$|^ORIG_HEAD$/
/** Words that name a commit rather than a path: `FETCH_HEAD`, `x~2`, `x^`, `x@{1}`, a hash, a remote's branch. */
const COMMIT_NAME = /^[A-Z_]+_HEAD$|[~^]|@\{|^[0-9a-f]{7,40}$|^(?:refs|origin|upstream)\//

/**
 * The commit a git command moves a branch to, shown, when it may hold
 * commits the gate never checked: `reset` to another commit than HEAD's own,
 * `update-ref`, `branch -f`, `-M` or `-C`, `switch -C` and `checkout -B`.
 */
function branchMove(sub: string, args: ReadonlyArray<string>): string | undefined {
  const end = args.indexOf('--')
  const options = end === -1 ? args : args.slice(0, end)
  const words = positionals(options)
  const shown = (commit: string | undefined) => `\`${display(commit ?? 'HEAD')}\``

  switch (sub) {
    case 'reset': {
      // With paths, reset changes the index and leaves the branch where it is.
      const mode = options.some((arg) => /^--(?:soft|mixed|hard|keep|merge)$/.test(arg))
      const [commit] = words
      if (end !== -1 && args.length > end + 1) return undefined
      if (commit === undefined || words.length > 1 || CHECKED_COMMIT.test(commit) || !(mode || COMMIT_NAME.test(commit))) return undefined
      return shown(commit)
    }
    case 'update-ref': {
      if (options.includes('-d')) return undefined
      if (options.includes('--stdin')) return 'the commits its input names'
      const refs = positionals(afterValues(options, ['-m']))
      return refs.length < 2 ? undefined : shown(refs[1])
    }
    case 'branch':
      if (options.some((arg) => arg === '-M' || arg === '-C')) return shown(words[0])
      return options.some((arg) => arg === '-f' || arg === '--force') && words.length > 0 ? shown(words[1]) : undefined
    case 'switch':
    case 'checkout': {
      const at = options.findIndex((arg) => arg === (sub === 'switch' ? '-C' : '-B') || arg === '--force-create')
      return at === -1 ? undefined : shown(positionals(options.slice(at + 2))[0])
    }
  }
  return undefined
}

/**
 * The commit a git command writes files from, when it is neither the index
 * nor HEAD, and the pathspecs it writes: `checkout <commit> -- <paths>`,
 * `restore --source`, `reset <commit> -- <paths>`, and `reset --hard
 * <commit>`, which writes the whole tree.
 */
function commitSource(sub: string, args: ReadonlyArray<string>, files: ReadonlyArray<string>): { readonly commit: string; readonly specs: ReadonlyArray<string> } | undefined {
  const end = args.indexOf('--')
  // Before `--` the first word is the commit; without it, the first of two or more.
  const commit = (end === -1 ? files : positionals(args.slice(0, end)))[0]
  const found =
    sub === 'restore' ? { commit: optionValue(args, ['-s', '--source']), specs: files }
    : sub === 'reset' && args.some((arg) => ['--hard', '--keep', '--merge'].includes(arg)) ? { commit, specs: [''] }
    : sub === 'checkout' || sub === 'reset' ? { commit, specs: files.slice(1) }
    : undefined
  return found?.commit === undefined || /^(HEAD|@)$/.test(found.commit) ? undefined : { commit: found.commit, specs: found.specs }
}

/** The value an option is given, attached or as the next word. */
function optionValue(args: ReadonlyArray<string>, names: ReadonlyArray<string>): string | undefined {
  for (let k = 0; k < args.length; k++) {
    const [name, value] = splitOption(args[k])
    if (names.includes(name)) return value ?? args[k + 1]
  }
  return undefined
}

/** The files a patch's headers name: unified, context and git diffs' `---` and `+++`, `diff --git`, renames and copies, and `Index:`. */
function patchedPaths(text: string): string[] {
  const paths: string[] = []
  for (const line of text.split('\n')) {
    const git = /^diff --git (\S+) (\S+)$/.exec(line)
    const header = /^(?:\+\+\+|---|\*\*\*) (\S+)/.exec(line) ?? /^(?:rename|copy) (?:from|to) (.+)$/.exec(line) ?? /^Index: (.+)$/.exec(line)
    for (const path of git === null ? [header?.[1] ?? '/dev/null'] : [git[1], git[2]]) if (path !== '/dev/null') paths.push(path.replace(/^"|"$/g, ''))
  }
  return paths
}

/**
 * Whether a command that commits without the pre-commit hook makes no
 * commit with these options: one of them says so and, where git reads the
 * options in pairs, every one is an option the fence knows and the last of
 * each pair agrees. A merge makes none after `--abort` or `--quit`, or with
 * `--no-ff` and `--no-commit`, since git fast-forwards whenever it can,
 * `--no-commit` or not; a cherry-pick or revert none after `--abort` or
 * `--quit`, which end what is in progress or fail, or when the last of `-n`,
 * `--no-commit` and `--commit` is not `--commit`.
 */
function makesNoCommit(sub: string, options: ReadonlyArray<string>): boolean {
  if (!options.some((arg) => GIT_SURFACE.commitsWithoutHook[sub].includes(arg))) return false
  if (!Object.hasOwn(GIT_SURFACE.pairedOptions, sub)) return true
  const read = readGitOptions(options, GIT_SURFACE.pairedOptions[sub])
  if (read === undefined) return false

  const last = (...pair: ReadonlyArray<string>) => read.filter((name) => pair.includes(name)).at(-1)
  if (sub === 'merge') {
    return (
      last('--abort', '--no-abort') === '--abort' ||
      last('--quit', '--no-quit') === '--quit' ||
      (last('--ff', '--no-ff', '--ff-only') === '--no-ff' && last('--commit', '--no-commit') === '--no-commit')
    )
  }
  const commit = last('-n', '--no-commit', '--commit', '--no-no-commit')
  return read.includes('--abort') || read.includes('--quit') || commit === '-n' || commit === '--no-commit'
}

/**
 * A git command's options in the order it reads them, short ones letter by
 * letter, without their values; undefined when one is not among `spec`'s.
 */
function readGitOptions(options: ReadonlyArray<string>, spec: GitOptions): string[] | undefined {
  const read: string[] = []

  for (let k = 0; k < options.length; k++) {
    const arg = options[k]
    if (arg === '-' || !arg.startsWith('-')) continue
    if (arg.startsWith('--')) {
      const [name, value] = splitOption(arg)
      if (spec.values.has(name)) {
        if (value === undefined) k++
      } else if (!spec.attached.has(name) && !(spec.flags.has(name) && value === undefined)) {
        return undefined
      }
      read.push(name)
      continue
    }
    for (let p = 1; p < arg.length; p++) {
      const letter = arg[p]
      if (!spec.shortFlags.includes(letter) && !spec.shortValues.includes(letter) && !spec.shortAttached.includes(letter)) return undefined
      read.push(`-${letter}`)
      if (spec.shortValues.includes(letter)) {
        if (p === arg.length - 1) k++
        break
      }
      if (spec.shortAttached.includes(letter)) break
    }
  }
  return read
}

/** `git hash-object -w -t commit`, which writes a commit object by hand. */
function writesCommitObject(options: ReadonlyArray<string>): boolean {
  return options.some((arg, index) =>
    arg === '-tcommit' || arg === '--type=commit' || ((arg === '-t' || arg === '--type') && options[index + 1] === 'commit')
  )
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

/** The words after a command's options, past the value of each option that takes one. */
function afterOptions(args: ReadonlyArray<string>, values: ReadonlyArray<string>): ReadonlyArray<string> {
  let k = 0

  while (k < args.length) {
    const arg = args[k]
    if (arg === '--') return args.slice(k + 1)
    if (!arg.startsWith('-') || arg === '-') break
    k += values.includes(arg) ? 2 : 1
  }
  return args.slice(k)
}

/** A command's arguments without the values of the options that take one. */
function afterValues(args: ReadonlyArray<string>, values: ReadonlyArray<string>): ReadonlyArray<string> {
  return args.filter((arg, index) => !values.includes(args[index - 1] ?? ''))
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

/** Words as a command line the reader reads back as them, an unread part as an expansion. */
function scriptOf(words: ReadonlyArray<string>): string {
  return words
    .map((word) =>
      wordParts(word)
        .map((part) => (part === UNREAD ? '"$_"' : part === UNREAD_WORDS ? '$_' : part === GLOB_ANY ? '*' : part === GLOB_ONE ? '?' : quote(part)))
        .join('') || "''"
    )
    .join(' ')
}

/** A word as `eval` and `git submodule foreach` read it: its text, joined to the others and read again. */
function evalText(word: string): string {
  return wordParts(word)
    .map((part) => (part === UNREAD || part === UNREAD_WORDS ? '$_' : part === GLOB_ANY ? '*' : part === GLOB_ONE ? '?' : part))
    .join('')
}

function shown(words: ReadonlyArray<string>): string {
  return words.map(quote).join(' ')
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? ''
  return line.length > 80 ? `${line.slice(0, 77)}...` : line
}

function from(subject: string, via: string | undefined): string {
  return via === undefined ? subject : `${via}: ${subject}`
}
