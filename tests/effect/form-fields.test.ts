import { describe, expect, test } from 'bun:test'
import { Effect, Schema as S } from 'effect'
import { Hono } from 'hono'
import { setupWeb } from '../../src/setup.js'
import { action } from '../../src/effect/action.js'
import { json } from '../../src/effect/responses.js'
import { validateRequest } from '../../src/effect/validation.js'
import { nestFields } from '../../src/effect/form-fields.js'
import { coercedNumber, requiredString, upload } from '../../src/effect/schema.js'
import { readError } from '../../src/testing.js'

describe('nestFields', () => {
  test('nests bracket and dotted names into objects and lists', () => {
    expect(nestFields({
      'lines[0][sku]': 'A-1',
      'lines[0][quantity]': '2',
      'lines.1.sku': 'B-2',
      'lines[1][quantity]': '1',
      'address[city]': 'Leeds',
      'tags[]': ['a', 'b'],
      name: 'Order',
    })).toEqual({
      lines: [{ sku: 'A-1', quantity: '2' }, { sku: 'B-2', quantity: '1' }],
      address: { city: 'Leeds' },
      tags: ['a', 'b'],
      name: 'Order',
    })
  })

  test('a single value under a [] name is a list of one', () => {
    expect(nestFields({ 'tags[]': 'a' })).toEqual({ tags: ['a'] })
  })

  test('ignores names that would reach an object prototype', () => {
    const nested = nestFields({ '__proto__[admin]': 'true', 'user[constructor][prototype]': 'x', 'a[b]': '1' })

    expect(nested).toEqual({ a: { b: '1' } })
    expect(({} as Record<string, unknown>).admin).toBeUndefined()
  })

  test('keeps a list index that is not a small number as a key', () => {
    expect(nestFields({ 'lines[99999999][q]': '1' })).toEqual({ lines: { 99999999: { q: '1' } } })
  })
})

describe('validateRequest reads nested form and query fields', () => {
  const Line = S.Struct({ sku: requiredString, quantity: coercedNumber })
  const app = new Hono()
  const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) })

  routes
    .post('/orders', action(Effect.gen(function* () {
      const order = yield* validateRequest(S.Struct({ lines: S.Array(Line), note: S.optional(S.String) }))

      return yield* json(order)
    })))
    .post('/receipts', action(Effect.gen(function* () {
      const claim = yield* validateRequest(S.Struct({
        items: S.Array(S.Struct({ amount: coercedNumber, receipt: upload({ maxBytes: 1024 }) })),
      }))

      return yield* json({ amounts: claim.items.map((item) => item.amount), names: claim.items.map((item) => item.receipt.name) })
    })))
    .get('/search', action(Effect.gen(function* () {
      const query = yield* validateRequest(S.Struct({ status: S.Array(S.String), sort: S.optional(S.String) }))

      return yield* json(query)
    })))

  test('an urlencoded form', async () => {
    const body = new URLSearchParams('lines[0][sku]=A-1&lines[0][quantity]=2&lines[1][sku]=B-2&lines[1][quantity]=1&note=first&note=last')
    const res = await app.request('/orders', { method: 'POST', body, headers: { Accept: 'application/json' } })

    expect(await res.json()).toEqual({ lines: [{ sku: 'A-1', quantity: 2 }, { sku: 'B-2', quantity: 1 }], note: 'last' })
  })

  test('a multipart form with files, as Inertia sends one with an upload', async () => {
    const body = new FormData()
    body.append('items[0][amount]', '12.5')
    body.append('items[0][receipt]', new File(['a'], 'taxi.pdf', { type: 'application/pdf' }))
    body.append('items[1][amount]', '3')
    body.append('items[1][receipt]', new File(['b'], 'lunch.pdf', { type: 'application/pdf' }))

    const res = await app.request('/receipts', { method: 'POST', body, headers: { Accept: 'application/json' } })

    expect(await res.json()).toEqual({ amounts: [12.5, 3], names: ['taxi.pdf', 'lunch.pdf'] })
  })

  test('a failing list item is reported under its path', async () => {
    const body = new URLSearchParams('lines[0][sku]=A-1&lines[0][quantity]=2&lines[1][sku]=&lines[1][quantity]=1')
    const res = await app.request('/orders', { method: 'POST', body, headers: { Accept: 'application/json' } })

    expect(res.status).toBe(422)
    expect(Object.keys((await readError(res)).errors ?? {})).toEqual(['lines.1.sku'])
  })

  test('every value of a [] query parameter', async () => {
    const res = await app.request('/search?status[]=open&status[]=closed&sort=new', { headers: { Accept: 'application/json' } })

    expect(await res.json()).toEqual({ status: ['open', 'closed'], sort: 'new' })
  })
})
