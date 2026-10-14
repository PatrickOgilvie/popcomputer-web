/* oxlint-disable effecttsgo/async-function -- Test entrypoints call app.request, a native Promise contract. */
/**
 * A failure an action cannot answer, such as another system being down, is a
 * defect: the action pipes that call through `Effect.orDie`. The request
 * answers 500, production says nothing about why, the development error names
 * the failure, and the error observer receives the failure itself.
 */

import { describe, expect, test } from 'bun:test'
import { Effect, Layer, Schema as S } from 'effect'
import { Hono } from 'hono'
import { setupWeb } from '../src/setup.js'
import { action } from '../src/effect/action.js'
import { json } from '../src/effect/responses.js'
import { EffectErrorObserverService, type EffectErrorEvent } from '../src/effect/error-observer.js'
import { readError, testEnv } from '../src/testing.js'

class CrmUnavailable extends S.TaggedError<CrmUnavailable>()('CrmUnavailable', { status: S.Number }) {}

/** A call to another system, failing as it does while that system is down. */
const syncDeals = Effect.fail(new CrmUnavailable({ status: 503 }))

function createApp(observed: EffectErrorEvent[]) {
  const app = new Hono()
  const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) }).services({
    app: Layer.succeed(EffectErrorObserverService, EffectErrorObserverService.of({
      observe: (event) => Effect.sync(() => void observed.push(event)),
    })),
  })

  routes.post('/deals/sync', action(Effect.gen(function* () {
    yield* syncDeals.pipe(Effect.orDie)

    return yield* json(S.Struct({ synced: S.Boolean }), { synced: true })
  })))

  return app
}

const sync = (app: Hono, bindings: Record<string, string>) =>
  app.request('/deals/sync', { method: 'POST', headers: { Accept: 'application/json', Origin: 'http://localhost' } }, testEnv(bindings))

describe('a failure an action turns into a defect with Effect.orDie', () => {
  test('answers 500 and, in production, says nothing about why', async () => {
    const res = await sync(createApp([]), { ENVIRONMENT: 'production' })
    const body = await readError(res)

    expect(res.status).toBe(500)
    expect(body.message).toBe('An error occurred. Please try again later.')
    expect(JSON.stringify(body)).not.toContain('CrmUnavailable')
  })

  test('names the failure in development', async () => {
    const res = await sync(createApp([]), {})

    expect(res.status).toBe(500)
    expect((await readError(res)).message).toBe('An unhandled Effect defect occurred: CrmUnavailable')
  })

  test('hands the failure itself to the error observer, as a defect', async () => {
    const observed: EffectErrorEvent[] = []

    await sync(createApp(observed), { ENVIRONMENT: 'production' })

    expect(observed).toEqual([expect.objectContaining({ kind: 'defect', handling: 'unhandled', error: new CrmUnavailable({ status: 503 }) })])
  })
})
