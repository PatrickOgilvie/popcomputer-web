/**
 * The commit boundary. Some work must not outlive a rollback: a purge, the
 * background work a write starts, a value stored in the data cache. Inside
 * `dbTransaction` such work waits for the commit, and a rollback drops it.
 * Outside one, a write has committed already, so the work runs at once.
 *
 * @internal
 */
import { Context, Effect, Option } from 'effect'

/** Work waiting for the transaction the running Effect is in to commit. */
const WaitingForCommit = Context.Reference<Option.Option<Array<Effect.Effect<void>>>>(
  '@popcomputer/web/WaitingForCommit',
  { defaultValue: () => Option.none() }
)

/** Run `work` once the transaction the running Effect is in commits, or now, outside one. A rollback drops it. */
export const afterCommit = <R>(work: Effect.Effect<void, never, R>): Effect.Effect<void, never, R> =>
  Effect.flatMap(WaitingForCommit, (waiting): Effect.Effect<void, never, R> =>
    Option.isNone(waiting)
      ? work
      : Effect.sync(() => {
          // SAFETY: the work runs, at the commit, in the context of the Effect
          // that called dbTransaction, which the transaction's own context is
          // made from: every service it requires is there.
          waiting.value.push(work as Effect.Effect<void>)
        })
  )

/** Whether the running Effect is inside a transaction, where what it reads may yet roll back. */
export const inTransaction: Effect.Effect<boolean> = Effect.map(WaitingForCommit, Option.isSome)

/**
 * `transaction`, holding the work it starts with {@link afterCommit}, and the
 * Effect that releases that work once it has committed: to the transaction
 * around this one, if there is one, or to run.
 */
export function holdUntilCommit<A, E, R>(transaction: Effect.Effect<A, E, R>): {
  readonly held: Effect.Effect<A, E, R>
  readonly release: Effect.Effect<void>
} {
  const waiting: Array<Effect.Effect<void>> = []

  return {
    held: Effect.provideService(transaction, WaitingForCommit, Option.some(waiting)),
    release: Effect.suspend(() => Effect.forEach(waiting.splice(0), afterCommit, { discard: true })),
  }
}
