/**
 * Property checks for the fuzz suite, on the tools `@popcomputer/web/fuzz`
 * gives applications (src/fuzz.ts), so the suite runs the same engine an
 * application's fuzz tests do.
 *
 * `bun test` runs each property for a few hundred cases from a fixed seed,
 * so the commit gate is repeatable. `bun run fuzz` runs every property for
 * many more cases from a random seed. A failure names the shrunk input, why
 * the property refused it, and a replay token:
 * `FUZZ_REPLAY='<token>' bun test tests/fuzz -t '<property>'` runs that case
 * again. A case that found a bug becomes a plain test beside its property.
 */
import { test } from 'bun:test'
import type { Arbitrary } from 'effect'
import { fuzz, fuzzTimeout, type FuzzOptions, type Refusal } from '../../src/fuzz.js'

export { anyText, oneOf, pick, show, textOf, weighted, type Refusal } from '../../src/fuzz.js'

/** A test that checks `holds` on generated inputs. */
export function property<A>(
  name: string,
  arbitrary: Arbitrary.Arbitrary<A>,
  holds: (value: A) => Refusal | Promise<Refusal>,
  options: FuzzOptions = {}
): void {
  test(name, () => fuzz(arbitrary, holds, options), fuzzTimeout)
}
