/**
 * Random walks over a machine's table, so every table gets the same check:
 * whatever the order of its events, a refused one changes nothing, and what
 * the machine promises holds after each move.
 */
import { Arbitrary, Result } from 'effect'
import { stepsOf } from '../../src/fuzz.js'
import { step, type Table } from '../../src/machine.js'
import { property, show, type Refusal } from './property'

interface WalkStep<S, E, Out> {
  readonly before: S
  readonly event: E
  readonly after: S
  readonly output: Out
}

/**
 * Walk `table` from `initial` through generated `events`, asking `holds` about
 * each move that was not refused and about the walk so far.
 */
export function machineProperty<S extends { readonly _tag: string }, E extends { readonly _tag: string }, Out>(
  name: string,
  table: Table<S, E, Out>,
  initial: S,
  events: Arbitrary.Arbitrary<E>,
  holds: (move: WalkStep<S, E, Out>, walk: ReadonlyArray<WalkStep<S, E, Out>>) => Refusal
): void {
  property(name, stepsOf(events, { maxLength: 24 }), (sequence) => {
    const walk: Array<WalkStep<S, E, Out>> = []
    let state = initial

    for (const event of sequence) {
      const moved = step(table, state, event)

      if (Result.isFailure(moved)) continue

      const [after, output] = moved.success
      const move = { before: state, event, after, output }

      walk.push(move)
      state = after

      const refusal = holds(move, walk)

      if (refusal !== undefined) return `${typeof refusal === 'string' ? refusal : refusal.join(' ')}, after ${show(walk.map((each) => each.event))}`
    }

    return undefined
  })
}
