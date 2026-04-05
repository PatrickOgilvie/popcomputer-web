import { Context, Effect, Option } from 'effect'
import type { HonertiaStructuredError } from './error-types.js'

export interface EffectErrorEvent {
  readonly source: 'framework' | 'user'
  readonly handling: 'unhandled' | 'handled'
  readonly kind: 'failure' | 'defect'
  readonly error: unknown
  readonly structured?: HonertiaStructuredError
  readonly metadata?: Record<string, unknown>
}

export class EffectErrorObserverService extends Context.Tag(
  'honertia/EffectErrorObserver'
)<EffectErrorObserverService, {
  readonly observe: (event: EffectErrorEvent) => Effect.Effect<void, never>
}>() {}

export function observeEffectErrorEvent(
  event: EffectErrorEvent
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const maybeObserver = yield* Effect.serviceOption(EffectErrorObserverService)
    if (Option.isNone(maybeObserver)) return

    yield* maybeObserver.value.observe(event)
  }).pipe(Effect.catchAllCause(() => Effect.void))
}

export function reportEffectError(
  error: unknown
): Effect.Effect<void, never>
export function reportEffectError(
  error: unknown,
  options: {
    readonly metadata?: Record<string, unknown>
  }
): Effect.Effect<void, never>
export function reportEffectError(
  error: unknown,
  options?: {
    readonly metadata?: Record<string, unknown>
  }
): Effect.Effect<void, never> {
  return observeEffectErrorEvent({
    source: 'user',
    handling: 'handled',
    kind: 'failure',
    error,
    metadata: options?.metadata,
  })
}
