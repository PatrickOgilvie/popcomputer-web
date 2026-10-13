/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
/**
 * JSON Response Tests
 *
 * A JSON response declared by a schema is encoded through its JSON form, as
 * page props are, and a test reads it back through the same schema.
 */

import { describe, expect, test } from 'bun:test'
import { Effect, Schema as S } from 'effect'
import { Hono } from 'hono'
import { setupWeb } from '../src/setup.js'
import { action } from '../src/effect/action.js'
import { json } from '../src/effect/responses.js'
import { HttpError } from '../src/effect/errors.js'
import { readError, readJson } from '../src/testing.js'

const Evaluation = S.Struct({ flag: S.String, enabled: S.Boolean, evaluatedAt: S.Date })

function createApp() {
  const app = new Hono()
  const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page), errors: { component: 'Error' } })

  routes
    .get('/api/flags', action(json(Evaluation, { flag: 'beta', enabled: true, evaluatedAt: new Date(Date.UTC(2026, 9, 13)) })))
    // SAFETY: deliberately breaks the declared shape at runtime to check the response fails.
    .get('/api/broken', action(json(Evaluation, { flag: 'beta', enabled: 'yes' } as never)))
    .get('/page', action(Effect.fail(new HttpError({ status: 409, message: 'Taken' }))))

  return app
}

describe('json(Schema, value)', () => {
  test('encodes the value through the schema, and readJson decodes it back', async () => {
    const res = await createApp().request('/api/flags')

    expect(await res.clone().json()).toEqual({ flag: 'beta', enabled: true, evaluatedAt: '2026-10-13T00:00:00.000Z' })
    expect(await readJson(res, Evaluation)).toEqual({
      flag: 'beta',
      enabled: true,
      evaluatedAt: new Date(Date.UTC(2026, 9, 13)),
    })
  })

  test('a value that does not match its schema is a server error', async () => {
    const res = await createApp().request('/api/broken', { headers: { Accept: 'application/json' } })

    expect(res.status).toBe(500)
  })
})

describe('readError', () => {
  test('says how to get the JSON envelope when the response is HTML', async () => {
    const res = await createApp().request('/page', { headers: { Accept: 'text/html' } })

    await expect(readError(res)).rejects.toThrow('Send Accept: application/json for the JSON envelope.')
  })
})
