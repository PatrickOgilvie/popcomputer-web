/**
 * A state machine as a value.
 *
 * A {@link Table} says what every event does in every state, as plain data, so
 * a state and event nobody thought about cannot exist: a missing cell is a
 * type error, and so is a move that returns a state other than the one it
 * names. {@link step} runs a table, purely. {@link cell} holds a machine in a
 * `Ref`, where moves are atomic. {@link rows} reads a table without running a
 * move, which the docs and the tests derive from.
 *
 * A machine's state is a `Data.TaggedEnum`, and so are its events. A cell that
 * moves returns an output as well as the next state: data saying what to do,
 * so the table decides and its caller acts.
 *
 * @internal
 */
import { Effect, Ref, Result, Schema } from 'effect'

type Tagged = { readonly _tag: string }

type Of<U extends Tagged, Tag extends U['_tag']> = Extract<U, { readonly _tag: Tag }>

/** A move to the state `to` names, which `run` must return. */
type Move<S extends Tagged, From, On, Out> = {
  readonly [To in S['_tag']]: {
    readonly to: To
    readonly run: (state: From, event: On) => readonly [Of<S, To>, Out]
  }
}[S['_tag']]

/**
 * What one event does in one state: a move, an event that changes nothing
 * for the reason it gives, or one the state refuses.
 */
export type Cell<S extends Tagged, From, On, Out> =
  | Move<S, From, On, Out>
  | { readonly ignore: string; readonly output: Out }
  | { readonly refuse: string }

/** Every state against every event. A missing cell is a type error. */
export type Table<S extends Tagged, E extends Tagged, Out> = {
  readonly [Tag in S['_tag']]: { readonly [Name in E['_tag']]: Cell<S, Of<S, Tag>, Of<E, Name>, Out> }
}

/** An event its state refuses, and why. */
export class Refused extends Schema.TaggedError<Refused>()('Refused', {
  state: Schema.String,
  event: Schema.String,
  because: Schema.String,
}) {}

const cellOf = <S extends Tagged, E extends Tagged, Out>(table: Table<S, E, Out>) =>
  // SAFETY: Table holds a cell for every state and event, each typed by its own tags.
  table as Readonly<Record<string, Readonly<Record<string, Cell<S, S, E, Out>>>>>

/** The state an event leaves a machine in and what it says to do, or why the state refuses it. */
export function step<S extends Tagged, E extends Tagged, Out>(
  table: Table<S, E, Out>,
  state: S,
  event: E
): Result.Result<readonly [S, Out], Refused> {
  const cell = cellOf(table)[state._tag]?.[event._tag]

  if (cell === undefined) throw new RangeError(`No cell for ${event._tag} in ${state._tag}`)
  if ('refuse' in cell) return Result.fail(new Refused({ state: state._tag, event: event._tag, because: cell.refuse }))
  if ('ignore' in cell) return Result.succeed([state, cell.output])

  return Result.succeed(cell.run(state, event))
}

/** One cell of a table, as the docs and the tests read it. */
export interface TableRow {
  readonly from: string
  readonly on: string
  readonly to: string
  /** `ok`, or `refused:` or `ignored:` with the reason the cell gives. */
  readonly mark: string
}

/** A table's cells as rows, read without running a move. */
export function rows<S extends Tagged, E extends Tagged, Out>(table: Table<S, E, Out>): ReadonlyArray<TableRow> {
  return Object.entries(cellOf(table)).flatMap(([from, events]) =>
    Object.entries(events).map(([on, cell]) => ({
      from,
      on,
      to: 'to' in cell ? cell.to : from,
      mark: 'refuse' in cell ? `refused: ${cell.refuse}` : 'ignore' in cell ? `ignored: ${cell.ignore}` : 'ok',
    }))
  )
}

/** A machine held in a `Ref`. */
export interface MachineCell<S extends Tagged, E extends Tagged, Out> {
  readonly state: Effect.Effect<S>
  /** Move the machine. A move is atomic, and a refused one changes nothing. */
  readonly send: (event: E) => Effect.Effect<Out, Refused>
}

/** Hold a machine in a `Ref`, starting at `initial`. */
export function cell<S extends Tagged, E extends Tagged, Out>(table: Table<S, E, Out>, initial: S): MachineCell<S, E, Out> {
  const held = Ref.makeUnsafe(initial)

  return {
    state: Ref.get(held),
    send: (event) => Effect.flatten(Ref.modify(held, (state): readonly [Effect.Effect<Out, Refused>, S] =>
      Result.match(step(table, state, event), {
        onFailure: (refused) => [Effect.fail(refused), state],
        onSuccess: ([next, output]) => [Effect.succeed(output), next],
      })
    )),
  }
}
