/**
 * A JSON endpoint is declared once, as a contract, and both ends derive from
 * it (docs/endpoints.md): `call` encodes a client's typed input, the server
 * decodes it before the handler runs, and the success leaves encoded through
 * its schema, so only the fields the schema declares leave the server.
 * Generated values and bodies check each promise. They found three bugs,
 * kept below as tests of their own: `call` dropped every field of an object
 * made with no prototype, as Effect's generators make them; it sent a field
 * the struct may leave out, left out, as null, which a nullable field reads
 * as a value; and the server read a body without its JSON form, so a Date
 * `call` sent as its ISO string was refused.
 *
 * - any value of the body's type reaches the handler, and comes back
 *   through `call`, as it was sent, and the query as its validators read
 *   it (an empty `nullableString` is null) and a URL carries it (a lone
 *   surrogate is U+FFFD);
 * - any other body is answered with a 4xx in the JSON envelope before the
 *   handler runs, and nothing the handler receives fails its schema;
 * - a field the success schema leaves out, such as a row's secret, never
 *   leaves the server;
 * - a contract with `auth: true` answers 401 to a client that is not signed
 *   in, whatever its body, before reading it, and hands a signed-in one's
 *   handler that user.
 */
import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { Arbitrary, Effect, Schema as S } from 'effect'
import { action } from '../../src/effect/action.js'
import { coercedNumber, nullableString } from '../../src/effect/schema.js'
import { call, endpoint, endpointRequest } from '../../src/endpoint.js'
import { setupWeb } from '../../src/setup.js'
import { signedIn, testEnv } from '../../src/testing.js'
import { anyText, oneOf, pick, property, show, textOf } from './property'

const SECRET = 'canary-owner-secret-5d1e'

const Line = S.Struct({ sku: S.String, quantity: S.Int.check(S.isGreaterThan(0)) })
const Order = S.Struct({
  name: S.String,
  note: S.NullOr(S.String),
  rush: S.Boolean,
  status: S.Literals(['draft', 'placed']),
  placedAt: S.Date,
  lines: S.Array(Line),
  tags: S.optional(S.Array(S.String)),
})
const Query = S.Struct({ page: coercedNumber, q: nullableString })

const endpoints = {
  placeOrder: endpoint.post('/api/orders', {
    query: Query,
    body: Order,
    success: S.Struct({ order: Order, page: S.Number, q: S.NullOr(S.String) }),
    status: 201,
  }),
  reschedule: endpoint.post('/api/schedule', {
    body: S.Struct({ at: S.Date, note: S.optional(S.NullOr(S.String)) }),
    success: S.Struct({ at: S.Date, noteSent: S.Boolean, note: S.NullOr(S.String) }),
  }),
  whoAmI: endpoint.post('/api/me', {
    auth: true,
    body: S.Struct({ count: S.Int }),
    success: S.Struct({ id: S.String, count: S.Int }),
  }),
}

/** A fresh application, and every input its handlers received. */
function createApp() {
  const received: unknown[] = []
  const app = new Hono()
  const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) })

  routes
    .endpoint(action(endpoints.placeOrder, ({ body, query }) =>
      Effect.sync(() => {
        received.push(body)
        // A row as the database might hold it, with a field the contract leaves out.
        const row = { ...body, ownerSecret: SECRET }

        return { order: row, page: query.page, q: query.q }
      })
    ))
    .endpoint(action(endpoints.reschedule, ({ body }) =>
      Effect.succeed({ at: body.at, noteSent: Object.hasOwn(body, 'note'), note: body.note ?? null })
    ))
    .endpoint(action(endpoints.whoAmI, ({ auth, body }) =>
      Effect.sync(() => {
        received.push(body)

        return { id: auth.user.id, count: body.count }
      })
    ))

  return { app, received }
}

const orderEquivalence = S.toEquivalence(Order)

/** An order as JSON carries it: its one optional field, given as undefined, left out. */
const asSent = ({ tags, ...order }: typeof Order.Type): typeof Order.Type => (tags === undefined ? order : { ...order, tags })

/** Whether two orders are the same, a field given as undefined the same as one left out. */
const sameOrder = (one: typeof Order.Type, other: typeof Order.Type) => orderEquivalence(asSent(one), asSent(other))
const Envelope = S.Struct({ code: S.String, tag: S.String, message: S.String, httpStatus: S.Number })
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g

