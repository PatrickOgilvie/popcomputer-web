# Page caching

Pages are cached at Cloudflare's edge by default. `setupWeb` serves a page from
Cloudflare's Cache API, skipping database, auth and rendering work, when
producing it read nothing request-specific. A page becomes dynamic, and renders
on every request, when it reads:

- a binding on `c.env` (D1, KV, R2, Durable Objects, service bindings, AI,
  Hyperdrive), which covers database queries however they are made;
- a request header, the raw request or request state, through
  `RequestService` or `RequestStateService`, or through the context a
  `web.services` request callback receives;
- a route model binding.

Cached pages are keyed by deploy. Bind the version metadata so each deploy
starts from an empty cache:

```jsonc
// wrangler.jsonc
"version_metadata": { "binding": "CF_VERSION_METADATA" }
```

Without it, pages are keyed by the asset version and expire after five minutes,
so server-only changes still appear.

- Signed-in requests, requests with `Authorization` or app cookies, partial
  reloads, stale Inertia versions and development never use the cache. Analytics
  and Cloudflare cookies such as `_ga` and `__cf_bm` don't count as app cookies.
- A response that sets no `Cache-Control` gets `no-store` when it is signed
  in or sets a cookie, such as a sign-in's, and `private, no-cache`
  otherwise: Workers Cache, once enabled, would otherwise keep a page
  rendered per request and serve it to other visitors.
- Browsers always revalidate cached pages. A page is stored only if the final
  response, after all middleware, still allows it: no `Set-Cookie`, and no
  other `Cache-Control`.
- The `X-Popweb-Cache` response header reports `BYPASS` on any request the
  page cache skips, such as a signed-in one, and `HIT`, `MISS` or `DYNAMIC`
  on the pages the default page cache considers; a route with a `{param}`
  placeholder, or with a `cache` option of its own, is not one of them.
- A test of the default page cache stubs the Cache API
  (`Reflect.set(globalThis, 'caches', { default: store })`) and reads each response's body
  before the next request: a page is stored once its body has streamed. A test
  request signed in with `signedIn` sends no session cookie, so it can be
  served a guest's cached page; send the session cookie a browser would.

The framework can't see data a page gets another way, such as an external
`fetch()` or the current time. Give those routes `cache: 'private'`: each
request renders the page, and only the visitor's browser keeps it, checking
back each time (`Cache-Control: private, no-cache`). Give a page only its link
should show, such as a signed preview, `cache: 'no-store'`, which keeps it
out of every cache, the browser's included. `pageCache: false` in `setupWeb`
turns page caching off for the whole application.

## Time-based caching with Workers Cache

To cache pages that do read data for a fixed time, set the route's `cache`
option and enable Workers Cache (`"cache": { "enabled": true }` in Wrangler
config). The option emits Workers Cache headers and tags. It does not publicly
cache authenticated, cookie-setting, partial, failed, or mutating responses,
nor one whose producing read a request header, a cookie or request state,
such as an API key a route's own layer reads: none of them is part of the
cache's key. That key is the path and query string, not the host, so a
Worker serving several hostnames shares one cache across them: a page that
differs by hostname does not set `cache`.

```ts
routes.get(paths.pricing, showPricing, {
  name: 'pricing.show',
  cache: { maxAge: 300, staleWhileRevalidate: 3600 },
})
```

Pages, meaning HTML documents and Inertia page objects, belong to the deploy
that rendered them: the HTML names that build's hashed assets. For pages the
option sends `Cache-Control: public, max-age=0, must-revalidate`, so browsers
revalidate every visit, and puts `maxAge` and `staleWhileRevalidate` in
`Cloudflare-CDN-Cache-Control`, which only Cloudflare reads. Every cached page
carries the `PAGE_CACHE_TAG` Cache-Tag (`popweb:page`). Workers Cache keys
entries by Worker version, so each deploy starts from an empty cache. If you
enable `cross_version_cache`, purge the tag after each deploy:

```ts
const cache = yield* ResponseCacheService
yield* cache.purge({ tags: [PAGE_CACHE_TAG] })
```

Other cached responses, such as JSON APIs and text, use `maxAge` and
`staleWhileRevalidate` in `Cache-Control` for every cache.

Workers Cache answers a hit before the Worker runs, so cached responses vary
on `Cookie`: visitors without cookies share the cached copy, and a request
with any cookie renders afresh. A signed-in member sees their own `auth.user`,
a form that redirects back keeps its flashed errors, and neither response is
stored. Visitors carrying only analytics cookies also miss the cache, so the
option pays off for traffic that arrives without cookies, such as first visits
and crawlers.

A bound route's cached page carries the Cache-Tag of each record it reads,
`recordCacheTag(table, primaryKey)` such as `projects:project-1`, whichever
column the route looks the record up by. Tags name tables by their key in the
schema, `planPrices` rather than the SQL name `plan_prices`, and the route
options, `purgeCache` and `cache` take only those and record tags, so a
misspelled table is a type error. `purges` removes cached entries after
a successful write. `purges: true` purges the records the route's bindings name
and the table of its last binding, so a write by id purges the page read by
slug, and the table's tag purges an index that declares it. A cached page
binds its record for anyone, `publicWhen` or `public: true`: registering
`cache` on a route whose record depends on the visitor, an `ownedBy` or
`guarded` binding or one under them, fails, since a shared cache would hand
one visitor's record to the next. Tags name the table, so a write through
the owner's `{project}` purges the public `{showcase}` page of the same row:

```ts
routes
  .get(paths.explore, showPricing, { cache: { maxAge: 300, tags: ['projects'] } })
  .get(paths.projectBySlug, showProjectBySlug, { cache: { maxAge: 300 } })
  .put(paths.project, updateProject, { purges: true })
```

A list of one parent's records, such as a workspace's templates, tags itself
with the child table and the parent, `` `templates:workspace-${workspace.id}` ``,
and the routes that write templates purge that tag with `purgeCache`. Tagging
it with the parent's record instead purges it on every write under the
parent, and with the table on every write to any parent's templates.

`purges: true` names only the route's own records, which for a route that
creates a record under its parent, such as `POST /threads/{thread}/posts`,
are the parent and its table (`threads`), not the new post's. When an action
creates or changes another record, such as a reply's post or the listing an
accepted offer sold, it adds that record's tag with `purgeCache`. The route purges it after the action
succeeds, together with its own `purges` if it has any, and not at all when
the action fails:

```ts
yield* purgeCache(recordCacheTag('projects', 'project-1'), 'projects')
```

A cached page that reads records beyond its route's bindings, such as the
translation a fallback shows, adds their tags to its response with
`tagCache`, so writes that purge them refresh it:

```ts
yield* tagCache(recordCacheTag('projects', 'project-1'))
```

`purgeCache` works the same in an Effect run by `routes.run`, such as a
queue consumer that changes a record: the purge runs once the Effect succeeds.

## Other patterns

- **Public pages that read data**: the `cache` route option, with
  `purges: true` on the routes that change their records, `purgeCache(...)`
  for other records an action changes, and the table's key in the schema in
  an index page's `tags`. Signed-in visitors render their own page, so the
  same route serves both.
