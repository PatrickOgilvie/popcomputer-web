/**
 * `fuzz` itself: whatever way a property fails, by returning why or by
 * throwing, as an `expect` or the code under test does, the failure shrinks
 * to its smallest input, says why, and gives the token that replays it.
 */
import { describe, expect, test } from 'bun:test'
import { Arbitrary, Schema as S } from 'effect'
import { fuzz } from '../../src/fuzz.js'

const number = Arbitrary.schema(S.Int.check(S.isBetween({ minimum: 0, maximum: 1000 })))

describe('fuzz', () => {
  test('shrinks a property that refuses an input', async () => {
    const failure = await fuzz(number, (value) => (value > 10 ? `${value} is over 10` : undefined)).catch((error: unknown) => String(error))

    expect(failure).toMatch(/Shrunk input: 11\b[\s\S]*Replay: [\s\S]*Refused: 11 is over 10/)
  })

  test('says so when the failing case holds when run again, as one that fails on what an earlier case left does', async () => {
    let cases = 0
    const failure = await fuzz(number, () => {
      cases += 1

      return cases === 5 ? 'the fifth case' : undefined
    }).catch((error: unknown) => String(error))

    expect(failure).toContain('Refused: nothing when run again, so the case fails only after the cases before it or by chance')
  })

  test('shrinks a property that throws, as one that refuses', async () => {
    const failure = await fuzz(number, (value) => {
      if (value > 10) throw new Error(`${value} is over 10`)

      return undefined
    }).catch((error: unknown) => String(error))

    expect(failure).toMatch(/Shrunk input: 11\b[\s\S]*Replay: [\s\S]*Refused: threw Error: 11 is over 10/)
  })
})
