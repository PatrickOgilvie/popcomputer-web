/**
 * Machines 2, 3, 8 and 36: what the browser
 * holds between requests. The flash cookie moves on the answer actually sent,
 * and a partial reload never merges one visitor's answer over another's page.
 */
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { Effect, Schema as S } from 'effect'
import { Hono } from 'hono'
import { action } from '../../src/effect/action.js'
import { RequestService } from '../../src/effect/services.js'
import { flash, forbidden, json, redirect, render } from '../../src/effect/responses.js'
import { requiredString } from '../../src/effect/schema.js'
import { validateRequest } from '../../src/effect/validation.js'
import { withinBudget } from '../../src/flash.js'
import { setupWeb } from '../../src/setup.js'
import { signedIn, testBrowser, testEnv } from '../../src/testing.js'

const inertia = { 'X-Inertia': 'true', 'X-Requested-With': 'XMLHttpRequest' }
const person = (id: string) => signedIn({ id, name: id })

afterEach(() => {
  setSystemTime()
})

function pages() {
  const app = new Hono()
  const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) })

  routes
    .get('/home', action(render('Home', { counter: 1, feed: 'the feed' })))
    .get('/next', action(render('Next', {})))
    .get('/quiet', action(json({ ok: true })))
    .get('/text', action(Effect.succeed(new Response('plain text'))))
    .get('/nothing', action(Effect.succeed(new Response(null, { status: 204 }))))
    .get('/elsewhere', action(redirect('https://elsewhere.example/landing')))
    .post('/saved', action(Effect.gen(function* () {
      yield* flash('notice', 'Saved.')

      return yield* redirect('/next')
    })))
    .post('/saved-then-forbid', action(Effect.gen(function* () {
      yield* flash('notice', 'Saved.')

      return yield* redirect('/render-then-forbid')
    })))
    .post('/saved-then-redirect', action(Effect.gen(function* () {
      yield* flash('notice', 'Saved.')

      return yield* redirect('/render-then-redirect')
    })))
    .post('/saved-elsewhere', action(Effect.gen(function* () {
      yield* flash('notice', 'Saved.')

      return yield* redirect('https://elsewhere.example/landing')
    })))
    .post('/projects', action(Effect.gen(function* () {
      yield* validateRequest(S.Struct({ name: requiredString }))

      return yield* redirect('/next')
    })))
    .get('/projects/new', action(render('Projects/New', {})))
    .get('/render-then-forbid', action(Effect.gen(function* () {
      yield* render('Next', {})

      return yield* forbidden('No.')
    })))
    .get('/render-then-redirect', action(Effect.gen(function* () {
      yield* render('Next', {})

      return yield* redirect('/next')
    })))
    .get('/keeps-history', action(render('Next', {}, { clearHistory: false })))

  return { app, routes }
}

describe('a partial reload', () => {
  const partial = (version: string) => ({ headers: { ...inertia, 'X-Inertia-Version': version, 'X-Inertia-Partial-Component': 'Home', 'X-Inertia-Partial-Data': 'counter' } })

  test('from the visitor its page went to answers its props', async () => {
    const { app } = pages()
    const ada = testEnv(person('ada'), {})
    const page = await (await app.request('/home', { headers: inertia }, ada)).json()
    const res = await app.request('/home', partial(page.version), ada)

    expect(res.status).toBe(200)
    expect(Object.keys((await res.json()).props)).toContain('counter')
  })

  test('M3.T33, M36.T18: from another member reloads the page in full, so no props of theirs stay', async () => {
    const { app } = pages()
    const page = await (await app.request('/home', { headers: inertia }, testEnv(person('ada'), {}))).json()
    const res = await app.request('https://example.com/home', partial(page.version), testEnv(person('grace'), {}))

    expect(res.status).toBe(409)
    expect(res.headers.get('X-Inertia-Location')).toBe('https://example.com/home')
  })

  test('M3.T32, T34, T35, M36.T17: and so does a guest after the session ended', async () => {
    const { app } = pages()
    const page = await (await app.request('/home', { headers: inertia }, testEnv(person('ada'), {}))).json()
    const res = await app.request('/home', partial(page.version), testEnv({}))

    expect(res.status).toBe(409)
  })

  test('leaves the flash for the page that follows', async () => {
    const { app } = pages()
    const page = await (await app.request('/home', { headers: inertia }, testEnv(person('ada'), {}))).json()
    const browser = testBrowser(app, testEnv(person('grace'), {}))

    await browser.request('/saved', { method: 'POST' })
    const held = browser.cookies.get('popweb-flash')
    const res = await browser.request('/home', partial(page.version))

    expect(res.status).toBe(409)
    expect(browser.cookies.get('popweb-flash')).toBe(held)
  })
})

