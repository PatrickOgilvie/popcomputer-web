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
import { ForbiddenError, HttpError, NotFoundError, type AppError } from '../../src/effect/errors.js'

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

  test('a rate limit tells the client when to retry, as a header and in the body', async () => {
    const res = await appFailingWith(HttpError.rateLimited(30)).request('/', api)

    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('30')
    expect(await res.json()).toMatchObject({ body: { retryAfter: 30 } })
  })

  test('a JSON client gets the structured error', async () => {
    const res = await appFailingWith(new ForbiddenError({ message: 'Not authorized' })).request('/', api)

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'WEB_AUTH_102_FORBIDDEN', tag: 'ForbiddenError' })
  })

  test('every 404 reads the same in production, whatever the resource name', async () => {
    const production = { ENVIRONMENT: 'production' }
    const team = await appFailingWith(new NotFoundError({ resource: 'Team' })).request('/', api, production)
    const bound = await appFailingWith(new NotFoundError({ resource: 'team', id: 'acme' })).request('/', api, production)
    const read = async (res: Response) => {
      const { timestamp: _timestamp, ...body } = await res.json()

      return body
    }

    expect(await read(team)).toEqual(await read(bound))
  })

  test('a production Cloudflare Pages deployment, which sets CF_PAGES_BRANCH, hides a failure\'s message', async () => {
    const app = appFailingWith(HttpError.internal('db://user:secret@host'))
    const res = await app.request('/', api, { CF_PAGES_BRANCH: 'main' })

    expect(res.status).toBe(500)
    expect((await res.json()).message).toBe('An error occurred. Please try again later.')
  })

  test('a development environment shows it', async () => {
    const app = appFailingWith(HttpError.internal('db://user:secret@host'))
    const res = await app.request('/', api, { ENVIRONMENT: 'development' })

    expect((await res.json()).message).toContain('secret')
  })
})
