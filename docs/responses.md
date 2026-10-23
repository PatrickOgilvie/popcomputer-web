# Cookies, files and headers

## Cookies

An application cookie, such as a guest's cart, is declared once with the
schema of its value, and actions read, set and clear it through the
declaration. The response carries what they set, beside flash, so a set
cookie survives the redirect after a form:

```ts
import { Option } from 'effect'
import { cookie } from '@popcomputer/web/effect'

export const cartCookie = cookie('cart', S.Struct({ id: S.String }), { maxAge: '30 days', path: '/r' })

export const addToCart = action(Effect.gen(function* () {
  const cart = Option.getOrElse(yield* cartCookie.read, () => ({ id: crypto.randomUUID() }))

  yield* cartCookie.set(cart)

  return yield* redirect(paths.dashboard)
}))
```

A value the browser sends that the schema rejects reads as none, and setting
one the schema rejects is a defect naming the cookie, so check limits first.
A value whose JSON form is a string, such as a token, is stored as it is, so a
cookie written by hand before reads the same.

Reading a cookie renders the page afresh for each request, and a cached page
whose path a cookie covers is rendered afresh for every visitor carrying it,
so scope a cookie to the paths that read it: `path: '/r/{restaurant}/'` takes
its placeholder from the route that sets it, and covers `/r/acme/cart` but
not the menu at `/r/acme`.

Cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` over HTTPS. An unsigned
cookie holds whatever a visitor sends, so it suits a preference or a pointer
the server checks. One the server must trust is declared with
`signed: { secret: 'COOKIE_SECRET' }`, naming the binding that holds the
secret, and a value without a valid signature reads as none. A secret the
bindings lack fails when the cookie is first read or set, so set a signed
cookie before the writes it goes with.

`betterAuthLogoutAction({ clear: [impersonationCookie] })` clears such
cookies on sign-out. A cookie set before the action fails is still sent with
the failure's response. A test reads the value a response set with
`readCookie(res, cartCookie)` from `@popcomputer/web/testing`.

## Files, headers and polling

`file(body, { contentType, filename })` answers with a file, such as an export
or a feed: text, bytes, or an Effect `Stream` sent as it is produced. A
`filename` offers it as a download. [Serving an upload back](#serving-an-upload-back)
shows doing so safely.

`json` and `text` take `{ status, headers }` as well as a status, and an
`etag` naming the version of what they hold, such as a counter the writes
bump: a client polling with `If-None-Match` gets `304 Not Modified` with no
body until it changes,
``json(KitchenOrders, orders, { etag: `orders-${version}` })``. When building
the body costs a query, `ifChanged(etag, response)` answers the 304 before
running the response's Effect at all.

A guard layer adds a header to every response of its routes, failures
included, with `responseHeader('Deprecation', 'true')`, as for an API's
rate-limit headers. An `HttpError` adds its own `headers` to the response, as
`HttpError.rateLimited(30)` adds `Retry-After`. `routes.options(path, action)`
answers a CORS preflight, with `noContent(headers)` for its 204.

## Serving an upload back

Serve an upload back with `file(bytes, { contentType, filename })`: the
`filename` makes it a download, and `file` always sends
`X-Content-Type-Options: nosniff`, so the browser keeps to the declared type.
Without a file name, it shows only an image other than SVG, a PDF, plain
text, JSON, audio or video as it is: any other body, such as HTML, SVG or
XML, gets `Content-Security-Policy: sandbox`, unless the response's
`headers` set their own policy. A `contentType` that is not one media
type, such as `image/png;x=,text/html`, which a browser reads by its last
type, is sent as `application/octet-stream`; `upload()` refuses such a file,
and keeps only its media type, so store `file.type` as it decodes. Name the
stored object with a key the server makes, never the upload's file name, and
check who may read the file before serving it, as for any record.

## Requests from other sites, and security headers

`setupWeb` refuses a state-changing request whose `Origin` (or `Referer`)
names another site with 403, through the error boundary, so a visit gets the
error page and a JSON client the envelope, beside the `SameSite` cookies
Better Auth sets. A request without either header, such as a webhook, passes,
and so does one whose `Authorization` header holds a token, such as
`Bearer`, which a browser never adds by itself. `Basic`, `Digest`,
`Negotiate` and `NTLM` credentials are checked like a cookie, since a browser
resends the ones it cached, as behind a staging gate, with another site's
form. A native app or another site that posts to the application is listed
in `security: { verifyOrigin: { allowedOrigins: ['https://admin.example'] } }`.

Every response also gets, unless it sets its own, `X-Content-Type-Options:
nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, which keeps the
same-site `Referer` a failed form goes back to (Hono's `secureHeaders()`
defaults to `no-referrer`, which sends every failed form to `/`), and framing
refused, `X-Frame-Options: DENY` with `frame-ancestors 'none'` added to its
`Content-Security-Policy`, so another site cannot frame a page under a decoy
to trick a visitor into clicking. `security: { headers: { frames:
'same-origin' } }` lets the application frame its own pages, and `headers:
false` sends none of them.
