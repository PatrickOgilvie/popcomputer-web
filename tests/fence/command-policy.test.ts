/**
 * Command Policy Tests
 *
 * An agent's hook passes each shell command line to the policy. A line that
 * skips the commit gate is refused, however it is spelled; one that deploys,
 * touches remote data, changes secrets, publishes or pushes needs the owner;
 * everything else runs.
 */

import { describe, expect, test } from 'bun:test'
import { commandPolicy, filePolicy, type CommandPolicyOptions, type FenceRule } from '../../src/fence/command-policy.js'

type Expected = readonly ['deny' | 'ask', FenceRule]

const scripts = {
  build: 'tsc --noEmit',
  check: 'tsc --noEmit && oxlint',
  deploy: 'bun run build && wrangler deploy',
  'db:migrate': 'wrangler d1 migrations apply DB --local',
  'db:migrate:remote': 'wrangler d1 migrations apply DB --remote',
  release: 'npm publish --access public',
  ship: 'bun run deploy',
  announce: 'echo shipping',
  preannounce: 'git push',
  loop: 'bun run loop',
}

const files: Readonly<Record<string, string>> = {
  'scripts/release.sh': '#!/bin/sh\nset -e\nbun test\nwrangler deploy\n',
  'scripts/check.sh': '#!/bin/sh\nbun test\nbunx oxlint\n',
  'scripts/deploy.ts': "import { $ } from 'bun'\nawait $`wrangler deploy --env production`\n",
  'scripts/commit.ts': "Bun.spawnSync(['git', 'commit', '--no-verify', '-m', 'wip'])\n",
}

