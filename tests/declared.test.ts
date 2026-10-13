/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
/**
 * Declared Values Tests
 *
 * The public user, shared props and flash values are declared once in
 * setupWeb, as Effect Schemas: what reaches the page is encoded through them,
 * so only declared fields reach the browser, as JSON.
 */

import { describe, expect, test } from 'bun:test'
import { Effect, Schema as S } from 'effect'
import { Hono } from 'hono'
import { setupWeb } from '../src/setup.js'
import { action } from '../src/effect/action.js'
import { flash, render, share } from '../src/effect/responses.js'
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
