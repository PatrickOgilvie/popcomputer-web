# Expenses API

## What the finance team asked for

> We want an API our mobile app can use for expenses. People log what they
> spent (amount, currency, what it was for, the day), and their manager
> approves or rejects it. Everyone with the same email domain is one team,
> and a team's managers are the people whose email starts with `manager.`,
> like `manager.jo@acme.test`. Managers see everything in their team. The app
> retries requests when the signal drops, so sending the same expense twice
> by accident mustn't log it twice. We'd like the API documented so the
> mobile developers can generate a client.

## The surface the finance team's reviewer will test

The reviewer has their own test suite, which drives the application through
HTTP exactly as described here. Build everything else as you see fit.

### Test support

`src/test-support.ts` exports:

- `app`: the Hono application, with every route registered.
- `freshEnv(): Promise<unknown>`: the third argument of `app.request(...)`
  for a fresh application served at `http://localhost`: its bindings, with a
  newly created, migrated and empty database. Each call returns an
  independent one.

The reviewer's tests use `testBrowser(app, await freshEnv())` from
`@popcomputer/web/testing` to keep each person's session cookie, and send
JSON with `Content-Type: application/json` and `Accept: application/json`.

### Accounts

Better Auth's email and password routes, at their default paths:

| Request | Body | Answer |
| --- | --- | --- |
| `POST /api/auth/sign-up/email` | `{ name, email, password }` (8+ characters) | `200`, `{ user: { id, ... } }`, signed in |
| `POST /api/auth/sign-in/email` | `{ email, password }` | `200`, signed in |

### Endpoints

An expense is `{ id, ownerId, amountCents, currency, description, spentOn, status }`:
`amountCents` a positive whole number, `currency` one of `GBP`, `EUR`, `USD`,
`description` 1 to 200 characters, `spentOn` a day as `YYYY-MM-DD`, `status`
one of `pending`, `approved`, `rejected`, and `ownerId` the id of the person
who logged it.

| Request | Answer |
| --- | --- |
| `POST /api/expenses` with `{ amountCents, currency, description, spentOn }` and, optionally, an `Idempotency-Key` header | `201` and the new expense, `pending`. The same person sending the same key again gets the expense the key already created (`200` or `201`), and nothing new is logged. |
| `GET /api/expenses` | `200`, `{ data: [expense, ...] }`: the person's own expenses, or, for a manager, every expense in their team |
| `GET /api/expenses/{expense}` | `200` and the expense |
| `POST /api/expenses/{expense}/approve` | the team's manager: `200` and the expense, now `approved`. An expense that is not `pending`: `409`. |
| `POST /api/expenses/{expense}/reject` | as approve, to `rejected` |
| `GET /api/openapi.json` | an OpenAPI 3 document describing the endpoints above |

Input that does not validate is answered `422`, with each invalid field's
message under `errors`, as `{ "errors": { "amountCents": "..." } }`. A
request without a session is answered `401` with JSON.

The database is Postgres (PGlite in tests).
