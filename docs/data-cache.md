# The data cache

The data cache keeps computed values in a store, checked against an Effect
Schema when read. Provide a store with `kvCache` as a `request` layer of
`web.services`; KV
keeps an entry at least 60 seconds, its shortest expiry, and `cache` still
treats it as fresh only for its `ttl`, counted from when the value is stored,
not from when its computation read its data. `kvCache` keeps its keys under
`popweb:cache:`, so its KV namespace can hold the application's other data,
such as an audit log, which the cache never reads, lists or deletes, even
for `cacheInvalidatePrefix('')`:

```ts
import { kvCache } from '@popcomputer/web/cache'

export const { app, routes } = web.services({
  request: (c) => kvCache(c.env.KV),
})
```

Then wrap a computation in `cache`:

```ts
import { eq } from 'drizzle-orm'
import { Duration, Effect, Schema as S } from 'effect'
import { action, authorize, dbQuery, render } from '@popcomputer/web/effect'
import { cache } from '@popcomputer/web/cache'
import { columnsOf } from '@popcomputer/web/schema'
import { projects } from '../schema'

export const listProjects = action(Effect.gen(function* () {
  const auth = yield* authorize()

  const summaries = yield* cache(
    `users:${auth.user.id}:projects`,
    dbQuery((db) =>
      db.select(columnsOf(projects, ProjectSummary)).from(projects).where(eq(projects.userId, auth.user.id))
    ),
    S.Array(ProjectSummary),
    { ttl: Duration.minutes(5), swr: Duration.minutes(1), version: true }
  )

  return yield* render('Projects/Index', { projects: summaries, next: null })
}))
```

The computation is any Effect, here a `dbQuery`; it runs only when the entry
is missing or stale, and its result is stored through the schema's JSON form, so a `Date` comes back as
a `Date`.

## Tagging cached data

A value that depends on records takes their cache tags, the names a route's
`purges` and `purgeCache` use (see [Time-based caching with Workers
Cache](page-cache.md#time-based-caching-with-workers-cache)). A route that purges one of
them after a write invalidates the value as well as the cached responses, so
what changed is stated once, by the write:

```ts
const summary = yield* cache(
  `projects:${project.id}:summary`,
  summarizeProject(project.id),
  ProjectSummary,
  { ttl: Duration.minutes(5), tags: [recordCacheTag('projects', project.id)] }
)
```

A tag gets a generation in the store when an entry first uses it, and each
purge of the tag replaces it, so an entry stored under an older one is a miss,
for `cacheGet` too. `cache` reads the generations before it computes, so a
purge during the computation leaves its value a miss. `cacheSet` with `tags`
records them as they are when it runs, and cannot know when its value was
read: a value read before a write whose purge ran before `cacheSet` stays
until its `ttl`. Compute a tagged value through `cache`.
A tagged read costs one store read per tag besides the entry's own; a purge of
a tag no entry uses costs a read and no write. KV accepts one write a second
to a key and takes up to a minute to show a write everywhere, so tag data by
the records it reads rather than by a table written many times a second.

## When the store fails

`cache` never fails because of the store: an unreachable store or an entry that
no longer matches the schema computes the value instead, and the failure goes
to `EffectErrorObserverService`. `cacheGet` and `cacheSet` fail with
`CacheError`, which renders as 503. `cacheInvalidate` and
`cacheInvalidatePrefix`, which follow a write that has already happened,
report a store failure instead of failing the request; the entry stays until
it expires.
Stale-while-revalidate refreshes in the background when the request has an
execution context and inline otherwise.

## Caching an API that authenticates each request

The route `cache` option never stores a response to a request with an
`Authorization` header: it answers `no-store`. Workers Cache answers a hit
before the Worker runs, so a stored response would reach a revoked key and
skip the key's rate limit. Authenticate every request and cache the data the
response is built from instead, keyed by what it depends on, such as the
project an API key belongs to, so every key of that project shares one entry.
Tag it with the records it reads, and the writes that purge them invalidate
it: `purges: true` on `PUT /projects/{project}/tasks/{task}` purges the
project's tag.

```ts
export const projectTasks = action(Effect.gen(function* () {
  // The key's project, or new UnauthorizedError({ message: 'This API key is not valid.', challenge: 'Bearer' }),
  // which a JSON client receives as a 401 with WWW-Authenticate: Bearer.
  const project = yield* apiKeyProject

  const tasks = yield* cache(
    `projects:${project.id}:tasks`,
    loadTasks(project.id),
    S.Array(Task),
    { ttl: Duration.seconds(30), tags: [recordCacheTag('projects', project.id)] }
  )

  return yield* json(S.Struct({ tasks: S.Array(Task) }), { tasks })
}))
```
