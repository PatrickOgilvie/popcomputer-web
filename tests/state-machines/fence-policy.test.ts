/**
 * Machines 60 and 61: the fence's shell reader and its policy walkers. Each
 * row is an input a real shell runs past the commit gate, or past the
 * owner, that the fence once read into `allow`. Each test asks the policy
 * for its verdict and never runs the input.
 */
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commandPolicy, filePolicy, type CommandPolicyOptions } from '../../src/fence/command-policy.js'
import { answerHook, type HookEnvironment } from '../../src/fence/hook.js'

const decision = (command: string, options: CommandPolicyOptions = {}) => commandPolicy(command, options).decision

/** A script that commits past the gate, as a program and as a shell script. */
const files: Readonly<Record<string, string>> = {
  'scripts/x.ts': 'import { execSync } from "node:child_process"\nexecSync("git commit -n -m y")\n',
  'scripts/x.sh': 'git commit -n -m y\n',
}
const readFile = (path: string) => files[path.replace(/^\.\//, '')]

describe('machine 60: the shell reader', () => {
  test('M60.T4: a `#` straight after `<(...)` is part of the word, not a comment', () => {
    expect(decision('cat <(true)#; git commit -n -m x')).toBe('deny')
  })

  test('M60.T8: a pipe from a subshell or a group into a shell', () => {
    expect(decision("(echo 'git commit -n -m x') | bash")).toBe('ask')
    expect(decision("{ echo 'git commit -n -m x'; } | bash")).toBe('ask')
  })

  test('M60.T15, M60.T20: a compound command after `!` or `time`', () => {
    for (const command of [
      'time { git commit -n -m x; }',
      '! { git commit -n -m x; }',
      'if ! { git commit -n -m x; }; then :; fi',
      'time while true; do git commit -n -m x; done',
      'time -p until false; do git commit -n -m x; done',
      '! for x in a; do git commit -n -m x; done',
      'time { HUSKY=0 git commit -m x; }',
      '! ! git commit -n -m x',
      'time ! git commit -n -m x',
      '! time { git commit -n -m x; }',
      'time time { git commit -n -m x; }',
      'echo $(time if true; then git commit -n -m x; fi)',
      `${'! '.repeat(16)}{ git commit -n -m x; }`,
    ]) {
      expect(decision(command)).toBe('deny')
    }
    for (const [command, rule] of [['time { wrangler deploy; }', 'deploy'], ['time { git push; }', 'push'], ['time { npm publish; }', 'publish']] as const) {
      expect(commandPolicy(command)).toMatchObject({ decision: 'ask', rule })
    }
    expect(commandPolicy(`${'! '.repeat(17)}{ git commit -n -m x; }`)).toMatchObject({ decision: 'ask', rule: 'unreadable' })
    // After an assignment `time` is a program, which runs a command named `{`, and `echo`'s `{` is a word.
    expect(decision('X=1 time { git commit -n -m x; }')).toBe('allow')
    expect(decision('echo { git commit -n -m x; }')).toBe('allow')
  })

  test('M60.T19: an alias of two commands', () => {
    expect(decision("shopt -s expand_aliases\nalias g='true && git commit -n -m x'\ng")).toBe('deny')
    expect(decision("alias g='git status'\ng")).toBe('ask')
  })

  test('M60.T22: `{` and `}` among the arguments are words', () => {
    expect(decision('git commit { -n -m x')).toBe('deny')
    expect(decision('git commit } -n -m x')).toBe('deny')
  })

  test('M60.T31: a brace expansion gives several words', () => {
    expect(decision('git {commit,-n} -m x')).toBe('deny')
    expect(decision('rm {README.md,lint-debt.json}')).toBe('ask')
  })

  test('M60.T32: a glob may name the command, the ledger or a hook', () => {
    expect(decision('./bin/gi? commit -n -m x')).toBe('ask')
    expect(decision('rm lint-debt.jso?')).toBe('ask')
    expect(decision("echo 'exit 0' > .git/hook?/pre-commit")).toBe('deny')
    expect(decision('rm -rf dist/*')).toBe('allow')
  })

  test('M60.T42: a command substitution inside arithmetic runs', () => {
    expect(decision('echo $(( $(git commit -n -m x) + 1 ))')).toBe('deny')
  })

  test('M60.T43: `$((` that the grammar cannot read as arithmetic', () => {
    expect(decision('echo $((git commit -n -m x) )')).toBe('ask')
  })

  test('M60.T51: a variable a builtin or a loop changed is not the value the line set', () => {
    expect(decision('X=status; read X <<< commit; git $X -n -m y')).toBe('deny')
    expect(decision('X=status; for X in commit; do git $X -n -m y; done')).toBe('deny')
    expect(decision('X=status; eval X=commit; git $X -n -m y')).toBe('deny')
  })

  test('M60.T52: a variable assigned on a branch not taken', () => {
    expect(decision('X=commit; false && X=status; git $X -n -m y')).toBe('deny')
    expect(decision('X=commit; if false; then X=status; fi; git $X -n -m y')).toBe('deny')
  })

  test('M60.T56: a `}` inside quotes does not close `${`', () => {
    expect(decision("echo ${X:-'}'}; git commit -n -m x")).toBe('deny')
    expect(decision('echo "${X:-"}"}"; git commit -n -m x')).toBe('deny')
  })

  test("M60.T58: an expansion's operator does not make its word empty", () => {
    for (const word of ['${CMD%x}', '${CMD:0}', '${!CMD}', '${CMD,,}']) expect(decision(`CMD=commit; git ${word} -n -m y`)).toBe('deny')
  })

  test("M60.T60: a default is not the variable's value", () => {
    expect(decision('read CMD <<< commit; git ${CMD:-status} -n -m x')).toBe('deny')
  })

  test('M60.T61: `${X:+word}` is word when X is set', () => {
    expect(decision('${HOME:+git} commit -n -m x')).toBe('deny')
    expect(decision('${HOME+git} commit -n -m x')).toBe('deny')
  })

  test("M60.T62: a default's command substitution runs", () => {
    expect(decision('echo ${X:-$(git commit --no-verify -m x)}')).toBe('deny')
  })

  test("M60.T62, M60.T77: a backquote or a substitution in any `${...}` operand runs", () => {
    for (const operator of [':-', ':+', ':=', '?', '#', '%', '/a/']) {
      expect(decision('echo ${X' + operator + '`git commit -n -m x`}')).toBe('deny')
      expect(decision('echo "${X' + operator + '`git commit -n -m x`}"')).toBe('deny')
    }
    expect(decision('echo ${X#$(git commit -n -m x)}')).toBe('deny')
    expect(decision('echo ${X%%$(git commit -n -m x)}')).toBe('deny')
    expect(commandPolicy('echo ${X:-`wrangler deploy`}')).toMatchObject({ decision: 'ask', rule: 'deploy' })
    expect(decision('cat <<EOF\n${X:-`git commit -n -m x`}\nEOF')).toBe('deny')
    // Escaped, the backquotes are text.
    expect(decision('echo ${X:-\\`git commit -n -m x\\`}')).toBe('allow')
  })

  test("M60.T63: a default's variable is not empty", () => {
    expect(decision('Y=git; ${X:-$Y} commit -n -m x')).toBe('deny')
  })

  test("M60.T69: `$'...'`'s \\u escapes", () => {
    expect(decision("$'\\u0067it' commit -n -m x")).toBe('deny')
    expect(decision("$'\\U00000067it' commit -n -m x")).toBe('deny')
  })

  test('M60.T72: a backquote inside a backquote, its own backquotes escaped', () => {
    const nested = (line: string) => ['echo `echo \\`' + line + '\\``', 'x=`echo \\`' + line + '\\``', 'echo "`echo \\`' + line + '\\``"']
    for (const line of ['git commit -n -m x', 'HUSKY=0 git commit -m x', 'git -c core.hooksPath=/dev/null commit -m x']) {
      for (const command of nested(line)) expect(decision(command)).toBe('deny')
    }
    for (const [line, rule] of [['wrangler deploy', 'deploy'], ['git push', 'push'], ['npm publish', 'publish']] as const) {
      for (const command of nested(line)) expect(commandPolicy(command)).toMatchObject({ decision: 'ask', rule })
    }
    // Inside double quotes, a backquote's `\"` is a quote; inside `$(...)` or a heredoc it is text.
    expect(decision('echo "`git commit \\"-n\\" -m x`"')).toBe('deny')
    expect(decision('echo `git commit \\"-n\\" -m x`')).toBe('allow')
    // zsh reads it so in arithmetic inside the quotes too, where bash keeps the backslash.
    expect(decision('echo "$((`git commit \\"-n\\" -m x` + 1))"')).toBe('deny')
    expect(decision('echo "$(echo `git commit \\"-n\\" -m x`)"')).toBe('allow')
    expect(decision('cat <<EOF\n`git commit \\"-n\\" -m x`\nEOF')).toBe('allow')
    // Each backquote counts toward the substitutions the reader follows.
    const within = (levels: number) => `${'echo $('.repeat(levels)}echo \`echo \\\`echo hi\\\`\`${')'.repeat(levels)}`
    expect(commandPolicy(within(15))).toMatchObject({ decision: 'ask', rule: 'unreadable' })
    expect(decision(within(14))).toBe('allow')
  })

  test("M60.T77: an unquoted heredoc's substitutions run", () => {
    expect(decision('cat <<EOF\n$(git commit --no-verify -m x)\nEOF')).toBe('deny')
    expect(decision('cat <<EOF\n`git commit --no-verify -m x`\nEOF')).toBe('deny')
    expect(decision('cat <<EOF\n${X:-$(git commit --no-verify -m x)}\nEOF')).toBe('deny')
    expect(decision('cat <<-EOF\n\t`git commit --no-verify -m x`\n\tEOF')).toBe('deny')
    expect(decision("cat <<'EOF'\n$(git commit --no-verify -m x)\nEOF")).toBe('allow')
  })

  test('M60.T81: `<<` inside arithmetic is a shift, not a heredoc', () => {
    expect(decision('(( x = 1 << 2 ))\ngit commit -n -m x')).toBe('deny')
    expect(decision('echo $[1<<2]\ngit commit -n -m x')).toBe('deny')
    expect(decision('for ((i=1<<2;i<0;i++)); do :; done\ngit commit -n -m x')).toBe('deny')
  })

  test("M60.T82: a heredoc whose delimiter holds an expansion", () => {
    expect(decision('cat <<$X\nhi\n$X\ngit commit -n -m x')).toBe('deny')
    expect(decision('cat <<"$X"\nhi\n$X\ngit commit -n -m x')).toBe('deny')
    expect(decision('cat <<$X\nhi\n$X')).toBe('ask')
  })

  test("M60.T86: zsh's `>!` writes the word after it", () => {
    expect(decision('echo x >! .git/hooks/pre-commit')).toBe('deny')
    expect(decision('echo x >! out.txt')).toBe('ask')
  })
})

describe('machine 61: the policy walkers', () => {
  test('M61.T3: thirteen nested wrappers, evals, envs or shells', () => {
    for (const wrapper of ['command ', 'eval ', 'env ', 'nohup ']) expect(decision(`${wrapper.repeat(13)}git commit -n -m x`)).not.toBe('allow')
    let nested = 'echo hi'
    for (let level = 0; level < 13; level++) nested = `sh -c "${nested.replace(/[\\"$`]/g, '\\$&')}"`
    expect(decision(nested)).toBe('ask')
  })

  test('M61.T4: what is too deep to read asks the owner', () => {
    expect(decision(`${'command '.repeat(13)}echo hi`)).toBe('ask')
    expect(decision(`${'command '.repeat(10)}echo hi`)).toBe('allow')
  })

  test('M61.T12: `source` of a process substitution', () => {
    expect(decision('source <(echo git commit -n -m x)')).toBe('ask')
  })

  test('M61.T16: writers of a named path the policy did not list', () => {
    expect(decision('find . -name lint-debt.json -delete')).toBe('ask')
    expect(decision('find . -name pre-commit -delete')).toBe('deny')
    expect(decision('find . -name lint-debt.json -exec rm {} +')).toBe('ask')
    expect(decision('curl -o lint-debt.json http://x')).toBe('ask')
    expect(decision('wget -O lint-debt.json http://x')).toBe('ask')
    expect(decision('tar xf a.tar lint-debt.json')).toBe('ask')
    expect(decision('unzip a.zip lint-debt.json')).toBe('ask')
    expect(decision('find . -name "*.tmp" -delete')).toBe('allow')
  })

  test('M61.T16: code that writes the paths its strings name', () => {
    for (const command of [
      `node -e 'require("fs").writeFileSync(".git/hooks/pre-commit","exit 0")'`,
      `python3 -c 'open(".git/hooks/pre-commit","w").write("exit 0")'`,
      `perl -e 'open(F, ">.git/hooks/pre-commit"); print F "exit 0"'`,
      `ruby -e 'File.write(".git/hooks/pre-commit", "exit 0")'`,
      `php -r 'file_put_contents(".git/hooks/pre-commit", "exit 0");'`,
      `awk 'BEGIN { print "exit 0" > ".git/hooks/pre-commit" }'`,
      `bun -e 'await Bun.write(".git/config", "")'`,
    ]) {
      expect(decision(command)).toBe('deny')
    }
    expect(commandPolicy(`node -e 'require("fs").writeFileSync("lint-debt.json", "{}")'`)).toMatchObject({ decision: 'ask', rule: 'fence-change' })
    const hooks = 'import { writeFileSync } from "node:fs"\nwriteFileSync(".git/hooks/pre-commit", "exit 0")\n'
    expect(decision('bun scripts/hooks.ts', { readFile: (path) => (path === 'scripts/hooks.ts' ? hooks : undefined) })).toBe('deny')
    // Reading one changes nothing.
    expect(decision(`node -e 'console.log(require("fs").readFileSync(".git/hooks/pre-commit", "utf8"))'`)).toBe('allow')
    expect(decision(`python3 -c 'print(open("lint-debt.json").read())'`)).toBe('allow')
  })

  test('M61.T16: gawk -i inplace and patch change the files they name', () => {
    expect(decision("awk -i inplace '{print}' .git/hooks/pre-commit")).toBe('deny')
    expect(commandPolicy("gawk --include=inplace -f fix.awk lint-debt.json", { readFile: () => '{ print }' })).toMatchObject({ decision: 'ask', rule: 'fence-change' })
    expect(decision("awk '{print}' .git/hooks/pre-commit")).toBe('allow')

    const patch = (path: string) => `--- a/${path}\t2026-01-01\n+++ b/${path}\n@@ -1 +1 @@\n-x\n+exit 0\n`
    const patches: Readonly<Record<string, string>> = {
      'hooks.patch': patch('.git/hooks/pre-commit'),
      'debt.patch': patch('lint-debt.json'),
      'src.patch': patch('src/app.ts'),
      'renamed.patch': 'diff --git a/x.json b/lint-debt.json\nrename from x.json\nrename to lint-debt.json\n',
      'lint-debt.json': '{}\n',
    }
    const withPatches = { readFile: (path: string) => patches[path] }
    expect(commandPolicy('patch -p1 < x.patch')).toMatchObject({ decision: 'ask', rule: 'unreadable' })
    expect(decision('patch -p1 < hooks.patch', withPatches)).toBe('deny')
    expect(commandPolicy('patch -p1 -i debt.patch', withPatches)).toMatchObject({ decision: 'ask', rule: 'fence-change' })
    expect(commandPolicy('cat debt.patch | patch -p1', withPatches)).toMatchObject({ decision: 'ask', rule: 'unreadable' })
    expect(commandPolicy('patch lint-debt.json src.patch', withPatches)).toMatchObject({ decision: 'ask', rule: 'fence-change' })
    expect(commandPolicy('patch -o lint-debt.json -i src.patch', withPatches)).toMatchObject({ decision: 'ask', rule: 'fence-change' })
    expect(decision('patch -d .git/hooks -p1 < src.patch', withPatches)).toBe('deny')
    expect(commandPolicy('patch --bogus < src.patch', withPatches)).toMatchObject({ decision: 'ask', rule: 'unreadable' })
    expect(decision('patch -p1 < src.patch', withPatches)).toBe('allow')
    // The file a patch is read from is not one it writes.
    expect(decision('patch -p1 -i lint-debt.json', withPatches)).toBe('allow')
    expect(decision('patch --dry-run -p1 < hooks.patch', withPatches)).toBe('allow')
    expect(commandPolicy('git apply renamed.patch', withPatches)).toMatchObject({ decision: 'ask', rule: 'fence-change' })
    expect(decision('git apply --directory=.git/hooks src.patch', withPatches)).toBe('deny')
    expect(decision('git apply < hooks.patch', withPatches)).toBe('deny')
    expect(decision('git apply src.patch', withPatches)).toBe('allow')
    expect(decision('git apply --stat hooks.patch', withPatches)).toBe('allow')
    expect(decision('git apply --check --apply src.patch', withPatches)).toBe('allow')
    expect(decision('git apply --check --apply hooks.patch', withPatches)).toBe('deny')
  })

  test('M61.T17: commands that run a command', () => {
    expect(decision("trap 'git commit -n -m x' EXIT")).toBe('deny')
    expect(decision('coproc git commit -n -m x')).toBe('deny')
    expect(decision('coproc NAME { git commit -n -m x; }')).toBe('deny')
  })

  test('M61.T17: commands that run the command their arguments give', () => {
    for (const command of [
      'arch -arm64 git commit -n -m x',
      'arch -arch x86_64 -e HUSKY=0 git commit -m x',
      'xcrun git commit -n -m x',
      'xcrun -sdk macosx git commit -n -m x',
      'script -q /dev/null git commit -n -m x',
      "script -qc 'git commit -n -m x' /dev/null",
      'cross-env HUSKY=0 git commit -m x',
      'npx cross-env HUSKY=0 git commit -m x',
      "cross-env-shell 'git commit -n -m x'",
      'npx dotenv -- git commit -n -m x',
      'dotenv -e .env git commit -n -m x',
      'dotenv -v HUSKY=0 -- git commit -m x',
      "npx concurrently 'git commit -n -m x'",
      "concurrently -n a,b 'bun test' 'git commit -n -m x'",
      'flock /tmp/l git commit -n -m x',
      "flock -w 5 /tmp/l -c 'git commit -n -m x'",
      "parallel ::: 'git commit -n -m x'",
      'parallel git ::: commit ::: -n',
      "parallel -j 4 ::: 'git commit -n -m x'",
      "echo 'git commit -n -m x' | parallel",
      "ssh -o ProxyCommand='git commit -n -m x' x",
      "ssh -o 'ProxyCommand git commit -n -m x' x",
      "ssh -oLocalCommand='git commit -n -m x' x",
    ]) {
      expect(decision(command)).toBe('deny')
    }
    expect(commandPolicy("concurrently 'npm:deploy'", { scripts: { deploy: 'wrangler deploy' } })).toMatchObject({ decision: 'ask', rule: 'deploy' })
    expect(commandPolicy("concurrently 'npm:watch-*'")).toMatchObject({ decision: 'ask', rule: 'unreadable' })
    expect(commandPolicy('parallel :::: commands.txt')).toMatchObject({ decision: 'ask', rule: 'unreadable' })
    expect(commandPolicy('cat commands.txt | parallel')).toMatchObject({ decision: 'ask', rule: 'unreadable' })
    expect(commandPolicy('xcrun --bogus git status')).toMatchObject({ decision: 'ask', rule: 'unreadable' })
    expect(commandPolicy('dotenv -c git status')).toMatchObject({ decision: 'ask', rule: 'unreadable' })
    expect(commandPolicy('script .git/hooks/pre-commit true')).toMatchObject({ decision: 'deny', rule: 'hook-bypass' })
    for (const command of ['xcrun -- git commit -n -m x', 'xcrun -v git commit -n -m x', 'dotenv -c prod -- git commit -n -m x']) expect(decision(command)).toBe('deny')
    // `xcrun -f` names the tool's path, and runs nothing.
    expect(decision('xcrun -f git commit -n -m x')).toBe('allow')
    for (const command of [
      'script --bogus x',
      'script -c "$CMD" /dev/null',
      'flock --bogus /tmp/l true',
      'flock /tmp/l -c "$CMD"',
      'ssh -Z host',
      "awk --bogus '{}'",
      'dotenv --bogus -- bun test',
      `parallel echo ::: ${Array.from({ length: 33 }, (_, at) => `a${at}`).join(' ')}`,
      'ssh -o ProxyCommand=./proxy.sh host',
    ]) {
      expect(commandPolicy(command)).toMatchObject({ decision: 'ask', rule: 'unreadable' })
    }
    expect(commandPolicy('script -c "$CMD" /dev/null')).toMatchObject({ reason: expect.stringContaining('a command for script that an expansion gives') })
    expect(commandPolicy('flock /tmp/l -c "$CMD"')).toMatchObject({ reason: expect.stringContaining('a command for flock that an expansion gives') })
    // What ssh runs on the host is read for the rules only: a script there is no file the fence opens here.
    for (const command of ['ssh host ./scripts/run.sh', 'ssh -o RemoteCommand=./scripts/run.sh host']) expect(decision(command)).toBe('allow')
    expect(decision(`parallel echo ::: ${Array.from({ length: 32 }, (_, at) => `a${at}`).join(' ')}`)).toBe('allow')
  })

  test("M61.T17: macOS's lockf runs the command after its lock file", () => {
    for (const command of ['lockf -k /tmp/l git commit -n -m x', 'lockf /tmp/l git commit --no-verify -m x', 'lockf -t 5 /tmp/l git commit -n -m x']) {
      expect(decision(command)).toBe('deny')
    }
    expect(commandPolicy('lockf /tmp/l wrangler deploy')).toMatchObject({ decision: 'ask', rule: 'deploy' })
    expect(commandPolicy('lockf /tmp/l git push')).toMatchObject({ decision: 'ask', rule: 'push' })
    expect(commandPolicy('lockf --bogus /tmp/l bun test')).toMatchObject({ decision: 'ask', rule: 'unreadable' })
    expect(decision('lockf -k /tmp/l bun test')).toBe('allow')
  })

  test('M61.T17: a program the fence does not know, whose arguments name a command the fence reads', () => {
    for (const command of ['gtimeout 5 git commit -n -m x', 'tool /tmp/l wrangler deploy', 'npx tool git push', 'tool git $(echo commit) -n']) {
      expect(commandPolicy(command)).toMatchObject({ decision: 'ask', rule: 'unreadable' })
    }
    for (const command of ['tool -k /tmp/l bun test', 'grep -rn git commit -n src', 'echo git push', 'man git push']) expect(decision(command)).toBe('allow')
  })

  test('M61.T17: programs whose code runs a command', () => {
    expect(decision(`awk 'BEGIN{system("git commit -n -m x")}'`)).toBe('deny')
    expect(decision(`gawk -v x=1 'BEGIN{system("git commit -n -m x")}'`)).toBe('deny')
    expect(decision(`osascript -e 'do shell script "git commit -n -m x"'`)).toBe('deny')
    expect(commandPolicy(`awk 'BEGIN{system("date")}'`)).toMatchObject({ decision: 'ask', rule: 'unreadable' })
    expect(commandPolicy(`awk -f prog.awk notes.txt`)).toMatchObject({ decision: 'ask', rule: 'unreadable' })
    expect(commandPolicy(`osascript -e 'tell app "Terminal" to do script "date"'`)).toMatchObject({ decision: 'ask', rule: 'unreadable' })
    expect(decision("awk -F, '{print $1}' notes.txt")).toBe('allow')
    expect(decision(`osascript -e 'display notification "done"'`)).toBe('allow')
  })

  test('M61.T18: runners of JavaScript and TypeScript', () => {
    for (const runner of ['tsx', 'ts-node', 'deno run', 'babel-node', 'ts-node-dev', 'ts-node-dev --respawn', 'tsnd']) expect(decision(`${runner} scripts/x.ts`, { readFile })).toBe('deny')
  })

  test('M61.T22: HUSKY set to what the fence cannot read', () => {
    expect(decision('HUSKY=$(echo 0) git commit -m x')).toBe('deny')
    expect(decision('export HUSKY=$(echo 0); git commit -m x')).toBe('deny')
  })

  test('M61.T23: GIT_CONFIG_GLOBAL and GIT_CONFIG name another config', () => {
    expect(decision('GIT_CONFIG_GLOBAL=g git commit -m x')).toBe('ask')
    expect(decision('GIT_CONFIG=g git commit -m x')).toBe('ask')
    expect(decision('GIT_DIR=elsewhere git commit -m x')).toBe('ask')
  })

  test('M61.T23: HOME and XDG_CONFIG_HOME point git at another global config', () => {
    for (const command of ['XDG_CONFIG_HOME=/tmp/x git commit -m x', 'HOME=/tmp/x git commit -m x', 'HOME=/tmp/x; git commit -m x', 'env HOME=/tmp/x git commit -m x']) {
      expect(commandPolicy(command)).toMatchObject({ decision: 'ask', rule: 'hook-bypass' })
    }
    // Empty, git reads ~/.config/git/config, as it does without it.
    expect(decision('XDG_CONFIG_HOME= git commit -m x')).toBe('allow')
  })

  test("M61.T26: a wrapper's option the fence does not read", () => {
    expect(decision('sudo -iu root git commit -m x')).toBe('ask')
    expect(decision('sudo -u root git commit -n -m x')).toBe('deny')
  })

  test('M61.T30: xargs reads every line of its input', () => {
    expect(decision("printf 'commit\\n-n\\n-m\\nx\\n' | xargs git")).toBe('deny')
  })

  test("M61.T31: xargs -I puts each input line in the command", () => {
    expect(decision("echo git commit -n -m x | xargs -I{} sh -c '{}'")).toBe('deny')
    expect(decision("git ls-files | xargs -I{} sh -c '{}'")).toBe('ask')
  })

  test("M61.T34: env -S's assignments", () => {
    expect(decision("env -S 'HUSKY=0 git commit -m x'")).toBe('ask')
  })

  test('M61.T36: env -S in a cluster', () => {
    expect(decision("env -vS 'git commit -n -m x'")).toBe('ask')
  })

  test("M61.T43: a shell's long option that takes the script", () => {
    expect(decision("fish --command 'git commit -n -m x'")).toBe('deny')
    expect(decision("fish -c 'git commit -n -m x'")).toBe('deny')
  })

  test('M61.T47: a script string the fence cannot read', () => {
    expect(decision('bash -c "$(echo git commit -n -m x)"')).toBe('ask')
    // eval reads its string again, so the substitution's words may be `git commit -n`.
    expect(decision('eval "$(echo git commit -n -m x)"')).toBe('deny')
    expect(decision('eval "$(echo status)"')).not.toBe('allow')
  })

  test("M61.T49: `-s` reads the script from input, its arguments are the script's", () => {
    expect(decision("bash -s -- arg <<< 'git commit -n -m x'")).toBe('deny')
    expect(decision("bash -s arg <<< 'git commit -n -m x'")).toBe('deny')
  })

  test('M61.T51: a process substitution as the script', () => {
    expect(decision('bash <(echo git commit -n -m x)')).toBe('ask')
  })

  test('M61.T55: inline code in a cluster or as `--eval=`', () => {
    expect(decision(`perl -we 'system("git commit -n -m x")'`)).toBe('deny')
    expect(decision(`ruby -we 'system("git commit -n -m x")'`)).toBe('deny')
    expect(decision(`node -pe 'require("child_process").execSync("git commit -n -m x")'`)).toBe('deny')
    expect(decision(`node --eval='require("child_process").execSync("git commit -n -m x")'`)).toBe('deny')
    expect(decision(`bun -pe 'require("child_process").execSync("git commit -n -m x")'`)).toBe('deny')
    expect(decision(`bun --eval='require("child_process").execSync("git commit -n -m x")'`)).toBe('deny')
    expect(decision(`python3 -Bc 'import os; os.system("git commit -n -m x")'`)).toBe('deny')
  })

  test('M48: the ledger written from another commit, into the index, or by git from a patch', () => {
    for (const command of [
      'git apply x.patch',
      'git apply --cached x.patch',
      'git update-index --cacheinfo 100644,abc,lint-debt.json',
      'git update-index --cacheinfo 100644 abc lint-debt.json',
      'git update-index --force-remove lint-debt.json',
      'git update-index --index-info < entries.txt',
      'git checkout HEAD~1 -- .',
      'git checkout HEAD~1 .',
      'git checkout main -- "*.json"',
      'git checkout HEAD~1 -- :/',
      'git restore -s HEAD~1 -- .',
      'git restore --source=main .',
      'git restore --source main -- .',
      'git reset HEAD~1 -- lint-debt.json',
      'git reset main -- .',
      'git reset --hard HEAD~1',
      'git reset --keep HEAD~1',
      'git read-tree HEAD~1',
      'git checkout-index -f lint-debt.json',
      'git checkout-index -a --prefix=.githooks/',
    ]) {
      expect(decision(command)).not.toBe('allow')
    }
    expect(decision('git checkout-index -a --prefix=.git/hooks/')).toBe('deny')
    expect(commandPolicy('git update-index --index-info <<EOF\n100644 abc\tlint-debt.json\nEOF')).toMatchObject({ decision: 'ask', rule: 'fence-change' })
    // A pathspec the fence cannot place covers the whole tree; a glob covers what it matches.
    for (const command of [
      'git checkout HEAD~1 -- "$DIR"',
      'git checkout HEAD~1 -- $DIR',
      'cd "$X" && git checkout HEAD~1 -- src',
      'git checkout HEAD~1 -- ..',
      'git checkout HEAD~1 -- /repo',
      'git checkout main -- *.json',
      'git checkout main -- "lint-debt.jso?"',
      'git checkout main -- lint-debt.jso?',
    ]) {
      expect(commandPolicy(command)).toMatchObject({ decision: 'ask', rule: 'fence-change' })
    }
    // From the index or HEAD, whose ledger is the one the gate holds the count to; a switch of branch; or no change.
    for (const command of [
      'git checkout -- .',
      'git checkout HEAD -- .',
      'git restore .',
      'git restore --staged .',
      'git reset --hard',
      'git reset --hard HEAD',
      'git reset --soft HEAD~1',
      'git reset HEAD~1',
      'git checkout main',
      'git checkout main -- src',
      'git checkout -- src/app.ts',
      'git -C app checkout HEAD~1 -- .',
      'git read-tree -n HEAD~1',
      'git checkout-index -a',
      'git checkout-index --prefix=.git/hooks/',
      'git update-index --stdin <<< src/app.ts',
      'git checkout main -- "src/*.ts"',
      'git checkout main -- "?.ts"',
    ]) {
      expect(decision(command)).toBe('allow')
    }
  })

  test("M61.T58, M48.T8: the fence's own CLI by another path", () => {
    expect(decision('bun src/fence/cli.ts debt --update --allow-increase')).toBe('ask')
    expect(decision('node dist/fence/cli.js debt --update --allow-increase')).toBe('ask')
  })

  test('M48.T9: raising the ledger with the flag in a substitution asks, as the flag itself does', () => {
    expect(decision('popweb-fence debt --update $(echo --allow-increase)')).toBe('ask')
    expect(decision('bunx popweb-fence debt --update "$(printf -- --allow-increase)"')).toBe('ask')
  })

  test('M61.T60 (a stated limit): code that names a process call asks, however it builds the command', () => {
    expect(decision(`node -e 'require("child_process").execSync("git com" + "mit -n -m x")'`)).toBe('ask')
    expect(decision(`node -e 'console.log("git com" + "mit")'`)).toBe('allow')
  })

  test('M61.T61: a backquote in a comment does not swallow the strings after it', () => {
    expect(decision('node -e \'// a `\nrequire("child_process").execSync("git commit -n -m x")\n// `\'')).toBe('deny')
  })

  test('M61.T66: a script over the size limit', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fence-'))
    try {
      writeFileSync(join(directory, 'big.sh'), `git commit -n -m y\n${'# padding\n'.repeat(30_000)}`)
      writeFileSync(join(directory, 'small.sh'), 'echo hi\n')
      const hook = (command: string) => spawnSync('bun', [join(import.meta.dir, '..', '..', 'src', 'fence', 'cli.ts'), 'hook'], { cwd: directory, input: command, encoding: 'utf8' })

      expect(hook('sh big.sh').status).toBe(2)
      expect(hook('sh missing.sh').status).toBe(2)
      expect(hook('sh small.sh').status).toBe(0)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('M61.T67: a relative path after `cd`', () => {
    const environment: HookEnvironment = { cwd: '/app', readFile: (path) => ({ '/app/scripts/x.sh': 'git commit -n -m y\n' })[path] }
    expect(answerHook('cd scripts && sh x.sh', environment).exitCode).toBe(2)
    expect(decision('cd scripts && sh x.sh', { readFile })).toBe('deny')
  })

  test("M61.T72: a runner's value option the fence does not know", () => {
    expect(decision('npx --cache /tmp/c wrangler deploy')).toBe('ask')
    expect(decision('npx --some-option /tmp/c git commit -n')).toBe('ask')
  })

  test("M61.T83: another directory's package.json", () => {
    const manifests: Readonly<Record<string, string>> = {
      '/app/package.json': JSON.stringify({ scripts: { build: 'tsc' } }),
      '/app/app/package.json': JSON.stringify({ scripts: { deploy: 'wrangler deploy' } }),
    }
    const environment: HookEnvironment = { cwd: '/app', readFile: (path) => manifests[path] }

    for (const command of ['cd app && bun run deploy', 'bun --cwd app run deploy', 'npm --prefix app run deploy', 'pnpm -C app run deploy']) {
      expect(answerHook(command, environment).exitCode).toBe(2)
    }
    expect(answerHook('cd app && bun run build', environment).exitCode).toBe(0)
  })

  test('M61.T88: an alias `-c` sets, with the arguments at its use', () => {
    expect(decision('git -c alias.x=commit x -n -m y')).toBe('deny')
    expect(decision("git -c 'alias.x=!git commit' x -n -m y")).toBe('deny')
  })

  test('M61.T88: an alias `git config` sets on the line, and one the fence cannot see', () => {
    for (const command of [
      'git config alias.x commit && git x -n -m y',
      'git config --global alias.x "commit -a" && git x -n -m y',
      "git config alias.x '!git commit' && git x -n -m y",
      'git config set alias.X commit; git x -n -m y',
    ]) {
      expect(decision(command)).toBe('deny')
    }
    // `-n` is commit's way past the hooks, so a command git does not have, which may be an alias of commit's, asks.
    for (const command of ['git ci -n -m y', 'git ci -anm y', 'git Commit -n -m y']) expect(commandPolicy(command)).toMatchObject({ decision: 'ask', rule: 'unreadable' })
    // An alias never shadows git's own command; an unset one is gone.
    expect(decision('git config alias.log commit && git log -n 5')).toBe('allow')
    expect(commandPolicy('git config --unset alias.x commit && git x -n -m y')).toMatchObject({ decision: 'ask', rule: 'unreadable' })
    expect(decision('git ci -m y')).toBe('allow')
  })

  test('M61.T89: `-c include.path`', () => {
    expect(decision('git -c include.path=g commit -m x')).toBe('ask')
    expect(decision('git -c core.fsmonitor=x status')).toBe('ask')
    expect(decision('git -c color.ui=never status')).toBe('allow')
  })

  test('M61.T99: commands that commit without the pre-commit hook', () => {
    for (const command of ['git pull --ff-only ../other HEAD', 'git cherry-pick FETCH_HEAD', 'git revert HEAD', 'git merge feature', 'git am patch', 'git rebase main']) {
      expect(decision(command)).toBe('ask')
    }
    for (const command of ['git merge --abort', 'git cherry-pick -n FETCH_HEAD', 'git rebase --abort', 'git merge-base HEAD main']) expect(decision(command)).toBe('allow')
  })

  test('M61.T99: a merge fast-forwards whenever it can, `--no-commit` or not', () => {
    for (const command of [
      'git merge --no-commit feature',
      'git merge --no-commit --ff-only feature',
      'git merge --no-commit --ff feature',
      'git merge --no-ff --no-commit --ff feature',
      'git merge --no-ff --no-commit --commit feature',
      'git merge --no-f --no-commit feature',
      'git merge --abort --no-abort feature',
    ]) {
      expect(commandPolicy(command)).toMatchObject({ decision: 'ask', rule: 'hook-bypass' })
    }
    for (const command of ['git merge --no-ff --no-commit feature', 'git merge --no-commit --no-ff feature']) expect(decision(command)).toBe('allow')
  })

  test('M61.T99: a cherry-pick or revert commits when the last of `-n`, `--no-commit` and `--commit` is `--commit`', () => {
    for (const command of [
      'git cherry-pick -n --commit feature',
      'git cherry-pick --no-commit --commit feature',
      'git cherry-pick -n --no-no-commit feature',
      'git revert -n --commit HEAD',
      'git revert --no-commit --commit HEAD',
      'git cherry-pick -n --comm feature',
    ]) {
      expect(commandPolicy(command)).toMatchObject({ decision: 'ask', rule: 'hook-bypass' })
    }
    for (const command of ['git cherry-pick --commit -n feature', 'git revert --no-commit HEAD', 'git cherry-pick -n -X --commit feature']) expect(decision(command)).toBe('allow')
  })

  test('M61.T99: commands that move a branch to commits this gate never checked', () => {
    for (const command of [
      'git fetch ../other main && git reset --hard FETCH_HEAD',
      'git reset --soft origin/main',
      'git reset FETCH_HEAD',
      'git reset abc1234',
      'git reset HEAD@{1}',
      'git reset --soft main',
      'git reset --hard FETCH_HEAD --',
      'git update-ref refs/heads/main FETCH_HEAD',
      'git update-ref -m sync HEAD abc1234',
      'git update-ref --stdin < refs.txt',
      'git branch -f main FETCH_HEAD',
      'git branch --force main',
      'git branch -M feature main',
      'git branch -C feature main',
      'git switch -C main FETCH_HEAD',
      'git switch --force-create main',
      'git checkout -B main --track origin/main',
      'git -C ../other commit -m x',
      'cd .. && git commit -m x',
    ]) {
      expect(commandPolicy(command)).toMatchObject({ decision: 'ask', rule: 'hook-bypass' })
    }
    for (const command of [
      'git reset --soft HEAD~1',
      'git reset HEAD^',
      'git reset --mixed @~2',
      'git reset --soft ORIG_HEAD',
      'git reset -- src/app.ts',
      'git reset src/app.ts',
      'git reset --soft origin/main -- src',
      'git update-ref -d refs/heads/old abc1234',
      'git update-ref refs/heads/main',
      'git branch -f',
      'git branch feature',
      'git branch -D old',
      'git branch -m old new',
      'git switch -c feature origin/feature',
      'git checkout -b feature',
      'git -C app commit -m x',
      'cd app && git commit -m x',
    ]) {
      expect(decision(command)).toBe('allow')
    }
  })

  test('M61.T100: `send-pack` pushes', () => {
    expect(commandPolicy('git send-pack ../remote main')).toMatchObject({ decision: 'ask', rule: 'push' })
    expect(decision('git send-pack --dry-run ../remote main')).toBe('allow')
  })

  test('M61.T101: git commands that change a named path', () => {
    for (const command of ['git rm lint-debt.json', 'git checkout HEAD~1 -- lint-debt.json', 'git restore --source=HEAD~1 lint-debt.json', 'git mv -f o.json lint-debt.json']) {
      expect(decision(command)).toBe('ask')
    }
    expect(decision('git -C app rm lint-debt.json')).toBe('ask')
    expect(decision('git rm src/old.ts')).toBe('allow')
  })

  test("M61.T113: removing or renaming the core section", () => {
    expect(decision('git config --remove-section core')).toBe('deny')
    expect(decision('git config --rename-section core foo')).toBe('deny')
    expect(decision('git config remove-section core')).toBe('deny')
    expect(decision('git config --remove-section alias')).toBe('allow')
  })

  test("M61.T116: a value option of wrangler's the fence does not know", () => {
    expect(decision('wrangler --name foo deploy')).toBe('ask')
    expect(decision('wrangler --unknown-option foo deploy')).toBe('ask')
    expect(decision('wrangler --unknown-option foo dev')).toBe('allow')
  })

  test('M61.T121: `echo`\'s options come first only', () => {
    expect(decision('echo git commit -n -m x | bash')).toBe('deny')
    expect(decision('echo commit -n -m x | xargs git')).toBe('deny')
  })

  test("M61.T122: `echo -e`'s escapes", () => {
    expect(decision("echo -e 'git commit \\x2dn -m x' | bash")).toBe('ask')
  })

  test("M61.T124: printf's other formats and escapes", () => {
    expect(decision("printf 'git commit \\x2dn -m x' | bash")).toBe('ask')
    expect(decision("printf '%.3s commit -n -m x' github | bash")).toBe('ask')
    expect(decision("printf '%s %s\\n' git status | bash")).toBe('allow')
  })

  test('M61.T126: `cat` of a file into a shell', () => {
    expect(decision("echo 'git commit -n -m x' > s.sh; cat s.sh | bash")).toBe('ask')
  })

  test('M61.T127: a pipeline of three into a shell', () => {
    expect(decision("echo 'git commit -n -m x' | cat | bash")).toBe('deny')
    expect(decision("echo 'git commit -n -m x' | tr a a | bash")).toBe('ask')
  })

  test("M61.T131: a substitution where wrangler's command goes", () => {
    expect(commandPolicy('wrangler $(echo deploy)')).toMatchObject({ decision: 'ask', rule: 'deploy' })
  })

  test('M61.T134: a path with `.`, `//` or another case', () => {
    for (const path of ['.git/./hooks/pre-commit', '.git//hooks/pre-commit', '.GIT/hooks/pre-commit', '.git/x/../hooks/pre-commit']) expect(filePolicy(path).decision).toBe('deny')
    expect(filePolicy('LINT-DEBT.json').decision).toBe('ask')
  })

  test('M61.T135: a path relative to a `cd` on the line', () => {
    expect(decision('cd .git/hooks && echo x > pre-commit')).toBe('deny')
    expect(decision('cd .git && echo x > hooks/pre-commit')).toBe('deny')
    expect(decision('cd "$DIR" && echo x > pre-commit')).toBe('ask')
    expect(decision('(cd .git/hooks); echo x > pre-commit')).toBe('allow')
  })

  test('M61.T134: a link to a protected path, or to a directory above one, changes it', () => {
    for (const command of [
      "ln -s .git/hooks h && echo 'exit 0' > h/pre-commit",
      "ln -s .git/hooks/pre-commit x; echo 'exit 0' > x",
      'ln -s .git g',
      'ln -sf ../.git/config sub/c',
      'ln .git/hooks/pre-commit x',
      'ln -s .git/hooks',
      'ln -s /repo/.git/hooks h',
      'ln -s -t links .git/hooks',
      'ln -s "$ROOT/.git" g',
      'cp -s .git/hooks/pre-commit x',
      'cp -al .git/hooks h',
      'cp --link .git/config c',
      'ln -s ~/.gitconfig g',
      'ln -s ../app/node_modules/@popcomputer/web/dist w',
    ]) {
      expect(decision(command)).toBe('deny')
    }
    expect(commandPolicy('ln -s lint-debt.json debt.json')).toMatchObject({ decision: 'ask', rule: 'fence-change' })
    expect(commandPolicy('ln -s .githooks h')).toMatchObject({ decision: 'ask', rule: 'fence-change' })
    // A path through `.` still names the files below it; a copy is no link.
    for (const command of [
      'ln -s ../shared/config.ts src/config.ts',
      'ln -s . self',
      'ln -s /repo/node_modules node_modules',
      'ln -s ../app/node_modules nm',
      'cp .git/hooks/pre-commit /tmp/pre-commit',
      'cp -a .git/hooks /tmp/hooks',
    ]) {
      expect(decision(command)).toBe('allow')
    }
  })

  test('M48 (a stated limit): `git stash pop` brings back files the fence cannot list, so it runs; the gate refuses a raised ledger it brings back', () => {
    expect(decision('git stash pop')).toBe('allow')
    expect(decision('git stash apply stash@{1}')).toBe('allow')
  })

  test("M48.T26: the mark `--allow-increase` leaves in git's directory, which the gate trusts a raised ledger by", () => {
    expect(decision("echo '{}' > .git/popweb-fence/lint-debt.json.json")).toBe('deny')
    expect(decision('cp lint-debt.json .git/popweb-fence/lint-debt.json.json')).toBe('deny')
    expect(filePolicy('/repo/.git/worktrees/app/popweb-fence/lint-debt.json.json').decision).toBe('deny')
    expect(decision('cat .git/popweb-fence/lint-debt.json.json')).toBe('allow')
  })

  test("M61.T136: git's config, where core.hooksPath lives", () => {
    expect(decision("printf '' > .git/config")).toBe('deny')
    expect(decision('rm .git/config')).toBe('deny')
    expect(filePolicy('/repo/.git/config').decision).toBe('deny')
  })
})
