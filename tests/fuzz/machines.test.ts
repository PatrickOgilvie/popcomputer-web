/**
 * The promises of the machines with a table, on random walks.
 */
import { describe } from 'bun:test'
import { Arbitrary, Data, Option } from 'effect'
import { pendingPurgesTable } from '../../src/effect/response-cache.js'
import { machineProperty } from './machine'
import { oneOf, pick } from './property'

type PendingEvent = Data.TaggedEnum<{ Add: { readonly tags: ReadonlyArray<string> }; Wrote: {}; Take: {}; Abandon: {} }>
const PendingEvent = Data.taggedEnum<PendingEvent>()

const events = oneOf(
  Arbitrary.map(pick(['a', 'b', 'c']), (tag): PendingEvent => PendingEvent.Add({ tags: [tag] })),
  Arbitrary.Constant<PendingEvent>(PendingEvent.Wrote()),
  Arbitrary.Constant<PendingEvent>(PendingEvent.Take()),
  Arbitrary.Constant<PendingEvent>(PendingEvent.Abandon())
)

describe('pending purges', () => {
  machineProperty(
    'settle once: a success hands over what was added, and a failure the same only after a write',
    pendingPurgesTable,
    { _tag: 'Open', tags: new Set<string>(), wrote: false },
    events,
    (move, walk) => {
      if (move.event._tag !== 'Take' && move.event._tag !== 'Abandon') return undefined

      const added = new Set(walk.flatMap((each) => each.event._tag === 'Add' ? each.event.tags : []))
      const wrote = walk.some((each) => each.event._tag === 'Wrote')
      const settles = walk.filter((each) => each.event._tag === 'Take' || each.event._tag === 'Abandon').length

      if (settles > 1) return 'a second settlement moved'
      if (move.event._tag === 'Abandon' && !wrote) return Option.isNone(move.output) ? undefined : 'a failure with no write owed purges'

      const handed = new Set(Option.getOrElse(move.output, () => []))

      if (handed.size !== added.size || [...added].some((tag) => !handed.has(tag))) return `settled ${[...handed]}, having added ${[...added]}`

      return undefined
    }
  )
})
