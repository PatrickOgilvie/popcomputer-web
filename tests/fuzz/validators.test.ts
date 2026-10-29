/**
 * Every validator `@popcomputer/web/schema` exports decodes text an
 * anonymous visitor sends, before any limit counts the request. For any
 * input each must answer, never crash, and a value it decoded must decode
 * the same once encoded back into a form, as a page that shows a saved value
 * and posts it again does. No text may make one slow: every pumped input
 * below, a lead, one piece repeated to 30 KB and an end that fails the
 * match, finds again run-1's C5 on 1.4.2, the email pattern that took half
 * a second on a dotted domain. That space is small, so it is tried whole.
 */
import { describe, expect, test } from 'bun:test'
import { Arbitrary, Exit, Predicate, Schema as S } from 'effect'
import * as validators from '../../src/schema'
import { anyText, oneOf, pick, property, show, textOf } from './property'

/** Each exported schema that decodes request input. */
const INPUTS = Object.entries(validators).flatMap(([name, value]) =>
  S.isSchema(value) && name !== 'ErrorResponse' ? [[name, value] as const] : []
)

/** How long one decode may take; a linear validator takes well under a millisecond on 30 KB. */
const SLOW_MS = 100

const LEADS = ['', 'a', 'a@', 'a@b', ' ', 'http://', 'https://a', '1', '::', 'a-', '2026-', '{"a":']
const PIECES = ['.', 'a.', '@', ' ', '-', 'a', '..', 'a@', '0', ':', '1.', '/', '%', '\t', 'é', '[', '"']
const ENDS = ['', '@', ' ', '!', '\n', 'x', '.', '\u0000']

/** Text built to make a backtracking pattern retry, every lead, piece and end. */
const PUMPED = LEADS.flatMap((lead) =>
  PIECES.flatMap((piece) => ENDS.map((end) => lead + piece.repeat(Math.ceil(30_000 / piece.length)) + end))
)

/** The quickest of three decodes, so one pause for garbage collection is not counted. */
function decodeMilliseconds<A, E>(decode: (input: string) => Exit.Exit<A, E>, input: string): number {
  let quickest = Number.POSITIVE_INFINITY

  for (let attempt = 0; attempt < 3 && quickest > SLOW_MS; attempt++) {
    const start = performance.now()
    decode(input)
    quickest = Math.min(quickest, performance.now() - start)
  }

  return quickest
}

/** Values in the validator's own encoding, from values of its decoded type, when Effect can generate those. */
function encodedValues(schema: (typeof INPUTS)[number][1]): Arbitrary.Arbitrary<unknown> | undefined {
  try {
    const encode = S.encodeUnknownExit(schema)

    return Arbitrary.map(Arbitrary.schema(schema), (value) => {
      const encoded = encode(value)

      return Exit.isSuccess(encoded) ? encoded.value : value
    })
  } catch {
    // Derivation throws for a schema Effect cannot yet generate (email, url, ip, isoDate).
    return undefined
  }
}

const FORM_TEXT = textOf(['a', ' ', '\t', '0', '1', '.', '-', '@', ':', '/', 'on', 'true', 'é', '\u0000', ''], 10)

describe('validators', () => {
  for (const [name, schema] of INPUTS) {
    const decode = S.decodeUnknownExit(schema)
    const encode = S.encodeUnknownExit(schema)
    const fromType = encodedValues(schema)
    const padded = fromType === undefined
      ? FORM_TEXT
      : Arbitrary.map(Arbitrary.all([pick(['', ' ', '\t']), fromType, pick(['', ' ', '\n'])]), ([lead, value, end]) =>
          Predicate.isString(value) ? lead + value + end : value
        )
    const input = oneOf<unknown>(padded, FORM_TEXT, anyText, pick([0, 1, -1, true, false]), Arbitrary.Constant(null), Arbitrary.Constant(['a', 'b']))

    property(`${name} answers any input, and decodes its own encoding to the same value`, input, (sent) => {
      const decoded = decode(sent)

      if (Exit.isFailure(decoded)) {
        return decoded.cause.reasons.every((reason) => reason._tag === 'Fail') ? undefined : `crashed on ${show(sent)}`
      }

      const encoded = encode(decoded.value)

      if (Exit.isFailure(encoded)) return `decoded ${show(sent)} to a value it cannot encode`

      const again = decode(encoded.value)

      if (Exit.isFailure(again)) return `decoded ${show(sent)}, but not its own encoding ${show(encoded.value)}`

      const reEncoded = encode(again.value)

      return Exit.isSuccess(reEncoded) && show(reEncoded.value) === show(encoded.value)
        ? undefined
        : `${show(sent)} decodes differently once posted again as ${show(encoded.value)}`
    }, { runs: 200 })
  }

  test('decode any text quickly', () => {
    const slow: string[] = []

    for (const [name, schema] of INPUTS) {
      const decode = S.decodeUnknownExit(schema)
      const input = PUMPED.find((text) => decodeMilliseconds(decode, text) > SLOW_MS)

      if (input !== undefined) slow.push(`${name} on ${show(input.slice(0, 12))}... (${input.length} characters)`)
    }

    expect(slow).toEqual([])
  }, 60_000)
})
