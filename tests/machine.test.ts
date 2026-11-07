/**
 * A state machine as a value: its table says what every event does in every
 * state, so a pair nobody thought about cannot exist.
 */
import { describe, expect, test } from 'bun:test'
import { Data, Effect, Result } from 'effect'
import { cell, rows, step, type Table } from '../src/machine.js'

type Door = Data.TaggedEnum<{ Open: { readonly visits: number }; Shut: {}; Locked: {} }>
type DoorEvent = Data.TaggedEnum<{ Enter: {}; Shut: {}; Lock: {} }>
const Door = Data.taggedEnum<Door>()
const DoorEvent = Data.taggedEnum<DoorEvent>()

const door: Table<Door, DoorEvent, number> = {
  Open: {
    Enter: { to: 'Open', run: (state) => [Door.Open({ visits: state.visits + 1 }), state.visits + 1] },
    Shut: { to: 'Shut', run: (state) => [Door.Shut(), state.visits] },
    Lock: { refuse: 'an open door cannot lock' },
  },
  Shut: {
    Enter: { refuse: 'the door is shut' },
    Shut: { ignore: 'it is shut already', output: 0 },
    Lock: { to: 'Locked', run: () => [Door.Locked(), 0] },
  },
  Locked: {
    Enter: { refuse: 'the door is locked' },
    Shut: { ignore: 'it is shut already', output: 0 },
    Lock: { ignore: 'it is locked already', output: 0 },
  },
}

// A missing cell and a move that returns another state are type errors.
// @ts-expect-error Locked × Lock is not said.
export const missing: Table<Door, DoorEvent, number> = { Open: door.Open, Shut: door.Shut, Locked: { Enter: door.Locked.Enter, Shut: door.Locked.Shut } }
export const wrongTarget: Table<Door, DoorEvent, number> = {
  ...door,
  // @ts-expect-error `to` says Locked, so `run` must return Locked.
  Shut: { ...door.Shut, Lock: { to: 'Locked', run: () => [Door.Shut(), 0] } },
}

describe('step', () => {
  test('a move gives the next state and its output', () => {
    expect(step(door, Door.Open({ visits: 1 }), DoorEvent.Enter())).toEqual(Result.succeed([Door.Open({ visits: 2 }), 2]))
  })

  test('an ignored event leaves the state and gives the output the table states', () => {
    expect(step(door, Door.Shut(), DoorEvent.Shut())).toEqual(Result.succeed([Door.Shut(), 0]))
  })

  test('a refused event says which state, which event and why', () => {
    const refused = step(door, Door.Locked(), DoorEvent.Enter())

    expect(Result.isFailure(refused) && { ...refused.failure }).toMatchObject({ state: 'Locked', event: 'Enter', because: 'the door is locked' })
  })
})

describe('a move to one of several states', () => {
  type Tank = Data.TaggedEnum<{ Empty: {}; Filled: { readonly litres: number } }>
  type TankEvent = Data.TaggedEnum<{ Draw: { readonly litres: number } }>
  const Tank = Data.taggedEnum<Tank>()
  const TankEvent = Data.taggedEnum<TankEvent>()

  const tank: Table<Tank, TankEvent, number> = {
    Empty: { Draw: { ignore: 'there is nothing to draw', output: 0 } },
    Filled: {
      Draw: {
        to: ['Empty', 'Filled'],
        run: (state, event) => state.litres > event.litres ? [Tank.Filled({ litres: state.litres - event.litres }), event.litres] : [Tank.Empty(), state.litres],
      },
    },
  }

  test('chooses from what the event carries', () => {
    expect(step(tank, Tank.Filled({ litres: 3 }), TankEvent.Draw({ litres: 1 }))).toEqual(Result.succeed([Tank.Filled({ litres: 2 }), 1]))
    expect(step(tank, Tank.Filled({ litres: 3 }), TankEvent.Draw({ litres: 5 }))).toEqual(Result.succeed([Tank.Empty(), 3]))
  })

  test('reads as every state it may move to', () => {
    expect(rows(tank)).toContainEqual({ from: 'Filled', on: 'Draw', to: 'Empty or Filled', mark: 'ok' })
  })

  test('a move to a state its cell does not name is a defect', () => {
    const lying: Table<Tank, TankEvent, number> = {
      ...tank,
      Filled: { Draw: { to: ['Empty'], run: (state) => [state, 0] } },
    }

    expect(() => step(lying, Tank.Filled({ litres: 1 }), TankEvent.Draw({ litres: 1 }))).toThrow('moved to Filled, which its cell does not name')
  })
})

describe('a state the table does not hold', () => {
  test('is a defect, not a move that does nothing', () => {
    // SAFETY: a durable state decoded without its schema is the way here: the types refuse it.
    expect(() => step(door, { _tag: 'Ajar' } as unknown as Door, DoorEvent.Enter())).toThrow('No cell for Enter in Ajar')
  })
})

describe('rows', () => {
  test('read every cell without running a move', () => {
    const untouchable: Table<Door, DoorEvent, number> = {
      ...door,
      Open: { ...door.Open, Enter: { to: 'Open', run: () => { throw new Error('a row runs no move') } } },
    }

    expect(rows(untouchable)).toHaveLength(9)
    expect(rows(door)).toContainEqual({ from: 'Open', on: 'Shut', to: 'Shut', mark: 'ok' })
    expect(rows(door)).toContainEqual({ from: 'Shut', on: 'Enter', to: 'Shut', mark: 'refused: the door is shut' })
    expect(rows(door)).toContainEqual({ from: 'Locked', on: 'Lock', to: 'Locked', mark: 'ignored: it is locked already' })
  })
})

describe('cell', () => {
  test('moves through the table, and a refused move changes nothing', async () => {
    const program = Effect.gen(function* () {
      const held = cell(door, Door.Open({ visits: 0 }))

      yield* held.send(DoorEvent.Shut())
      const refused = yield* Effect.flip(held.send(DoorEvent.Enter()))
      const state = yield* held.state

      return { because: refused.because, state }
    })

    expect(await Effect.runPromise(program)).toEqual({ because: 'the door is shut', state: Door.Shut() })
  })

  test('overlapping moves each see the state the last one left', async () => {
    const program = Effect.gen(function* () {
      const held = cell(door, Door.Open({ visits: 0 }))

      yield* Effect.forEach(Array.from({ length: 50 }, () => DoorEvent.Enter()), held.send, { concurrency: 'unbounded' })

      return yield* held.state
    })

    expect(await Effect.runPromise(program)).toEqual(Door.Open({ visits: 50 }))
  })
})
