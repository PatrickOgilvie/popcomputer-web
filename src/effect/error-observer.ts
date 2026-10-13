import { Context, Effect, Option } from 'effect'
import type { StructuredError } from './error-types.js'

export type EffectErrorMetadata = Readonly<Record<
  string,
  string | number | boolean | null
>>

export interface EffectErrorEvent {
  readonly source: 'framework' | 'user'
  readonly handling: 'unhandled' | 'handled'
  readonly kind: 'failure' | 'defect'
  readonly error: unknown
  readonly structured?: StructuredError
  readonly metadata?: EffectErrorMetadata
}

export class EffectErrorObserverService extends Context.Service<EffectErrorObserverService, {
  readonly observe: (event: EffectErrorEvent) => Effect.Effect<void, never>
}>()('@popcomputer/web/EffectErrorObserver') {}

export function observeEffectErrorEvent(
  event: EffectErrorEvent
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const maybeObserver = yield* Effect.serviceOption(EffectErrorObserverService)

    if (Option.isNone(maybeObserver)) return

    yield* maybeObserver.value.observe(event)
  }).pipe(Effect.ignoreCause)
}

/**
 * Observe a failure the request's response does not show, such as failed
 * background work or a cache store the cache recovered from. Without an
 * observer it is logged through Effect's logger, so it is never silent: an
 * unhandled failure as an error, a handled one as a warning.
 */
export function observeOrLog(
  event: EffectErrorEvent,
  message: string
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const maybeObserver = yield* Effect.serviceOption(EffectErrorObserverService)

    if (Option.isSome(maybeObserver)) {
      return yield* maybeObserver.value.observe(event)
    }

    const log = event.handling === 'unhandled' ? Effect.logError : Effect.logWarning

    yield* log(message, event.error).pipe(Effect.annotateLogs({ ...event.metadata }))
  }).pipe(Effect.ignoreCause)
}

export function reportEffectError(
  cause: unknown
): Effect.Effect<void, never>
export function reportEffectError(
  cause: unknown,
  options: {
    readonly metadata?: EffectErrorMetadata
  }
): Effect.Effect<void, never>
export function reportEffectError(
  cause: unknown,
  options?: {
    readonly metadata?: EffectErrorMetadata
  }
): Effect.Effect<void, never> {
  return observeEffectErrorEvent({
    source: 'user',
    handling: 'handled',
    kind: 'failure',
    error: cause,
    metadata: options?.metadata,
  })
}
