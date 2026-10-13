/**
 * Application cookies: declared once with their value's schema, read, set
 * and cleared by actions, and carried by the response.
 */

import { describe, expect, test } from 'bun:test'
import { Effect, Option, Schema as S } from 'effect'
import { Hono } from 'hono'
import { setupWeb } from '../../src/setup.js'
import { action } from '../../src/effect/action.js'
import { flash, json, redirect } from '../../src/effect/responses.js'
import { cookie } from '../../src/effect/cookies.js'

const cartCookie = cookie('cart', S.Struct({ id: S.String, items: S.Number }), { maxAge: '30 days', path: '/r' })

function createApp() {
  const app = new Hono()
  const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) })

  routes
    .post('/r/cart', action(Effect.gen(function* () {
      yield* cartCookie.set({ id: 'cart-1', items: 2 })
      yield* flash('notice', 'Added to your cart.')

      return yield* redirect('/r/menu')
    })))
    .get('/r/cart', action(Effect.gen(function* () {
      const cart = yield* cartCookie.read

      return yield* json({ cart: Option.getOrNull(cart) })
    })))
    .delete('/r/cart', action(Effect.gen(function* () {
      yield* cartCookie.clear

      return yield* json({ cleared: true })
    })))

  return app
}

const cartCookieOf = (response: Response) => response.headers.getSetCookie().find((value) => value.startsWith('cart='))

describe('cookie', () => {
  test('an action sets a cookie on its response, beside flash, and the next request reads it', async () => {
    const app = createApp()
    const set = await app.request('/r/cart', { method: 'POST' })
    const written = cartCookieOf(set)

    expect(set.status).toBe(303)
    expect(written).toContain('Path=/r')
    expect(written).toContain('HttpOnly')
    expect(written).toContain('SameSite=Lax')
    expect(written).toContain(`Max-Age=${30 * 24 * 60 * 60}`)
    expect(set.headers.getSetCookie().some((value) => value.startsWith('popweb-flash='))).toBe(true)

    const read = await app.request('/r/cart', { headers: { Cookie: written?.split(';')[0] ?? '' } })

    expect(await read.json()).toEqual({ cart: { id: 'cart-1', items: 2 } })
  })

  test('a value the schema rejects, or none, reads as none', async () => {
    const app = createApp()
    const tampered = await app.request('/r/cart', { headers: { Cookie: 'cart=%7B%22id%22%3A1%7D' } })
    const absent = await app.request('/r/cart')

    expect(await tampered.json()).toEqual({ cart: null })
    expect(await absent.json()).toEqual({ cart: null })
  })

  test('clear expires the cookie', async () => {
    const cleared = cartCookieOf(await createApp().request('/r/cart', { method: 'DELETE' }))

    expect(cleared).toContain('Max-Age=0')
    expect(cleared).toContain('Path=/r')
  })
})
