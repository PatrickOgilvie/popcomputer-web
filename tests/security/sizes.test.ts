/**
 * Requests whose size alone costs the isolate that serves every request: a
 * list of thousands of invalid items, each kept, observed and answered as
 * an error of its own.
 *
 * Precedents: Laravel's validator and Zod report every invalid item; a
 * Worker's isolate shares its memory among the requests it serves.
 */

import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { Effect, Layer, Schema as S } from 'effect'
import { action } from '../../src/effect/action.js'
import { EffectErrorObserverService, type EffectErrorEvent } from '../../src/effect/error-observer.js'
import { json } from '../../src/effect/responses.js'
import { coercedNumber, maxItems, minItems } from '../../src/effect/schema.js'
import { validateRequest } from '../../src/effect/validation.js'
import { setupWeb } from '../../src/setup.js'
import { testEnv } from '../../src/testing.js'

const Line = S.Struct({ amount: coercedNumber })
const Order = S.Struct({ items: maxItems(Line, 50) })
const Lines = S.Struct({ lines: S.Array(Line) })
const Pair = S.Struct({ items: minItems(Line, 2) })
const Ok = S.Struct({ ok: S.Boolean })

function createApp(observed: EffectErrorEvent[] = []) {
  const app = new Hono()
  const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) }).services({
    app: Layer.succeed(EffectErrorObserverService, EffectErrorObserverService.of({
      observe: (event) => Effect.sync(() => void observed.push(event)),
    })),
  })
  const accept = (schema: S.Codec<unknown, unknown>) => action(Effect.gen(function* () {
    yield* validateRequest(schema)

    return yield* json(Ok, { ok: true })
  }))

  routes.post('/orders', accept(Order)).post('/lines', accept(Lines)).post('/pairs', accept(Pair))

  return app
}

/** A body of one list, its items' fields as a form sends them. */
type ListBody = Readonly<Partial<Record<'items' | 'lines', ReadonlyArray<Readonly<Record<string, string>>>>>>

const post = (app: Hono, path: string, body: ListBody) => app.request(path, {
  method: 'POST',
  headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}, testEnv({ ENVIRONMENT: 'production' }))

/** `count` items, none with an amount. */
const empty = (count: number) => Array.from({ length: count }, () => ({}))

describe('a list longer than its maxItems', () => {
  test("is refused with the limit's message alone, however many of its items are invalid", async () => {
    const app = createApp()

    for (const count of [51, 16_000]) {
      const res = await post(app, '/orders', { items: empty(count) })

      expect({ count, status: res.status, errors: (await res.json()).errors }).toEqual({
        count,
        status: 422,
        errors: { items: 'Must have at most 50 items' },
      })
    }
  })

  test('within the limit still reports each invalid item', async () => {
    const res = await post(createApp(), '/orders', { items: [{ amount: '1' }, {}, { amount: 'x' }] })

    expect((await res.json()).errors).toEqual({ 'items.1.amount': 'This field is required', 'items.2.amount': 'Expected a number' })
  })

  test("and a list shorter than its minItems is refused with that limit's message", async () => {
    const res = await post(createApp(), '/pairs', { items: empty(1) })

    expect((await res.json()).errors).toEqual({ items: 'Must have at least 2 items' })
  })
})

describe('a list of thousands of invalid items', () => {
  test('lists at most 100 fields and says more were invalid, in the 422 and to the error observer', async () => {
    const observed: EffectErrorEvent[] = []
    const res = await post(createApp(observed), '/lines', { lines: empty(16_000) })
    const body = await res.json()
    const fields = Object.keys(body.errors)

    expect(res.status).toBe(422)
    expect(fields).toHaveLength(101)
    expect(fields.slice(0, 2)).toEqual(['lines.0.amount', 'lines.1.amount'])
    expect(body.errors.form).toBe('More than 100 fields are invalid; the first 100 are listed.')
    expect(Object.keys(observed[0].structured?.validation?.fields ?? {})).toEqual(fields)
    expect(observed[0].structured?.message.length).toBeLessThan(3_000)
  })

  test('is answered the same size whatever the count', async () => {
    const app = createApp()
    const sizes = await Promise.all([1_000, 16_000].map(async (count) => (await (await post(app, '/lines', { lines: empty(count) })).text()).length))

    expect(sizes[0]).toBe(sizes[1])
    expect(sizes[1]).toBeLessThan(50_000)
  })

  test('as a form post too', async () => {
    const res = await createApp().request('/lines', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: Array.from({ length: 2_000 }, (_, index) => `lines[${index}][amount]=x`).join('&'),
    }, testEnv({ ENVIRONMENT: 'production' }))

    expect(Object.keys((await res.json()).errors)).toHaveLength(101)
  })
})
