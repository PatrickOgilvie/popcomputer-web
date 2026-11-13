# The agent fence

`AGENTS.md` asks an agent to run the type check, the lint rules and the
tests, to say why it turns a rule off, and to leave deploys to the owner. An
agent can skip a paragraph; it cannot skip a check that refuses to pass. The
fence turns those rules into three checks:

- the commit gate runs the checks before every commit;
- the agent's command hook refuses a command that skips the gate, and asks
  the owner before one that deploys, touches remote data, changes secrets,
  publishes or pushes;
- the debt report counts every comment that turns a rule off, so the count
  only shrinks.

When an enforced check and a paragraph disagree, the check wins and the
paragraph gets fixed. The checks ship in the package as the `popweb-fence`
command and the `@popcomputer/web/fence` entrypoint, for Node and Bun alike.

## The commit gate

The gate is the checks `AGENTS.md`'s "Before finishing" names, as a git
pre-commit hook. Commit it as `.githooks/pre-commit`:

```sh
#!/bin/sh
# The commit gate: the checks an agent runs before finishing, before every commit.
set -e
bunx tsc --noEmit
bunx oxlint
bun test
bunx popweb-fence debt --check
```

Install it once, in your own terminal:

```bash
chmod +x .githooks/pre-commit && git config core.hooksPath .githooks
```

