/**
 * A failure that names where to send the visitor, a failed form's
 * `redirectTo` or a guest page's, leads to a path or an `http:` or `https:`
 * URL, as a `Redirect` does. Any other scheme, such as a `javascript:` URL
 * built from a visitor's input, is a defect: an Inertia visit assigns its
 * location to `window.location.href`.
 *
 * Precedents: Nuxt CVE-2024-34343 and React Router CVE-2026-22029
 * (`javascript:` navigation targets).
 */

import { describe, expect, test } from 'bun:test'
import { Effect, Layer, Schema as S } from 'effect'
import { Hono } from 'hono'
import { setupWeb } from '../../src/setup.js'
import { action } from '../../src/effect/action.js'
import { createGuestLayer } from '../../src/effect/auth.js'
import { EffectErrorObserverService, type EffectErrorEvent } from '../../src/effect/error-observer.js'
import { ValidationError } from '../../src/effect/errors.js'
import { json, render } from '../../src/effect/responses.js'
import { requiredString } from '../../src/effect/schema.js'
import { validateRequest } from '../../src/effect/validation.js'
import { signedIn, testEnv } from '../../src/testing.js'

const Step = S.Struct({ name: requiredString })

function createApp(observed: EffectErrorEvent[] = []) {
  const app = new Hono()
  const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) }).services({
    app: Layer.succeed(EffectErrorObserverService, EffectErrorObserverService.of({
      observe: (event) => Effect.sync(() => void observed.push(event)),
    })),
  })

  // Where a failed step goes back to, as an action might build it from what it read.
  const step = (redirectTo: string) => action(Effect.gen(function* () {
    const input = yield* validateRequest(Step, { redirectTo })

    return yield* json(S.Struct({ name: S.String }), input)
  }))

  routes
    .post('/script', step('javascript:alert(1)'))
    .post('/data', step('data:text/html,<script>alert(1)</script>'))
    .post('/path', step('/steps/2'))
    .post('/elsewhere', step('https://example.com/steps/2'))
  routes.provide(createGuestLayer(() => false, 'javascript:alert(1)')).get('/join', action(render('Join')))
  // Middleware that throws reaches Hono's onError, which has no runtime to report a defect with.
  routes.middleware(() => {
    throw new ValidationError({ errors: { name: 'Required.' }, redirectTo: 'javascript:alert(1)' })
  }).post('/thrown', step('/steps/2'))

  return app
}

const failedForm = { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'http://localhost' }, body: 'name=' }

describe("a failure's redirectTo", () => {
  test('to a path or an http(s) URL sends a failed form there', async () => {
    const app = createApp()

    expect((await app.request('/path', failedForm, testEnv({}))).headers.get('Location')).toBe('/steps/2')
    expect((await app.request('/elsewhere', failedForm, testEnv({}))).headers.get('Location')).toBe('https://example.com/steps/2')
  })

  test('to any other scheme is a defect the observer sees, and sends no one there', async () => {
    const observed: EffectErrorEvent[] = []
    const app = createApp(observed)

    for (const path of ['/script', '/data']) {
      const res = await app.request(path, failedForm, testEnv({ ENVIRONMENT: 'production' }))

      expect([path, res.status, res.headers.get('Location')]).toEqual([path, 500, null])
    }

    expect(observed.map((event) => event.kind)).toEqual(['defect', 'defect'])
    expect(String(observed[0]?.error)).toContain('not a javascript: URL')
  })

  test('thrown where no runtime can report it, goes back to the form instead', async () => {
    const res = await createApp().request('/thrown', { ...failedForm, headers: { ...failedForm.headers, Referer: 'http://localhost/steps/1' } }, testEnv({}))

    expect([res.status, res.headers.get('Location')]).toEqual([303, '/steps/1'])
  })

  test("of a guests' page is checked as well, for a signed-in visitor it sends away", async () => {
    // A layer that fails leaves the route's runtime, where the observer
    // runs, unbuilt, as for any failing layer: the answer is what shows it.
    const res = await createApp().request('/join', {}, testEnv(signedIn({ id: 'ada' }), { ENVIRONMENT: 'production' }))

    expect([res.status, res.headers.get('Location')]).toEqual([500, null])
  })
})
