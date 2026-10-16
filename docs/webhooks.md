# Webhooks verify the raw body, then record the event once

A webhook's signature covers the exact bytes sent, so read the raw body with
`RequestService`'s `raw()` rather than `validateRequest` (read
`raw().clone().text()` when `validateRequest` reads the body afterwards),
verify it with Web Crypto (`crypto.subtle.verify` compares in constant time), and only then decode
it. Read the secret with `config.redacted`, which reads the Worker's binding
and keeps it out of logs. Providers retry, so record each event id under a
unique key and treat a duplicate as already handled. On D1, insert the event
id in the same `dbBatch` as the writes it causes, so a replay's unique
violation undoes the whole batch:

```ts
import { eq } from 'drizzle-orm'
import { DateTime, Redacted } from 'effect'
import { orders, webhookEvents } from '../schema'

const PaymentEvent = S.Struct({ id: S.String, orderId: S.String })

async function verifySignature(secret: string, body: string, signature: string) {
  // An HMAC-SHA256 in hex is 64 hex digits: anything else is not a signature.
  if (!/^[0-9a-f]{64}$/.test(signature)) return false

  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  )
  const bytes = Uint8Array.from(signature.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16))

  return crypto.subtle.verify('HMAC', key, bytes, encoder.encode(body))
}

export const paymentWebhook = action(Effect.gen(function* () {
  const request = yield* RequestService
  const secret = yield* config.redacted('PAYMENT_WEBHOOK_SECRET')
  const body = yield* Effect.promise(() => request.raw().text())
  const signature = request.header('X-Signature') ?? ''

  if (!(yield* Effect.promise(() => verifySignature(Redacted.value(secret), body, signature)))) {
    return yield* httpError(401, 'Invalid signature')
  }

  const event = yield* S.decodeUnknownEffect(S.fromJsonString(PaymentEvent))(body).pipe(
    Effect.catchTag('SchemaError', () => httpError(400, 'Malformed event'))
  )

  const paidAt = DateTime.toDateUtc(yield* DateTime.now)

  return yield* dbTransaction(Effect.gen(function* () {
    yield* dbMutation((db) => db.insert(webhookEvents).values(event))
    yield* dbMutation((db) => db.update(orders).set({ paidAt }).where(eq(orders.id, event.orderId)))
  })).pipe(
    Effect.andThen(noContent()),
    Effect.catchTag('DatabaseConstraintViolation', (violation) => Effect.gen(function* () {
      if (violation.constraint !== 'unique') return yield* violation

      // A replay of an event already recorded.
      return yield* noContent()
    }))
  )
}))
```

A refusal answers through `httpError`, so the provider gets the same JSON
envelope as every other client, and an acknowledgement needs no body: any
`2xx` tells the provider to stop retrying.
