/**
 * Agent Hook Tests
 *
 * `popweb-fence hook` reads what an agent sends before a tool runs and
 * answers in that agent's own format: Claude Code's PreToolUse decision,
 * Cursor's permission, or, for a plain command line, exit status 2.
 */

import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { answerHook, type HookEnvironment } from '../../src/fence/hook.js'

const files: Readonly<Record<string, string>> = {
  '/app/package.json': JSON.stringify({ scripts: { deploy: 'wrangler deploy', test: 'bun test' } }),
}
const environment: HookEnvironment = { cwd: '/elsewhere', readFile: (path) => files[path] }

const claudeCode = (toolName: string, toolInput: Record<string, unknown>) =>
  JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput, cwd: '/app' })

const decision = (stdout: string) => JSON.parse(stdout).hookSpecificOutput

describe('Claude Code', () => {
  test('refuses a command that skips the gate, with the reason for the agent', () => {
    const answer = answerHook(claudeCode('Bash', { command: 'git commit --no-verify -m wip' }), environment)

    expect(answer.exitCode).toBe(0)
    expect(decision(answer.stdout)).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' })
    expect(decision(answer.stdout).permissionDecisionReason).toContain('Fix what the gate reports')
  })

  test("asks the owner about a package.json script the session's directory declares", () => {
    const answer = answerHook(claudeCode('Bash', { command: 'bun run deploy' }), environment)

    expect(decision(answer.stdout)).toMatchObject({ permissionDecision: 'ask' })
    expect(decision(answer.stdout).permissionDecisionReason).toContain('bun run deploy: wrangler deploy')
  })

  test('leaves an ordinary command to the normal permission flow', () => {
    expect(answerHook(claudeCode('Bash', { command: 'bun run test' }), environment)).toEqual({ exitCode: 0, stdout: '', stderr: '' })
  })

  test("refuses an edit of git's hooks and asks about one of the fence's files", () => {
    const hooks = answerHook(claudeCode('Write', { file_path: '/app/.git/hooks/pre-commit', content: 'exit 0' }), environment)
    const lint = answerHook(claudeCode('Edit', { file_path: '/app/oxlint.config.ts', old_string: 'error', new_string: 'off' }), environment)
    const page = answerHook(claudeCode('Edit', { file_path: '/app/src/pages.ts', old_string: 'a', new_string: 'b' }), environment)

    expect(decision(hooks.stdout)).toMatchObject({ permissionDecision: 'deny' })
    expect(decision(lint.stdout)).toMatchObject({ permissionDecision: 'ask' })
    expect(page.stdout).toBe('')
  })
})

describe('Cursor', () => {
  test('answers every command, allowed or not, with a permission', () => {
    const allowed = answerHook(JSON.stringify({ hook_event_name: 'beforeShellExecution', command: 'ls', cwd: '/app' }), environment)
    const refused = answerHook(JSON.stringify({ hook_event_name: 'beforeShellExecution', command: 'HUSKY=0 git commit', cwd: '/app' }), environment)
    const asked = answerHook(JSON.stringify({ hook_event_name: 'beforeShellExecution', command: 'npm run deploy', cwd: '/app' }), environment)

    expect(JSON.parse(allowed.stdout)).toEqual({ permission: 'allow' })
    expect(JSON.parse(refused.stdout)).toMatchObject({ permission: 'deny' })
    expect(JSON.parse(refused.stdout).agent_message).toContain('HUSKY')
    expect(JSON.parse(asked.stdout)).toMatchObject({ permission: 'ask' })
  })
})

describe('a plain command line', () => {
  test('exits 2 with the reason on stderr when the command must not run', () => {
    const refused = answerHook('git commit -n -m wip\n', environment)
    const asked = answerHook('wrangler secret put AUTH_SECRET', environment)

    expect(refused).toMatchObject({ exitCode: 2, stdout: '' })
    expect(refused.stderr).toContain('Refused:')
    expect(asked).toMatchObject({ exitCode: 2 })
    expect(asked.stderr).toContain('Ask the user to run it')
    expect(answerHook('bun test', environment)).toEqual({ exitCode: 0, stdout: '', stderr: '' })
  })
})

test('the command reads the payload on stdin and answers on stdout', () => {
  const cli = join(import.meta.dir, '..', '..', 'src', 'fence', 'cli.ts')
  const result = spawnSync('bun', [cli, 'hook'], { input: claudeCode('Bash', { command: 'sh -c "git push --no-verify"' }), encoding: 'utf8' })

  expect(result.status).toBe(0)
  expect(decision(result.stdout)).toMatchObject({ permissionDecision: 'deny' })
})
