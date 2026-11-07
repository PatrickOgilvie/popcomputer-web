/**
 * Machines 50 to 53, 58 and 59: the tools a test runs the application with.
 * testBrowser keeps cookies as a browser does, by RFC 6265, and follows a
 * redirect as one does; testClock's settle and testD1 hold what they promise.
 */
import { describe, expect, test } from 'bun:test'
import { Clock, Duration, Effect, Option } from 'effect'
import { Hono } from 'hono'
import { action } from '../../src/effect/action.js'
import { json } from '../../src/effect/responses.js'
import { RequestService } from '../../src/effect/services.js'
import { setupWeb } from '../../src/setup.js'
import { held, receive, sent } from '../../src/cookie-jar.js'
import { testBrowser, testClock, testEnv } from '../../src/testing.js'

/** An app that sets the cookies `?set=` names, at the path asked for, and echoes the Cookie header it receives. */
function cookieApp() {
  const app = new Hono()
  const seen: Array<{ readonly method: string; readonly path: string; readonly body: string }> = []

  app.all('*', async (c) => {
    const headers = new Headers()

    for (const cookie of c.req.queries('set') ?? []) headers.append('Set-Cookie', cookie)
    seen.push({ method: c.req.method, path: c.req.path, body: await c.req.text() })

    const redirect = c.req.query('redirect')

    if (redirect !== undefined) {
      headers.set('Location', c.req.query('to') ?? '/next')

      return new Response(null, { status: Number(redirect), headers })
    }

    return new Response(c.req.header('Cookie') ?? '', { headers })
  })

  return { app, seen }
}

const setting = (path: string, ...cookies: string[]) => `${path}?${new URLSearchParams(cookies.map((cookie) => ['set', cookie]))}`

describe("testBrowser's cookies, by RFC 6265", () => {
  test('M59.T2: a cookie set with no Path, or an empty one, covers the directory of the path that set it', async () => {
    const browser = testBrowser(cookieApp().app)

    await browser.request(setting('/a/b/set', 'nopath=1', 'empty=2; Path='))

    expect(await (await browser.request('/z')).text()).toBe('')
    expect(await (await browser.request('/a/b/x')).text()).toBe('nopath=1; empty=2')
  })

  test('M59.T4: one name at two paths is two cookies, each sent to its own path', async () => {
    const browser = testBrowser(cookieApp().app)

    await browser.request(setting('/', 'c=one; Path=/a', 'c=two; Path=/b'))

    expect(await (await browser.request('/a')).text()).toBe('c=one')
    expect(await (await browser.request('/b')).text()).toBe('c=two')
  })

  test('M59.T6: clearing a cookie at one path leaves the one at another', async () => {
    const browser = testBrowser(cookieApp().app)

    await browser.request(setting('/', 'c=one; Path=/a', 'c=two; Path=/b'))
    await browser.request(setting('/', 'c=; Path=/a; Max-Age=0'))

    expect(await (await browser.request('/a')).text()).toBe('')
    expect(await (await browser.request('/b')).text()).toBe('c=two')
  })

  test('M59.T7: a Max-Age of zero or less, however it is spelled, expires the cookie', async () => {
    const browser = testBrowser(cookieApp().app)

    await browser.request(setting('/', 'a=1', 'b=2'))
    await browser.request(setting('/', 'a=; Max-Age=-1', 'b=; Max-Age=00'))

    expect(await (await browser.request('/')).text()).toBe('')
  })

  test('M59.T9: Max-Age comes before Expires', async () => {
    const browser = testBrowser(cookieApp().app)

    await browser.request(setting('/', 'kept=1; Max-Age=3600; Expires=Wed, 01 Jan 2020 00:00:00 GMT'))

    expect(await (await browser.request('/')).text()).toBe('kept=1')
  })

  test('M59.T11: a cookie whose Max-Age has run out is no longer sent', async () => {
    const browser = testBrowser(cookieApp().app)

    await browser.request(setting('/', 'brief=1; Max-Age=1'))
    await new Promise((resolve) => setTimeout(resolve, 1100))

    expect(await (await browser.request('/')).text()).toBe('')
    expect(browser.cookies.has('brief')).toBe(false)
  })

  test('M59.T16: a path covers the paths under it, not those that merely start with it', async () => {
    const browser = testBrowser(cookieApp().app)

    await browser.request(setting('/', 'a=1; Path=/app'))

    expect(await (await browser.request('/apple')).text()).toBe('')
    expect(await (await browser.request('/app/x')).text()).toBe('a=1')
  })

  test('the more specific path is sent first', async () => {
    const browser = testBrowser(cookieApp().app)

    await browser.request(setting('/', 'c=root; Path=/', 'c=deep; Path=/a/b'))

    expect(await (await browser.request('/a/b/c')).text()).toBe('c=deep; c=root')
  })
})

describe('the cookie jar, at exact times', () => {
  const names = (cookies: ReadonlyArray<{ readonly name: string; readonly value: string }>) => cookies.map((cookie) => `${cookie.name}=${cookie.value}`)

  test('M59.T7, T11: a cookie expires when its Max-Age has passed, at that instant', () => {
    const jar = receive([], ['a=1; Max-Age=2', 'b=2; Max-Age=0'], '/', 1000)

    expect(names(held(jar, 1000))).toEqual(['a=1'])
    expect(names(held(jar, 2999))).toEqual(['a=1'])
    expect(names(held(jar, 3000))).toEqual([])
  })

  test('M59.T9: a Max-Age that is no number is ignored, and Expires decides', () => {
    const jar = receive([], ['a=1; Max-Age=soon; Expires=Thu, 01 Jan 2099 00:00:00 GMT'], '/', 1000)

    expect(names(held(jar, 2000))).toEqual(['a=1'])
  })

  test('M59.T2: a cookie set from a path that is not absolute covers the root', () => {
    expect(receive([], ['a=1'], 'relative', 0)[0]?.path).toBe('/')
  })

  test('a Set-Cookie with no name, or no =, is ignored, and an attribute with no value is read', () => {
    const jar = receive([], ['=value', '  =value', 'novalue', 'a=1; HttpOnly; Path=/x'], '/', 0)

    expect(jar.map((cookie) => `${cookie.name}=${cookie.value}@${cookie.path}`)).toEqual(['a=1@/x'])
    expect(names(sent(jar, '/x', 0))).toEqual(['a=1'])
  })
})

