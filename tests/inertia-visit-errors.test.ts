/* oxlint-disable effecttsgo/async-function -- Test entrypoints call app.request, a native Promise contract. */
/**
 * A failure answers an Inertia visit with Inertia's page protocol, whatever
 * the visit's User-Agent or Accept says. Command-line and AI clients get
 * JSON, but one driving the application as a browser does sends X-Inertia,
 * and an Inertia client cannot read a JSON error.
 */

import { describe, expect, test } from 'bun:test'
import { Effect, Schema as S } from 'effect'
import { Hono } from 'hono'
import { setupWeb } from '../src/setup.js'
import { action } from '../src/effect/action.js'
import { httpError, redirect, render } from '../src/effect/responses.js'
import { requiredString } from '../src/effect/schema.js'
import { validateRequest } from '../src/effect/validation.js'

const save = action(Effect.gen(function* () {
  yield* validateRequest(S.Struct({ title: requiredString }))

  return yield* redirect('/')
}))

function createApp() {
  const app = new Hono()
  const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) })

  routes
    .get('/notes', action(render('Notes/Index')))
    .post('/notes', save)
    .post('/locked', action(httpError(403, 'Locked.')))

  return app
}

const agents = ['curl/8.7.1', 'claude-code/1.0', 'Mozilla/5.0 (Macintosh) Claude/1.0']

const post = (path: string, headers: Record<string, string>) => createApp().request(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
  body: '{}',
})

describe('an Inertia visit from a command-line or AI user agent', () => {
  test.each(agents)('sends a failed form back to its page: %s', async (agent) => {
    const response = await post('/notes', { 'X-Inertia': 'true', 'User-Agent': agent })

    expect(response.status).toBe(303)
    expect(response.headers.get('Location')).toBe('/notes')
  })

  test.each(agents)('renders the error page for a failure: %s', async (agent) => {
    const response = await post('/locked', { 'X-Inertia': 'true', 'User-Agent': agent })

    expect(response.status).toBe(403)
    expect(response.headers.get('X-Inertia')).toBe('true')
    expect(await response.json()).toMatchObject({ component: 'Error', props: { status: 403 } })
  })

  test.each(agents)('without X-Inertia, still gets JSON: %s', async (agent) => {
    const response = await post('/notes', { 'User-Agent': agent })

    expect(response.status).toBe(422)
    expect(response.headers.get('X-Inertia')).toBeNull()
    expect(await response.json()).toMatchObject({ httpStatus: 422 })
  })
})