The command hook refuses an agent's `git config core.hooksPath`, so the
owner installs the gate, and every worktree of the repository shares it.
The template does it on `bun install`: its `prepare` script runs
`.githooks/install.ts`, which sets `core.hooksPath` to `.githooks` in a git
repository where nothing else set it, so an install the agent runs only
switches the gate on. A team on [Lefthook](https://lefthook.dev) commits
the same checks as `lefthook.yml` instead, and runs `bunx lefthook install`:

```yaml
pre-commit:
  parallel: false
  commands:
    types:
      run: bunx tsc --noEmit
    lint:
      run: bunx oxlint
    test:
      run: bun test
    debt:
      run: bunx popweb-fence debt --check
```

When the gate fails, fix what it reports and commit again. `git commit
--no-verify`, `git commit -n`, `HUSKY=0`, `LEFTHOOK=0` and a changed
`core.hooksPath` all skip it, and the command hook refuses each one.

## The command hook

`popweb-fence hook` reads the command an agent is about to run, as the
agent's hook passes it, and answers in that agent's format.

| It finds | For example | It |
| --- | --- | --- |
| A way around the commit gate | `git commit --no-verify`, `-n`, `HUSKY=0`, `LEFTHOOK=0`, `-c core.hooksPath=...`, `lefthook uninstall`, a write into `.git/hooks/` or `.git/config`, by a redirect, a program's code, a patch or a link to one, a commit written by hand with `git commit-tree`, `git fast-import` or `git hash-object -t commit` | refuses it |
| A commit the gate did not check | `git pull`, `merge`, `rebase`, `cherry-pick`, `revert` and `am`, and `merge --no-commit` unless the last of its `--ff`, `--no-ff` and `--ff-only` is `--no-ff`, since git fast-forwards whenever it can, and `cherry-pick -n` or `revert -n` whose last of `-n`, `--no-commit` and `--commit` is `--commit`; a branch moved to another commit than its own by `reset`, `branch -f`, `update-ref`, `switch -C` or `checkout -B`; a commit in a directory above this one; settings given by `git -c` or `GIT_CONFIG_*`, and `GIT_DIR`, `HOME` or `XDG_CONFIG_HOME`; a program `GIT_PAGER`, `GIT_SSH_COMMAND` or `EDITOR` names, read as a command | asks the owner |
| A deploy | `wrangler deploy`, `wrangler versions deploy`, `wrangler rollback` | asks the owner |
| Remote data | `wrangler d1 migrations apply --remote`, `wrangler d1 execute --remote`, any `wrangler ... --remote` | asks the owner |
| A secret | `wrangler secret put`, `bulk` or `delete` | asks the owner |
| A release | `npm publish`, `bun publish`, `pnpm publish` | asks the owner |
| A push | `git push`, `git send-pack` | asks the owner |
| A change to the fence | `oxlint.config.ts`, `lefthook.yml`, `.githooks/` or the directory `core.hooksPath` names, `.husky/`, `.pre-commit-config.yaml`, `.simple-git-hooks.json`, `.claude/settings.json`, `lint-debt.json`, written as they are or by `git checkout <commit> -- .`, `git reset --hard <commit>` or `git apply`; `popweb-fence debt --allow-increase` | asks the owner |
| What it cannot read | a command name a variable gives, `bash -c "$CMD"`, an alias, a script it cannot open, code that can start a process, a pipe into a shell from a command whose output it cannot know, a value holding a quoted `$(...)`, which bash runs where it evaluates the value as arithmetic; a program it does not know whose arguments, from the first that names a command it reads, make a command it would not allow, as `gtimeout 5 git push`, or one of which is a command line that does, beginning with such a name or joining commands with `&&`, `\|\|`, `;` or `\|`, as `tmux new 'cd app && git push'` (not `echo`, `grep`, `say` or another that only prints, searches or displays them, nor a `--title`, `--body` or `-m` value) | asks the owner |

`wrangler deploy --dry-run`, `npm publish --dry-run`, `git push --dry-run`
and D1's local database (`--local`, the default) need no one.

The hook parses a command line with tree-sitter's bash grammar and judges
every command the tree holds: in lists, pipes, subshells, `$(...)`,
heredocs and arithmetic, in `sh -c`, `eval` and `trap` strings, behind
`env`, `sudo`, `xargs`, `npx`, `cross-env`, `lockf` and `parallel`, in the
`package.json` scripts a runner names, so `bun run deploy` asks when its
script deploys, and in the scripts and programs, awk's among them, a command
runs. A `cd` on the line moves the directory it reads paths and scripts
from; it compares paths without `.`, `..` or case.

It never reads a word holding a `$` expansion, a substitution or a glob,
not even a variable the line sets: it tries each as `git`, `commit` and
`-n`, and refuses `git $(echo commit) -n`, so write such a command out in
full; `git commit -m "$(cat <<'EOF' ... EOF)"`, one quoted word, runs. Where
such a word, or a wrapper's option it does not know, decides what runs, it
asks, as before a script it cannot open or over 256 KiB, and before code
that can start a process, whose command is built at run time.

### Claude Code

Commit `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "bun \"$CLAUDE_PROJECT_DIR/node_modules/@popcomputer/web/dist/fence/cli.js\" hook"
          }
        ]
      }
    ]
  }
}
```

Claude Code shows a refusal's reason to the agent, and puts a question to
you in its permission prompt, auto mode included: approve the one command,
or decline it and run it yourself; a `claude -p` run refuses it. The `Edit`
and `Write` matchers send file edits through the same policy, so an edit of
`.git/hooks/` is refused and an edit of a fence file asks. `node` runs the
hook as well as `bun`.

### Cursor

Commit `.cursor/hooks.json`; a project's hooks run from its root:

```json
{
  "version": 1,
  "hooks": {
    "beforeShellExecution": [
      {
        "command": "bun node_modules/@popcomputer/web/dist/fence/cli.js hook",
        "failClosed": true
      }
    ]
  }
}
```

`failClosed` refuses a command when the hook itself fails, as it does until
`bun install` has run: run the first install yourself. Claude Code lets it through.

### Other agents

An agent whose hook pipes the command line to a program and blocks on exit
status 2 uses the command as it is: `popweb-fence hook` reads a plain command
line on stdin, and exits 2 with the reason on stderr when the command must
not run. Check it by hand:

```bash
echo 'sh -c "git commit --no-verify"' | bunx popweb-fence hook
```

An agent whose hooks are code, such as a Pi extension, calls the policy
itself:

```ts
// scripts/agent-policy.ts
import { readFileSync, statSync } from 'node:fs'
import { commandPolicy, filePolicy } from '@popcomputer/web/fence'

const { scripts } = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts?: Record<string, string> }
const readFile = (path: string) => (statSync(path, { throwIfNoEntry: false })?.isFile() ? readFileSync(path, 'utf8') : undefined)

export const beforeCommand = (command: string) => commandPolicy(command, { scripts, readFile })
export const beforeEdit = (path: string) => filePolicy(path)
```

Each returns `{ decision: 'allow' }`, or a `decision` of `'deny'` or `'ask'`
with the `rule`, the `subject` and the `reason`. Without `readFile`, a
script a command runs is one the policy cannot open, so it asks.

### What it cannot see

The hook is a guard that keeps an agent to the rules, not a security
boundary: it reads the command line, not the system it runs on. It cannot
see an alias set outside the line, a `make`, `just`, `turbo`, `lerna` or
`nx` target, a command or path a program builds at run time, what
`git stash pop` brings back, or a fence file in a directory a command
removes whole. What cannot be skipped is a required CI check that runs the
gate on every pull request. When a spelling gets past the hook, add the
case to the policy's tests first, as `AGENTS.md` says.

## The debt report

`popweb-fence debt` lists every comment in the application's source that
turns a rule or a check off, with the reason it gives, and counts them:

```text
src/actions/reports.ts:41  oxlint-disable-next-line popcomputer-web/no-sql-interpolation  -- the column names are constants
src/email.ts:12  @ts-expect-error  (no reason given)

2 disable directives, 1 without a reason.
```

It counts Oxlint's and ESLint's `disable` comments, TypeScript's
`@ts-expect-error`, `@ts-ignore` and `@ts-nocheck`, and Effect's
`@effect-diagnostics` comments that lower a rule below `error`, in the files
git tracks or would track. It reads comments with Oxc's parser, as Oxlint
does, so JSX text, strings and regular expressions hold none, and it refuses
a file the parser cannot read. A reason follows ` -- `, as
`// oxlint-disable-next-line popcomputer-web/no-sql-interpolation -- the column names are constants`.

`popweb-fence debt --update` writes the ledger, `lint-debt.json`: each
directive without its line, so moving code changes nothing. Commit it.
Before the first `--update`, give each loosening the application means a
reasoned disable comment, as `explain-security-loosening` on a binding
public by design: the first ledger records them, and each later one is the
owner's to allow. `popweb-fence debt --check`, the gate's last step, reads
the index, the commit about to be made, and fails:

- when the code holds more directives than the ledger, naming the new
  ones. Fix the code each rule reports. A directive the owner accepts goes
  in with `popweb-fence debt --update --allow-increase`, which the command
  hook asks the owner about, and which marks the raise;
- when the code holds fewer, or different ones, until `--update` records
  them, so the baseline follows the debt down and a later directive cannot
  take the freed place unnoticed;
- when the ledger counts or ignores more than HEAD's without that mark, in
  git's directory where the hook refuses an agent's write, as one restored
  from an older commit, moved into place or forged does.

`--update` never raises the count, and a deleted ledger keeps HEAD's,
however `--ledger` spells the path and whatever `GIT_DIR` names. A generated
file that turns rules off, such as Wrangler's `worker-configuration.d.ts`,
goes in the ledger's `ignore`, a list of paths and globs (`src/gen/**`);
a new entry leaves directives out, so only `--allow-increase` records it:

```json
{ "count": 0, "ignore": ["worker-configuration.d.ts"], "directives": [] }
```

`--json` prints the directives with their lines; `--ledger <path>` names another.

## Boundaries and sign-off

The hook enforces the steps it can see. `AGENTS.md`'s "Boundaries and
sign-off" lists all of them, what an agent changes alone and what needs the
owner: copy it into the application's `AGENTS.md`, add its own steps, and
keep the hook's list and the section's in step.
