/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
/**
 * Request State Service Tests
 *
 * RequestStateService shares request-scoped values between Effect actions
 * and surrounding Hono middleware, backed by Hono's context variables
 * (c.set / c.var). An action can publish a value (e.g. a verified API key's
 * environment) that a wrapping middleware reads after next(), and can read
 * values a middleware set before the route ran.
 */

import { describe, test, expect } from 'bun:test'
import { Hono } from 'hono'
import { Effect, Schema as S } from 'effect'
import { effectRoutes } from '../../src/effect/routing.js'
import { honertia } from '../../src/middleware.js'
import { effectBridge } from '../../src/effect/bridge.js'
import { RequestStateService } from '../../src/effect/services.js'
import type { PageProps } from '../../src/types.js'

const createApp = () => {
  const app = new Hono()
  app.use('*', honertia({ version: '1.0.0', render: (page) => JSON.stringify(page) }))
  app.use('*', effectBridge())

  return app
}

describe('RequestStateService', () => {
  test('action-published state is readable by wrapping middleware after next()', async () => {
    const app = new Hono()
    app.use('*', honertia({ version: '1.0.0', render: (page) => JSON.stringify(page) }))

    // Outer middleware: rewrites the response from state the action published
    app.use('*', async (c, next) => {
      await next()
      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      const environment = (c.var as PageProps).apiKeyEnvironment

      if (S.is(S.String)(environment)) {
        c.res.headers.set('X-Api-Key-Environment', environment)
      }
    })

    app.use('*', effectBridge())

    effectRoutes(app).get(
      '/keys/verify',
      Effect.gen(function* () {
        const state = yield* RequestStateService
        state.set('apiKeyEnvironment', 'test')

        return new Response('verified')
      })
    )

    const res = await app.request('/keys/verify')
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Api-Key-Environment')).toBe('test')
  })

  test('middleware-set state is readable inside the action', async () => {
    const app = new Hono()
    app.use('*', honertia({ version: '1.0.0', render: (page) => JSON.stringify(page) }))

    app.use('*', async (c, next) => {
      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      c.set('tenantId' as never, 'tenant-42' as never)
      await next()
    })

    app.use('*', effectBridge())

    effectRoutes(app).get(
      '/tenant',
      Effect.gen(function* () {
        const state = yield* RequestStateService

        return new Response(state.get<string>('tenantId') ?? 'missing')
      })
    )

    const res = await app.request('/tenant')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('tenant-42')
  })

  test('get returns undefined for unset keys', async () => {
    const app = createApp()

    effectRoutes(app).get(
      '/unset',
      Effect.gen(function* () {
        const state = yield* RequestStateService

        return Response.json({ value: state.get('never-set') ?? null })
      })
    )

    const res = await app.request('/unset')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ value: null })
  })
})
