/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
import { describe, expect, test } from 'bun:test'
import { Context, Deferred, Effect, Layer, Logger } from 'effect'
import { Hono } from 'hono'
import { setupWeb } from '../../src/setup.js'
import { background } from '../../src/effect/background.js'
import { HttpError } from '../../src/effect/errors.js'
import {
  EffectErrorObserverService,
  type EffectErrorEvent,
} from '../../src/effect/error-observer.js'
import { effectRoutes } from '../../src/effect/routing.js'
import { ExecutionContextService } from '../../src/effect/services.js'
import { testEnv } from '../../src/testing.js'

class ScopedBackgroundResource extends Context.Service<
  ScopedBackgroundResource,
  { readonly isReleased: () => boolean }
>()('test/ScopedBackgroundResource') {}

describe('background', () => {
  test('keeps Worker work alive and observes failures with its operation name', async () => {
    const events: EffectErrorEvent[] = []
    const waitUntilPromises: Promise<unknown>[] = []
    const releaseBackground = Deferred.makeUnsafe<void>()
    const app = new Hono()

    setupWeb(app, {
      version: '1.0.0',
      render: (page) => JSON.stringify(page),
    }).services({
      request: () =>
        Layer.succeed(EffectErrorObserverService, {
          observe: (event) => Effect.sync(() => events.push(event)),
        }),
    })

    effectRoutes(app).post(
      '/events',
      Effect.gen(function* () {
        yield* background(
          'analytics.record-signup',
          Deferred.await(releaseBackground).pipe(
            Effect.andThen(Effect.fail(HttpError.internal('analytics unavailable')))
          )
        )

        return new Response(null, { status: 202 })
      })
    )

    const response = await app.fetch(
      new Request('http://localhost/events', { method: 'POST' }),
      {},
      {
        waitUntil: (promise: Promise<unknown>) => waitUntilPromises.push(promise),
        passThroughOnException: () => {},
        props: {},
      }
    )

    expect(response.status).toBe(202)
    expect(waitUntilPromises.length).toBeGreaterThan(0)
    await Effect.runPromise(Deferred.succeed(releaseBackground, undefined))
    await Promise.allSettled(waitUntilPromises)
    expect(events).toHaveLength(1)
    expect(events[0].metadata).toEqual({ operation: 'analytics.record-signup' })
    expect(events[0].handling).toBe('unhandled')
  })

  test("keeps a promise handed to waitUntil alive, and observes its failure", async () => {
    const events: EffectErrorEvent[] = []
    const waitUntilPromises: Promise<unknown>[] = []
    const app = new Hono()

    setupWeb(app, {
      version: '1.0.0',
      render: (page) => JSON.stringify(page),
    }).services({
      request: () =>
        Layer.succeed(EffectErrorObserverService, {
          observe: (event) => Effect.sync(() => events.push(event)),
        }),
    })

    effectRoutes(app).post(
      '/events',
      Effect.gen(function* () {
        const execution = yield* ExecutionContextService
        execution.waitUntil(Promise.reject(new Error('webhook delivery failed')))

        return new Response(null, { status: 202 })
      })
    )

    const response = await app.fetch(
      new Request('http://localhost/events', { method: 'POST' }),
      {},
      {
        waitUntil: (promise: Promise<unknown>) => waitUntilPromises.push(promise),
        passThroughOnException: () => {},
        props: {},
      }
    )

    expect(response.status).toBe(202)
    expect(waitUntilPromises.length).toBeGreaterThan(0)
    await Promise.allSettled(waitUntilPromises)
    expect(events.map((event) => event.metadata)).toEqual([{ operation: 'external-background' }])
  })

  test('runs safely before completion when no Worker execution context exists', async () => {
    let completed = false
    const app = new Hono()

    setupWeb(app, {
      version: '1.0.0',
      render: (page) => JSON.stringify(page),
    })
    effectRoutes(app).post(
      '/events',
      Effect.gen(function* () {
        yield* background(
          'events.persist',
          Effect.sync(() => {
            completed = true
          })
        )

        return new Response(null, { status: 202 })
      })
    )

    const response = await app.request('/events', { method: 'POST' })
    expect(response.status).toBe(202)
    expect(completed).toBe(true)
  })

  test('keeps a standalone route runtime alive until scoped background work settles', async () => {
    let released = false
    let backgroundObservedReleasedResource: boolean | undefined
    const waitUntilPromises: Promise<unknown>[] = []
    const releaseBackground = Deferred.makeUnsafe<void>()
    const app = new Hono()

    const resourceLayer = Layer.effect(
      ScopedBackgroundResource,
      Effect.acquireRelease(
        Effect.succeed({ isReleased: () => released }),
        () => Effect.sync(() => {
          released = true
        })
      )
    )

    effectRoutes(app, { services: () => resourceLayer }).post(
      '/events',
      Effect.gen(function* () {
        yield* background(
          'events.use-scoped-resource',
          Deferred.await(releaseBackground).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                const resource = yield* ScopedBackgroundResource
                backgroundObservedReleasedResource = resource.isReleased()
              })
            )
          )
        )

        return new Response(null, { status: 202 })
      })
    )

    const response = await app.fetch(
      new Request('http://localhost/events', { method: 'POST' }),
      {},
      {
        waitUntil: (promise: Promise<unknown>) => waitUntilPromises.push(promise),
        passThroughOnException: () => {},
        props: {},
      }
    )

    expect(response.status).toBe(202)
    expect(waitUntilPromises.length).toBeGreaterThan(0)
    expect(released).toBe(false)
    await Effect.runPromise(Deferred.succeed(releaseBackground, undefined))
    await Promise.allSettled(waitUntilPromises)
    expect(backgroundObservedReleasedResource).toBe(false)
    expect(released).toBe(true)
  })

  test('logs failed work through the Effect logger when no observer is installed', async () => {
    const logs: Array<{ readonly level: string; readonly message: unknown }> = []
    const recording = Logger.layer([
      Logger.make((options) => logs.push({ level: options.logLevel, message: options.message })),
    ])
    const app = new Hono()
    const { routes } = setupWeb(app, { version: '1.0.0', render: (page) => JSON.stringify(page) })

    routes.post('/events', Effect.gen(function* () {
      yield* background('record-activity', Effect.fail(new HttpError({ status: 500, message: 'activity table missing' })))

      return new Response(null, { status: 202 })
    }))

    const response = await app.request('/events', { method: 'POST' }, testEnv(recording))

    expect(response.status).toBe(202)
    expect(logs).toContainEqual({ level: 'Error', message: ['Background work failed', expect.any(HttpError)] })
  })
})
