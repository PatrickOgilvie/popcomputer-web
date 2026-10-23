import { Effect, Option } from 'effect'
import {
  createUnavailableResponseCacheClient,
  makePendingPurges,
  PendingPurges,
  purgeTags,
  ResponseCacheService,
} from './response-cache.js'
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
  // work in a Worker can outlive, so the work purges what it names itself,
  // whether it runs after the response or before it.
  const pending = makePendingPurges()
  // A route gives its Workers Cache client; work scheduled outside a route
  // purges only cached data, as it would outside a Worker.
  const responseCache = Option.getOrElse(yield* Effect.serviceOption(ResponseCacheService), createUnavailableResponseCacheClient)

  yield* execution.schedule(
    operation,
    effect.pipe(
      Effect.provideService(PendingPurges, pending),
      Effect.tap(() =>
        Effect.flatMap(pending.take, purgeTags).pipe(Effect.provideService(ResponseCacheService, responseCache))
      )
    )
  )
})
