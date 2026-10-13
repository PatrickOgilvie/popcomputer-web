# Ceramics shop

## What the owner asked for

> I make ceramics and want a small online shop. I add each piece with a photo,
> its price and how many I have. Customers sign up, order a piece and pay
> through PayFake, our payment provider: PayFake calls our website when a
> payment goes through, and the order should then show as paid. I need to see
> every order; customers see their own. My account is `owner@shop.test`;
> anyone else at `@shop.test` helps me run the shop too.

## The surface the owner's reviewer will test

The reviewer has their own test suite, which drives the application through
HTTP exactly as described here. Build everything else as you see fit.

### Test support

`src/test-support.ts` exports:

- `app`: the Hono application, with every route registered.
- `freshEnv(): Promise<unknown>`: the third argument of `app.request(...)`
  for a fresh application served at `http://localhost`: its bindings, with a
  newly created, migrated and empty database, and `PAYFAKE_SECRET` set to
  `payfake-test-secret`. Each call returns an independent one.

The reviewer's tests use `testBrowser(app, await freshEnv())` from
`@popcomputer/web/testing`, so every page is requested as an Inertia visit
(`X-Inertia: true`), and every form is posted urlencoded, or as
`multipart/form-data` when it carries a file.

### Accounts

| Request | Fields | Answer |
| --- | --- | --- |
| `POST /register` | `name`, `email`, `password` (8+ characters) | `303` to `/products`, signed in |
| `POST /login` | `email`, `password` | `303` to `/products`, signed in |
| `POST /logout` | | `303` to `/login`, signed out |

Staff are the users whose email ends in `@shop.test`. A visitor who is not
signed in and requests a page below, other than `/products`, is redirected to
`/login`.

### Pages and forms

Prices are whole pence (`priceCents`).

| Request | Who | Answer |
| --- | --- | --- |
| `GET /products` | anyone | page `Products/Index`, props `products`: every product, each `{ id, name, priceCents, stock, photoUrl }`, where `photoUrl` is the path of its photo |
| `POST /products` | staff | multipart fields `name`, `priceCents` (a positive whole number), `stock` (a whole number, 0 or more) and `photo` (a PNG or JPEG image); `303` to `/products`. An invalid field goes back with `errors.<field>`. Anyone else: `403`. |
| `GET {photoUrl}` | anyone | the photo |
| `POST /orders` | anyone signed in | fields `productId` and `quantity` (a whole number, 1 or more); places an order for that many, taking them from the product's stock: `303` to `/orders/{order}`. More than the stock holds: back with `errors.quantity`. |
| `GET /orders` | anyone signed in | page `Orders/Index`, props `orders`: the visitor's own orders, or every order for staff, each `{ id, productId, quantity, totalCents, status }`, `status` `pending` or `paid` |
| `GET /orders/{order}` | the customer who placed it, or staff | page `Orders/Show`, props `order`, as above |

### PayFake's webhook

PayFake posts each successful payment to `POST /webhooks/payfake` as JSON,
`{ "eventId": "evt_…", "orderId": "…", "amountCents": 1234 }`, with the header
`PayFake-Signature`: the lowercase hex HMAC-SHA256 of the exact request body,
keyed with `PAYFAKE_SECRET`. A payment PayFake has delivered before (the same
`eventId`) may be delivered again. Answer a delivery the application accepts,
or has already accepted, with any `2xx`, so PayFake stops retrying it.

The database is Cloudflare D1.
