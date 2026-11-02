/**
 * A defect is a broken promise wherever it happens: in an action, which
 * answers 500, and where no answer shows it, in background work after an
 * action succeeded or in shared props a page renders without. As AFL++'s
 * sanitizers abort on a fault the program would survive, `sendFuzzRequest`
 * records what the error observer sees while the request runs, in place of
 * the application's own observer, and `brokenPromises` reports each defect
 * and each failure of background work, so a fuzz test catches the ones its
 * answers hide.
 */
import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { Data, Effect, Layer } from 'effect'
import { action } from '../../src/effect/action.js'
import { background } from '../../src/effect/background.js'
import { EffectErrorObserverService, type EffectErrorEvent } from '../../src/effect/error-observer.js'
import { json } from '../../src/effect/responses.js'
import { brokenPromises, sendFuzzRequest, type FuzzRequest } from '../../src/fuzz.js'
import { setupWeb } from '../../src/setup.js'
import { testEnv } from '../../src/testing.js'

class NotifyFailed extends Data.TaggedError('NotifyFailed')<{ readonly reason: string }> {}

/** What the application's own observer, such as its Sentry, saw. */
const reported: EffectErrorEvent[] = []

function createApp() {
  const app = new Hono()
  const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) }).services({
    app: Layer.succeed(EffectErrorObserverService, EffectErrorObserverService.of({
      observe: (event) => Effect.sync(() => void reported.push(event)),
    })),
  })

  routes
    .get('/fine', action(json({ ok: true })))
    .get('/dies', action(Effect.die(new Error('the action died'))))
    .post('/notify', action(Effect.gen(function* () {
      yield* background('notify', Effect.die(new Error('the notification died')))

      return yield* json({ ok: true })
    })))
    .post('/notify-fails', action(Effect.gen(function* () {
      yield* background('notify', Effect.fail(new NotifyFailed({ reason: 'mail is down' })))

      return yield* json({ ok: true })
    })))

  return app
}

const request = (method: string, path: string): FuzzRequest => ({ person: null, method, path, query: '', headers: { accept: 'application/json' }, body: { as: 'none' } })

describe('a defect no answer shows', () => {
  test('is recorded on the answer, in place of the application’s own observer', async () => {
    reported.length = 0
    const answer = await sendFuzzRequest(createApp(), request('POST', '/notify'), testEnv({}))

    expect(answer?.response.status).toBe(200)
    expect(answer?.observed.map((event) => event.kind)).toEqual(['defect'])
    expect(reported).toEqual([])
  })

  test('breaks a promise when it happens in background work after the action succeeded', async () => {
    const answer = await sendFuzzRequest(createApp(), request('POST', '/notify'), testEnv({}))

    expect(answer === undefined ? [] : brokenPromises(request('POST', '/notify'), answer)).toEqual([
      'made a defect in notify: Error: the notification died',
    ])
  })

  test('breaks a promise when background work fails, which nothing tells the visitor', async () => {
    const answer = await sendFuzzRequest(createApp(), request('POST', '/notify-fails'), testEnv({}))

    expect(answer === undefined ? [] : brokenPromises(request('POST', '/notify-fails'), answer)).toEqual([
      'its background work notify failed: NotifyFailed {"reason":"mail is down"}',
    ])
  })

  test('breaks a promise beside the 500 an action’s defect answers', async () => {
    const answer = await sendFuzzRequest(createApp(), request('GET', '/dies'), testEnv({}))

    expect(answer === undefined ? [] : brokenPromises(request('GET', '/dies'), answer)).toEqual([
      'answered 500',
      'made a defect: Error: the action died',
    ])
  })

  test('breaks none when nothing failed', async () => {
    const answer = await sendFuzzRequest(createApp(), request('GET', '/fine'), testEnv({}))

    expect(answer?.observed).toEqual([])
    expect(answer === undefined ? [] : brokenPromises(request('GET', '/fine'), answer)).toEqual([])
  })
})
