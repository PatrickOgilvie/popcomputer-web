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
import { validateRequest } from '../../src/effect/validation.js'
import { requiredString } from '../../src/effect/schema.js'
import { cookie } from '../../src/effect/cookies.js'
import { readCookie, testBrowser } from '../../src/testing.js'

const cartCookie = cookie('cart', S.Struct({ id: S.String, items: S.Number }), { maxAge: '30 days', path: '/r' })
// A pointer the server trusts only when the signature holds.
const impersonationCookie = cookie('impersonation', S.Struct({ id: S.String }), { signed: { secret: 'COOKIE_SECRET' } })

// A token stored as it is, scoped to one restaurant's guest pages.
const guestCookie = cookie('guest', S.String, { path: '/r/{restaurant}/' })

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
    .post('/r/{restaurant}/visit', action(Effect.gen(function* () {
      yield* guestCookie.set('tok-123')

      return yield* json({ visited: true })
    })))
    .get('/r/{restaurant}/visit', action(Effect.gen(function* () {
      return yield* json({ guest: Option.getOrNull(yield* guestCookie.read) })
    })))
    .post('/admin/impersonate', action(Effect.gen(function* () {
      yield* impersonationCookie.set({ id: 'imp-1' })

      return yield* json({ started: true })
    })))
    .get('/admin/impersonating', action(Effect.gen(function* () {
      return yield* json({ impersonation: Option.getOrNull(yield* impersonationCookie.read) })
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

describe('cookie values and paths', () => {
  test('a string is stored as it is, and one stored as a JSON string reads too', async () => {
    const app = createApp()
    const set = await app.request('/r/acme/visit', { method: 'POST' })

    expect(set.headers.getSetCookie().find((value) => value.startsWith('guest='))).toStartWith('guest=tok-123;')
    expect(Option.getOrNull(readCookie(set, guestCookie))).toBe('tok-123')
    expect(await (await app.request('/r/acme/visit', { headers: { Cookie: 'guest=%22tok-9%22' } })).json()).toEqual({ guest: 'tok-9' })
  })

  test('a path placeholder is filled from the route that sets the cookie', async () => {
    const set = await createApp().request('/r/acme/visit', { method: 'POST' })

    expect(set.headers.getSetCookie().find((value) => value.startsWith('guest='))).toContain('Path=/r/acme/')
  })

  test('readCookie reads the value a response set, and none once cleared', async () => {
    const app = createApp()

    expect(Option.getOrNull(readCookie(await app.request('/r/cart', { method: 'POST' }), cartCookie))).toEqual({ id: 'cart-1', items: 2 })
    expect(Option.isNone(readCookie(await app.request('/r/cart', { method: 'DELETE' }), cartCookie))).toBe(true)
  })
})

describe('signed cookies', () => {
  const env = { COOKIE_SECRET: 'test-secret' }

  test('read back only with a valid signature', async () => {
    const app = createApp()
    const set = await app.request('/admin/impersonate', { method: 'POST' }, env)
    const written = set.headers.getSetCookie().find((value) => value.startsWith('impersonation='))?.split(';')[0] ?? ''
    const [, value = ''] = written.split('=')
    const forged = `impersonation=${encodeURIComponent(JSON.stringify({ id: 'imp-2' }))}`
    const tampered = `impersonation=${value.replace('imp-1', 'imp-2')}`

    const read = async (cookieHeader: string) =>
      (await (await app.request('/admin/impersonating', { headers: { Cookie: cookieHeader } }, env)).json()).impersonation

    expect(await read(written)).toEqual({ id: 'imp-1' })
    expect(await read(forged)).toBeNull()
    expect(await read(tampered)).toBeNull()
    expect(Option.getOrNull(readCookie(set, impersonationCookie))).toEqual({ id: 'imp-1' })
  })
})

describe('testBrowser', () => {
  test('names the page it last showed as the Referer of a form it posts', async () => {
    const app = new Hono()
    const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) })
    routes
      .get('/projects/new', action(json({ form: true })))
      .post('/projects', action(Effect.gen(function* () {
        yield* validateRequest(S.Struct({ name: requiredString }))

        return yield* json({ created: true })
      })))

    const browser = testBrowser(app)
    await browser.request('/projects/new')
    const failed = await browser.request('/projects', { method: 'POST', body: new URLSearchParams('name='), headers: { Accept: 'text/html' } })

    expect(failed.headers.get('Location')).toBe('/projects/new')
  })

  test('takes a cookie a test gives it', async () => {
    const browser = testBrowser(createApp())
    browser.setCookie('cart', encodeURIComponent(JSON.stringify({ id: 'given', items: 1 })), '/r')

    expect(await (await browser.request('/r/cart')).json()).toEqual({ cart: { id: 'given', items: 1 } })
  })

  test('keeps cookies across requests, sends them by path, and drops the cleared ones', async () => {
    const browser = testBrowser(createApp())

    await browser.request('/r/cart', { method: 'POST' })
    expect(await (await browser.request('/r/cart')).json()).toEqual({ cart: { id: 'cart-1', items: 2 } })

    // The cart cookie covers /r only.
    expect(browser.cookies.has('cart')).toBe(true)
    await browser.request('/r/cart', { method: 'DELETE' })
    expect(browser.cookies.has('cart')).toBe(false)
    expect(await (await browser.request('/r/cart')).json()).toEqual({ cart: null })
  })
})
