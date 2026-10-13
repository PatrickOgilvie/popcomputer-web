/**
 * Compile-time tests for endpoint contracts: the contract types the action's
 * input and success, and registration reports what the contract and the
 * routes do not cover. If this file compiles, the types are correct.
 */

import { Context, Effect, Schema as S } from 'effect'
import { Hono } from 'hono'
import { setupWeb } from '../src/setup.js'
import { action } from '../src/effect/action.js'
import { bound } from '../src/effect/binding.js'
import { call, endpoint, type EndpointInput } from '../src/endpoint.js'
import { coercedNumber, requiredString } from '../src/effect/schema.js'

type AssertEqual<T, U> = [T] extends [U] ? ([U] extends [T] ? true : false) : false

const Place = S.Struct({ id: S.String, name: S.String })

class PlaceExists extends S.TaggedError<PlaceExists>()('PlaceExists', { placeId: S.String }) {}
class Unrelated extends S.TaggedError<Unrelated>()('Unrelated', {}) {}

class Geocoder extends Context.Service<Geocoder, { readonly locate: (name: string) => Effect.Effect<string> }>()('Geocoder') {}

const endpoints = {
  createPlace: endpoint.post('/places', {
    body: S.Struct({ name: requiredString, rating: coercedNumber }),
    success: Place,
    status: 201,
    errors: { 409: PlaceExists },
  }),
  showPlace: endpoint.get('/places/{place}', { success: Place }),
  listPlaces: endpoint.get('/places', { query: S.Struct({ page: coercedNumber }), success: S.Array(Place) }),
}

// The input holds the path's parameters and what the contract declares.
const inputs: [
  AssertEqual<EndpointInput<typeof endpoints.createPlace>, { readonly params: {}; readonly body: { readonly name: string; readonly rating: number } }>,
  AssertEqual<EndpointInput<typeof endpoints.showPlace>['params'], { readonly place: string }>,
  AssertEqual<EndpointInput<typeof endpoints.listPlaces>['query'], { readonly page: number }>,
] = [true, true, true]
void inputs

// @ts-expect-error A GET carries no body.
endpoint.get('/places', { body: Place })

// @ts-expect-error The success must match the contract's.
action(endpoints.showPlace, () => Effect.succeed({ id: 'p1' }))

// @ts-expect-error The input has no query the contract does not declare.
action(endpoints.showPlace, ({ query }) => Effect.succeed({ id: String(query), name: 'x' }))

const createPlace = action(endpoints.createPlace, ({ body }) =>
  Effect.gen(function* () {
    if (body.name === 'taken') return yield* new PlaceExists({ placeId: 'p1' })

    return { id: 'p2', name: body.name }
  })
)

const failsUndeclared = action(endpoints.createPlace, () => Effect.fail(new Unrelated()))

const needsGeocoder = action(endpoints.createPlace, ({ body }) =>
  Effect.map(Geocoder.use((geocoder) => geocoder.locate(body.name)), (id) => ({ id, name: body.name }))
)

const readsMissingModel = action(endpoints.createPlace, ({ body }) =>
  Effect.map(bound('place'), () => ({ id: 'p3', name: body.name }))
)

const readsModel = action(endpoints.showPlace, () => Effect.map(bound('place'), () => ({ id: 'p3', name: 'x' })))

{
  const { routes } = setupWeb(new Hono(), { version: 'type-test', render: (page) => JSON.stringify(page) })

  // A declared failure is answered by the contract.
  routes.endpoint(createPlace)
  // A placeholder in the contract's path binds the model.
  routes.endpoint(readsModel)
  // @ts-expect-error A failure the contract does not declare is unhandled.
  routes.endpoint(failsUndeclared)
  // @ts-expect-error Nothing provides Geocoder.
  routes.endpoint(needsGeocoder)
  // @ts-expect-error The contract's path has no {place}.
  routes.endpoint(readsMissingModel)
}

async function client() {
  // @ts-expect-error The body is required.
  await call(endpoints.createPlace)
  // @ts-expect-error The path needs its parameter.
  await call(endpoints.showPlace, {})

  const result = await call(endpoints.createPlace, { body: { name: 'Café', rating: 4 } })

  if (result.ok) {
    const name: string = result.value.name
    void name
  } else if (result.error._tag === 'PlaceExists') {
    const placeId: string = result.error.placeId
    void placeId
  } else {
    const status: number = result.error.httpStatus
    void status
  }
}

void client

// A contract requiring a user gives the handler `auth`; one that does not, none.
const secured = endpoint.post('/places/{place}/name', { auth: true, body: S.Struct({ name: S.String }), success: Place })
action(secured, ({ auth, params }) => Effect.succeed({ id: params.place, name: auth.user.id }))
// @ts-expect-error The contract does not require a user.
action(endpoints.showPlace, ({ auth }) => Effect.succeed({ id: String(auth), name: 'x' }))
