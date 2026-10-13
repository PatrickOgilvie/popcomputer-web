/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
/**
 * Error Page Tests
 *
 * Page and HTML requests see every failure through the application's error
 * page, with the failure's status; JSON clients get the structured error.
 */

import { describe, expect, test } from 'bun:test'
import { Effect } from 'effect'
import { Hono } from 'hono'
import { setupWeb } from '../../src/setup.js'
import { ForbiddenError, HttpError, type AppError } from '../../src/effect/errors.js'

function appFailingWith(error: AppError) {
  const app = new Hono()
  const { routes } = setupWeb(app, {
    version: '1',
    render: (page) => JSON.stringify(page),
    errors: { component: 'Error' },
  })

  routes.get('/', Effect.fail(error))

  return app
}

const inertia = { headers: { 'X-Inertia': 'true', 'X-Inertia-Version': '1' } }
const browser = { headers: { Accept: 'text/html' } }
const api = { headers: { Accept: 'application/json' } }

describe('error page', () => {
  test('a forbidden page request renders the error page with 403', async () => {
    const app = appFailingWith(new ForbiddenError({ message: 'Not authorized' }))

    for (const init of [inertia, browser]) {
      const res = await app.request('/', init)

      expect(res.status).toBe(403)
      expect(await res.json()).toMatchObject({
        component: 'Error',
        props: { status: 403, code: 'WEB_AUTH_102_FORBIDDEN' },
      })
    }
  })

  test('an HTTP error without a body renders the error page with its status', async () => {
    const res = await appFailingWith(new HttpError({ status: 409, message: 'Name taken' })).request('/', inertia)

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({
      component: 'Error',
      props: { status: 409, code: 'WEB_HTTP_4XX_CLIENT_ERROR', title: 'Request Failed' },
    })
  })

  test('an HTTP error with a body answers with JSON for every client', async () => {
    const app = appFailingWith(new HttpError({ status: 429, message: 'Slow down', body: { retryAfter: 60 } }))
    const res = await app.request('/', inertia)

    expect(res.status).toBe(429)
    expect(res.headers.get('Content-Type')).toContain('application/json')
    expect(await res.json()).toMatchObject({ body: { retryAfter: 60 } })
  })

  test('a JSON client gets the structured error', async () => {
    const res = await appFailingWith(new ForbiddenError({ message: 'Not authorized' })).request('/', api)

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'WEB_AUTH_102_FORBIDDEN', tag: 'ForbiddenError' })
  })
})
