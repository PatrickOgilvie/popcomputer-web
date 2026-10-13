/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
/**
 * Declared Values Tests
 *
 * The public user, shared props and flash values are declared once in
 * setupWeb, as Effect Schemas: what reaches the page is encoded through them,
 * so only declared fields reach the browser, as JSON.
 */

import { describe, expect, test } from 'bun:test'
import { Effect, Layer, Schema as S } from 'effect'
import { Hono } from 'hono'
import { setupWeb } from '../src/setup.js'
import { action } from '../src/effect/action.js'
import { flash, json, redirect, render, share, shareProps } from '../src/effect/responses.js'
import { currentUser } from '../src/effect/auth.js'
import { EffectErrorObserverService } from '../src/effect/error-observer.js'
import { HttpError } from '../src/effect/errors.js'
import { signedIn, testEnv } from '../src/testing.js'

function createApp() {
  const app = new Hono()
  const { routes } = setupWeb(app, {
    version: '1',
    render: (page) => JSON.stringify(page),
    auth: { share: S.Struct({ id: S.String, email: S.String }) },
    shared: S.Struct({ lastVisit: S.Date }),
    flash: S.Struct({ notice: S.Struct({ text: S.String, at: S.Date }) }),
    errors: { component: 'Error' },
  })

  routes
    .get('/dashboard', action(Effect.gen(function* () {
      yield* share('lastVisit', new Date(Date.UTC(2026, 9, 13)))
      yield* flash('notice', { text: 'Welcome back', at: new Date(Date.UTC(2026, 9, 13, 9)) })

      return yield* render('Dashboard')
    })))
    .get('/undeclared', action(Effect.gen(function* () {
      yield* share('theme', 'dark')

      return yield* render('Dashboard')
    })))

  return app
}

const page = { 'X-Inertia': 'true', 'X-Inertia-Version': '1' }

describe('declared values', () => {
  test('pages receive the public user, shared props and flash encoded through their schemas', async () => {
    const res = await createApp().request(
      '/dashboard',
      { headers: page },
      testEnv(signedIn({ id: 'user-1', email: 'ada@example.com', name: 'Ada' }))
    )

    expect(await res.json()).toMatchObject({
      props: {
        auth: { user: { id: 'user-1', email: 'ada@example.com' } },
        lastVisit: '2026-10-13T00:00:00.000Z',
      },
      flash: { notice: { text: 'Welcome back', at: '2026-10-13T09:00:00.000Z' } },
    })
  })

  test('the public user carries only the fields its schema names', async () => {
    const res = await createApp().request(
      '/dashboard',
      { headers: page },
      testEnv(signedIn({ id: 'user-1', email: 'ada@example.com', name: 'Ada' }))
    )

    expect(Object.keys((await res.json()).props.auth.user).sort()).toEqual(['email', 'id'])
  })

  test('sharing a key setupWeb does not declare is a defect', async () => {
    const res = await createApp().request('/undeclared', { headers: { Accept: 'application/json' } }, testEnv(signedIn({ id: 'user-1' })))

    expect(res.status).toBe(500)
    expect((await res.json()).message).toContain("'theme' is not in setupWeb's shared")
  })
})

describe('shareProps', () => {
  function sharingApp() {
    const app = new Hono()
    let computed = 0
    const { routes } = setupWeb(app, {
      version: '1',
      render: (page) => JSON.stringify(page),
      shared: S.Struct({ unread: S.Number, since: S.Date }),
    })

    const unread = Effect.gen(function* () {
      computed += 1
      const viewer = yield* currentUser

      return viewer ? { unread: 3 } : {}
    })
    const since = Effect.succeed({ since: new Date(Date.UTC(2026, 9, 13)) })

    routes
      .provide(shareProps(unread))
      .provide(shareProps(since))
      .get('/inbox', action(render('Inbox')))
      .post('/inbox', action(redirect('/inbox')))
      .get('/api/inbox', action(json({ ok: true })))

    return { app, computed: () => computed }
  }

  test('pages receive the props it computes, encoded through setupWeb\'s shared', async () => {
    const { app } = sharingApp()
    const res = await app.request('/inbox', { headers: page }, testEnv(signedIn({ id: 'user-1' })))

    expect((await res.json()).props).toMatchObject({ unread: 3, since: '2026-10-13T00:00:00.000Z' })
  })

  test('each computation decides its own props', async () => {
    const { app } = sharingApp()
    const res = await app.request('/inbox', { headers: page })
    const props = (await res.json()).props

    expect(props.unread).toBeUndefined()
    expect(props.since).toBe('2026-10-13T00:00:00.000Z')
  })

  test('a computation that fails is reported, and the page renders without its props', async () => {
    const app = new Hono()
    const observed: string[] = []
    const observer = Layer.succeed(EffectErrorObserverService, {
      observe: (event) => Effect.sync(() => {
        observed.push(String(event.metadata?.operation))
      }),
    })
    const { routes } = setupWeb(app, {
      version: '1',
      render: (page) => JSON.stringify(page),
      shared: S.Struct({ unread: S.Number }),
    })

    routes
      .provide(shareProps(Effect.fail(new HttpError({ status: 503, message: 'Database unavailable' }))))
      .get('/inbox', action(render('Inbox', { title: 'Inbox' })))

    const res = await app.request('/inbox', { headers: page }, testEnv(observer))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.props.title).toBe('Inbox')
    expect(body.props.unread).toBeUndefined()
    expect(observed).toEqual(['shareProps'])
  })

  test('redirects and JSON responses never compute them', async () => {
    const { app, computed } = sharingApp()
    const env = testEnv(signedIn({ id: 'user-1' }))

    await app.request('/inbox', { method: 'POST', headers: page }, env)
    await app.request('/api/inbox', { headers: { Accept: 'application/json' } }, env)
    expect(computed()).toBe(0)

    await app.request('/inbox', { headers: page }, env)
    expect(computed()).toBe(1)
  })
})
