/* oxlint-disable effecttsgo/async-function -- Test entrypoints call app.request, a native Promise contract. */
/**
 * A test replaces a service that reaches another system with a fake, through
 * testEnv's layer, wherever the application gives that service: once for the
 * application, for each request, or on a route with `routes.provide()`. The
 * fake is built once a request, so a fake that keeps state keeps one.
 */

import { describe, expect, test } from 'bun:test'
import { Context, Effect, Layer, Ref, Schema as S } from 'effect'
import { Hono } from 'hono'
import { setupWeb } from '../src/setup.js'
import { action } from '../src/effect/action.js'
import { json } from '../src/effect/responses.js'
import { testEnv } from '../src/testing.js'

/** Another system: a CRM the application reads organisations from. */
class Crm extends Context.Service<Crm, { readonly organisations: Effect.Effect<ReadonlyArray<string>> }>()('test/Crm') {}

const realCrm = Layer.succeed(Crm, Crm.of({ organisations: Effect.succeed(['from the real CRM']) }))

const Organisations = S.Struct({ organisations: S.Array(S.String) })

const listOrganisations = action(Effect.gen(function* () {
  const crm = yield* Crm

  return yield* json(Organisations, { organisations: yield* crm.organisations })
}))

/** An application giving the CRM one of the three ways. */
function appGivingCrm(how: 'app' | 'request' | 'route') {
  const app = new Hono()
  const setup = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) })

  if (how === 'route') {
    setup.routes.provide(realCrm).get('/organisations', listOrganisations)
  } else {
    setup.services(how === 'app' ? { app: realCrm } : { request: () => realCrm }).routes.get('/organisations', listOrganisations)
  }

  return app
}

const fakeCrm = Layer.succeed(Crm, Crm.of({ organisations: Effect.succeed(['from the fake']) }))

const organisations = async (app: Hono, layer: Layer.Layer<never>) => {
  const response = await app.request('/organisations', { headers: { Accept: 'application/json' } }, testEnv(layer))

  return S.decodeUnknownSync(Organisations)(await response.json()).organisations
}

describe("testEnv's layer replaces a service", () => {
  for (const how of ['app', 'request', 'route'] as const) {
    test(`given ${how === 'route' ? 'on a route with routes.provide()' : `in web.services' ${how}`}`, async () => {
      const app = appGivingCrm(how)

      expect(await organisations(app, Layer.empty)).toEqual(['from the real CRM'])
      expect(await organisations(app, fakeCrm)).toEqual(['from the fake'])
    })
  }

  test('building a fake that keeps state once a request, so the action and the route share it', async () => {
    let builds = 0
    const countingCrm = Layer.effect(Crm, Effect.gen(function* () {
      builds += 1
      const calls = yield* Ref.make(0)

      return Crm.of({ organisations: Effect.map(Ref.updateAndGet(calls, (count) => count + 1), (count) => [`call ${count}`]) })
    }))

    expect(await organisations(appGivingCrm('route'), countingCrm)).toEqual(['call 1'])
    expect(builds).toBe(1)
  })
})
