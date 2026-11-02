/**
 * An action that declares its input, `action(form(Schema), handler)`: the
 * handler receives the request's fields decoded, a failed form goes back to
 * its page and runs nothing, the route's layers decide first, and the route
 * table records what the route accepts.
 */

import { describe, expect, test } from 'bun:test'
import { Effect, Schema as S } from 'effect'
import { Hono } from 'hono'
import { setupWeb } from '../../src/setup.js'
import { action, form } from '../../src/effect/action.js'
import { RequireAuthLayer } from '../../src/effect/auth.js'
import { json, redirect, render } from '../../src/effect/responses.js'
import { coercedNumber, requiredString } from '../../src/effect/schema.js'

const paths = { home: '/', items: '/items', notes: '/notes', upload: '/upload' } as const

const Item = S.Struct({ name: requiredString, quantity: coercedNumber })
const Received = S.Struct({ name: S.String, quantity: S.Number, keys: S.Array(S.String) })
const Note = S.Struct({ note: S.String })

function createApp() {
  const app = new Hono()
  const ran: unknown[] = []
  const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page), paths })

  routes
    .get(paths.items, action(render('Items/Index')))
    .post(paths.items, action(form(Item), (input) => Effect.gen(function* () {
      ran.push(input)

      return yield* json(Received, { name: input.name, quantity: input.quantity, keys: Object.keys(input) })
    })))
    .post(paths.upload, action(form(Note, { bodyLimit: 64, request: { order: ['body'] } }), (input) => json(Note, input)))
  routes.provide(RequireAuthLayer).post(paths.notes, action(form(Item), () => redirect(paths.home)))

  return { app, ran, routes }
}

const posted = (body: string, headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
  body,
})

const asJson = { Accept: 'application/json' }

describe('an action that declares its input', () => {
  test('hands its handler the input decoded, without the keys its schema does not declare', async () => {
    const { app, ran } = createApp()
    const res = await app.request(paths.items, posted('name=Bolt&quantity=3&admin=true', asJson))

    expect(await res.json()).toEqual({ name: 'Bolt', quantity: 3, keys: ['name', 'quantity'] })
    expect(ran).toEqual([{ name: 'Bolt', quantity: 3 }])
  })

  test('sends a failed form back to its page with the errors, and a JSON client a 422, without running the handler', async () => {
    const { app, ran } = createApp()
    const page = await app.request(paths.items, posted('name=&quantity=3', { Referer: 'http://localhost/items' }))
    const client = await app.request(paths.items, posted('name=&quantity=3', asJson))

    expect([page.status, page.headers.get('Location')]).toEqual([303, '/items'])
    expect(client.status).toBe(422)
    expect(Object.keys((await client.json()).errors)).toEqual(['name'])
    expect(ran).toEqual([])
  })

  test("reads the request as validateRequest's options say", async () => {
    const { app } = createApp()

    // Only the body is read, so a query value is no note.
    expect((await app.request(`${paths.upload}?note=query`, posted('', asJson))).status).toBe(422)
    expect(await (await app.request(`${paths.upload}?note=query`, posted('note=body', asJson))).json()).toEqual({ note: 'body' })
    expect((await app.request(paths.upload, posted(`note=${'x'.repeat(100)}`, asJson))).status).toBe(413)
  })

  test("lets the route's layers decide before the input is read", async () => {
    const { app } = createApp()

    // Signed out, an invalid form is asked to sign in, not shown its errors.
    expect((await app.request(paths.notes, posted('name=', asJson))).status).toBe(401)
  })

  test('is recorded in the route table, with the fields it decodes', () => {
    const { routes } = createApp()
    const rows = new Map(routes.toJson().map((row) => [`${row.method} ${row.path}`, row]))

    expect(rows.get('post /items')?.input).toEqual({ fields: ['name', 'quantity'] })
    expect(rows.get('post /upload')?.input).toEqual({ fields: ['note'], bodyLimit: 64 })
    expect(rows.get('get /items')?.input).toBeUndefined()
    expect(routes.getRegistry().all().find((row) => row.method === 'post' && row.path === paths.items)?.input?.schema).toBe(Item)
  })
})

// Checked by `bun run test:types`, never run: the handler's input is the schema's decoded type, both ways.
export function inputIsTyped() {
  return action(form(Item), (input) => Effect.gen(function* () {
    const decoded: { readonly name: string; readonly quantity: number } = input
    const sameAsInput: typeof input = { name: 'Bolt', quantity: 3 }

    return yield* json(S.Struct({ quantity: S.Number }), { quantity: decoded.quantity + sameAsInput.quantity })
  }))
}
