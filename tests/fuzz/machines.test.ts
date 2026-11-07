/**
 * The promises of the machines with a table, on random walks.
 */
import { describe } from 'bun:test'
import { Arbitrary, Data } from 'effect'
import { pendingPurgesTable } from '../../src/effect/response-cache.js'
import { machineProperty } from './machine'
import { oneOf, pick } from './property'

type PendingEvent = Data.TaggedEnum<{ Add: { readonly tags: ReadonlyArray<string> }; Take: {} }>
const PendingEvent = Data.taggedEnum<PendingEvent>()

const events = oneOf(
  Arbitrary.map(pick(['a', 'b', 'c']), (tag): PendingEvent => PendingEvent.Add({ tags: [tag] })),
  Arbitrary.Constant<PendingEvent>(PendingEvent.Take())
)

describe('pending tags', () => {
  machineProperty('a take hands over exactly what was added before it, once', pendingPurgesTable, { _tag: 'Open', tags: new Set<string>() }, events, (move, walk) => {
    if (move.event._tag !== 'Take') return undefined

    const added = new Set(walk.flatMap((each) => each.event._tag === 'Add' ? each.event.tags : []))
    const handed = new Set(move.output)
    const takes = walk.filter((each) => each.event._tag === 'Take').length

    if (takes > 1) return 'a second take moved'
    if (handed.size !== added.size || [...added].some((tag) => !handed.has(tag))) return `took ${[...handed]}, having added ${[...added]}`

    return undefined
  })
})