describe('the flash', () => {
  const shownAfter = async (browser: ReturnType<typeof testBrowser>) =>
    (await (await browser.request('/next', { headers: inertia })).json()).flash

  test('M2.T8: a render the action discarded shows nothing, so the page that answers does', async () => {
    const { app } = pages()
    const browser = testBrowser(app, testEnv({}))

    await browser.request('/saved-then-forbid', { method: 'POST' })
    const page = await (await browser.request('/render-then-forbid', { headers: inertia })).json()

    expect(page.flash).toEqual({ notice: 'Saved.' })
    expect(browser.cookies.has('popweb-flash')).toBe(false)
  })

  test('M2.T8: and a redirect after it carries the flash on', async () => {
    const { app } = pages()
    const browser = testBrowser(app, testEnv({}))

    await browser.request('/saved-then-redirect', { method: 'POST' })
    await browser.request('/render-then-redirect', { headers: inertia })

    expect(await shownAfter(browser)).toEqual({ notice: 'Saved.' })
  })

  test('M2.T20: a JSON answer leaves it for the next page', async () => {
    const { app } = pages()
    const browser = testBrowser(app, testEnv({}))

    await browser.request('/saved', { method: 'POST' })
    const res = await browser.request('/quiet', { headers: { Accept: 'application/json' } })

    expect(res.headers.getSetCookie()).toEqual([])
    expect(await shownAfter(browser)).toEqual({ notice: 'Saved.' })
  })

  test('M2.T21: as does plain text and an empty answer', async () => {
    const { app } = pages()
    const browser = testBrowser(app, testEnv({}))

    await browser.request('/saved', { method: 'POST' })
    await browser.request('/text')
    await browser.request('/nothing')

    expect(await shownAfter(browser)).toEqual({ notice: 'Saved.' })
  })

  test('M2.T22: and an Inertia redirect to another site', async () => {
    const { app } = pages()
    const browser = testBrowser(app, testEnv({}))

    await browser.request('/saved', { method: 'POST' })
    const res = await browser.request('/elsewhere', { headers: inertia })

    expect(res.status).toBe(409)
    expect(await shownAfter(browser)).toEqual({ notice: 'Saved.' })
  })

  test("a page another tab renders at another address leaves the flash for the page the redirect leads to", async () => {
    const { app } = pages()
    const browser = testBrowser(app, testEnv({}))

    await browser.request('/saved', { method: 'POST' })
    const otherResponse = await browser.request('/home', { headers: inertia })

    expect((await otherResponse.json()).flash).toEqual({})
    // It writes no cookie: what it was sent may be older than the cookie by the time it answers.
    expect(otherResponse.headers.getSetCookie()).toEqual([])
    expect(await shownAfter(browser)).toEqual({ notice: 'Saved.' })
    // Shown once.
    expect(await shownAfter(browser)).toEqual({})
  })

  test("a failed form's errors go back to the form's page, whatever page another tab renders first", async () => {
    const { app } = pages()
    const browser = testBrowser(app, testEnv({}))

    await browser.request('/projects/new', { headers: inertia })
    const failed = await browser.request('/projects', { method: 'POST', body: new URLSearchParams('name='), headers: { Accept: 'text/html' } })

    expect(failed.headers.get('Location')).toBe('/projects/new')
    expect((await (await browser.request('/next', { headers: inertia })).json()).props.errors).toEqual({})
    expect(Object.keys((await (await browser.request('/projects/new', { headers: inertia })).json()).props.errors)).toEqual(['name'])
  })

  test('a redirect from the page a flash is for carries it on to where it leads', async () => {
    const { app } = pages()
    const browser = testBrowser(app, testEnv({}))

    await browser.request('/saved-then-redirect', { method: 'POST' })
    // The page it is for redirects instead: /render-then-redirect sends it on to /next.
    await browser.request('/render-then-redirect', { headers: inertia })

    expect((await (await browser.request('/home', { headers: inertia })).json()).flash).toEqual({})
    expect(await shownAfter(browser)).toEqual({ notice: 'Saved.' })
  })

  test('a flash a redirect to another site leaves goes to whichever page renders next, as it did', async () => {
    const { app } = pages()
    const browser = testBrowser(app, testEnv({}))

    await browser.request('/saved-elsewhere', { method: 'POST' })

    expect((await (await browser.request('/home', { headers: inertia })).json()).flash).toEqual({ notice: 'Saved.' })
  })

  test('two flashes for different pages go to whichever page renders next, together, as both did', async () => {
    const { app } = pages()
    const browser = testBrowser(app, testEnv({}))

    await browser.request('/saved', { method: 'POST' })
    await browser.request('/saved-then-forbid', { method: 'POST' })

    expect((await (await browser.request('/home', { headers: inertia })).json()).flash).toEqual({ notice: 'Saved.' })
    expect(await shownAfter(browser)).toEqual({})
  })

  test('a flash cookie an earlier release wrote, naming no page, goes to whichever page renders next', async () => {
    const { app } = pages()
    const browser = testBrowser(app, testEnv({}))
    const written = JSON.stringify({ errors: {}, flash: { notice: 'Saved.' }, until: Date.now() + 60_000 })

    browser.setCookie('popweb-flash', Buffer.from(written).toString('base64url'), '/')

    expect((await (await browser.request('/home', { headers: inertia })).json()).flash).toEqual({ notice: 'Saved.' })
  })

  test('M2.T29: a flash beside the history clear still lasts its minute, though the clear outlives it', async () => {
    const signOut = new Hono()
    // history.encrypt: true, so only the flag clears: under the default, every guest's page does.
    const { routes } = setupWeb(signOut, { version: '1', render: (page) => JSON.stringify(page), history: { encrypt: true } })

    routes
      .post('/bye', action(Effect.gen(function* () {
        yield* flash('notice', 'Signed out.')

        return new Response(null, { status: 303, headers: { Location: '/next', 'Set-Cookie': 'better-auth.session_token=; Max-Age=0; Path=/' } })
      })))
      .get('/next', action(render('Next', {})))

    const browser = testBrowser(signOut, testEnv({}))

    setSystemTime(new Date('2026-01-01T00:00:00Z'))
    await browser.request('/bye', { method: 'POST' })
    setSystemTime(new Date('2026-01-01T00:05:00Z'))
    const page = await (await browser.request('/next', { headers: inertia })).json()

    expect(page.flash).toEqual({})
    expect(page.clearHistory).toBe(true)
  })

  test('a value set after a page was rendered waits for the next page', async () => {
    const app = new Hono()
    const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) })

    routes
      .get('/late', action(Effect.gen(function* () {
        yield* flash('shown', 'on this page')
        const page = yield* render('Late', {})

        yield* flash('later', 'on the next')

        return page
      })))
      .get('/next', action(render('Next', {})))

    const browser = testBrowser(app, testEnv({}))
    const first = await (await browser.request('/late', { headers: inertia })).json()
    const next = await (await browser.request('/next', { headers: inertia })).json()

    expect(first.flash).toEqual({ shown: 'on this page' })
    expect(next.flash).toEqual({ later: 'on the next' })
  })

  test("M2.T10, T26: a value set after a prefetch's page was rendered waits for the next page too", async () => {
    const app = new Hono()
    const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) })

    routes
      .get('/late', action(Effect.gen(function* () {
        const page = yield* render('Late', {})

        yield* flash('later', 'on the next')

        return page
      })))
      .get('/next', action(render('Next', {})))

    const browser = testBrowser(app, testEnv({}))
    const prefetched = await (await browser.request('/late', { headers: { ...inertia, Purpose: 'prefetch' } })).json()
    const next = await (await browser.request('/next', { headers: inertia })).json()

    expect(prefetched.flash).toEqual({})
    expect(next.flash).toEqual({ later: 'on the next' })
  })

  test('a value set before a page the action dropped goes with the redirect', async () => {
    const app = new Hono()
    const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) })

    routes
      .get('/dropped', action(Effect.gen(function* () {
        yield* flash('notice', 'kept')
        yield* render('Dropped', {})

        return yield* redirect('/next')
      })))
      .get('/next', action(render('Next', {})))

    const browser = testBrowser(app, testEnv({}))

    await browser.request('/dropped', { headers: inertia })

    expect((await (await browser.request('/next', { headers: inertia })).json()).flash).toEqual({ notice: 'kept' })
  })

  test('only a 3xx from the page a flash is for carries it on, renewing it, and one from another page writes nothing', async () => {
    const app = new Hono()
    const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) })

    routes
      .post('/saved/{code}', action(Effect.gen(function* () {
        const request = yield* RequestService
        yield* flash('notice', 'Saved.')

        return yield* redirect(`/status/${request.param('code')}`)
      })))
      .get('/status/{code}', action(Effect.gen(function* () {
        const request = yield* RequestService

        return new Response(null, { status: Number(request.param('code')) })
      })))
      .get('/page', action(render('Page', {})))

    // The flash is for /status/{code}; `at` is the status the request there answers.
    const writes = async (code: number, at = code) => {
      const browser = testBrowser(app, testEnv({}))

      await browser.request(`/saved/${code}`, { method: 'POST' })

      return (await browser.request(`/status/${at}`)).headers.getSetCookie().length
    }

    expect(await writes(299)).toBe(0)
    expect(await writes(300)).toBe(1)
    expect(await writes(399)).toBe(1)
    expect(await writes(400)).toBe(0)
    // What a redirect from another page sent may be older than the cookie.
    expect(await writes(300, 301)).toBe(0)

    // A 3xx that names no Location leads to no page: the flash goes to whichever renders next.
    const browser = testBrowser(app, testEnv({}))
    await browser.request('/saved/300', { method: 'POST' })
    await browser.request('/status/300')
    expect((await (await browser.request('/page', { headers: inertia })).json()).flash).toEqual({ notice: 'Saved.' })
  })

  test("the history's clear, which names no page, passes through a redirect that changes nothing without a write", async () => {
    const app = new Hono()
    // history.encrypt: true, so only the flag clears: under the default, every guest's page does.
    const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page), history: { encrypt: true } })

    routes
      .post('/bye', action(Effect.succeed(new Response(null, { status: 303, headers: { Location: '/hop', 'Set-Cookie': 'better-auth.session_token=; Max-Age=0; Path=/' } }))))
      .get('/hop', action(redirect('/next')))
      .get('/next', action(render('Next', {})))

    // From no cookie, and from one this code cannot read, which the answer replaces.
    for (const held of [undefined, 'not-a-flash-cookie']) {
      const browser = testBrowser(app, testEnv({}))

      if (held !== undefined) browser.setCookie('popweb-flash', held, '/')

      expect((await browser.request('/bye', { method: 'POST' })).headers.getSetCookie().some((cookie) => cookie.startsWith('popweb-flash='))).toBe(true)
      expect((await browser.request('/hop')).headers.getSetCookie()).toEqual([])
      expect((await (await browser.request('/next', { headers: inertia })).json()).clearHistory).toBe(true)
    }
  })

  test('M2.T35: over the cookie\'s budget, as many field errors as fit go on, and the form says the rest did not', () => {
    const errors = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`items.${index}.name`, 'This field is required']))
    const kept = withinBudget({ errors, flash: {}, clearHistory: false })

    expect(Object.keys(kept.errors).length).toBeGreaterThan(50)
    expect(Object.keys(kept.errors)).toContain('items.0.name')
    expect(kept.errors.form).toBe('Some of the errors in this form could not be shown.')
  })

  test('M2.T35: a form of 70 invalid fields comes back with its errors', async () => {
    const app = new Hono()
    const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) })
    const Items = S.Struct({ items: S.Array(S.Struct({ name: requiredString })) })

    routes
      .get('/form', action(render('Form', {})))
      .post('/form', action(Effect.gen(function* () {
        yield* validateRequest(Items)

        return yield* redirect('/form')
      })))

    const browser = testBrowser(app, testEnv({}))
    const body = new URLSearchParams(Array.from({ length: 70 }, (_, index) => [`items[${index}][name]`, ''])).toString()

    await browser.request('/form', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: 'http://localhost/form' }, body })
    const page = await (await browser.request('/form', { headers: inertia })).json()

    expect(Object.keys(page.props.errors).length).toBeGreaterThan(50)
  })
})

