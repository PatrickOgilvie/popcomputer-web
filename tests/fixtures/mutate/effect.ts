/** A module of Effects for tests/mutate.test.ts to recover from the errors of. */
import { Effect, Schema as S } from 'effect'

export class Missing extends S.TaggedError<Missing>()('Missing', {}) {}
export class SoldOut extends S.TaggedError<SoldOut>()('SoldOut', {}) {}

const stock = new Map([['tea', 2], ['cake', 0]])

export function take(item: string): Effect.Effect<number, Missing | SoldOut> {
  const count = stock.get(item)
  if (count === undefined) return Effect.fail(new Missing({}))
  return count > 0 ? Effect.succeed(count - 1) : Effect.fail(new SoldOut({}))
}

// The callback's failures flow out through takeTwice's.
export const takeTwice = (item: string) => take(item).pipe(Effect.flatMap(() => take(item)))

export const count = (items: readonly string[]): Effect.Effect<number> => Effect.succeed(items.length)
