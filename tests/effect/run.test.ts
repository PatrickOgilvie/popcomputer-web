/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
/**
 * routes.run Tests
 *
 * An Effect run outside a request, as a Cron Trigger or Queue consumer runs
 * one, gets the application's services as an action does.
 */

import { describe, expect, test } from 'bun:test'
import { Config, Context, Effect, Layer, Schema as S } from 'effect'
import { Hono } from 'hono'
import { setupWeb } from '../../src/setup.js'

class Counter extends Context.Service<Counter, { readonly next: Effect.Effect<number> }>()('test/Counter') {}

class SweepFailed extends S.TaggedError<SweepFailed>()('SweepFailed', { reason: S.String }) {}

function createApp() {
  const app = new Hono<{ Bindings: { readonly REGION: string } }>()
  let count = 0
  const counter = Layer.succeed(Counter, Counter.of({ next: Effect.sync(() => ++count) }))
  const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) })

  return { app, routes, counted: routes.provide(counter) }
}

describe('routes.run', () => {
  test('resolves with the Effect\'s value, reading the bindings it is given', async () => {
    const { routes } = createApp()

    const region = await routes.run(
      Effect.gen(function* () {
        return { region: yield* Config.String('REGION') }
      }),
      { REGION: 'weur' }
    )

    expect(region).toEqual({ region: 'weur' })
  })

  test('provides the layers its builder was given', async () => {
    const { counted } = createApp()
    const next = Effect.flatMap(Counter, (counter) => counter.next)

    expect(await counted.run(next, { REGION: 'weur' })).toBe(1)
    expect(await counted.run(next, { REGION: 'weur' })).toBe(2)
  })

  test('rejects with the Effect\'s failure', async () => {
    const { routes } = createApp()

    await expect(routes.run(Effect.fail(new SweepFailed({ reason: 'locked' })), { REGION: 'weur' })).rejects.toMatchObject({
      _tag: 'SweepFailed',
      reason: 'locked',
    })
  })

  test('cannot be reached by a request', async () => {
    const { app } = createApp()
    const res = await app.request('/__popweb/run', {}, { REGION: 'weur' })

    expect(res.status).toBe(404)
  })
})
