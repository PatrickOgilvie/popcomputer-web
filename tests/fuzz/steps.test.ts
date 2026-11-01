/**
 * The generators an application's lifecycle tests start from. `stepsOf`
 * gives sequences of a lifecycle's steps, and `textOf` text of its pieces;
 * both must reach their whole length within the runs a commit gate gives, or
 * a bug that needs several steps in order survives it.
 *
 * The lifecycle here is a job's: finished, invoiced, signed off. The
 * application's copy has a bug only that path reaches, signing off an
 * invoiced job by reopening it, among twelve steps as fieldops' job has.
 *
 * A failing sequence must also shrink to the steps its bug needs, as the
 * session fuzz's sequences of requests must: a project ada makes, a note
 * grace adds, ada hiding and showing the notes, and ada's edit of the
 * latest, which lets her change grace's note. A step can be needed only
 * until another shrinks, as the project the edit named before it shrank to
 * name her seeded one, or the show of a note a hide since dropped had hidden.
 *
 * Each check runs the 300 cases `fuzz` runs by default, from fixed seeds
 * whatever `FUZZ_SEED` says: these tests measure the generators, so a seed
 * that finds less must not pass them by chance.
 */
import { describe, expect, test } from 'bun:test'
import { Arbitrary, Effect } from 'effect'
import { pick, stepsOf, textOf } from '../../src/fuzz.js'

const STEPS = ['note', 'assign', 'schedule', 'start', 'pause', 'resume', 'finish', 'reopen', 'invoice', 'remind', 'signOff', 'archive'] as const

type Step = (typeof STEPS)[number]
type Status = 'open' | 'finished' | 'invoiced' | 'signedOff'

/** The rule: a job is finished, then invoiced, then signed off, and reopened until it is signed off. */
function next(status: Status, step: Step): Status {
  if (step === 'finish' && status === 'open') return 'finished'
  if (step === 'invoice' && status === 'finished') return 'invoiced'
  if (step === 'signOff' && status === 'invoiced') return 'signedOff'
  if (step === 'reopen' && status !== 'signedOff') return 'open'

  return status
}

/** The application's copy of the rule, with the planted bug. */
function applied(status: Status, step: Step): Status {
  return step === 'signOff' && status === 'invoiced' ? 'open' : next(status, step)
}

/** Whether the application and the rule agree after every step. */
function agrees(steps: ReadonlyArray<Step>): boolean {
  let expected: Status = 'open'
  let actual: Status = 'open'

  for (const step of steps) {
    expected = next(expected, step)
    actual = applied(actual, step)

    if (actual !== expected) return false
  }

  return true
}

interface NoteStep {
  readonly act: 'make' | 'note' | 'hide' | 'show' | 'edit'
  /** Where ada edits from: her seeded project, or the one she made, where an edit does nothing before she makes it. */
  readonly on?: 'seeded' | 'made'
}

/** Whether grace's note stays hers: the application lets ada edit it while it shows. */
function noteKept(steps: ReadonlyArray<NoteStep>): boolean {
  let made = false
  let noted = false
  let hidden = false

  for (const { act, on = 'seeded' } of steps) {
    if (act === 'make') made = true
    if (act === 'note') noted = true
    if (act === 'hide' || act === 'show') hidden = act === 'hide'
    if (act === 'edit' && (on === 'seeded' || made) && noted && !hidden) return false
  }

  return true
}

/** The default runs of `holds`, from `seed`. */
function check<A>(arbitrary: Arbitrary.Arbitrary<A>, holds: (value: A) => boolean, seed: string | number = 'popweb') {
  return Effect.runPromise(Arbitrary.checkEffect(arbitrary, holds, { runs: 300, seed }))
}

/** What the default runs of `holds` shrink to from each of ten seeds, or how a check that found nothing ended. */
function shrunkFrom<A>(arbitrary: Arbitrary.Arbitrary<A>, holds: (value: A) => boolean) {
  return Promise.all(['popweb', 1, 2, 3, 4, 5, 6, 7, 8, 9].map(async (seed) => {
    const result = await check(arbitrary, holds, seed)

    return result._tag === 'Falsified' ? result.shrunkInput : result._tag
  }))
}

/** Each value's size over the default runs. */
async function sizes<A>(arbitrary: Arbitrary.Arbitrary<A>, size: (value: A) => number): Promise<number[]> {
  const seen: number[] = []

  await check(arbitrary, (value) => seen.push(size(value)) > 0)

  return seen
}

const mean = (values: ReadonlyArray<number>) => values.reduce((sum, value) => sum + value, 0) / values.length

describe('stepsOf', () => {
  test('gives sequences of every length up to maxLength, five or six steps on average', async () => {
    const lengths = await sizes(stepsOf(pick(STEPS), { maxLength: 12 }), (steps) => steps.length)

    expect(mean(lengths)).toBeGreaterThan(4.5)
    expect(new Set(lengths)).toEqual(new Set(Array.from({ length: 13 }, (_, length) => length)))
  })

  test('finds a bug three steps deep from every seed within the default runs, shrunk to those three steps', async () => {
    const found = await shrunkFrom(stepsOf(pick(STEPS), { maxLength: 12 }), agrees)

    expect(found).toEqual(Array.from({ length: 10 }, () => ['finish', 'invoice', 'signOff']))
  })

  test('drops a step a later one needed only before it shrank, from every seed', async () => {
    // The edit needs ada's made project until it shrinks to her seeded one.
    const found = await shrunkFrom(stepsOf({ act: pick(['make', 'note', 'edit']), on: pick(['seeded', 'made']) }, { maxLength: 12 }), noteKept)

    expect(found).toEqual(Array.from({ length: 10 }, () => [{ act: 'note', on: 'seeded' }, { act: 'edit', on: 'seeded' }]))
  })

  test('drops a step that undid one since dropped, from every seed', async () => {
    // A show is needed while a hide comes before it, and not once the hide is dropped.
    const found = await shrunkFrom(stepsOf({ act: pick(['make', 'note', 'hide', 'show', 'edit']) }, { maxLength: 12 }), noteKept)

    expect(found).toEqual(Array.from({ length: 10 }, () => [{ act: 'note' }, { act: 'edit' }]))
  })

  test('takes a step as a record of generated fields', async () => {
    const lengths = await sizes(stepsOf({ step: pick(STEPS), quantity: pick([1, 2, 5]) }, { maxLength: 3 }), (sequence) =>
      sequence.every((each) => STEPS.includes(each.step) && [1, 2, 5].includes(each.quantity)) ? sequence.length : -1
    )

    expect(Math.min(...lengths)).toBe(0)
    expect(Math.max(...lengths)).toBe(3)
  })
})

describe('textOf', () => {
  test('gives text of every number of pieces up to maxPieces', async () => {
    const lengths = await sizes(textOf(['x'], 16), (text) => text.length)

    expect(mean(lengths)).toBeGreaterThan(6)
    expect(Math.max(...lengths)).toBe(16)
  })
})
