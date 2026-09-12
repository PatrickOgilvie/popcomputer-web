/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
import { expect, test } from 'bun:test'
import { Effect } from 'effect'
import { TestClock } from 'effect/testing'
import { Hono } from 'hono'
import { AuthUserService } from '../../src/effect/services.js'
import { TestCaptureService, TestLayer } from '../../src/effect/test-layers.js'
import { effectBridge } from '../../src/effect/bridge.js'
import { effectHandler } from '../../src/effect/handler.js'
import { getResponseTestCaptures } from '../../src/effect/test-capture-store.js'

test('auth fixtures expire relative to the provided Effect clock', async () => {
  await Effect.runPromise(Effect.gen(function* () {
    yield* TestClock.adjust('10 seconds')

    const user = yield* AuthUserService.pipe(
      Effect.provide(TestLayer.Auth.withUser({ id: 'clock-user' })),
    )

    expect(user.user.id).toBe('clock-user')
    expect(user.session.expiresAt.getTime()).toBe(3_610_000)
  }).pipe(Effect.provide(TestClock.layer())))
})

test('capture reads are lazy effects over the layer-owned state', async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const capture = yield* TestCaptureService
    const read = capture.get
    yield* capture.capture('events', { name: 'saved', payload: { id: '1' } })

    expect((yield* read).events).toEqual([{ name: 'saved', payload: { id: '1' } }])
  }).pipe(Effect.provide(TestLayer.Capture.make())))
})

test('the Hono bridge attaches captured events to the completed response', async () => {
  const app = new Hono()
  app.use('*', effectBridge())
  app.get('/capture', effectHandler(Effect.gen(function* () {
    const capture = yield* TestCaptureService
    yield* capture.capture('events', { name: 'saved', payload: { id: '1' } })

    return new Response('saved')
  })))

  const response = await app.request('/capture', {}, { __testLayer: TestLayer.Capture.make() })

  expect(response.status).toBe(200)
  expect(getResponseTestCaptures(response)?.events).toEqual([{ name: 'saved', payload: { id: '1' } }])
})
