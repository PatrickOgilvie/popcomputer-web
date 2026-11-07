import { Effect } from 'effect'
import { afterCommit } from './commit.js'
import { ExecutionContextService } from './services.js'

/**
 * Schedule an Effect as runtime-owned background work.
 *
 * Cloudflare requests use `waitUntil`; other runtimes execute the work before
 * completing the request. Failures are observed and do not change the response.
 * The tags the work names with `purgeCache` are purged once it succeeds.
 */
export const background = Effect.fn('Web.background')(function* <A, E, R>(
  operation: string,
  effect: Effect.Effect<A, E, R>
) {
  const execution = yield* ExecutionContextService

  // The route purges what its action named once the action succeeds, which
  // work in a Worker can outlive, so every scheduled piece of work purges what
  // it names itself, whether it runs after the response or before it.
  // Started inside dbTransaction, it waits for the commit, so it never runs
  // on a closed transaction or for writes that rolled back.
  yield* afterCommit(execution.schedule(operation, effect))
})
