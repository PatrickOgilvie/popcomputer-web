/**
 * `fuzz` itself: whatever way a property fails, by returning why or by
 * throwing, as an `expect` or the code under test does, the failure shrinks
 * to its smallest input, says why, and gives the token that replays it. A
 * failure in a long sequence of steps shrinks past the hundred candidates
 * Effect's check tries by default, and a slow one stops shrinking in time to
 * report before `fuzzTimeout`.
 */
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { Arbitrary, Schema as S } from 'effect'
import { fuzz, fuzzTimeout, pick, stepsOf } from '../../src/fuzz.js'

const number = Arbitrary.schema(S.Int.check(S.isBetween({ minimum: 0, maximum: 1000 })))

/** Whether a job's steps never sign off an invoiced job, which the application's bug lets them do. */
function signedOff(steps: ReadonlyArray<string>): string | undefined {
  let status = 'open'

  for (const step of steps) {
    if (step === 'finish' && status === 'open') status = 'finished'
    if (step === 'invoice' && status === 'finished') status = 'invoiced'
    if (step === 'reopen') status = 'open'
    if (step === 'signOff' && status === 'invoiced') return `signed off after ${steps.join(' ')}`
  }

  return undefined
}

afterEach(() => {
  setSystemTime()
})

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

  test('shrinks a sequence of up to 200 steps to the three a bug needs, past the hundred candidates Effect tries', async () => {
    // Dropping each step the bug does not need takes a candidate of its own.
    const steps = stepsOf(pick(['note', 'finish', 'reopen', 'invoice', 'signOff']), { maxLength: 200 })
    const failure = await fuzz(steps, signedOff).catch((error: unknown) => String(error))

    expect(failure).toContain('Refused: signed off after finish invoice signOff')
  })

  test('stops shrinking a slow property with a quarter of fuzzTimeout left, and says so', async () => {
    // Eight numbers, so the first case has smaller ones to try.
    const numbers = Arbitrary.all(Array.from({ length: 8 }, () => number))
    const failure = await fuzz(numbers, () => {
      // The first case to fail takes the test's whole time.
      setSystemTime(Date.now() + fuzzTimeout)

      return 'refused'
    }).catch((error: unknown) => String(error))

    expect(failure).toMatch(/after 1 run\(s\) and 0 shrink\(s\)[\s\S]*Stopped shrinking with a quarter of fuzzTimeout left: a smaller input may fail too/)
  })
})
