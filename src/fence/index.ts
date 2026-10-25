/**
 * `@popcomputer/web/fence`: the checks that hold an agent to an
 * application's rules, beyond what it reads. The command policy refuses a
 * shell command that skips the commit gate and asks the owner before one
 * that deploys, touches remote data, changes secrets, publishes or pushes;
 * the debt report counts every comment that turns a rule off, so the count
 * only shrinks. `popweb-fence hook` runs the policy for Claude Code and
 * Cursor, and `popweb-fence debt` the report, as docs/agent-fence.md shows.
 *
 * This entrypoint imports only Node's built-ins, so an agent's hook loads
 * it in a few milliseconds.
 */
export { commandPolicy, filePolicy, type CommandPolicyOptions, type FenceRule, type FenceVerdict } from './command-policy.js'
export { compareDebt, debtLedger, describeDirective, disableDirectives, parseLedger, scanDebt, type DebtComparison, type DebtLedger, type DisableDirective } from './debt.js'
export { answerHook, type HookAnswer, type HookEnvironment } from './hook.js'
