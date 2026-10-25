/**
 * The agent's hook: reads what Claude Code or Cursor sends before a shell
 * command or a file edit, and answers with the policy's decision in that
 * agent's own format. Another agent can pipe the command line itself: a
 * command that must not run then exits with status 2 and the reason on
 * stderr.
 */
import { isAbsolute, join } from 'node:path'
import { commandPolicy, filePolicy, type CommandPolicyOptions } from './command-policy.js'

/** What the hook prints, and the status it exits with. */
export interface HookAnswer {
  readonly exitCode: 0 | 2
  readonly stdout: string
  readonly stderr: string
}

/** Where the hook reads the package.json scripts and the files a command names. */
export interface HookEnvironment {
  /** The directory a command runs in when the payload does not name one. */
  readonly cwd: string
  /** A file's text by its absolute path, or undefined when it does not exist or is too large to read. */
  readonly readFile: (path: string) => string | undefined
}

type Answer = { readonly decision: 'allow' } | { readonly decision: 'ask' | 'deny'; readonly reason: string }

/** Claude Code's tools that change one file, and the input that names it. */
const FILE_TOOLS: Readonly<Record<string, string>> = { Edit: 'file_path', Write: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' }

/** The hook's answer to one payload, as Claude Code, Cursor or a plain command line sends it. */
export function answerHook(input: string, environment: HookEnvironment): HookAnswer {
  const payload = parse(input)

  if (payload === undefined) {
    return plain(decide(() => commandPolicy(input.trim(), policyOptions(environment.cwd, environment))))
  }

  const cwd = typeof payload.cwd === 'string' ? payload.cwd : environment.cwd
  const toolInput = isRecord(payload.tool_input) ? payload.tool_input : {}
  const command = typeof payload.command === 'string' ? payload.command : toolInput.command

  // Claude Code names the event PreToolUse; Cursor's events are camel-cased.
  if (payload.hook_event_name === 'PreToolUse' || (payload.hook_event_name === undefined && isRecord(payload.tool_input))) {
    const fileInput = typeof payload.tool_name === 'string' && Object.hasOwn(FILE_TOOLS, payload.tool_name) ? toolInput[FILE_TOOLS[payload.tool_name]] : undefined

    if (typeof command === 'string') return claudeCode(decide(() => commandPolicy(command, policyOptions(cwd, environment))))
    if (typeof fileInput === 'string') return claudeCode(decide(() => filePolicy(fileInput)))
    return claudeCode({ decision: 'allow' })
  }

  return cursor(typeof command === 'string' ? decide(() => commandPolicy(command, policyOptions(cwd, environment))) : { decision: 'allow' })
}

function policyOptions(cwd: string, environment: HookEnvironment): CommandPolicyOptions {
  const resolve = (path: string) => (isAbsolute(path) ? path : join(cwd, path))

  return {
    scripts: packageScripts(environment.readFile(join(cwd, 'package.json'))),
    readFile: (path) => environment.readFile(resolve(path)),
  }
}

/** Fails closed: a command the policy cannot read goes to the owner. */
function decide(policy: () => Answer): Answer {
  try {
    return policy()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { decision: 'ask', reason: `The fence could not read this command (${message}). Approve it only if you expected it.` }
  }
}

function claudeCode(answer: Answer): HookAnswer {
  if (answer.decision === 'allow') return { exitCode: 0, stdout: '', stderr: '' }

  const output = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: answer.decision,
      permissionDecisionReason: `@popcomputer/web fence: ${answer.reason}`,
    },
  }
  return { exitCode: 0, stdout: `${JSON.stringify(output)}\n`, stderr: '' }
}

function cursor(answer: Answer): HookAnswer {
  const output =
    answer.decision === 'allow'
      ? { permission: 'allow' }
      : { permission: answer.decision, user_message: `@popcomputer/web fence: ${answer.reason}`, agent_message: `@popcomputer/web fence: ${answer.reason}` }
  return { exitCode: 0, stdout: `${JSON.stringify(output)}\n`, stderr: '' }
}

function plain(answer: Answer): HookAnswer {
  if (answer.decision === 'allow') return { exitCode: 0, stdout: '', stderr: '' }

  const reason = answer.decision === 'deny' ? `Refused: ${answer.reason}` : `Needs the owner: ${answer.reason} Ask the user to run it, or to approve it.`
  return { exitCode: 2, stdout: '', stderr: `@popcomputer/web fence: ${reason}\n` }
}

function parse(input: string): Record<string, unknown> | undefined {
  if (!input.trimStart().startsWith('{')) return undefined
  try {
    const value: unknown = JSON.parse(input)
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

function packageScripts(text: string | undefined): Record<string, string> | undefined {
  const manifest = text === undefined ? undefined : parse(text)
  if (manifest === undefined || !isRecord(manifest.scripts)) return undefined
  return Object.fromEntries(Object.entries(manifest.scripts).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