const options: CommandPolicyOptions = { scripts, readFile: (path) => files[path.replace(/^\.\//, '')] }

const allowed: ReadonlyArray<string> = [
  'git status',
  'git commit -m "Add projects"',
  'git commit -am "fix" && git log -1',
  'git commit -m "Say why: drop --no-verify from the docs"',
  'git commit -m wip -- notes/-n.md',
  'git log --grep=--no-verify',
  'git push --dry-run origin main',
  'git config --get core.hooksPath',
  'git config core.hooksPath',
  'echo "git commit --no-verify"',
  "grep -rn 'wrangler deploy' docs",
  'cat lefthook.yml .git/hooks/pre-commit',
  'command -v wrangler',
  'bun test && bunx oxlint && bunx tsc --noEmit',
  'wrangler deploy --dry-run --outdir dist',
  'bunx wrangler deploy --dry-run=true',
  'wrangler dev',
  'wrangler d1 migrations apply DB',
  'wrangler d1 migrations apply DB --local',
  'wrangler d1 execute DB --local --command "SELECT 1"',
  'wrangler secret list',
  'wrangler types',
  'npm publish --dry-run',
  'bun run build',
  'bun run check',
  'npm run db:migrate',
  'bun run loop',
  'npm run deploy -- --dry-run',
  'sh scripts/check.sh',
  'popweb-fence debt --update',
  'sed -n 1,20p oxlint.config.ts',
  'rm -rf node_modules && bun install',
]

const refused: ReadonlyArray<readonly [string, Expected]> = [
  // Skipping the gate, however it is spelled.
  ['git commit --no-verify -m wip', ['deny', 'hook-bypass']],
  ['git commit -n -m wip', ['deny', 'hook-bypass']],
  ['git commit -nm wip', ['deny', 'hook-bypass']],
  ['git commit -anm wip', ['deny', 'hook-bypass']],
  ['git commit -m wip -n', ['deny', 'hook-bypass']],
  ['git commit --no-veri -m wip', ['deny', 'hook-bypass']],
  ['git -C app --no-pager commit --no-verify', ['deny', 'hook-bypass']],
  ['git push --no-verify', ['deny', 'hook-bypass']],
  ['git merge --no-verify feature', ['deny', 'hook-bypass']],
  ['/usr/bin/git commit --no-verify', ['deny', 'hook-bypass']],
  ['\\git commit --no-verify', ['deny', 'hook-bypass']],
  ['g"i"t commit --no-ver\'ify\'', ['deny', 'hook-bypass']],
  ["git commit $'--no-verify'", ['deny', 'hook-bypass']],
  ['FLAG=--no-verify; git commit $FLAG -m wip', ['deny', 'hook-bypass']],
  ['ARGS="commit --no-verify"; git $ARGS', ['deny', 'hook-bypass']],
  ['alias g=git; g commit -n', ['deny', 'hook-bypass']],
  ['bun test && git commit --no-verify -m wip', ['deny', 'hook-bypass']],
  ['bun test || git commit -n -m wip', ['deny', 'hook-bypass']],
  ['bun test; git commit -n -m wip', ['deny', 'hook-bypass']],
  ['bun test\ngit commit -n -m wip', ['deny', 'hook-bypass']],
  ['(cd app && git commit --no-verify)', ['deny', 'hook-bypass']],
  ['{ git commit --no-verify; }', ['deny', 'hook-bypass']],
  ['if true; then git commit -n; fi', ['deny', 'hook-bypass']],
  ['echo $(git commit --no-verify)', ['deny', 'hook-bypass']],
  ['echo `git commit --no-verify`', ['deny', 'hook-bypass']],
  ['sh -c "git commit --no-verify -m wip"', ['deny', 'hook-bypass']],
  ["bash -lc 'cd app && git commit -n -m \"wip\"'", ['deny', 'hook-bypass']],
  ['zsh -o pipefail -c "git commit -n"', ['deny', 'hook-bypass']],
  ['echo "git commit --no-verify" | sh', ['deny', 'hook-bypass']],
  ['bash <<< "git commit -n"', ['deny', 'hook-bypass']],
  ['bash <<EOF\ngit commit --no-verify\nEOF', ['deny', 'hook-bypass']],
  ['eval "git commit --no-verify"', ['deny', 'hook-bypass']],
  ['echo --no-verify | xargs git commit -m wip', ['deny', 'hook-bypass']],
  ['find . -name x -exec git commit --no-verify \\;', ['deny', 'hook-bypass']],
  ['timeout 60 git commit -n', ['deny', 'hook-bypass']],
  ['nohup nice -n 5 git commit -n', ['deny', 'hook-bypass']],
  ['node -e "require(\'child_process\').execSync(\'git commit --no-verify\')"', ['deny', 'hook-bypass']],
  ['python3 -c "import subprocess; subprocess.run([\'git\', \'commit\', \'--no-verify\'])"', ['deny', 'hook-bypass']],
  ['bun scripts/commit.ts', ['deny', 'hook-bypass']],
  ['git rebase -x "git commit --amend --no-verify" main', ['deny', 'hook-bypass']],
  ['HUSKY=0 git commit -m wip', ['deny', 'hook-bypass']],
  ['LEFTHOOK=0 git commit -m wip', ['deny', 'hook-bypass']],
  ['env LEFTHOOK=false git commit -m wip', ['deny', 'hook-bypass']],
  ['env -i PATH=/usr/bin HUSKY=0 git commit', ['deny', 'hook-bypass']],
  ['sudo -E LEFTHOOK_EXCLUDE=tsc git commit', ['deny', 'hook-bypass']],
  ['SKIP=tsc git commit -m wip', ['deny', 'hook-bypass']],
  ['export HUSKY=0; git commit -m wip', ['deny', 'hook-bypass']],
  ['GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit', ['deny', 'hook-bypass']],
  ['git -c core.hooksPath=/dev/null commit -m wip', ['deny', 'hook-bypass']],
  ['git -c core.hookspath=/dev/null commit', ['deny', 'hook-bypass']],
  ['git --config-env=core.hooksPath=EMPTY commit', ['deny', 'hook-bypass']],
  ["git -c 'alias.ci=commit --no-verify' ci", ['deny', 'hook-bypass']],
  ["git config alias.ci 'commit -n'", ['deny', 'hook-bypass']],
  ['git config core.hooksPath /dev/null', ['deny', 'hook-bypass']],
  ['git config --local core.hooksPath .githooks', ['deny', 'hook-bypass']],
  ['git config --unset core.hooksPath', ['deny', 'hook-bypass']],
  ['lefthook uninstall', ['deny', 'hook-bypass']],
  ['rm .git/hooks/pre-commit', ['deny', 'hook-bypass']],
  ['chmod -x .git/hooks/pre-commit', ['deny', 'hook-bypass']],
  ['ln -sf /dev/null .git/hooks/pre-commit', ['deny', 'hook-bypass']],
  ['echo "exit 0" > .git/hooks/pre-commit', ['deny', 'hook-bypass']],
  ['printf "skip: true" >> lefthook-local.yml', ['deny', 'hook-bypass']],
  ['rm -rf node_modules/@popcomputer/web/dist/fence', ['deny', 'hook-bypass']],

  // The owner's steps: deploys, remote data, secrets, releases, pushes.
  ['wrangler deploy', ['ask', 'deploy']],
  ['bunx wrangler deploy', ['ask', 'deploy']],
  ['npx --yes wrangler@4 deploy --env production', ['ask', 'deploy']],
  ['bun x wrangler deploy', ['ask', 'deploy']],
  ['pnpm exec wrangler deploy', ['ask', 'deploy']],
  ['pnpm dlx wrangler deploy', ['ask', 'deploy']],
  ['yarn wrangler deploy', ['ask', 'deploy']],
  ['./node_modules/.bin/wrangler deploy', ['ask', 'deploy']],
  ['node node_modules/wrangler/bin/wrangler.js deploy', ['ask', 'deploy']],
  ['CLOUDFLARE_ACCOUNT_ID=abc wrangler deploy', ['ask', 'deploy']],
  ['env -i PATH=/usr/bin wrangler deploy', ['ask', 'deploy']],
  ['bun run build && wrangler deploy', ['ask', 'deploy']],
  ['sh -c "bunx wrangler deploy"', ['ask', 'deploy']],
  ['W=wrangler; $W deploy', ['ask', 'deploy']],
  ['${WRANGLER:-wrangler} deploy', ['ask', 'deploy']],
  ['wrangler -e production deploy', ['ask', 'deploy']],
  ['wrangler deploy --dry-run=false', ['ask', 'deploy']],
  ['wrangler versions deploy', ['ask', 'deploy']],
  ['wrangler versions upload', ['ask', 'deploy']],
  ['wrangler rollback', ['ask', 'deploy']],
  ['wrangler pages deploy dist', ['ask', 'deploy']],
  ['wrangler d1 migrations apply DB --remote', ['ask', 'remote-data']],
  ['bunx wrangler d1 migrations apply wendlingbeck --remote', ['ask', 'remote-data']],
  ['wrangler d1 execute DB --remote --command "DELETE FROM users"', ['ask', 'remote-data']],
  ['wrangler d1 execute DB --command="SELECT 1" --remote=true', ['ask', 'remote-data']],
  ['wrangler d1 export DB --remote --output dump.sql', ['ask', 'remote-data']],
  ['wrangler d1 time-travel restore DB --timestamp 1700000000', ['ask', 'remote-data']],
  ['wrangler d1 delete DB', ['ask', 'remote-data']],
  ['wrangler kv key put --remote --binding KV key value', ['ask', 'remote-data']],
  ['wrangler r2 bucket delete uploads', ['ask', 'remote-data']],
  ['wrangler dev --remote', ['ask', 'remote-data']],
  ['wrangler secret put AUTH_SECRET', ['ask', 'secret']],
  ['echo "$SECRET" | bunx wrangler secret put AUTH_SECRET', ['ask', 'secret']],
  ['wrangler secret bulk .dev.vars', ['ask', 'secret']],
  ['wrangler secret delete OLD_KEY', ['ask', 'secret']],
  ['wrangler versions secret put AUTH_SECRET', ['ask', 'secret']],
  ['npm publish', ['ask', 'publish']],
  ['npm --workspace web publish --access public', ['ask', 'publish']],
  ['bun publish', ['ask', 'publish']],
  ['pnpm -r publish', ['ask', 'publish']],
  ['yarn npm publish', ['ask', 'publish']],
  ['git push', ['ask', 'push']],
  ['git push origin main', ['ask', 'push']],
  ['git -C app push --force-with-lease', ['ask', 'push']],

  // Scripts and files the command runs.
  ['bun run deploy', ['ask', 'deploy']],
  ['npm run deploy', ['ask', 'deploy']],
  ['bun deploy', ['ask', 'deploy']],
  ['pnpm run deploy', ['ask', 'deploy']],
  ['bun run ship', ['ask', 'deploy']],
  ['bun run db:migrate:remote', ['ask', 'remote-data']],
  ['npm run release', ['ask', 'publish']],
  ['npm run announce', ['ask', 'push']],
  ['sh scripts/release.sh', ['ask', 'deploy']],
  ['./scripts/release.sh', ['ask', 'deploy']],
  ['source scripts/release.sh', ['ask', 'deploy']],
  ['bun scripts/deploy.ts', ['ask', 'deploy']],

  // The fence's own files, and the debt baseline.
  ['sed -i "" "s/error/off/" oxlint.config.ts', ['ask', 'fence-change']],
  ['perl -pi -e "s/error/off/" oxlint.config.ts', ['ask', 'fence-change']],
  ['cat > .claude/settings.json <<EOF\n{}\nEOF', ['ask', 'fence-change']],
  ['rm -rf .githooks', ['ask', 'fence-change']],
  ['cp /tmp/empty.yml lefthook.yml', ['ask', 'fence-change']],
  ['popweb-fence debt --update --allow-increase', ['ask', 'fence-change']],
  ['bun node_modules/@popcomputer/web/dist/fence/cli.js debt --update --allow-increase', ['ask', 'fence-change']],

  // A refusal outranks a question.
  ['wrangler deploy && git commit --no-verify', ['deny', 'hook-bypass']],
]

describe('commandPolicy', () => {
  test.each(allowed)('allows %p', (command) => {
    expect(commandPolicy(command, options)).toEqual({ decision: 'allow' })
  })

  test.each(refused)('answers %p with %p', (command, expected) => {
    const verdict = commandPolicy(command, options)

    expect(verdict.decision === 'allow' ? verdict : [verdict.decision, verdict.rule]).toEqual([...expected])
  })

  test('names the command and says what to do instead', () => {
    const verdict = commandPolicy('bun test && git commit --no-verify -m wip')

    expect(verdict).toMatchObject({ decision: 'deny', subject: 'git commit --no-verify -m wip' })
    expect(verdict.decision !== 'allow' && verdict.reason).toContain('Fix what the gate reports')
  })

  test('names the script a command came from', () => {
    const verdict = commandPolicy('bun run deploy', { scripts })

    expect(verdict).toMatchObject({ decision: 'ask', subject: 'bun run deploy: wrangler deploy' })
  })

  test('without the scripts, a script name is just a word', () => {
    expect(commandPolicy('bun run deploy')).toEqual({ decision: 'allow' })
  })
})

describe('filePolicy', () => {
  test.each([
    ['/repo/.git/hooks/pre-commit', 'deny', 'hook-bypass'],
    ['C:\\repo\\.git\\hooks\\pre-commit', 'deny', 'hook-bypass'],
    ['/repo/lefthook-local.yml', 'deny', 'hook-bypass'],
    ['/repo/lefthook.yml', 'ask', 'fence-change'],
    ['/repo/.githooks/pre-commit', 'ask', 'fence-change'],
    ['/repo/oxlint.config.ts', 'ask', 'fence-change'],
    ['/repo/.claude/settings.json', 'ask', 'fence-change'],
    ['/repo/.claude/settings.local.json', 'ask', 'fence-change'],
    ['/repo/.cursor/hooks.json', 'ask', 'fence-change'],
    ['/repo/lint-debt.json', 'ask', 'fence-change'],
  ] as const)('answers an edit of %p with %p', (path, decision, rule) => {
    expect(filePolicy(path)).toMatchObject({ decision, rule })
  })

  test.each(['/repo/src/app.ts', '/repo/docs/lefthook.md', '/repo/src/oxlint.ts'])('allows an edit of %p', (path) => {
    expect(filePolicy(path)).toEqual({ decision: 'allow' })
  })
})