describe('endpoint contracts', () => {
  property(
    'carry any value of their types to the handler and back through call',
    Arbitrary.all([Arbitrary.schema(Order), Arbitrary.schema(Query)]),
    async ([order, query]) => {
      const { app, received } = createApp()
      let result: Awaited<ReturnType<typeof call<typeof endpoints.placeOrder>>>

      try {
        result = await call(endpoints.placeOrder, { body: order, query }, { fetch: (request) => app.request(request) })
      } catch (error) {
        return `call threw for ${show(order)} with ${show(query)}: ${error instanceof Error ? error.message : 'a value'}`
      }

      const text = await result.response.clone().text()

      if (text.includes(SECRET)) return `the owner's secret left the server: ${text.slice(0, 120)}`
      if (!result.ok) return `${show(order)} with ${show(query)} answered ${result.status}: ${text.slice(0, 160)}`
      const [handled] = received

      if (received.length !== 1 || !S.is(Order)(handled) || !sameOrder(handled, order)) return `the handler received ${show(received)}`

      // The query's form validators normalize as a GET form needs: an empty `q` is null.
      const expected = S.decodeUnknownSync(Query)(S.encodeUnknownSync(Query)(query))
      // A URL carries UTF-8, which has no lone surrogate: every encoder sends U+FFFD for one.
      const q = expected.q?.replace(LONE_SURROGATE, '\ufffd') ?? null

      return sameOrder(result.value.order, order) && result.value.page === expected.page && result.value.q === q
        ? undefined
        : `sent ${show(order)} and ${show(query)}, got back ${show(result.value)}`
    }
  )

  test('call sends the fields of an object made with no prototype, as Effect generates them', () => {
    const query = Object.assign(Object.create(null), { page: 2, q: 'a' })
    const order = Object.assign(Object.create(null), { name: 'Ada', note: null, rush: false, status: 'draft', placedAt: new Date(0), lines: [] })

    expect(endpointRequest(endpoints.placeOrder, { query, body: order }).url).toBe('http://localhost/api/orders?page=2&q=a')
  })

  test('a Date in a body travels as its ISO string and arrives as a Date', async () => {
    const { app } = createApp()
    const at = new Date(Date.UTC(2026, 10, 3, 9))
    const result = await call(endpoints.reschedule, { body: { at } }, { fetch: (request) => app.request(request) })

    expect(result.ok && result.value.at.toISOString()).toBe(at.toISOString())
  })

  test('an optional field left out, or given as undefined, arrives left out, not as null', async () => {
    const { app } = createApp()
    const send = (body: { readonly at: Date; readonly note?: string | null }) =>
      call(endpoints.reschedule, { body }, { fetch: (request) => app.request(request) })
    const answers = await Promise.all([send({ at: new Date(0) }), send({ at: new Date(0), note: undefined }), send({ at: new Date(0), note: null })])

    expect(answers.map((answer) => answer.ok && { noteSent: answer.value.noteSent, note: answer.value.note })).toEqual([
      { noteSent: false, note: null },
      { noteSent: false, note: null },
      { noteSent: true, note: null },
    ])
  })

  const field = oneOf<unknown>(
    pick(['', 'a', 'draft', 'placed', 'Draft', 0, 1, -1, 1.5, true, false]),
    Arbitrary.Constant(null),
    Arbitrary.Constant([]),
    Arbitrary.Constant({}),
    Arbitrary.Constant([{ sku: 'a', quantity: 1 }]),
    Arbitrary.Constant([{ sku: 'a', quantity: 0 }]),
    Arbitrary.Constant([{ sku: 1, quantity: '2' }]),
    anyText
  )
  const rawBody = oneOf(
    Arbitrary.map(
      Arbitrary.array(Arbitrary.all([pick(['name', 'note', 'rush', 'status', 'lines', 'tags', 'ownerSecret', '__proto__', 'constructor', 'extra']), field]), { maxLength: 7 }),
      (entries) => JSON.stringify(Object.fromEntries(entries))
    ),
    Arbitrary.map(
      Arbitrary.all([Arbitrary.schema(Order), pick(['name', 'note', 'rush', 'status', 'lines']), field]),
      // SAFETY: a struct's JSON form is an object.
      ([order, key, value]) => JSON.stringify({ ...S.encodeUnknownSync(S.toCodecJson(Order))(order) as object, [key]: value })
    ),
    textOf(['{', '}', '"name"', ':', '"a"', ',', '[', ']', 'null', '\u0000'], 8)
  )

  property(
    'answer any other body before the handler runs, in the JSON envelope',
    Arbitrary.all([rawBody, textOf(['page=1', 'page=x', 'page=', 'q=a', 'q=', '&', 'page=1e400', 'page=-0', 'page[]=1'], 3)]),
    async ([body, query]) => {
      const { app, received } = createApp()
      const res = await app.request(`/api/orders?${query}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
      const text = await res.text()

      if (text.includes(SECRET)) return `the owner's secret left the server: ${text.slice(0, 120)}`
      if (res.status >= 500) return `${show(body)} answered ${res.status}: ${text.slice(0, 160)}`
      if (received.some((value) => !S.is(Order)(value))) return `the handler received ${show(received)}, which fails its schema`
      if (res.status === 201) return undefined
      if (received.length > 0) return `the handler ran for a ${res.status}`

      const envelope = S.decodeUnknownExit(S.fromJsonString(Envelope))(text)

      return envelope._tag === 'Success' && envelope.value.httpStatus === res.status
        ? undefined
        : `a ${res.status} came as ${show(text.slice(0, 120))}`
    }
  )

  property(
    'with auth: true, answer 401 to anyone not signed in and the user to anyone who is',
    Arbitrary.all([pick(['', 'ada', 'grace']), oneOf(Arbitrary.map(Arbitrary.schema(S.Int), (count) => JSON.stringify({ count })), rawBody)]),
    async ([person, body]) => {
      const { app, received } = createApp()
      const env = person === '' ? testEnv({}) : testEnv(signedIn({ id: person }), {})
      const res = await app.request('/api/me', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }, env)
      const text = await res.text()

      if (person === '') return res.status === 401 && received.length === 0 ? undefined : `a visitor got ${res.status} after the handler ran ${received.length} times`
      if (res.status >= 500) return `${show(body)} answered ${res.status}: ${text.slice(0, 160)}`
      if (res.status !== 200) return received.length === 0 ? undefined : `the handler ran for a ${res.status}`

      const answer = S.decodeUnknownExit(S.fromJsonString(S.Struct({ id: S.String })))(text)

      return answer._tag === 'Success' && answer.value.id === person ? undefined : `${person} was answered ${text.slice(0, 120)}`
    }
  )
})
