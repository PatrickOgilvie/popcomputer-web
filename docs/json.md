# JSON clients

A JSON client gets every failure in one envelope, whatever its status. A
request is a JSON client when it asks for JSON or sends a JSON body, or when
it asks for no HTML while sending an `Accept` header, as `fetch` does with
`*/*`, or an `Authorization` header, as an API client with a bearer token
does. So is a request whose User-Agent names a command-line or AI client
(`curl`, `claude`, `CLI`), such as an agent checking a page with `curl`.
Browsers ask for HTML on every visit and form post, so they get pages,
a signed-out visitor goes to sign in, and a failed form goes back to the
form; a signed-out JSON client gets a 401 instead. An Inertia visit
(`X-Inertia: true`) always gets Inertia's page protocol, whatever its
User-Agent or `Accept`. `prefersJson` and `jsonOrRender` decide the same way.

```json
{
  "code": "WEB_VAL_004_SCHEMA_MISMATCH",
  "tag": "ValidationError",
  "message": "This field is required",
  "httpStatus": 422,
  "errors": { "name": "This field is required" }
}
```

An API whose clients may send neither header, such as a scanner that forgot
its key, registers its routes on `routes.jsonApi()`, with their declared
paths, `routes.jsonApi().provide(ApiKeyAuth).get(paths.apiInvoices, listInvoices)`:
every request to them is a JSON client. An API that rejects query parameters
it does not declare passes `validateRequest(Query, { request: { order:
['query'] }, parseOptions: { onExcessProperty: 'error' } })`; reading only
the query keeps the route's own parameters from counting as excess.

## JSON responses declared by a schema

A JSON API declares each endpoint as a contract, as
[JSON endpoints](endpoints.md) shows, and its actions return values the
contract encodes. An ordinary action that answers JSON, such as a page's
`jsonOrRender`, declares its response as an Effect Schema and answers with
`json(Schema, value)`: the value is checked against the schema and encoded
through its JSON form, so a `Date` leaves as an ISO string. A test reads it
back with `readJson(res, Schema)` from `@popcomputer/web/testing`, and a
client decodes it with the same schema,
`S.decodeUnknownSync(S.toCodecJson(Schema))(await res.json())`, so the shape
is declared once. `Jsonify<typeof Schema.Type>` from
`@popcomputer/web/effect` types a JSON response as React reads it.

A schema a client imports is bundled with it. Declare a response schema that
a separate client decodes, such as a CLI's or an SDK's, apart from the
Drizzle tables, unlike a page schema, which React reads only as a type: read
its columns with `columnsOf(table, Schema)` and answer with
`json(Schema, rows)`, where a field whose column changes type fails to
type-check. The same holds for a page answered with `jsonOrRender` that such
a client decodes.

## Failures a client reads

The envelope's `errors` names each invalid field's message, as a form's page
receives them. `ErrorResponse` from `@popcomputer/web/schema` is the
envelope's schema, which imports only `effect`, so a client decodes a failure
with it; `readError(res)` from `@popcomputer/web/testing` reads it in a test.

An `HttpError` with a body adds it as `body`. A body a client reads is
declared by a schema, as a JSON response is:
`httpError(409, 'Some lines are short of stock.', ShortOfStock, { lines })`
checks and encodes it, a test reads it with `readError(res, ShortOfStock)`,
and a client decodes the whole failure with `errorResponseWith(ShortOfStock)`.
A body without a schema,
`httpError(409, 'Already checked in.', { code: 'ticket_already_used' })`,
reaches the client as
`{ ..., "httpStatus": 409, "body": { "code": "ticket_already_used" } }`.

Answer a record the client may not see with `notFound(...)`, which is what a
missing bound record answers, rather than an `httpError(404, ...)` with a body
of its own, so a client cannot tell which ids exist. Production replaces the
message of a 5xx or an internal failure with a generic one, and gives every
404 the same message: a 404 whose message a page shows carries it in a body,
`httpError(404, message, Schema, { message })`, which production keeps. Test
the envelope a client receives with `ENVIRONMENT: 'production'` in the test
bindings.

## Calling an endpoint

`call(endpoint, input, options)` sends a request built from the contract and
reads the answer: `{ ok: true, value }` with the success decoded, so dates
are `Date`s again, or `{ ok: false, error }`, where `error` is a declared
failure, decoded as the failure itself, or an `EndpointFailure` holding the
envelope, such as a 422's `errors`. Both narrow on `_tag`. In the browser it
uses `fetch` and the page's origin; a test passes the application as `fetch`,
so the test reads as a client does:

```ts
// src/api.test.ts
import { expect, test } from 'bun:test'
import { call } from '@popcomputer/web/endpoint'
import { signedIn, testEnv } from '@popcomputer/web/testing'
import app from './app'
import './api-routes'
import { endpoints } from './endpoints'
import { testBindings } from './test-bindings'

const as = (id: string) => ({
  fetch: (request: Request) => app.request(request, undefined, testEnv(signedIn({ id }), testBindings)),
})

test('a slug is taken once', async () => {
  const created = await call(endpoints.createProject, { body: { name: 'Launch', slug: 'launch' } }, as('user-1'))
  const again = await call(endpoints.createProject, { body: { name: 'Again', slug: 'launch' } }, as('user-1'))

  expect(created.ok && created.value.slug).toBe('launch')
  expect(!again.ok && again.error._tag).toBe('SlugTaken')
})

test("another member's project is not found", async () => {
  const shown = await call(endpoints.showProject, { params: { project: 'project-1' } }, as('user-2'))

  expect(shown.status).toBe(404)
})
```

The input is encoded through the contract's schemas without their checks, so
a form that calls an endpoint shows the server's messages for each invalid
field. A page's form posts stay ordinary actions with `validateRequest`; an
endpoint serves a client that reads JSON, such as a search box, a mobile app
or another service.
