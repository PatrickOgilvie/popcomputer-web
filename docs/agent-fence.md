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
command and the `@popcomputer/web/fence` entrypoint, which import only
Node's built-ins.

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
owner installs the gate, and every worktree of the repository shares it. A
team on [Lefthook](https://lefthook.dev) commits the same checks as
`lefthook.yml` instead, and runs `bunx lefthook install`:

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
| A way around the commit gate | `git commit --no-verify`, `-n`, `HUSKY=0`, `LEFTHOOK=0`, `-c core.hooksPath=...`, `lefthook uninstall`, a write into `.git/hooks/` | refuses it |
| A deploy | `wrangler deploy`, `wrangler versions deploy`, `wrangler rollback` | asks the owner |
| Remote data | `wrangler d1 migrations apply --remote`, `wrangler d1 execute --remote`, any `wrangler ... --remote` | asks the owner |
| A secret | `wrangler secret put`, `bulk` or `delete` | asks the owner |
| A release | `npm publish`, `bun publish`, `pnpm publish` | asks the owner |
| A push | `git push` | asks the owner |
| A change to the fence | `oxlint.config.ts`, `lefthook.yml`, `.githooks/`, `.claude/settings.json`, `lint-debt.json`, `popweb-fence debt --allow-increase` | asks the owner |

`wrangler deploy --dry-run`, `npm publish --dry-run`, `git push --dry-run`
and D1's local database (`--local`, the default) need no one.

The hook reads a command line as the shell would: through quotes and
escapes, `&&`, `||`, `;` and pipes, `sh -c` and `bash -lc`, `eval`,
`$(...)`, heredocs, env prefixes and `env`, `npx`, `bunx`, `pnpm exec` and
`node_modules/.bin`, the variables the line sets itself, and the
`package.json` scripts a runner names, so `bun run deploy` asks when its
script deploys. It also reads a shell script the command runs, and the
strings of a JavaScript or TypeScript one.

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

Claude Code shows a refusal's reason to the agent. It puts a question to
you in its permission prompt, auto mode included: approve the one command,
or decline it and run it yourself. In a `claude -p` run, where nobody can
answer, it refuses the command. The `Edit` and
`Write` matchers send file edits through the same policy, so an edit of
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

`failClosed` refuses a command when the hook itself fails, and until `bun
install` has run, it fails: run the first install yourself. Claude Code has
no such setting and lets the command through.

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
import { readFileSync } from 'node:fs'
import { commandPolicy, filePolicy } from '@popcomputer/web/fence'

const { scripts } = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts?: Record<string, string> }

export const beforeCommand = (command: string) => commandPolicy(command, { scripts })
export const beforeEdit = (path: string) => filePolicy(path)
```

Each returns `{ decision: 'allow' }`, or a `decision` of `'deny'` or `'ask'`
with the `rule`, the `subject` and the `reason`.

### What it cannot see

The hook reads the command line, not the system it runs on. It cannot see a
git alias or a shell alias set outside the line, a `make` or `just` target,
a program in another language, or a command a program builds at run time.
When a spelling gets past it, add the case to the policy's tests before
anything else, as the gardener rule in `AGENTS.md` says.

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
git tracks or would track. A reason follows ` -- `, as
`// oxlint-disable-next-line popcomputer-web/no-sql-interpolation -- the column names are constants`.

`popweb-fence debt --update` writes the ledger, `lint-debt.json`: each
directive without its line, so moving code changes nothing. Commit it.
`popweb-fence debt --check`, the gate's last step, then fails:

- when the code holds more directives than the ledger, naming the new
  ones. Fix the code each rule reports. A directive the owner accepts goes
  in with `popweb-fence debt --update --allow-increase`, which the command
  hook asks the owner about;
- when the code holds fewer, or different ones, until `--update` records
  them, so the baseline follows the debt down and a later directive cannot
  take the freed place unnoticed.

`--update` never raises the count, and a deleted ledger keeps the count
committed before it. A generated file that turns rules off, such as
Wrangler's `worker-configuration.d.ts`, goes in the ledger's `ignore`, a
list of paths and globs (`src/generated/**`):

```json
{ "count": 0, "ignore": ["worker-configuration.d.ts"], "directives": [] }
```

`--json` prints the directives with their lines, and `--ledger <path>` names
another ledger.

## Boundaries and sign-off

The hook enforces the steps it can see. `AGENTS.md`'s "Boundaries and
sign-off" section lists all of them: what an agent changes alone, and what
needs the owner. Copy it into the application's own `AGENTS.md`, add the
application's own steps, and keep the hook's list and the section's in
step.
