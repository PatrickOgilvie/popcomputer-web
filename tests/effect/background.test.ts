import { describe, expect, test } from 'bun:test'
import { Context, Effect, Layer } from 'effect'
import { Hono } from 'hono'
import { setupHonertia } from '../../src/setup.js'
import { background } from '../../src/effect/background.js'
import { HttpError } from '../../src/effect/errors.js'
import {
  EffectErrorObserverService,
  type EffectErrorEvent,
} from '../../src/effect/error-observer.js'
import { effectRoutes } from '../../src/effect/routing.js'

class ScopedBackgroundResource extends Context.Service<
  ScopedBackgroundResource,
  { readonly isReleased: () => boolean }
>()('test/ScopedBackgroundResource') {}

describe('background', () => {
  test('keeps Worker work alive and observes failures with its operation name', async () => {
    const events: EffectErrorEvent[] = []
    const waitUntilPromises: Promise<unknown>[] = []
    const app = new Hono()

    setupHonertia(app, {
      honertia: {
        version: '1.0.0',
        render: (page) => JSON.stringify(page),
      },
      effect: {
        services: () =>
          Layer.succeed(EffectErrorObserverService, {
            observe: (event) => Effect.sync(() => events.push(event)),
          }),
      },
    })

    effectRoutes(app).post(
      '/events',
      Effect.gen(function* () {
        yield* background(
          'analytics.record-signup',
          Effect.sleep('5 millis').pipe(
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
      }
    )

    expect(response.status).toBe(202)
    expect(waitUntilPromises.length).toBeGreaterThan(0)
    await Promise.allSettled(waitUntilPromises)
    expect(events).toHaveLength(1)
    expect(events[0].metadata).toEqual({ operation: 'analytics.record-signup' })
    expect(events[0].handling).toBe('unhandled')
  })

  test('runs safely before completion when no Worker execution context exists', async () => {
    let completed = false
    const app = new Hono()

    setupHonertia(app, {
      honertia: {
        version: '1.0.0',
        render: (page) => JSON.stringify(page),
      },
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
    let backgroundObservedReleasedResource = false
    const waitUntilPromises: Promise<unknown>[] = []
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
          Effect.sleep('5 millis').pipe(
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
      }
    )

    expect(response.status).toBe(202)
    expect(waitUntilPromises.length).toBeGreaterThan(0)
    await Promise.allSettled(waitUntilPromises)
    expect(backgroundObservedReleasedResource).toBe(false)
    expect(released).toBe(true)
  })
})