describe('testBrowser sending', () => {
  test('a browser with no cookies sends no Cookie header', async () => {
    const app = new Hono()

    app.get('/', (c) => c.text(String(c.req.header('Cookie') !== undefined)))

    expect(await (await testBrowser(app).request('/')).text()).toBe('false')
  })
})

describe('testBrowser following a redirect', () => {
  test('M59.T26: a 307 or 308 after a POST repeats the POST, with its body', async () => {
    for (const status of [307, 308]) {
      const { app, seen } = cookieApp()
      const browser = testBrowser(app)
      const posted = await browser.request(`/form?redirect=${status}`, { method: 'POST', body: 'name=Ada', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })

      await browser.follow(posted)

      expect(seen.at(-1)).toEqual({ method: 'POST', path: '/next', body: 'name=Ada' })
    }
  })

  test('M59.T26: a 303 after a POST is followed with a GET', async () => {
    const { app, seen } = cookieApp()
    const browser = testBrowser(app)

    await browser.follow(await browser.request('/form?redirect=303', { method: 'POST', body: 'name=Ada' }))

    expect(seen.at(-1)).toEqual({ method: 'GET', path: '/next', body: '' })
  })

  test('M59.T26: a 307 this browser did not request needs the method and body it repeats', async () => {
    const { app, seen } = cookieApp()
    const browser = testBrowser(app)
    const elsewhere = await app.request('/form?redirect=307', { method: 'POST', body: 'name=Ada' })

    await expect(browser.follow(elsewhere)).rejects.toThrow('pass its method and body')
    await browser.follow(elsewhere, { method: 'POST', body: 'name=Ada' })

    expect(seen.at(-1)).toEqual({ method: 'POST', path: '/next', body: 'name=Ada' })
  })

  test('M59.T27: a relative Location resolves against the URL it answered', async () => {
    const { app, seen } = cookieApp()
    const browser = testBrowser(app)

    await browser.follow(await browser.request('/a/b?redirect=303&to=next', { method: 'POST' }))

    expect(seen.at(-1)?.path).toBe('/a/next')
  })
})

describe("testClock's settle", () => {
  /** A read that takes 20 real milliseconds, as a database's does. */
  const read = Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 20)))

  const appOn = async () => {
    const time = await testClock(new Date('2026-01-01T00:00:00Z'))
    const app = new Hono()
    const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) })

    routes.get('/timed', action(Effect.flatMap(read.pipe(Effect.timeoutOption('5 seconds')), (done) => json({ timedOut: Option.isNone(done) }))))
    routes.get('/read', action(Effect.andThen(read, Effect.flatMap(Clock.currentTimeMillis, (at) => json({ at })))))
    routes.get('/later', action(Effect.andThen(Effect.sleep('1 second'), Effect.flatMap(read.pipe(Effect.timeoutOption('5 seconds')), (done) => json({ timedOut: Option.isNone(done) })))))
    routes.get('/wait', action(Effect.gen(function* () {
      const request = yield* RequestService

      yield* Effect.sleep(request.query().for as Duration.Input)

      return yield* json({ waited: true })
    })))

    return { app, time, env: testEnv(time.layer) }
  }

  test("M58.T8: work waiting on a read is not timed out by its own timeout's sleep", async () => {
    const { app, time, env } = await appOn()
    const res = await time.settle(app.request('/timed', {}, env))

    expect(await res.json()).toEqual({ timedOut: false })
    expect(time.now().toISOString()).toBe('2026-01-01T00:00:00.000Z')
  })

  test('M58.T8: a read that starts after the clock moved for one sleep still finishes before its timeout', async () => {
    const { app, time, env } = await appOn()
    const res = await time.settle(app.request('/later', {}, env))

    expect(await res.json()).toEqual({ timedOut: false })
    expect(time.now().toISOString()).toBe('2026-01-01T00:00:01.000Z')
  })

  test("M58.T9: another's sleep is not ended under work waiting on a read", async () => {
    const { app, time, env } = await appOn()

    // A request elsewhere waits a week on the clock, and is never settled.
    void app.request('/wait?for=7%20days', {}, env)

    const res = await time.settle(app.request('/read', {}, env))

    expect(await res.json()).toEqual({ at: Date.UTC(2026, 0, 1) })
  })

  test('M58.T10: a sleep left from before the clock was set back is not ended under work that waits on none', async () => {
    const { app, time, env } = await appOn()

    void app.request('/wait?for=1%20hour', {}, env)
    await time.set(new Date('2026-01-01T00:00:00Z'))
    await time.settle(app.request('/read', {}, env))

    expect(time.now().toISOString()).toBe('2026-01-01T00:00:00.000Z')
  })

  test('M58.T11: two settles at once move the clock as one, and not for work that waits on none', async () => {
    const { app, time, env } = await appOn()

    void app.request('/wait?for=1%20hour', {}, env)
    await Promise.all([time.settle(app.request('/read', {}, env)), time.settle(app.request('/read', {}, env))])

    expect(time.now().toISOString()).toBe('2026-01-01T00:00:00.000Z')
  })
})
