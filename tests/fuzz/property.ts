/**
 * Property checks for the fuzz suite, on Effect's own generators
 * (`effect/Arbitrary`), so the suite needs no engine of its own.
 *
 * `bun test` runs each property for a few hundred cases from a fixed seed,
 * so the commit gate is repeatable. `bun run fuzz` runs every property for
 * many more cases from a random seed. A failure names the shrunk input, why
 * the property refused it, and a replay token:
 * `FUZZ_REPLAY='<token>' bun test tests/fuzz -t '<property>'` runs that case
 * again. A case that found a bug becomes a plain test beside its property.
 */
import { test } from 'bun:test'
import { Arbitrary, Effect, Schema as S, type SchemaAST } from 'effect'

const configuredRuns = process.env.FUZZ_RUNS === undefined ? undefined : Number(process.env.FUZZ_RUNS)
// `random` picks a seed per run; the replay token a failure prints records it.
const seed = process.env.FUZZ_SEED === 'random' ? Date.now() : process.env.FUZZ_SEED ?? 'popweb'
const replay = process.env.FUZZ_REPLAY

/** Why a property refused an input, or undefined when it holds. */
export type Refusal = string | undefined

/**
 * A test that checks `holds` on generated inputs. `runs` is the property's
 * share of the commit gate, for one whose cases are slow; `FUZZ_RUNS`
 * overrides it.
 */
export function property<A>(
  name: string,
  arbitrary: Arbitrary.Arbitrary<A>,
  holds: (value: A) => Refusal | Promise<Refusal>,
  options: { readonly runs?: number } = {}
): void {
  const runs = configuredRuns ?? options.runs ?? 300

  test(name, async () => {
    const result = await Effect.runPromise(
      Arbitrary.checkEffect(arbitrary, (value) => Effect.promise(async () => (await holds(value)) === undefined), {
        runs,
        seed,
        replay,
      })
    )

    if (result._tag === 'Passed') return

    const refusal = result._tag === 'Falsified' ? await holds(result.shrunkInput) : undefined

    throw new Error([Arbitrary.formatCheckFailure(result), refusal && `Refused: ${refusal}`].filter(Boolean).join('\n'))
  }, configuredRuns === undefined ? 60_000 : 3_600_000)
}

/** One of `values`, shrinking toward the first. */
export function pick<const Values extends readonly [SchemaAST.LiteralValue, ...SchemaAST.LiteralValue[]]>(
  values: Values
): Arbitrary.Arbitrary<Values[number]> {
  return Arbitrary.schema(S.Literals(values))
}

/** A value from one of `arbitraries`, shrinking toward the first. */
export function oneOf<A>(...arbitraries: readonly [Arbitrary.Arbitrary<A>, ...Arbitrary.Arbitrary<A>[]]): Arbitrary.Arbitrary<A> {
  const [, ...rest] = arbitraries

  return Arbitrary.flatMap(pick([0, ...rest.map((_, index) => index + 1)]), (index) => arbitraries[index])
}

/** Text made of the given pieces, up to `maxPieces` of them. */
export function textOf(pieces: readonly [string, ...string[]], maxPieces = 8): Arbitrary.Arbitrary<string> {
  return Arbitrary.map(Arbitrary.array(pick(pieces), { maxLength: maxPieces }), (chosen) => chosen.join(''))
}

/** A value as JSON with every character outside printable ASCII escaped, so U+00A0 never reads as a space. */
export function show<A>(value: A): string {
  return (JSON.stringify(value) ?? String(value)).replace(
    /[^\x20-\x7e]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  )
}

/** Any string, as Effect generates `Schema.String`. */
export const anyText: Arbitrary.Arbitrary<string> = Arbitrary.schema(S.String)
