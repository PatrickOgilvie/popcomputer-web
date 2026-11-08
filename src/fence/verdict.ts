/** What a command or a file change breaks: the fence's own rule, or a step that needs the owner. */
export type FenceRule =
  /**
   * It skips or switches off the git hooks that run the commit gate: refused,
   * or asked of the owner where git commits without them by design, as a
   * merge, a rebase or a cherry-pick does, or a setting may switch them off.
   */
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
   * It holds what the fence cannot read where it matters: a command an
   * expansion names, a script it cannot open, code that starts a process,
   * text the shell's grammar cannot parse. Asked of the owner.
   */
  | 'unreadable'

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

export type Finding = Exclude<FenceVerdict, { readonly decision: 'allow' }>

/** The answer for several findings: a refusal first, then a question with a rule of its own, then any question. */
export function strongest(findings: ReadonlyArray<Finding>): FenceVerdict {
  return (
    findings.find((finding) => finding.decision === 'deny') ??
    findings.find((finding) => finding.rule !== 'unreadable') ??
    findings[0] ?? { decision: 'allow' }
  )
}
