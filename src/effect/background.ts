import { Effect } from 'effect'
import { ExecutionContextService } from './services.js'

/**
 * Schedule an Effect as runtime-owned background work.
 *
 * Cloudflare requests use `waitUntil`; other runtimes execute the work before
 * completing the request. Failures are observed and do not change the response.
 */
export function background<A, E, R>(
  operation: string,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<void, never, R | ExecutionContextService> {
  return Effect.flatMap(ExecutionContextService, (execution) =>
    execution.schedule(operation, effect)
  )
}
