/**
 * Machines 26 and 27: the purges a piece
 * of work owes and the tags a stored response carries. Each is taken once.
 */
import { describe, expect, test } from 'bun:test'
import { Cause, Effect, Exit, Option } from 'effect'
import { makePendingCacheTags, makePendingPurges } from '../../src/effect/response-cache.js'

const dieMessage = (exit: Exit.Exit<unknown, unknown>): string =>
  Exit.isFailure(exit) ? Cause.pretty(exit.cause) : 'it succeeded'

describe('pending purges', () => {
  test('hands over what was added, once', async () => {
    const pending = makePendingPurges()

    await Effect.runPromise(pending.add(['a', 'b']))
    await Effect.runPromise(pending.add(['b', 'c']))

    expect(await Effect.runPromise(pending.take)).toEqual(['a', 'b', 'c'])
  })

  test('M26.T17: a second take is refused, so no tag is purged twice', async () => {
    const pending = makePendingPurges()

    await Effect.runPromise(pending.add(['a']))
    await Effect.runPromise(pending.take)

    expect(dieMessage(await Effect.runPromiseExit(pending.take))).toContain('settled once')
    expect(dieMessage(await Effect.runPromiseExit(pending.abandon))).toContain('settled once')
  })

  test('a failure owes nothing before a write commits, and everything after one', async () => {
    const before = makePendingPurges()
    const after = makePendingPurges()

    await Effect.runPromise(before.add(['a']))
    await Effect.runPromise(after.add(['a']))
    await Effect.runPromise(after.wrote)

    expect(await Effect.runPromise(before.abandon)).toEqual(Option.none())
    expect(await Effect.runPromise(after.abandon)).toEqual(Option.some(['a']))
  })

  test('a write after the purges settled is no route\'s to purge, and is no defect', async () => {
    const pending = makePendingPurges()

    await Effect.runPromise(pending.take)

    expect(Exit.isSuccess(await Effect.runPromiseExit(pending.wrote))).toBe(true)
  })

  test('a tag added after the take names itself in the defect', async () => {
    const pending = makePendingPurges()

    await Effect.runPromise(pending.take)

    expect(dieMessage(await Effect.runPromiseExit(pending.add(['late'])))).toContain('purgeCache(late): The work it belongs to has finished')
  })
})

describe('pending cache tags', () => {
  test('M27.T10: a second take is refused, so a page is tagged once', async () => {
    const pending = makePendingCacheTags()

    await Effect.runPromise(pending.add(['a']))
    await Effect.runPromise(pending.take)

    expect(dieMessage(await Effect.runPromiseExit(pending.take))).toContain('taken once')
  })

  test('a tag added after the take names itself in the defect', async () => {
    const pending = makePendingCacheTags()

    await Effect.runPromise(pending.take)

    expect(dieMessage(await Effect.runPromiseExit(pending.add(['late'])))).toContain('tagCache(late): Its route has stored the response')
  })
})
