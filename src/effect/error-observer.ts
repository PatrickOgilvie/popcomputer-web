import { Context, Effect, Option } from 'effect'
import type { HonertiaStructuredError } from './error-types.js'

export type EffectErrorMetadata = Readonly<Record<
  string,
  string | number | boolean | null
>>

export interface EffectErrorEvent {
  readonly source: 'framework' | 'user'
  readonly handling: 'unhandled' | 'handled'
  readonly kind: 'failure' | 'defect'
  readonly error: unknown
  readonly structured?: HonertiaStructuredError
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
  }).pipe(Effect.catchCause(() => Effect.void))
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
