import { Effect } from 'effect'
import { ExecutionContextService } from './services.js'

/**
 * Schedule an Effect as runtime-owned background work.
 *
 * Cloudflare requests use `waitUntil`; other runtimes execute the work before
 * completing the request. Failures are observed and do not change the response.
 */
export const background = Effect.fn('Web.background')(function* <A, E, R>(
  operation: string,
  effect: Effect.Effect<A, E, R>
) {
  const execution = yield* ExecutionContextService

  yield* execution.schedule(operation, effect)
})
