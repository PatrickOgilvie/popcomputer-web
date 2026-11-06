/**
 * `fuzz` itself: whatever way a property fails, by returning why or by
 * throwing, as an `expect` or the code under test does, the failure shrinks
 * to its smallest input, says why, and gives the token that replays it. A
 * failure in a long sequence of steps shrinks past the hundred candidates
 * Effect's check tries by default, and a slow one stops shrinking in time to
 * report before `fuzzTimeout`. A failure the input does not explain, as when
 * the machine or a test's harness gives way, stops the run where it happened
 * and keeps what failed, rather than shrinking onto an innocent input.
 */
import { afterAll, afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from 'bun:test'
import { Arbitrary, Schema as S } from 'effect'
import { join } from 'node:path'
import { fuzz, fuzzTimeout, pick, stepsOf } from '../../src/fuzz.js'

const number = Arbitrary.schema(S.Int.check(S.isBetween({ minimum: 0, maximum: 1000 })))
// Eight numbers, so a failing case has smaller ones to try.
const numbers = Arbitrary.all(Array.from({ length: 8 }, () => number))

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

// A failure prints as it happens, which these tests make on purpose.
const printed = spyOn(console, 'error')

beforeEach(() => {
  printed.mockClear()
  printed.mockImplementation(() => undefined)
})

afterEach(() => {
  setSystemTime()
})

afterAll(() => {
  printed.mockRestore()
})

describe('fuzz', () => {
  test('shrinks a property that refuses an input', async () => {
    const failure = await fuzz(number, (value) => (value > 10 ? `${value} is over 10` : undefined)).catch((error: unknown) => String(error))

    expect(failure).toMatch(/Shrunk input: 11\b[\s\S]*Replay: [\s\S]*Refused: 11 is over 10/)
  })

  test('keeps what a throw said and where, as well as the smallest input that fails', async () => {
    const failure = await fuzz(number, (value) => {
      if (value > 10) throw new TypeError(`${value} is over 10`)

      return undefined
    }).catch((error: unknown) => String(error))

    expect(failure).toMatch(/Refused: threw TypeError: 11 is over 10/)
    expect(failure).toMatch(/First failure: threw TypeError: \d+ is over 10\n[\s\S]*fuzz\.test\.ts/)
  })

  test('shows what a throw wraps, as a query error wraps what its database said', async () => {
    const failure = await fuzz(number, () => {
      throw new Error('Failed query: select 1', { cause: new Error('D1_ERROR: database is locked', { cause: 'the disk' }) })
    }).catch((error: unknown) => String(error))

    expect(failure).toMatch(/First failure: threw Error: Failed query: select 1\n[\s\S]*Caused by Error: D1_ERROR: database is locked\n[\s\S]*Caused by "the disk"/)
  })

  test('adds no cause to an error that wraps nothing', async () => {
    const failure = await fuzz(number, () => {
      throw new Error('alone')
    }).catch((error: unknown) => String(error))

    expect(failure).toContain('First failure: threw Error: alone')
    expect(failure).not.toContain('Caused by')
  })

  test('takes a throw of anything at all, an error or not', async () => {
    // eslint-style lint rules read a literal throw as a mistake; a rejection is what a property gets anyway.
    const failure = await fuzz(number, () => Promise.reject(null)).catch((error: unknown) => String(error))

    expect(failure).toContain('First failure: threw null')
  })

  test('prints the first failure before shrinking, so a run cut short has it', async () => {
    const printedBy: number[] = []

    await fuzz(number, (value) => {
      printedBy.push(printed.mock.calls.length)

      return value > 10 ? `${value} is over 10` : undefined
    }).catch(() => undefined)

    expect(printed.mock.calls.join(' ')).toMatch(/case \d+ failed on \d+: \d+ is over 10/)
    // By the last shrink, and only once however many it took.
    expect(printedBy.at(-1)).toBe(1)
  })

  test('a case that holds when run again stops the run unshrunk, keeping what failed', async () => {
    let runs = 0
    const failure = await fuzz(numbers, () => {
      runs += 1

      return runs === 5 ? 'the fifth case' : undefined
    }, { runs: 50 }).catch((error: unknown) => String(error))

    expect(failure).toMatch(/after 5 run\(s\) and 0 shrink\(s\)/)
    expect(failure).toContain('held when run again')
    expect(failure).toContain('First failure: the fifth case')
    // The case, and the case again: no shrinking, and no case after it.
    expect(runs).toBe(6)
  })

  test('a failure that takes every later case with it stops at its case, not on the smallest input', async () => {
    let runs = 0
    const failure = await fuzz(numbers, () => {
      runs += 1

      if (runs === 7) throw new Error('connection refused')
      if (runs >= 5) throw new Error('false == true')

      return undefined
    }, { runs: 50 }).catch((error: unknown) => String(error))

    expect(failure).toMatch(/after 5 run\(s\) and 0 shrink\(s\)/)
    expect(failure).toContain('the case before it, which held, fails now too')
    expect(failure).toContain('The case before it: threw Error: connection refused')
    expect(failure).toMatch(/First failure: threw Error: false == true\n[\s\S]*fuzz\.test\.ts/)
    // The case, the case again and the one before it: no shrinking, and no case after it.
    expect(runs).toBe(7)
  })

  test('a failure in the very first case has no case before it to compare, and shrinks', async () => {
    const failure = await fuzz(number, (value) => `${value} refused`).catch((error: unknown) => String(error))

    expect(failure).toContain('Refused: 0 refused')
  })

  test('a failure of the input alone leaves the case before it holding, and shrinks', async () => {
    const failure = await fuzz(number, (value) => (value > 10 ? `${value} is over 10` : undefined)).catch((error: unknown) => String(error))

    expect(failure).toMatch(/Shrunk input: 11\b/)
    expect(failure).not.toContain('held when run again')
    expect(failure).not.toContain('fails now too')
  })

  test('a smallest case that holds when run at the end says so, and shows what failed first', async () => {
    let runs = 0
    const failure = await fuzz(numbers, () => {
      runs += 1

      // The case fails and fails again, then nothing does.
      return runs === 5 || runs === 6 ? 'only for a moment' : undefined
    }, { runs: 50 }).catch((error: unknown) => String(error))

    expect(failure).toContain('held when run again')
    expect(failure).toContain('First failure: only for a moment')
  })

  test('shrinks a sequence of up to 200 steps to the three a bug needs, past the hundred candidates Effect tries', async () => {
    // Dropping each step the bug does not need takes a candidate of its own.
    const steps = stepsOf(pick(['note', 'finish', 'reopen', 'invoice', 'signOff']), { maxLength: 200 })
    const failure = await fuzz(steps, signedOff).catch((error: unknown) => String(error))

    expect(failure).toContain('Refused: signed off after finish invoice signOff')
  })

  test('stops shrinking a slow property with a quarter of fuzzTimeout left, and says so', async () => {
    const failure = await fuzz(numbers, () => {
      // The first case to fail takes the test's whole time.
      setSystemTime(Date.now() + fuzzTimeout)

      return 'refused'
    }).catch((error: unknown) => String(error))

    expect(failure).toMatch(/after 1 run\(s\) and 0 shrink\(s\)[\s\S]*Stopped shrinking with a quarter of fuzzTimeout left: a smaller input may fail too/)
  })

  test('checks each example on every run, before the cases it generates, under the same property', async () => {
    const checked: number[] = []

    await fuzz(number, (value) => {
      checked.push(value)
    }, { runs: 3, examples: [2000, 3000] })

    expect(checked.slice(0, 2)).toEqual([2000, 3000])
    expect(checked).toHaveLength(5)
  })

  test('says which example was refused, and why, and runs no case after it', async () => {
    let runs = 0
    const failure = await fuzz(number, (value) => {
      runs += 1

      return value === 3000 ? 'over the limit' : undefined
    }, { runs: 50, examples: [2000, 3000, 4000] }).catch((error: unknown) => String(error))

    expect(failure).toContain('Example 2 of 3 refused: over the limit')
    expect(failure).toContain('Input: 3000')
    expect(runs).toBe(2)
  })

  test('shows where an example that throws threw', async () => {
    const failure = await fuzz(number, () => {
      throw new Error('out of disk')
    }, { examples: [2000] }).catch((error: unknown) => String(error))

    expect(failure).toMatch(/Example 1 of 1 refused: threw Error: out of disk\n[\s\S]*fuzz\.test\.ts/)
  })

  test('FUZZ_REPLAY runs the one case it names, without the examples', async () => {
    const script = (replay: string | undefined) => {
      const source = `
        import { Arbitrary, Schema as S } from 'effect'
        import { fuzz } from ${JSON.stringify(join(import.meta.dir, '../../src/fuzz.ts'))}

        const number = Arbitrary.schema(S.Int.check(S.isBetween({ minimum: 0, maximum: 1000 })))
        const checked = []
        const failure = await fuzz(number, (value) => {
          checked.push(value)

          return value > 10 ? 'over 10' : undefined
        }, { examples: [1] }).catch((error) => String(error))

        console.log(JSON.stringify({ checked, failure }))
      `
      const run = Bun.spawnSync(['bun', '-e', source], { env: { ...process.env, ...(replay === undefined ? {} : { FUZZ_REPLAY: replay }) }, stderr: 'ignore' })

      return S.decodeUnknownSync(S.fromJsonString(S.Struct({ checked: S.Array(S.Number), failure: S.String })))(run.stdout.toString())
    }

    const first = script(undefined)
    const token = /Replay: (.+)/.exec(first.failure)?.[1]

    expect(first.checked[0]).toBe(1)
    expect(token).toBeDefined()

    const replayed = script(token)

    expect(replayed.checked).not.toContain(1)
    expect(replayed.failure).toContain('Refused: over 10')
  })
})