describe('the history clear', () => {
  const ended = (app: Hono) => {
    // history.encrypt: true, so only the flag clears: under the default, every guest's page does.
    const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page), history: { encrypt: true } })

    routes
      .post('/bye', action(Effect.succeed(new Response(null, { status: 303, headers: { Location: '/next', 'Set-Cookie': 'better-auth.session_token=; Max-Age=0; Path=/' } }))))
      .get('/next', action(render('Next', {})))
      .get('/keeps-history', action(render('Next', {}, { clearHistory: false })))
      .get('/clears-and-ends', action(Effect.map(render('Next', {}), (page) => {
        page.headers.append('Set-Cookie', 'better-auth.session_token=; Max-Age=0; Path=/')

        return page
      })))
      .get('/render-then-forbid', action(Effect.gen(function* () {
        yield* render('Next', {})

        return yield* forbidden('No.')
      })))

    return testBrowser(app, testEnv({}))
  }

  test('M3.T10: a page that asks to keep the history leaves the clear for the next page', async () => {
    const browser = ended(new Hono())

    await browser.request('/bye', { method: 'POST' })
    const kept = await (await browser.request('/keeps-history', { headers: inertia })).json()
    const next = await (await browser.request('/next', { headers: inertia })).json()

    expect(kept.clearHistory).toBe(false)
    expect(next.clearHistory).toBe(true)
  })

  test('a page that clears, in an answer that ends the session, leaves no second clear', async () => {
    const browser = ended(new Hono())

    await browser.request('/bye', { method: 'POST' })
    const clearing = await (await browser.request('/clears-and-ends', { headers: inertia })).json()
    const next = await (await browser.request('/next', { headers: inertia })).json()

    expect(clearing.clearHistory).toBe(true)
    expect(next.clearHistory).toBeUndefined()
  })

  test('M3.T18: a render the action discarded takes nothing, so the page that answers clears', async () => {
    const browser = ended(new Hono())

    await browser.request('/bye', { method: 'POST' })
    const page = await (await browser.request('/render-then-forbid', { headers: inertia })).json()

    expect(page.clearHistory).toBe(true)
  })

  test('M3.T12: an application with no pages never raises it, so its answers stay cacheable', async () => {
    const app = new Hono()
    const { routes } = setupWeb(app, { version: '1' })

    routes
      .post('/bye', action(Effect.succeed(new Response(null, { status: 204, headers: { 'Set-Cookie': 'better-auth.session_token=; Max-Age=0; Path=/' } }))))
      .get('/public', action(json({ ok: true })), { cache: { maxAge: 60 } })

    const browser = testBrowser(app, testEnv({}))

    await browser.request('/bye', { method: 'POST' })
    const res = await browser.request('/public')

    expect(browser.cookies.has('popweb-flash')).toBe(false)
    expect(res.headers.getSetCookie()).toEqual([])
    expect(res.headers.get('Cache-Control')).not.toContain('no-store')
  })
})

describe('the internal mark', () => {
  test('a page leaves with no mark of the framework on it', async () => {
    const { app } = pages()
    const res = await app.request('/next', { headers: inertia }, testEnv({}))

    expect([...res.headers.keys()].filter((name) => name.startsWith('x-popweb'))).toEqual([])
  })
})

