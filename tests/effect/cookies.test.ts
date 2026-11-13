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
import { readCookie, testBrowser, testClock, testEnv } from '../../src/testing.js'

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
    // Outside the cart cookie's path, where a browser does not send it.
    .get('/elsewhere/cart', action(Effect.gen(function* () {
      return yield* json({ cart: Option.getOrNull(yield* cartCookie.read) })
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

  // A pass the server trusts for an hour: a copy kept past it reads as none.
  const passCookie = cookie('pass', S.String, { maxAge: '1 hour', signed: { secret: 'COOKIE_SECRET' } })

  async function passApp() {
    const time = await testClock(new Date('2026-03-01T09:00:00Z'))
    const app = new Hono()
    const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) })

    routes
      .post('/pass', action(Effect.gen(function* () {
        yield* passCookie.set('pass-1.5')

        return yield* json({ given: true })
      })))
      .get('/pass', action(Effect.gen(function* () {
        return yield* json({ pass: Option.getOrNull(yield* passCookie.read) })
      })))

    const bindings = testEnv(time.layer, env)
    const read = async (cookieHeader: string) =>
      (await (await app.request('/pass', { headers: { Cookie: cookieHeader } }, bindings)).json()).pass
    const set = await app.request('/pass', { method: 'POST' }, bindings)
    const written = set.headers.getSetCookie().find((value) => value.startsWith('pass='))?.split(';')[0] ?? ''

    return { time, read, set, written }
  }

  test('a signed cookie with a lifetime reads as none once a copy outlives it', async () => {
    const { time, read, set, written } = await passApp()

    expect(await read(written)).toBe('pass-1.5')
    expect(Option.getOrNull(readCookie(set, passCookie))).toBe('pass-1.5')

    await time.advance('59 minutes')
    expect(await read(written)).toBe('pass-1.5')

    // The second its Max-Age ends, as the browser drops it.
    await time.advance('1 minute')
    expect(await read(written)).toBeNull()
  })

  test('a signed cookie without a lifetime keeps a value that ends in digits whole', async () => {
    const noteCookie = cookie('note', S.String, { signed: { secret: 'COOKIE_SECRET' } })
    const app = new Hono()
    const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) })

    routes
      .post('/note', action(Effect.gen(function* () {
        yield* noteCookie.set('v1.5')

        return yield* json({ noted: true })
      })))
      .get('/note', action(Effect.gen(function* () {
        return yield* json({ note: Option.getOrNull(yield* noteCookie.read) })
      })))

    const set = await app.request('/note', { method: 'POST' }, env)
    const written = set.headers.getSetCookie().find((value) => value.startsWith('note='))?.split(';')[0] ?? ''

    expect(Option.getOrNull(readCookie(set, noteCookie))).toBe('v1.5')
    expect((await (await app.request('/note', { headers: { Cookie: written } }, env)).json()).note).toBe('v1.5')
  })

  test('the expiry is signed, so a copy cannot move it', async () => {
    const { time, read, written } = await passApp()
    const [prefix = '', , signature = ''] = /^(.*)\.(\d+)\.([^.]+)$/.exec(written)?.slice(1) ?? []

    expect(prefix).toBe('pass=pass-1.5')

    await time.advance('2 hours')
    expect(await read(`${prefix}.${Math.floor(Date.parse('2026-03-01T13:00:00Z') / 1000)}.${signature}`)).toBeNull()
  })

  test('a value signed before expiries were signed still reads', async () => {
    const { read } = await passApp()
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.COOKIE_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const signature = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('pass=pass-1.5'))).toString('base64url')

    expect(await read(`pass=pass-1.5.${signature}`)).toBe('pass-1.5')
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
    expect(await (await browser.request('/elsewhere/cart')).json()).toEqual({ cart: null })
    expect(browser.cookies.has('cart')).toBe(true)
    await browser.request('/r/cart', { method: 'DELETE' })
    expect(browser.cookies.has('cart')).toBe(false)
    expect(await (await browser.request('/r/cart')).json()).toEqual({ cart: null })
  })
})
