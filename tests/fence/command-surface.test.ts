/**
 * Command Policy Surface Tests
 *
 * Each walker of the command policy, option by option: the wrappers, shells
 * and interpreters, the package managers, git's dangerous surface, wrangler,
 * the commands that write a named path, and what a pipe hands a shell. Each
 * row is a command line and the verdict it gets; nothing runs.
 */

import { describe, expect, test } from 'bun:test'
import { commandPolicy, type CommandPolicyOptions, type FenceRule } from '../../src/fence/command-policy.js'
import { isDynamic } from '../../src/fence/shell.js'

type Verdict = 'allow' | readonly ['ask' | 'deny', FenceRule]

const files: Readonly<Record<string, string>> = {
  'scripts/commit.sh': 'git commit -n -m y\n',
  'scripts/status.sh': 'git status\n',
  'scripts/commit.py': 'import os\nos.system("git commit -n -m y")\n',
  'scripts/commit.pl': 'system("git commit -n -m y");\n',
  'scripts/commit.rb': 'system("git commit -n -m y")\n',
  'scripts/commit.php': '<?php exec("git commit -n -m y");\n',
  'scripts/message.ts': 'const message = `wrangler ${command} is next`\nconsole.log(message)\n',
  'scripts/plain.js': 'console.log("hi")\n',
  'scripts/tool': '#!/usr/bin/env node\nrequire("child_process").execSync("git commit -n -m y")\n',
  'scripts/hello': 'echo hello\n',
  'server.js': 'console.log("serving")\n',
  'tool.ts': 'require("child_process").execSync("git commit -n -m y")\n',
  'scripts/hint.ts': 'console.log(`git "${sub}" origin`)\nconsole.log(`${tool} is ready`)\n',
  'scripts/runs.ts': 'execSync("sh scripts/deploys.sh")\n',
  'scripts/deploys.sh': 'wrangler $(echo deploy)\n',
  'testing/package.json': JSON.stringify({ scripts: { test: 'wrangler deploy' } }),
  'app/package.json': JSON.stringify({ scripts: { deploy: 'wrangler deploy', test: 'bun test' } }),
  'bad/package.json': '{ not json',
  'array/package.json': JSON.stringify({ scripts: ['wrangler deploy'] }),
  'deeper/app/package.json': JSON.stringify({ name: 'no scripts' }),
}
const scripts = { deploy: 'wrangler deploy', build: 'tsc', test: 'bun test', start: 'node server.js', stop: 'wrangler delete', loop: 'npm run loop' }
const options: CommandPolicyOptions = { scripts, readFile: (path) => files[path.replace(/^\.\//, '')] }

const verdict = (command: string): Verdict => {
  const answer = commandPolicy(command, options)
  return answer.decision === 'allow' ? 'allow' : [answer.decision, answer.rule]
}

const table = (rows: ReadonlyArray<readonly [string, Verdict]>) =>
  test.each(rows)('%p is %p', (command, expected) => {
    expect(verdict(command)).toEqual(expected)
  })

const bypass = ['deny', 'hook-bypass'] as const
const unreadable = ['ask', 'unreadable'] as const
const fence = ['ask', 'fence-change'] as const
const deploy = ['ask', 'deploy'] as const
const remote = ['ask', 'remote-data'] as const
const secret = ['ask', 'secret'] as const
const push = ['ask', 'push'] as const
const unchecked = ['ask', 'hook-bypass'] as const

describe('wrappers unwrap only through the options they read', () => {
  table([
    ['nice -10 git commit -n', bypass],
    ['nice -n', unreadable],
    ['nice --adjustment=5 git commit -n', bypass],
    ['sudo --preserve-env=PATH git commit -n', bypass],
    ['sudo --user root git commit -n', bypass],
    ['sudo --user', unreadable],
    ['sudo --bogus git status', unreadable],
    ['sudo "$OPTIONS" git status', unreadable],
    ['sudo -E HUSKY=0 git commit', bypass],
    ['sudo HUSKY=0', bypass],
    [`${'command '.repeat(12)}git commit -n`, bypass],
    ['timeout --signal KILL 5 git commit -n', bypass],
    ['timeout -s KILL 5 git commit -n', bypass],
    ['timeout 5', 'allow'],
    ['time -p git commit -n', bypass],
    ['exec -a name git commit -n', bypass],
    ['command -p git commit -n', bypass],
    ['command -v git', 'allow'],
    ['command -V git', 'allow'],
    ['nohup -- git commit -n', bypass],
    ['repeat 3 git commit -n', bypass],
    ['env - HUSKY=0 git commit', bypass],
    ['env -u HOME git commit -n', bypass],
    ['env --unset=HOME git commit -n', bypass],
    ['env -C app git status', unreadable],
    ['env FOO=bar', 'allow'],
    ['coproc NAME { git commit -n; }', bypass],
    ['coproc { git commit -n; }', bypass],
  ])
})

describe('eval, trap, su and watch read their strings as command lines', () => {
  table([
    ['eval git commit -n', bypass],
    // eval reads its string again, so an unquoted reading of it may be `git commit -n`.
    ['eval "$CMD"', bypass],
    ['eval "git status"', 'allow'],
    ['eval echo "$X"', unreadable],
    ['trap "git commit -n" EXIT', bypass],
    ['trap -- "git commit -n" EXIT', bypass],
    ['trap "$CMD" EXIT', bypass],
    ['trap - EXIT', 'allow'],
    ['trap -p', 'allow'],
    ['trap INT', 'allow'],
    // One word is a signal to reset, not a command.
    ["trap 'git commit -n'", 'allow'],
    ['su root -c "git commit -n"', bypass],
    ['su root --command="git commit -n"', bypass],
    ['su root --command "git commit -n"', bypass],
    ['su root -c "$CMD"', bypass],
    ['su root -c', 'allow'],
    ['su root', 'allow'],
    ['watch "git commit -n"', bypass],
    ['watch -n 5 git status', 'allow'],
  ])
})

describe('aliases', () => {
  table([
    ['alias', 'allow'],
    ['alias -p', 'allow'],
    ['alias g="git status"', unreadable],
    ['alias g="$CMD"; g', unreadable],
    ['shopt -s expand_aliases', unreadable],
    ['shopt -s nullglob', 'allow'],
    ['bash -O expand_aliases -c "ls"', unreadable],
    ['bash -o expand_aliases -c "ls"', unreadable],
  ])
})

describe('shells: the string `-c` gives, the script they read, or the file they run', () => {
  table([
    ['bash -c "git commit -n"', bypass],
    ['bash -c "echo hi"', 'allow'],
    ['fish -c "echo hi" arg', 'allow'],
    ['bash -lc "git commit -n" name arg', bypass],
    ['bash -c', 'allow'],
    ['bash +o pipefail -c "git commit -n"', bypass],
    ['bash +x -c "git commit -n"', bypass],
    ['bash -n scripts/commit.sh', 'allow'],
    ['bash scripts/commit.sh', bypass],
    ['bash -- scripts/commit.sh', bypass],
    ['bash scripts/status.sh', 'allow'],
    ['bash scripts/missing.sh', unreadable],
    ['bash -', 'allow'],
    ['bash', 'allow'],
    ['bash --rcfile x.sh -c "git commit -n"', bypass],
    ['bash --bogus x', unreadable],
    ['bash < scripts/commit.sh', bypass],
    ['bash 3< scripts/commit.sh', 'allow'],
    ['bash < scripts/missing.sh', unreadable],
    ['fish -c "git commit -n"', bypass],
    ['fish -C "git commit -n"', bypass],
    ['fish --init-command "git commit -n"', bypass],
    ['fish -n scripts/commit.sh', bypass],
    ['source scripts/commit.sh', bypass],
    ['. scripts/commit.sh', bypass],
    ['source', 'allow'],
    ['source "$FILE"', unreadable],
    ['source node_modules/x/setup.sh', 'allow'],
    ['./scripts/hello', 'allow'],
    ['./scripts/tool', bypass],
    ['scripts/commit.sh', bypass],
    ['commit.sh', unreadable],
    ['"$DIR"/node_modules/.bin/tsc', 'allow'],
    ['"$DIR"/bin/tool', unreadable],
    ['"$DIR"/git commit -n', bypass],
    ['"$DIR"/wrangler deploy', deploy],
    ['"$X" status', unreadable],
    ['* -n -m x', bypass],
  ])
})

describe('interpreters: inline code, a file, a module, or their input', () => {
  table([
    ['node -- scripts/tool', bypass],
    ['node - < scripts/tool', bypass],
    ['node scripts/plain.js', 'allow'],
    ['node -r tsx scripts/plain.js', 'allow'],
    ['node --require tsx scripts/plain.js', 'allow'],
    ['node --run deploy', deploy],
    ['node --run=deploy', deploy],
    ['node -e "$CODE"', unreadable],
    ['node -e "console.log(1)"', 'allow'],
    ['node -e "console.log(1)" scripts/missing.js', 'allow'],
    ['python3 -m tool < scripts/commit.py', 'allow'],
    ['python3 -i lint-debt.json', unreadable],
    ['ruby -i.bak -e 1 lint-debt.json', fence],
    ['bun scripts/hint.ts', 'allow'],
    ['bun scripts/runs.ts', deploy],
    ['bun run tool.ts', bypass],
    ['node -c scripts/plain.js', 'allow'],
    ['node "$FILE"', unreadable],
    ['echo "require(\'child_process\')" | node', unreadable],
    ['tsx scripts/plain.js', 'allow'],
    ['python3 -m http.server', 'allow'],
    ['python3 scripts/commit.py', bypass],
    ['python3 -W ignore scripts/commit.py', bypass],
    ['python3 -c "print(1)" scripts/commit.py', 'allow'],
    // python's -c ends its options: the words after it are the code's arguments.
    [`python3 -c "print(1)" -c 'import os; os.system("git commit -n")'`, 'allow'],
    ["echo 'console.log(1)' | node - scripts/missing.js", 'allow'],
    ['perl -i.e scripts/commit.pl', bypass],
    [`perl -e'system("git commit -n")'`, bypass],
    ['python3.12 -c "import os; os.system(\'git commit -n\')"', bypass],
    ['perl scripts/commit.pl', bypass],
    ['perl -I lib scripts/commit.pl', bypass],
    ['perl -Ilib scripts/commit.pl', bypass],
    ['perl -i.bak -e "s/a/b/" oxlint.config.ts', fence],
    ['ruby scripts/commit.rb', bypass],
    ['ruby -I lib scripts/commit.rb', bypass],
    ['php scripts/commit.php', bypass],
    ['php -f scripts/commit.php', bypass],
    ['php -fscripts/commit.php', bypass],
    ['php -d x=1 scripts/commit.php', bypass],
    ['php -r "exec(\'git commit -n\');"', bypass],
    ['bun scripts/message.ts', 'allow'],
    ['bun -e "$CODE"', unreadable],
    ['bun --cwd app -e "require(\'child_process\').execSync(\'git commit -n\')"', bypass],
    ['deno eval "console.log(1)"', 'allow'],
    ['deno eval "$CODE"', unreadable],
    ['deno eval', 'allow'],
    ['deno task deploy', unreadable],
    ['deno scripts/tool.ts', unreadable],
    ['deno run', 'allow'],
    ['deno fmt', 'allow'],
    ['yarn node -e "require(\'child_process\').execSync(\'git commit -n\')"', bypass],
  ])
})

describe('package managers: scripts, runners and publishing', () => {
  table([
    ['npm test', 'allow'],
    ['npm start', 'allow'],
    ['npm stop', ['ask', 'deploy']],
    ['npm run loop', 'allow'],
    ['npm --prefix app run deploy', deploy],
    ['npm --prefix=app test', 'allow'],
    ['npm --prefix "$DIR" run deploy', deploy],
    ['cd "$DIR" && npm run build', unreadable],
    ['npm run', 'allow'],
    ['npm exec -- wrangler deploy', deploy],
    ['npm x wrangler deploy', deploy],
    ['npm publish', ['ask', 'publish']],
    ['npm -- run deploy', deploy],
    ['bun run --cwd app deploy', deploy],
    ['bun --cwd bad run deploy', 'allow'],
    ['bun --cwd array run deploy', 'allow'],
    ['bun --cwd deeper/app run deploy', 'allow'],
    ['bun run "$SCRIPT"', deploy],
    ['bun run "$SCRIPT" --x', deploy],
    ['bun run scripts/tool', bypass],
    ['bun run', 'allow'],
    ['bun x wrangler deploy', deploy],
    ['bun publish', ['ask', 'publish']],
    ['bun test', 'allow'],
    ['bun', 'allow'],
    ['pnpm deploy', 'allow'],
    ['pnpm dlx wrangler deploy', deploy],
    ['pnpm exec -- git commit -n', bypass],
    ['pnpm publish', ['ask', 'publish']],
    ['pnpm run deploy', deploy],
    ['pnpm -C app run deploy', deploy],
    ['pnpm t', 'allow'],
    ['pnpm -C testing t', deploy],
    ['cd "$X" && npm test', unreadable],
    ['yarn add publish', 'allow'],
    ['pnpm stop', deploy],
    ['pnpm run', 'allow'],
    ['pnpm', 'allow'],
    ['yarn dlx wrangler deploy', deploy],
    ['yarn exec git commit -n', bypass],
    ['yarn publish', ['ask', 'publish']],
    ['yarn npm publish', ['ask', 'publish']],
    ['yarn npm info', 'allow'],
    ['yarn run deploy', deploy],
    ['yarn run', 'allow'],
    ['yarn add x', 'allow'],
    ['yarn', 'allow'],
    ['yarn --cwd app deploy', deploy],
    ['npx -c "git commit -n"', bypass],
    ['npx --call="git commit -n"', bypass],
    ['npx -c "$CMD"', unreadable],
    ['pnpx --shell-mode "git commit -n"', bypass],
    ['npx -p wrangler wrangler deploy', deploy],
    ['npx --bogus wrangler deploy', unreadable],
    ['npx', 'allow'],
    ['npx "$BIN" deploy', deploy],
    ['npx "$BIN"', unreadable],
  ])
})

describe("git's dangerous surface", () => {
  table([
    ['git --exec-path', 'allow'],
    ['git --exec-path=/tmp/git status', unchecked],
    ['git --git-dir elsewhere status', unchecked],
    ['git --work-tree=elsewhere status', unchecked],
    ['git -C "$DIR" rm lint-debt.json', fence],
    ['git -C "$DIR" rm notes.txt', unreadable],
    ['git -C .git rm config', bypass],
    ['git --config-env=core.hooksPath=X commit', bypass],
    ['git --config-env=alias.ci=X ci', unreadable],
    ['git -c "$SETTING" status', bypass],
    ['git -c user.name=x commit -m y', 'allow'],
    ['git -c alias.ci=commit status', 'allow'],
    ["git -c 'alias.ci=commit -n' status", 'allow'],
    ['git -c "alias.ci=$CMD" ci', unreadable],
    ['git push -n', 'allow'],
    ['git send-pack -n ../remote', push],
    ['git rebase --exec "git commit -n" main', bypass],
    ['git rebase --exec="git commit -n" main', bypass],
    ['git rebase --continue', unchecked],
    ['git bisect run git commit -n', bypass],
    ['git bisect start', 'allow'],
    ['git submodule foreach git commit -n', bypass],
    ['git submodule update', 'allow'],
    ['git am --abort', 'allow'],
    ['git revert --no-commit HEAD', 'allow'],
    ['git restore -s HEAD~1 lint-debt.json', fence],
    ['git clean -e lint-debt.json', 'allow'],
    ['git clean -f lint-debt.json', fence],
    ['git config --edit', unchecked],
    ['git config -e', unchecked],
    ['git config edit', unchecked],
    ['git config "$KEY" value', bypass],
    ['git config alias.ci', 'allow'],
    ['git config alias.ci "commit -n"', bypass],
    ['git config include.path other.config', unchecked],
    ['git config core.fsmonitor "sh -c x"', unchecked],
    ['git config --unset core.pager', 'allow'],
    ['git config user.name x', 'allow'],
    ['git config --add core.hooksPath x', bypass],
    ['git config --unset-all core.hooksPath', bypass],
    ['git config set core.hooksPath x', bypass],
    ['git config --file x.cfg core.hooksPath', 'allow'],
    ['git config --rename-section core.x y', bypass],
    ['GIT_CONFIG_KEY_0=alias.ci GIT_CONFIG_VALUE_0="commit -n" git ci', unchecked],
    ['GIT_CONFIG_KEY_0=user.name git commit -m x', 'allow'],
    ['GIT_CONFIG_KEY_0=$(echo x) git commit -m x', bypass],
    ['GIT_CONFIG_PARAMETERS="\'user.name\'=\'x\'" git commit -m x', unchecked],
    ['GIT_CONFIG_PARAMETERS=$(echo x) git commit -m x', bypass],
    ['GIT_CONFIG_PARAMETERS= git commit -m x', 'allow'],
    ['GIT_CONFIG_GLOBAL=/dev/null git commit -m x', 'allow'],
    ['LEFTHOOK=$(echo 0) git commit', bypass],
    ['HUSKY=1 git commit -m x', 'allow'],
    ['X=1 HUSKY=0', bypass],
    ['SKIP= git commit -m x', 'allow'],
    ['BASH_ENV=setup.sh bash -c ls', unreadable],
    ['ENV= sh', 'allow'],
    ['LD_PRELOAD=x.so ls', unreadable],
    ['NODE_OPTIONS="--require ./x.js" node -v', unreadable],
    ['NODE_OPTIONS=--import=./x.js node -v', unreadable],
    ['NODE_OPTIONS=--max-old-space-size=4096 bun test', 'allow'],
    ['GIT_PAGER="$PAGER" git log', unreadable],
    ['GIT_PAGER= git log', 'allow'],
  ])
})

describe('wrangler, its options read both ways when the fence does not know them', () => {
  table([
    ['wrangler versions deploy', deploy],
    ['wrangler versions upload', deploy],
    ['wrangler versions view', 'allow'],
    ['wrangler triggers deploy', deploy],
    ['wrangler triggers list', 'allow'],
    ['wrangler pages publish dist', deploy],
    ['wrangler pages dev', 'allow'],
    ['wrangler versions secret put KEY', secret],
    ['wrangler pages secret bulk file', secret],
    ['wrangler pages secret list', 'allow'],
    ['wrangler pages project delete name', deploy],
    ['wrangler pages project list', 'allow'],
    ['wrangler d1 time-travel restore DB', remote],
    ['wrangler d1 time-travel info DB', 'allow'],
    ['wrangler kv namespace delete --local', 'allow'],
    ['wrangler deploy --env=production --json', deploy],
    ['wrangler --config wrangler.toml deploy', deploy],
    ['wrangler --json deploy', deploy],
    ['wrangler --bogus --other deploy', deploy],
    ['wrangler dev --bogus value', 'allow'],
    ['wrangler --name deploy dev', 'allow'],
    ['wrangler --json x deploy', 'allow'],
    ['wrangler d1:execute DB --remote', remote],
  ])
})

describe('commands that write a named path', () => {
  table([
    ['cp -t .git/hooks pre-commit', bypass],
    ['cp --target-directory=.githooks pre-commit', fence],
    ['cp a b', 'allow'],
    ['cp -t out lint-debt.json', fence],
    ["rm 'x{}'", 'allow'],
    ['echo x >& lint-debt.json', fence],
    ['echo x >&2', 'allow'],
    ['curl -sSLo lint-debt.json http://x', fence],
    ['curl -olint-debt.json http://x', fence],
    ['curl --output lint-debt.json http://x', fence],
    ['curl --output=lint-debt.json http://x', fence],
    ["curl -O 'http://x/lint-debt.json?raw=1'", fence],
    ['curl -XPOST -o out.txt http://x', 'allow'],
    ['curl --remote-name http://x/lint-debt.json', fence],
    ['curl -s http://x/lint-debt.json', 'allow'],
    ['curl -HOK http://x/lint-debt.json', 'allow'],
    ['wget http://x/lint-debt.json', fence],
    ['wget -P .githooks http://x/pre-commit', fence],
    ['wget --directory-prefix=.githooks http://x/pre-commit', fence],
    ['wget -Olint-debt.json http://x/a', fence],
    ['wget --output-document=lint-debt.json http://x/a', fence],
    ['wget http://x/', 'allow'],
    ['tar -xf a.tar lint-debt.json', fence],
    ['tar --extract -f a.tar lint-debt.json', fence],
    ['tar --get --file=a.tar lint-debt.json', fence],
    ['tar xf a.tar -C .githooks pre-commit', fence],
    ['tar xf a.tar --directory=.githooks pre-commit', fence],
    ['tar cf lint-debt.json src', fence],
    ['tar -czf lint-debt.json src', fence],
    ['tar --create --file lint-debt.json src', fence],
    ['tar tf lint-debt.json', 'allow'],
    ['tar xf a.tar', 'allow'],
    ['tar x lint-debt.json < a.tar', fence],
    ['unzip a.zip lint-debt.json', fence],
    ['unzip a.zip -d .githooks pre-commit', fence],
    ['unzip a.zip -x lint-debt.json', 'allow'],
    ['unzip a.zip', 'allow'],
    ['find .git/hooks -delete', bypass],
    ['find . -iname LINT-DEBT.JSON -delete', fence],
    ['find . -path ./.githooks/pre-commit -delete', fence],
    ['find -L . -name lint-debt.json -delete', fence],
    ['find . -name "lint-debt.js[o]n" -delete', fence],
    ['find dist -name "*.js" -delete', 'allow'],
    ['find . -fprint lint-debt.json', fence],
    ['find . -name x -exec rm {} \\;', 'allow'],
    ['find . -name x -exec git "$SUB" -n \\;', bypass],
    ['find . -exec', 'allow'],
    ['find -name lint-debt.json -delete', fence],
    ["find . -exec git commit ';' -n", 'allow'],
    ['find . -exec git commit {} + -n', 'allow'],
    ['sed --in-place s/a/b/ lint-debt.json', fence],
    ['sed -n p lint-debt.json', 'allow'],
    ['dd if=/dev/zero of=lint-debt.json', fence],
  ])
})

describe('what a pipe hands a shell', () => {
  table([
    ["printf '%s\\n' 'git commit -n' | bash", bypass],
    ["printf 'echo 100%%' | bash", 'allow'],
    ["printf '%s %s\\n' git status git log | bash", 'allow'],
    ["printf 'git commit -n' | bash", bypass],
    ['printf | bash', unreadable],
    ["printf -v x 'git commit -n' | bash", unreadable],
    ["echo -n 'git commit -n' | bash", bypass],
    ["echo -E 'git commit -n' | bash", bypass],
    ["echo 'git\\ commit' | bash", unreadable],
    ["echo 'a\\b' c | bash", unreadable],
    ["echo -e 'git status' | bash", unreadable],
    ['echo git commit "$X" | bash', unreadable],
    ['echo git commit -n | xargs', 'allow'],
    ['echo "$CMD" | bash', unreadable],
    ["echo 'git commit -n' > f | bash", unreadable],
    ["echo 'git commit -n' | cat - | bash", bypass],
    ['cat | bash', 'allow'],
    ["bash <<< 'git commit -n'", bypass],
    ['bash <<< "$CMD"', unreadable],
    ['find . -print0 | xargs -0 sh', unreadable],
    ["printf 'commit -n' | xargs -d , git", bypass],
    ["printf 'a b\\n' | xargs -I{} echo {}", 'allow'],
    ['xargs -a list.txt git', bypass],
    ['xargs --arg-file=list.txt sh', unreadable],
    ["echo \"a 'b'\" | xargs git", bypass],
    ['xargs --bogus git', unreadable],
    ['echo x | xargs', 'allow'],
    // -I puts each line in as one word.
    ['echo commit -n | xargs --replace git {}', 'allow'],
    ['echo git commit -n | xargs --replace sh -c {}', bypass],
  ])
})

describe('a word the fence cannot read', () => {
  table([
    ['git commit $FLAGS', bypass],
    ['wrangler $(echo deploy)', deploy],
    ['popweb-fence debt --update "$FLAG"', fence],
    ['bun scripts/message.ts', 'allow'],
    ['echo $A $B $C $D $E $F $G $H', 'allow'],
  ])
})

describe('what the answers say', () => {
  test('a command from inline code is named as itself, one from a file by the file', () => {
    expect(commandPolicy(`node -e "require('child_process').execSync('git commit --no-verify')"`)).toMatchObject({ subject: 'git commit --no-verify' })
    expect(commandPolicy('sh scripts/commit.sh', options)).toMatchObject({ subject: 'scripts/commit.sh: git commit -n -m y' })
  })

  test('each unread part of a word shows as `$(…)`', () => {
    expect(commandPolicy('"$A$B" status')).toMatchObject({ subject: "'$(…)$(…)' status" })
  })
})

test('a path with an expansion never reaches readFile, which may refuse what no file name holds', () => {
  const strict: CommandPolicyOptions = {
    readFile: (path) => {
      if (isDynamic(path)) throw new Error(`no file is named ${JSON.stringify(path)}`)
      return undefined
    },
  }
  expect(commandPolicy('source "$X"', strict)).toMatchObject({ decision: 'ask', rule: 'unreadable' })
  expect(commandPolicy('bash < "$X"', strict)).toMatchObject({ decision: 'ask', rule: 'unreadable' })
})
