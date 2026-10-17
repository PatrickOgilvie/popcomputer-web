# Upgrading to @popcomputer/web 1.4.0

This guide takes an application on any release before 1.0.0, or on the
`honertia` package it was renamed from, to 1.4.0.

1.1.0, 1.2.0, 1.2.2, 1.2.3, 1.2.4 and 1.3.0 change nothing that an application
written for 1.0.0 needs to change, and the `1.0.0-next` pre-releases were never
published to npm. 1.4.0 asks each route binding to say who may load its
record, which a lint rule reports. So the path is one jump: make the 1.0.0
changes below, install 1.4.0, give each binding its option as
[From 1.3 to 1.4](#from-13-to-14) shows, and you are done.

The framework's own documents back every step here. They ship in the package,
so the installed copies in `node_modules/@popcomputer/web/` match the version
you installed:

- [`README.md`](README.md): the design, and an index of `docs/`
- [`docs/`](docs/): one short file per task, such as
  [`docs/which-api.md`](docs/which-api.md), which names the API for each task
- [`CHANGELOG.md`](CHANGELOG.md): a section per release
- [`AGENTS.md`](AGENTS.md): the one API to use for each task

## Contents

1. [Before you start](#before-you-start)
2. [Find your starting point](#find-your-starting-point)
3. [From Effect 3](#from-effect-3)
4. [From `honertia`](#from-honertia)
5. [From 0.4, 0.5 and 0.6](#from-04-05-and-06)
6. [From 0.7 to 1.0](#from-07-to-10)
7. [Changes no type error points at](#changes-no-type-error-points-at)
8. [From 1.0 to 1.3](#from-10-to-13)
9. [From 1.3 to 1.4](#from-13-to-14)
10. [Tooling after the upgrade](#tooling-after-the-upgrade)
11. [Checklist](#checklist)
12. [A worked example](#a-worked-example)

## Before you start

- **Start from green.** Make sure your tests pass on your current version, and
  commit, so each step below is its own reviewable change.
- **Go in order, and type-check after each step.** Run `bunx tsc --noEmit`
  after every step. The type errors name what is left; the changes no type
  error points at are listed in their own section.
- **From `honertia`, or anything before 0.4, there is no green state until
  the end.** Those releases ran on Effect 3, and 1.2 runs only on Effect 4, so
  your application's own Effect code moves at the same time as the framework.
  Work on a branch, and follow the order in
  [Together with the framework](#together-with-the-framework).
- **Check the peer dependencies.** 1.4.0 needs:

  | Package | Range | Needed when |
  | --- | --- | --- |
  | `effect` | `^4.0.0` | Always |
  | `hono` | `^4.13.5` | Always |
  | `drizzle-orm` | `>=0.45.2 <1.0.0` | You use Drizzle or route model binding |
  | `better-auth` | `>=1.7.7 <1.8.0` | You use the Better Auth integration |
  | `miniflare` | `>=4.0.0 <5.0.0` | You test against Cloudflare D1 |
  | `@types/react` | `>=18` | You use the React page types |

  Each floor is the first release with the security fixes for the parts the
  package uses. Hono 5 and Drizzle 1.0 are outside the ranges.

- **Install 1.4.0** with the peers your application uses, removing `honertia`
  if you are on it:

  ```bash
  bun remove honertia                    # if you are on honertia
  bun add @popcomputer/web@^1.4.0 effect@^4.0.0
  bun add 'better-auth@>=1.7.7 <1.8.0'   # if you use Better Auth
  bun add 'drizzle-orm@>=0.45.2 <1.0.0'  # if you use Drizzle
  ```

  Add `hono@^4.13.5` only if your Hono is older than 4.13.5: `bun add` writes
  the range you give, so it would loosen a tighter one, such as `^4.13.10`.
  Better Auth's plugin packages, such as `@better-auth/mcp`, move with
  `better-auth` to the same version.

## Find your starting point

| You are on | Do these sections |
| --- | --- |
| `honertia` 0.1.x | [From Effect 3](#from-effect-3), [From `honertia`](#from-honertia), then [0.7 to 1.0](#from-07-to-10) |
| 0.1.x to 0.3.x | [From Effect 3](#from-effect-3), then [0.7 to 1.0](#from-07-to-10) |
| 0.4.x | [0.4 to 0.5](#04-to-05), [0.5 to 0.6](#05-to-06), [0.6 to 0.7](#06-to-07), then [0.7 to 1.0](#from-07-to-10) |
| 0.5.x | [0.5 to 0.6](#05-to-06), [0.6 to 0.7](#06-to-07), then [0.7 to 1.0](#from-07-to-10) |
| 0.6.x | [0.6 to 0.7](#06-to-07), then [0.7 to 1.0](#from-07-to-10) |
| 0.7.x | [0.7 to 1.0](#from-07-to-10) |
| 1.0.x to 1.2.x | [1.0 to 1.3](#from-10-to-13), then [1.3 to 1.4](#from-13-to-14) |
| 1.3.x | [1.3 to 1.4](#from-13-to-14) only |

`honertia` and `@popcomputer/web` share one version line, so `honertia` 0.1.45
is "0.1.x". The 0.4 to 0.7 sections hardly apply to an application coming from
0.1 to 0.3: its code never had what they change, so the 0.7 to 1.0 steps,
read against your own code, take you the rest of the way.

Every path ends with [Changes no type error points at](#changes-no-type-error-points-at),
[Tooling](#tooling-after-the-upgrade) and the [Checklist](#checklist).

## From Effect 3

`honertia` and releases before 0.4 ran on Effect 3. 1.2 needs Effect 4, and so
does your application's own code: its schemas, services, layers, errors and
tests. For most applications this is most of the upgrade. One application of
about 100,000 lines reported 3,895 type errors right after the install, and
351 once its code that never imports the framework was on Effect 4.

### What Effect publishes

Effect's repository, [Effect-TS/effect](https://github.com/Effect-TS/effect),
holds the migration:

- **`MIGRATION.md`** explains what changed around the code: one version for
  every Effect package, packages merged into `effect`, and unstable modules.
  Read it once, first.
- **`migration/*.md`** are topic guides for changes that are rewrites rather
  than renames: services (`Context.Tag` to `Context.Service`), `Cause`, error
  handling, forking, layer memoization, `FiberRef`, `Runtime`, `Scope`,
  equality, and Schema, the longest.
- **`migration/v3-to-v4.md`** is a reference generated from the API diff:
  every renamed, changed or removed API, one line each, as
  `` - `Old.symbol` -> `New.symbol`: why ``. It is about 17,000 lines: search
  it, never read it whole.

Clone it shallowly into a folder git ignores, and the Effect 3 branch beside
it for when you need to know what an old API did:

```bash
git clone --depth 1 --single-branch https://github.com/Effect-TS/effect .repos/effect
git clone --depth 1 --single-branch --branch v3 https://github.com/Effect-TS/effect .repos/effect-v3
echo '.repos/' >> .gitignore
```

Effect also publishes a skill that drives this migration with a coding agent,
`effect-v3-to-v4` in [Effect-TS/skills](https://github.com/Effect-TS/skills),
which follows the same reference. Where it says to import from
`effect/unstable/...`, follow `MIGRATION.md` instead: Effect 4.0 dropped the
`unstable` segment, so `effect/unstable/http` is `effect/http`.

### Look each API up

For each symbol a type error names, search the reference, then a topic guide
when the entry calls for a rewrite, then Effect 4's source to confirm a
signature before writing code against it:

```bash
# One symbol
rg -n 'Effect\.catchAll`' .repos/effect/migration/v3-to-v4.md

# A module's whole section
rg -n -A 40 '^### `effect/Schema`' .repos/effect/migration/v3-to-v4.md

# Where a v3 import moved
rg -n '^@effect/platform/HttpClient ' .repos/effect/migration/v3-to-v4.md
```

A miss in the import map is not the end: the reference also lists the imports
with no counterpart and the modules removed, each with what to use instead.

### Packages first

Change `package.json` before the first type check, or the errors drown in
imports that no longer resolve:

- **Remove the packages merged into `effect`,** such as `@effect/platform`,
  `@effect/rpc` and `@effect/cluster`, and rewrite their imports by the
  reference's import map: `@effect/platform/HttpClient` is
  `effect/http/HttpClient`.
- **Keep the separate packages,** `@effect/platform-*`, `@effect/sql-*`,
  `@effect/ai-*`, `@effect/opentelemetry` and `@effect/vitest`, on the same
  version as `effect`: in Effect 4 every package shares one version.
- **`honertia` pinned Effect 3 as a dependency of its own,** so removing it is
  what removes the second copy of Effect.

### The renames you will meet most

Each line is from the reference, checked against Effect 4.0's published
types:

| Effect 3 | Effect 4 |
| --- | --- |
| `Context.Tag`, `Effect.Tag`, `Effect.Service` | `Context.Service`. `Effect.Service` generated a `Default` layer; write the `Layer.effect` yourself |
| `Layer.scoped` | `Layer.effect`, which supplies the layer's scope |
| `Effect.catchAll`, `Effect.orElse` | `Effect.catch` |
| `Effect.catchAllCause` | `Effect.catchCause` |
| `Effect.catchSome` | `Effect.catchFilter`, with a `Filter` in place of the function returning an `Option` |
| `Effect.either`, `Either`, `effect/Either` | `Effect.result`, `Result`, `effect/Result`. `Either.right` is `Result.succeed`, `Either.left` is `Result.fail`, and `match` takes `onSuccess` and `onFailure` |
| `Effect.zipRight` | `Effect.andThen` |
| `Effect.fork`, `Effect.forkDaemon` | `Effect.forkChild`, `Effect.forkDetach` |
| `FiberRef.make` | `Context.Reference`, with a default value |
| `Runtime.runPromise` | `Effect.runPromiseWith`, or `Effect.runPromise` when no services are needed |
| `Schema.Literal('a', 'b')` | `Schema.Literals(['a', 'b'])`; `Schema.Literal` takes one value |
| `Schema.Union(A, B)` | `Schema.Union([A, B])` |
| `Schema.decodeUnknown`, `Schema.decode` | `Schema.decodeUnknownEffect`, `Schema.decodeEffect` |
| `Schema.decodeUnknownEither` | `Schema.decodeUnknownExit`, or `Schema.decodeUnknownResult` to keep code shaped by success and failure |
| `Schema.Date` (from a string), `Schema.DateFromSelf` | `Schema.DateFromString`, `Schema.Date` |
| `Schema.parseJson(schema)` | `Schema.fromJsonString(schema)` |
| `Schema.filter(predicate)` | `.check(Schema.makeFilter(predicate))`, or `Schema.refine` for a type refinement |
| `Schema.pattern(re)`, `Schema.minLength(n)`, `Schema.nonEmptyString()` | `.check(Schema.isPattern(re))`, `.check(Schema.isMinLength(n))`, `.check(Schema.isNonEmpty())` |
| `Schema.extend(fields)` | `.mapFields(Struct.assign(fields))` |
| `Schema.transform` | `.pipe(Schema.decodeTo(target, SchemaTransformation.transform({ decode, encode })))` |
| `Schema.transformOrFail` | `Schema.decodeTo` with `SchemaGetter.transformEffect` |
| `schema.annotations({ ... })` | `schema.annotate({ ... })` |
| `Schema.Schema<A, I, R>` as a type | `Schema.Codec<A, I, R>` |
| `ParseResult.TreeFormatter` | `SchemaIssue.makeFormatterDefault()`. The reference names `defaultFormatter`, which Effect 4.0's published types do not export |

```diff
- class Pipedrive extends Context.Tag('Pipedrive')<Pipedrive, PipedriveApi>() {}
+ class Pipedrive extends Context.Service<Pipedrive, PipedriveApi>()('Pipedrive') {}

- const Stage = Schema.Literal('lead', 'won', 'lost')
+ const Stage = Schema.Literals(['lead', 'won', 'lost'])

- const result = yield* Effect.either(syncDeal(deal))
- if (Either.isLeft(result)) ...
+ const result = yield* Effect.result(syncDeal(deal))
+ if (Result.isFailure(result)) ...
```

### Rules that keep the migration honest

- **Never write a compatibility layer** that re-exports the old names. It makes
  the errors vanish and leaves the code between versions for good.
- **No `any` and no `as` casts** to quiet an error after a rename. Such an
  error usually means the replacement has a different shape; go back to the
  reference or the source.
- **No invented APIs.** Every replacement comes from the reference, a topic
  guide or Effect 4's source.
- **The type check is the gate.** Run the tests too, and keep every test's
  intent: rewrite a test for the new API rather than delete or loosen it.

### What no type error shows

Each of these compiles and behaves differently:

- `Schema.UUID` becomes a string with `isUUID()`, which also checks the
  version and variant digits, so some ids v3 accepted are refused. `isGUID()`
  keeps v3's behaviour; use it for ids another system issues.
- `NumberFromString` decodes `""` to `0`, and `"abc"` to `NaN`. Where `0` is a
  valid value, such as an index read from a path, refuse blank text first.
- `mapFields(Struct.assign(...))` drops the struct's checks unless given
  `{ unsafePreserveChecks: true }`; v3's `extend` kept them.
- An `.annotations({ parseOptions: { onExcessProperty: 'error' } })` has no
  effect in Effect 4, so a body schema silently stops refusing unknown fields.
  Pass the options where you decode:
  `validateRequest(Command, { parseOptions: { onExcessProperty: 'error' } })`.
- `Schema.Date` refuses an invalid `Date` that `DateFromSelf` accepted.
- A filter's `message` is a string, not a function.
- `Cause` is flat: a test asserting `{ _tag: 'Fail', error }` asserts
  `{ reasons: [{ _tag: 'Fail', error }] }`.

### Together with the framework

Neither migration can be type-checked alone, because `honertia` runs only on
Effect 3 and 1.2 only on Effect 4. The order that works:

1. Install everything at once (see [Before you start](#before-you-start)).
2. Move the code that never imports the framework to Effect 4, a directory at
   a time. The directories are independent, so the work can run in parallel.
3. At the same time, write the framework's setup: `src/app.ts`, `src/paths.ts`
   and the route registrations (steps 1 to 5 of [0.7 to 1.0](#from-07-to-10)).
4. Then rewrite the actions, which need both.

Commits in between will not type-check; say so in their messages.

## From `honertia`

The package was renamed. The Inertia protocol is unchanged; the imports, the
setup and some names move.

```diff
- import { setupHonertia } from 'honertia'
- import { action, render } from 'honertia/effect'
+ import { setupWeb } from '@popcomputer/web'
+ import { action, render } from '@popcomputer/web/effect'
```

The setup is flatter:

```diff
- setupHonertia(app, {
-   honertia: { version, render, database, schema, bindings },
-   auth,
- })
+ setupWeb(app, { version, render, database, schema, bindings, auth })
```

Each former name has a direct replacement:

| Former name | Name in 1.2 |
| --- | --- |
| `HonertiaDatabaseType`, `HonertiaAuthType`, `HonertiaBindingsType`, `HonertiaAuthUserType`, `HonertiaRouteBindingsType` | One registration of `setupWeb`'s result: `interface Register { web: typeof web }` (step 2 below) |
| `HonertiaService` / `HonertiaRenderer` | `PageService` / `PageRenderer` |
| `honertiaContext` / `honertiaServices` | `webContext` / `webServices` |
| `honertia` middleware / `c.var.honertia` | `web` / `c.var.web` |
| `HonertiaConfigurationError` | `ConfigurationError` |
| `HonertiaStructuredError` | `StructuredError` |
| `HEADERS.HONERTIA` | `HEADERS.INERTIA` |
| `HON_*` error codes | `WEB_*` error codes |

The former names are not exported. Uninstall `honertia`: it is a separate
package, not a wrapper, so install only one framework package.

### From `honertia` 0.1

A 0.1 application sets up as middleware and registers its routes and error
handlers apart. Each piece has a place in 1.2:

| In `honertia` 0.1 | In 1.2 |
| --- | --- |
| `app.use('*', setupHonertia({ honertia: { ... }, effect: { services } }))` | `export const web = setupWeb(new Hono<Env>(), { ... })`, registered (step 2), with services from `web.services(...)` (step 5) |
| `honertia: { auth: (c) => createAuth(c.var.db) }` | `auth: { client: (c, { db }) => createAuth({ db, ... }) }`: `c.var.db` is gone |
| `registerErrorHandlers(app, { component, showDevErrors, envKey, devValue })` | `setupWeb`'s `errors: { component, showDevErrors, envKey, devValue }` |
| `effectRoutes(app)` | `routes` (step 2), with every path in `src/paths.ts` (step 4) |
| `effectAuthRoutes(app, { ... })` | Routes behind `RequireGuestLayer` (step 8), and `routes.all(paths.authApi, betterAuthHandler())` |
| Route options `body:` and `query:`, and `validatedBody<T>()` / `validatedQuery<T>()` | `validateRequest(Schema, { request: { order: ['body'] } })`, one source per schema (step 6) |
| Route option `params:` | A binding, so a missing record is a 404 (step 4); see below |
| `HonertiaService.share(key, value)` in a layer | `shared` in the setup, computed by `routes.provide(shareProps(effect))` (step 3) |
| `import { requiredString, email } from 'honertia'` | `@popcomputer/web/schema` (step 1) |

Three things change without a type error:

- **`effectAuthRoutes` registered Better Auth's handler at `/api/auth/*` for
  you.** Without `routes.all(paths.authApi, betterAuthHandler())`, anything
  that calls Better Auth directly stops working: its client SDK, an OAuth
  provider's callback, or a plugin's own pages and endpoints, such as the MCP
  plugin's sign-in and consent.
- **`params:` answered 404 for a malformed id.** A `{param}` with no binding
  is now a plain parameter read with `validateRequest`, whose failure is a 422
  or a redirect back. Bind the record to keep the 404, or answer
  `ValidationError` with `notFound(...)`.
- **0.1 validated the body before guard layers ran; 1.2 runs the guards
  first,** so a signed-out request with a malformed id goes to sign in, not to
  a 404. And pages receive only the user fields `auth.share` names: 0.1 shared
  the whole user and session, token included.

A webhook becomes an action, which reads its raw body and signature through
`RequestService`. A route another protocol owns entirely, such as an MCP
server, can stay on the Hono app: register it before passing the app to
`setupWeb`, so the framework's middleware never runs for it.

## From 0.4, 0.5 and 0.6

### 0.4 to 0.5

- `TestCaptureService.get` is an Effect value: replace `yield* capture.get()`
  with `yield* capture.get` in test layers and helpers.
- Numeric form values, numeric route bindings and persisted cache timestamps
  reject non-finite numbers.
- `nullableString` accepts scalar values and rejects objects and arrays.
- `declined` decodes `0`, `"0"`, `"false"`, `"no"` and `"off"` to `false`.

### 0.5 to 0.6

- Effect 4 is stable and required: install `effect@^4.0.0`, which no longer
  accepts `4.0.0-rc.*` pre-releases, and apply Effect's own pre-release
  renames (for example `SchemaTransformation.transformOrFail` became
  `transformEffect`, and `Schema.isLengthBetween` became `isBetweenLength`).
  Every package that peers on Effect moves with it: a release built against
  the pre-releases may import modules stable Effect no longer has.
  `@popcomputer/structured-chat` 0.13 and `@popcomputer/document-graph` 0.11
  are the first on stable Effect 4. A patch the application keeps against one
  of those packages' old versions (`patchedDependencies`) does not apply to
  the new one: carry it forward or drop it.
- `createTemplate` renders `<title inertia>`, so `<Head title>` replaces the
  template title. Remove any client-side code that deleted the template's
  title. Server code that edits the rendered document as a string, such as
  one that turned `<title>` into `<title inertia>` or wrote each page's title
  into it, must look for `<title inertia>`: one that requires `<title>` fails
  on every page. The document's other landmarks are `<meta charset="utf-8">`,
  the viewport `<meta>`, the empty `<div id="app"></div>` that follows the
  page's `<script data-page="app" type="application/json">`, and `</head>`.
- `vite.script()` and `vite.hmrHead()` accept a dev server origin as well as a
  port, for a local proxy that serves Vite under its own hostname:

  ```ts
  const viteServer = 'https://vite.myapp.localhost'
  const scripts = [vite.script('/src/main.tsx', viteServer)]
  const head = vite.hmrHead(viteServer)
  ```

### 0.6 to 0.7

Pages that read no data are cached at Cloudflare's edge by default. Check
three things:

- Bind version metadata, so each deploy starts from an empty cache. In
  `wrangler.jsonc`:

  ```jsonc
  "version_metadata": { "binding": "CF_VERSION_METADATA" }
  ```

  In `wrangler.toml`:

  ```toml
  [version_metadata]
  binding = "CF_VERSION_METADATA"
  ```

  Named environments (`[env.staging]`) do not inherit it; repeat it in each.

- Give `cache: 'private'` to routes whose page changes without reading a
  binding or request header, such as one built from an external `fetch()` or
  the current time.
- Middleware that sets `Cache-Control` on every response, such as a blanket
  `no-store`, stops pages from being cached. Set it only when a response has
  no `Cache-Control` yet.
- An application with caching of its own, such as its own `Cache-Control`
  policy or its own use of Cloudflare's Cache API, can keep it and turn the
  page cache off: `pageCache: false` in `setupWeb`.

Workers builds no longer need `drizzle-orm` installed when the application
has no route model binding.

## From 0.7 to 1.0

1.0 replaced most of the 0.x API. Each step shows the 0.7 code it replaces;
skip a step whose code your application never had.

### 1. Import each name from its one entrypoint

`@popcomputer/web/effect` no longer re-exports the validators, the data cache
or the Better Auth integration, and synonyms are gone:

```diff
- import { requiredString, email } from '@popcomputer/web/effect'
- import { cache } from '@popcomputer/web/effect'
- import { betterAuthLogoutAction } from '@popcomputer/web/effect'
+ import { email, requiredString } from '@popcomputer/web/schema'
+ import { cache } from '@popcomputer/web/cache'
+ import { betterAuthLogoutAction } from '@popcomputer/web/auth'

- yield* requireAuth()
+ yield* authorize()
- const signedIn = yield* isAuthenticated
+ const signedIn = (yield* currentUser) !== null
- const value = yield* validate(Schema, input)
+ const value = yield* validateUnknown(Schema, input)
- description: optionalString,
+ description: nullableString,
- import { S } from '@popcomputer/web/schema'
+ import { Schema as S } from 'effect'
```

The entrypoints are:

| Entrypoint | For |
| --- | --- |
| `@popcomputer/web` | `setupWeb`, template helpers, Hono middleware |
| `@popcomputer/web/effect` | Actions, routes, responses, pages, the database, services, errors |
| `@popcomputer/web/schema` | Validators |
| `@popcomputer/web/auth` | The Better Auth integration |
| `@popcomputer/web/cache` | The KV data cache |
| `@popcomputer/web/drizzle` | `rowOf` |
| `@popcomputer/web/endpoint` | `endpoint`, `call` and `openApi` |
| `@popcomputer/web/lint` | `webLint`, in `oxlint.config.ts` |
| `@popcomputer/web/react` | Page component types |
| `@popcomputer/web/paths` | `href` |
| `@popcomputer/web/testing` | Tests |

Error codes start `WEB_` instead of `HON_`.

### 2. Register the setup instead of augmenting

The types the module augmentations restated now come from the values
`setupWeb` takes, and `setupWeb`'s `routes` replaces `effectRoutes(app)`:

```diff
- // src/web-types.ts
- declare module '@popcomputer/web/effect' {
-   interface WebBindingsType { type: Bindings }
-   interface WebDatabaseType { type: ReturnType<typeof createDb>; schema: typeof schema }
-   interface WebAuthType { type: ReturnType<typeof createAuth> }
-   interface WebRouteBindingsType { type: typeof routeBindings }
- }
-
- const app = new Hono<Env>()
- const application = setupWeb(app, { version, render, database, schema, bindings: routeBindings, auth })
- export default app
+ // src/app.ts
+ export const web = setupWeb(new Hono<Env>(), { version, render, database, schema, bindings, pages, paths, auth })
+
+ declare module '@popcomputer/web' {
+   interface Register {
+     web: typeof web
+   }
+ }
+
+ export const { app, routes } = web
+ export default app
```

Delete the augmentation file. An application with services of its own takes
its routes from `web.services(...)` instead (step 5).

0.x also took the setup as middleware, `app.use('*', setupWeb({ ... }))`, and
the error boundary from `registerErrorHandlers(app, options)`. `setupWeb`
takes the Hono app as its first argument, and those options are its `errors`.

### 3. Declare the user, shared props and flash as schemas

The signed-in user comes from the user table, and pages receive only the
fields `share` names. Shared props and flash are declared in the setup, and
shared props are computed by `shareProps`:

```diff
  auth: {
    client,
-   session: AuthSession, // a hand-written copy of Better Auth's user and session
-   share: ({ user }) => ({ id: user.id, name: user.name, image: user.image }),
+   session: betterAuthSession(tableSchema(schema.user)),
+   share: tableSchema(schema.user).mapFields(Struct.pick(['id', 'name', 'image'])),
  },
+ shared: S.Struct({ unreadCount: S.Number }),
+ flash: S.Struct({ success: S.String }),

- declare module '@popcomputer/web/react' {
-   interface SharedProps { unreadCount: number }
- }
```

`schema.user` is Better Auth's user table as `docs/auth-tables.md` names it; use your
own table's key, such as `schema.users`. The session token is
`Redacted<string>`: read it with `Redacted.value`. A
user field you add, such as a role, is a column, and Better Auth reads it
from there:
`additionalFields: betterAuthFields(schema.user, { role: { input: false } })`.
When a Better Auth plugin adds session fields, pass the session table too:
`betterAuthSession(tableSchema(schema.user), tableSchema(schema.session))`.

A 0.x `share` function could add values from the session, such as whether an
administrator is impersonating the user. `share` now encodes the user's record
alone, so share such a value as its own prop: declare it in `shared` and
compute it with `shareProps`, whose Effect reads the session through
`currentUser`.

### 4. Declare paths, bindings and pages

Every path moves to `src/paths.ts`, bindings name their tables, and each
page's props are a schema in `src/pages.ts`:

```diff
- effectRoutes(app).get('/projects/{project}', showProject, { name: 'projects.show' })
+ routes.get(paths.project, showProject, { name: 'projects.show' })

- return yield* redirect(`/projects/${project.id}`, 303)
+ return yield* redirect(paths.project, { project: project.id })

- <Link href={`/projects/${project.id}`}>
+ <Link href={href(paths.project, { project: project.id })}>

- const routeBindings = { project: Project } // an Effect Schema of the row
+ bindings: { project: schema.projects },

- const Show: WebPage<WithSharedProps<{ project: Project }>> = ({ project }) => ...
+ const Show: WebPage<'Projects/Show'> = ({ project }) => ...
```

`redirect` always answers 303; its status argument is gone. Query values go
in its third argument: `redirect(paths.deals, {}, { tab: 'stale' })`.

Registering pages is all or nothing: once `pages` is passed, `render` takes
only registered names, so every page needs a schema. An application with many
pages, whose props have no schemas yet, can upgrade without `pages` and add
them afterwards. Until then, `render` takes props of any declared shape,
interfaces included, whose values JSON carries.

### 5. Give services after registering

`setupWeb`'s `effect.services` moves to `web.services(...)`, called after the
`Register` declaration, which returns the routes. Its `request` layer is built
for each request and its `app` layer once per isolate. The data cache's store
is provided rather than found in a binding named `KV`. The layers need no
type annotations:

```diff
  export const web = setupWeb(new Hono<Env>(), {
    ...,
-   effect: {
-     services: (c) => auditLogFor(c.env.KV),
-   },
  })

- export const { app, routes } = web
+ export const { app, routes } = web.services({
+   app: ClockLive,
+   request: (c) => Layer.merge(auditLogFor(c.env.KV), kvCache(c.env.KV)),
+ })
```

Read vars and secrets with `config.string('NAME')` and
`config.redacted('KEY')`, whose names are checked against the bindings type.

### 6. Validate inside the action, and let failed forms go back

The route options `body`, `query` and `validateBody`, and
`validatedBody<T>()`, are gone. `errorComponent` is gone too: a failed form
now redirects back to the page it came from, which renders with all its
props and the field errors:

```diff
- effectRoutes(app).post('/projects', createProject, { body: CreateProject })
- const input = yield* validatedBody<CreateProject>()
+ routes.post(paths.projects, createProject)
+ const input = yield* validateRequest(CreateProject)

- const input = yield* validateRequest(UpdateProject, { errorComponent: 'Projects/Edit' })
+ const input = yield* validateRequest(UpdateProject)

- return yield* Effect.fail(new ValidationError({ errors: { amount: 'Too low.' }, component: 'Listings/Show' }))
+ return yield* invalid({ amount: 'Too low.' })

- validateRequest(Filters, { request: { profile: 'laravel' } })
+ validateRequest(Filters, { request: { order: ['query', 'body'] } })
```

A form posted without a same-origin `Referer`, as a test often does, goes
back to the page its route names: `routes.post(path, action, { form: paths.page })`.
Use `flash('success', 'Saved.')` before a redirect instead of passing a
message to the next page by hand.

`renderWithErrors(component, errors, props)` and `PageService`'s `setErrors`
are gone. To render a page again in place with its errors, as they did, pass
the errors as a prop: the renderer merges an `errors` prop with flashed ones.

```diff
- return yield* renderWithErrors('Join/New', { websiteUrl: 'Enter a website.' }, props)
+ return yield* render('Join/New', { ...props, errors: { websiteUrl: 'Enter a website.' } })
```

`RequestService`'s `json()` takes no type argument: decode the `unknown` it
returns.

### 7. Use the new database operations

The callback receives the application's own Drizzle client, so Drizzle checks
every column. `asTrusted` and the database argument are gone, and a
transaction runs an Effect:

```diff
- const db = yield* DatabaseService
- yield* dbMutation(db, asTrusted({ ...input, userId: auth.user.id }), (tx, values) =>
-   tx.insert(projects).values(values)
- )
+ yield* dbMutation((db) =>
+   db.insert(projects).values({ ...input, id: crypto.randomUUID(), userId: auth.user.id })
+ )

- yield* dbTransaction(db, async (tx) => {
-   await tx.delete(tasks).where(eq(tasks.projectId, project.id))
-   await tx.delete(projects).where(eq(projects.id, project.id))
- })
+ yield* dbTransaction(Effect.gen(function* () {
+   yield* dbMutation((db) => db.delete(tasks).where(eq(tasks.projectId, project.id)))
+   yield* dbMutation((db) => db.delete(projects).where(eq(projects.id, project.id)))
+ }))

- Effect.catchTag('DatabaseMutationFailed', ...)
+ Effect.catchTag('DatabaseError', ...)
```

Reads use `dbQuery((db) => ...)`. On Cloudflare D1, where `dbTransaction` is
a type error, write with `dbBatch((db) => [...])`.

Domain code that already takes the database client as an argument can keep
it. The lint rules refuse `DatabaseService` in an action
(`no-database-service-in-action`), so read it in one adapter module outside
the actions and hand the client on. Likewise, `Effect.provide` in an action is
refused (`no-provision-in-action`): give the layer to the routes that need it
with `routes.provide(layer)`. A test replaces a service given that way through
`testEnv`'s layer, as it replaces any other.

### 8. Move auth routes onto `routes`

A sign-in action validates its form like any action and returns
`betterAuthRedirect`. The pages are ordinary routes behind
`RequireGuestLayer`:

```diff
- effectAuthRoutes(app, {
-   loginComponent: 'Auth/Login',
-   loginAction: betterAuthFormAction({
-     schema: SignIn,
-     errorComponent: 'Auth/Login',
-     call: (auth, input, request) => auth.api.signInEmail({ body: input, headers: request.headers, asResponse: true }),
-     errorMapper: (error) => ({ email: error.message }),
-     redirectTo: '/projects',
-   }),
-   logoutAction: betterAuthLogoutAction({ redirectTo: '/login' }),
- })
+ routes
+   .provide(RequireGuestLayer)
+   .get(paths.login, action(render('Auth/Login')))
+   .post(paths.login, signIn)
+ routes.post(paths.logout, betterAuthLogoutAction({ redirectTo: paths.login }))
+ routes.all(paths.authApi, betterAuthHandler()) // effectAuthRoutes registered this for you
```

- **`effectAuthRoutes` registered Better Auth's handler at `/api/auth/*`**
  without saying so. Keep it, as above, if anything calls Better Auth there:
  its client SDK, an OAuth provider's callback, an MCP client, a payment
  provider's webhook, or a plugin's own pages. Without it they answer 404,
  and no type error says so.

- `signIn` returns
  `betterAuthRedirect('signInEmail', { body: input }, { redirectTo, errors })`.
  [`docs/sign-in.md`](docs/sign-in.md) shows it in full.
- Validate a sign-in password with `currentPassword`, which never trims it,
  and a new one with `password(...)`.
- Never call `auth.api` from an action: it skips Better Auth's rate limits
  and origin checks. Call an endpoint whose result you need with
  `betterAuthCall(endpoint, { body })`.
- `betterAuthFormAction` is gone. A form whose `call` sent a request to
  Better Auth's handler by path, with fields of its own such as the MCP
  plugin's `oauth_query`, can keep that call in an action: validate the form,
  send it, and answer with a 303 carrying the cookies Better Auth set, or
  `invalid(errors)` for a refusal. `betterAuthRedirect` and `betterAuthCall`
  call an endpoint by its name on Better Auth's instance, so an application
  whose `auth.client` returns a wrapper that loads Better Auth on first use
  keeps its own calls; `betterAuthLogoutAction` works through such a wrapper.
- A signed-out visitor goes to `auth.signInPath` (default `/login`) with the
  page as `?redirect=`, which `intendedUrl(fallback)` returns to after
  signing in. A signed-in visitor on a guest page goes to `auth.homePath`.
- To slow password guessing, add
  `auth.signInLimits: { limiter: 'SIGN_IN_LIMITER', table: schema.rateLimit }`
  and sweep old rows with `routes.scheduled(() => sweepSignInFailures)`.

### 9. Name cache tags by the schema, and rename `cache: false`

Tags name tables by their key in the schema and records as
`table:primaryKey`, so the tags a page carries and the tags a write purges
match. A route that opted out of the page cache says `cache: 'private'`:

```diff
- effectRoutes(app).get('/plans', showPlans, { cache: { maxAge: 300, tags: ['plan_prices'] } })
+ routes.get(paths.plans, showPlans, { cache: { maxAge: 300, tags: ['planPrices'] } })

- effectRoutes(app).get('/weather', showWeather, { cache: false })
+ routes.get(paths.weather, showWeather, { cache: 'private' })

- const responses = yield* ResponseCacheService
- yield* responses.purge({ tags: [`project:${project.id}`] })
+ yield* purgeCache(recordCacheTag('projects', project.id))
```

`cacheInvalidate` and `cacheInvalidatePrefix` no longer fail, so remove any
`Effect.catchTag('CacheError', ...)` on them.

### 10. Test through the application

`describeRoute`, `createRouteTester` and `TestLayer` are gone. A test calls
`app.request` with `testEnv`, signs in with `signedIn`, and uses a real
database of the production family: PGlite for Postgres, or Miniflare's D1
through `testD1`:

```diff
- const res = await app.request('/projects/project-1', {}, {
-   ...bindings,
-   __testLayer: Layer.merge(TestLayer.Auth.withUser({ id: 'user-1' }), TestLayer.Database.inMemory()),
- })
+ const res = await app.request(
+   '/projects/project-1',
+   { headers: { 'X-Inertia': 'true' } },
+   testEnv(signedIn({ id: 'user-1' }), testBindings, { database: testDb })
+ )
+ const page = await readPage(res, 'Projects/Show')
```

A field error in `page.props.errors` is a message, or an error bag's
messages, and `signedIn`'s default user is named `Test User`. An application
whose `auth.session` adds required fields, such as a role, passes them to
`signedIn`.

A 0.x test that built a small application of its own, with only the routes
under test and stand-ins for the services they use, can stay one rather than
move onto the real application. `setupWeb` returns its `routes`, and the
stand-ins move to `.services`:

```diff
- const app = new Hono<Env>()
- app.use('*', setupWeb({ version: 'test', render, effect: { services: () => fakes } }))
- effectRoutes<Env, Services>(app).post('/api/contact', createContactMessage)
- registerErrorHandlers(app, { showDevErrors: false })
+ const { app, routes } = setupWeb(new Hono<Env>(), {
+   version: 'test',
+   render,
+   errors: { showDevErrors: false },
+ }).services({ request: () => fakes })
+ routes.post('/api/contact', createContactMessage)
```

`buildContextLayer`, which gave an Effect a request's services outside a
route, is gone: give the Effect the services it reads, or run it with
`routes.run(effect, env)`, which gives it those an action has.

Moving tests onto the real application brings up:

- **The build manifest.** An `app.ts` that computes its version with
  `createVersion(manifest)` imports `dist/manifest.json`, which exists only
  after `vite build`. Build before testing (a `postinstall` script does it on
  a fresh clone), or keep the import in a module of its own and replace it
  in a test preload.
- **A database binding.** `signedIn` still loads the session through the
  request's database, so a test env without one answers 503
  (`SessionLookupUnavailable`) before any action runs.
- **D1's limit of 100 bound parameters.** Seed data inserted in one statement,
  as `bun:sqlite` allowed, fails on D1 with `too many SQL variables`: insert
  it in chunks.
- **Speed.** Real D1 databases are slower than `bun:sqlite` stand-ins; a
  suite of 1,000 tests went from 11 to 27 seconds.

If you ran tests on 1.1.0, its `testD1` left a `miniflare-*` directory in the
system's temporary directory on every run, tens of megabytes for a large
schema. 1.2.0 leaves none; delete the old ones once no test is running.

### 11. Replace the `popweb` CLI

The package has no CLI:

```diff
- bunx popweb routes --app src/app.ts --json
+ routes.toJson()
- bunx popweb check --app src/app.ts
+ bunx tsc --noEmit
- bunx popweb db:migrate
+ bunx drizzle-kit migrate               # Postgres
+ bunx wrangler d1 migrations apply DB   # Cloudflare D1
- bunx popweb generate:openapi --app src/app.ts
+ openApi(endpoints, info)               # from @popcomputer/web/endpoint
```

Delete `.popweb-applied.json`: drizzle-kit and Wrangler record applied
migrations in the database itself. The generators have no replacement; write
actions from the examples in `docs/` and `AGENTS.md`. Remove `popweb`
scripts from `package.json`.

### 12. Give a helper that reads a route model its requirement

A helper annotated `Effect.Effect<A, E, BoundModels>` that calls
`bound('project')` requires `BoundRequirements<'project'>` instead. An action
that reads a model its route's path does not bind is a `missingRouteModels`
type error where the route is registered:

```diff
- const ownProject: Effect.Effect<Project, BoundModelError, BoundModels> = ...
+ const ownProject: Effect.Effect<Project, BoundModelError, BoundRequirements<'project'>> = ...
```

### Reading the type errors

A type error where a route is registered names what is missing:

| Error | Means | Fix |
| --- | --- | --- |
| `missingServices` | The action uses a service the setup does not provide | Provide it in `web.services(...)` or with `routes.provide(layer)` |
| `unhandledErrors` | The action fails with an error that is not the framework's | Answer it with `Effect.catchTag`. For a failure the action cannot answer, such as another system being down, pipe that call through `Effect.orDie`: the request answers 500 and the error observer receives the failure. Never over `authorize()`, `bound()`, `validateRequest` or the database |
| `missingRouteModels` | The action reads a `bound()` model its path does not bind | Add the `{param}` to the path, or stop reading the model |
| An error at `render(...)` | The page or its props differ from `src/pages.ts` | Match the page schema |
| `'web' implicitly has type 'any'` (TS7022) | A `setupWeb` value reads the registration, such as a service using `dbQuery` | Move it to `web.services(...)` |

A list cut off with `... 7 more ...` shows whole with
`"noErrorTruncation": true` in `tsconfig.json`. [Reading the type
errors](docs/type-errors.md) explains each one in full.

## Changes no type error points at

These compile unchanged and behave differently. Check each against your
application and its tests.

**Requests and validation**

- **Cross-site writes are refused.** A `POST`, `PUT`, `PATCH` or `DELETE`
  whose `Origin` (or `Referer`) names another origin gets a 403. A request
  with neither header, such as a webhook, passes, and so does one with an
  `Authorization` header. List a native app or another site that posts in
  `security: { verifyOrigin: { allowedOrigins: ['https://admin.example'] } }`.
- **API clients get JSON.** A request that asks for no HTML but sends an
  `Accept` header (`fetch`'s `*/*`) or an `Authorization` header is a JSON
  client: its failures are JSON, and a signed-out one gets a 401 instead of a
  redirect to sign in. So is a request whose User-Agent names a command-line
  or AI client (`curl`, `claude`, `CLI`): a page checked with `curl` answers
  JSON, and a signed-out one a 401. An Inertia visit always gets Inertia's
  page protocol.
- **Route parameters can't be overwritten.** A body or query field with the
  same name as a route parameter and a different value fails validation. It
  used to replace the parameter.
- **Every invalid field is reported**, not only the first, and an absent
  field reads "This field is required" rather than "Missing key".
- **Form lists nest.** `validateRequest` reads fields named
  `lines[0][quantity]` or `lines.0.quantity` into objects and lists, and every
  value of a `tags[]` field.
- **An invalid query on a page visit renders the error page** with a 422.
- **`invalid(...)` sends the form back with a GET of its page.** If that GET
  does something, such as recording that a document was viewed, render the
  page with an `errors` prop instead.

**Responses**

- **`redirect` always answers 303,** where a 0.x route may have answered 302.
- **`httpError(status, message)` without a body renders the error page** for
  a browser visit; a JSON client still gets JSON.
- **`file(bytes, { filename })` downloads.** It sends
  `Content-Disposition: attachment`; to show a file inline under a name, set
  that header yourself.
- **`render` answers 200 unless given a status.** A page that reports
  something missing passes it as the third argument:
  `render('Signing/LinkInvalid', {}, { status: 404 })`.

**Route models**

- **Models load when the action first calls `bound()`.** A route whose action
  never calls `bound('project')` no longer answers 404 for a missing project,
  and a `{param}` with no binding is a plain parameter you read with
  `validateRequest`. On a route that needs a signed-in user, call
  `authorize()` before `bound()`.

**Uploads**

- **Upload families leave out active content.** `upload({ types: ['image/*'] })`
  no longer accepts SVG, and no family accepts HTML or XML; name
  `'image/svg+xml'` to accept SVG.
- **Uploads are checked against their contents.** A PNG, JPEG, GIF, WebP,
  AVIF, HEIC, BMP, PDF or ZIP must start with its signature, so an HTML page
  sent as `image/png` is refused. Decoding an upload now reads the file, so
  decode it with `validateRequest` or `S.decodeUnknownEffect`, not
  synchronously.
- `file()` sends `X-Content-Type-Options: nosniff`, and sandboxes such a file
  shown inline.

**Caching**

- **Caching is stricter.** Cached responses vary on `Cookie`, so a visitor
  with any cookie renders afresh. A response without `Cache-Control` gets
  `no-store` when it is signed in or sets a cookie, and `private, no-cache`
  otherwise. `purges: true` on a route without a `{param}` throws at
  registration.
- **The data cache keeps its keys under `popweb:cache:`**, so a KV namespace
  can hold your other data too. Entries cached before the upgrade read as
  misses once, are computed again, and expire on their own.

**Security headers**

- **Every response refuses framing** unless it sets its own headers: it gets
  `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`
  and `frame-ancestors 'none'` in its `Content-Security-Policy`. If you embed
  your own pages in iframes, set `security: { headers: { frames: 'same-origin' } }`,
  or `false` for none.

**Better Auth**

- **`betterAuthHandler` is a function:** register it as
  `routes.all(paths.authApi, betterAuthHandler())`. If your Better Auth
  config declares user fields with `input: true`, name the ones visitors may
  set: `betterAuthHandler({ settable: ['timeZone'] })`.
- **`effectifyBetterAuth` is removed,** with `BetterAuthEffectApi`,
  `BetterAuthEffectClient`, `BetterAuthBoundaryFailure` and
  `BetterAuthActionResult`. Use `betterAuthRedirect` and `betterAuthCall`
  from an action. Code outside an action calls Better Auth's own `auth.api`.
- **Better Auth must be 1.7.7 or a later 1.7.x,** the releases the
  framework's Better Auth tests pass against. It used to accept every 1.x.
- **A database that ran Better Auth 1.7.0 through 1.7.2 has a required
  `account.issuer` that 1.7.3 and later never write.** Every sign-up and
  account link then fails, and Better Auth refuses to start: `Required columns
  Better Auth never writes: account.issuer`. Check with
  `SELECT * FROM account LIMIT 0` (use your table's name). If the column is
  there, relax it before deploying 1.7.7, as Better Auth's
  [1.7 upgrade guide](https://www.better-auth.com/docs/guides/1-7-upgrade-guide)
  says, and drop the unique index on `issuer` and `accountId`. SQLite and D1
  cannot drop `NOT NULL` in place, so rebuild the table in a migration:

  ```sql
  CREATE TABLE account_next (/* the same columns in the same order, with issuer TEXT */);
  INSERT INTO account_next SELECT * FROM account;
  DROP TABLE account;
  ALTER TABLE account_next RENAME TO account;
  -- Recreate the table's other indexes, leaving out the one on issuer.
  ```

  Make the column optional in the Drizzle schema too. Dropping it is
  separate cleanup.

**Errors**

- **Production errors say less.** Production JSON errors no longer include
  `docs` or `fixes`, and a client that matches error codes reads `WEB_`
  instead of `HON_`.
- **Every 404 has the same message in production:** "Nothing was found at
  this address.", whatever `notFound(...)` or `httpError(404, message)`
  said, so a response cannot tell a missing record from one the visitor may
  not see. A page that shows the server's message for a failed `fetch`, such
  as a form that says which agency is no longer listed, now shows that
  sentence instead. Development keeps the message, so the application's own
  tests still pass and only production changes; test with
  `ENVIRONMENT: 'production'` in the bindings to see what a client gets.
  Give each 404 whose message a page shows a body that carries it, which
  production keeps:

  ```ts
  import { Schema as S } from 'effect'
  import { httpError } from '@popcomputer/web/effect'

  const ShownMessage = S.Struct({ message: S.String })

  /** A 404 whose message a page shows, kept in the body in production. */
  export const notFoundShown = (message: string) =>
    httpError(404, message, ShownMessage, { message })
  ```

  The page reads the envelope's `body.message` before its `message`. A 404
  no page shows needs nothing.
- **Expected 4xx failures are no longer logged as errors** by the framework,
  but `EffectErrorObserverService` still receives them. An observer that
  reports everything should skip them.
- **An action can no longer fail with its own errors.** `honertia` answered a
  failure the action did not handle with a 500; 1.2 refuses to register the
  action (`unhandledErrors`). Answer each failure, or turn one the action
  cannot answer into a defect with `Effect.orDie`, as
  [Reading the type errors](#reading-the-type-errors) shows.

## From 1.0 to 1.3

Nothing to change. Install 1.3.0:

```bash
bun add @popcomputer/web@^1.3.0
```

What 1.1.0 brought:

- **A page loaded during a deploy reloads instead of staying blank.** For a
  few seconds after `wrangler deploy`, the previous version can still answer
  at some edge locations, with a page naming scripts the new deploy no longer
  serves. `createTemplate` now inlines a small script that reloads the page
  when one of its own scripts or stylesheets fails to load: at once, then
  after 2 and 4 seconds, at most three times a minute, so it never loops.
- **`TEMPLATE_SCRIPT_HASH`.** If your application sends its own
  `Content-Security-Policy` with a `script-src`, allow that script:

  ```ts
  import { TEMPLATE_SCRIPT_HASH } from '@popcomputer/web'

  const scriptSrc = `script-src 'self' ${TEMPLATE_SCRIPT_HASH}`
  ```

What 1.2.0 brings:

- **`render` takes a status:** `render('Signing/LinkInvalid', {}, { status: 404 })`
  answers 404, as a visit and as the Inertia page object.
- **`render` takes props an interface declares,** without a page registry,
  whose values JSON carries.
- **A test's fake replaces a service a route gives** with `routes.provide()`,
  as it replaces those `web.services(...)` gives. The fake is built once a
  request.
- **`testD1` leaves no temporary files behind.**
- **One way to answer 500.** A failure an action cannot answer, such as
  another system being down, goes through `Effect.orDie` on that call, and the
  development error page names it.

What 1.2.2 brings:

- **An Inertia visit gets Inertia's page protocol whatever its User-Agent
  says.** A browser or agent whose User-Agent names `claude`, `curl` or
  `CLI` got JSON errors an Inertia client cannot read.
- **Signing out of a Better Auth loaded on first use ends the session.** An
  application that wraps Better Auth to keep it out of a Worker's startup
  only had its cookies cleared; `betterAuthRedirect` and `betterAuthCall` now
  say why they cannot call through such a wrapper.
- **`web.services`' `request(c)` runs only when an action does,** not for
  every request: a plain Hono route, such as a media file or a redirect, no
  longer builds the application's services.

What 1.2.3 brings:

- **A sign-in keeps its new session** when the browser still held a session
  the database no longer had (revoked elsewhere, or by a password reset), or
  one Better Auth was extending. The old session's expiry or renewal was
  written after the new session's cookie, so a sign-in through Better Auth's
  handler, or an action returning Better Auth's cookies, looked accepted and
  the next page was signed out, or still the previous user.

What 1.3.0 brings:

- **The Worker's vars and secrets can be declared once,** with `defineEnv`
  from `@popcomputer/web/env` in `src/env.ts`: each one's schema, whether it
  is a secret, whether the Worker needs it, and how to generate it.
  `EnvBindings<typeof env>` types the bindings, and `setupWeb`'s `env` checks
  each isolate's bindings before it serves, failing requests with
  `EnvInvalid`, which names each missing or invalid one and never a value.
  It's optional; an application without `env` works as before. When you add
  it, give `testEnv` every var and secret it requires, since tests go through
  the same check. [Vars and secrets](docs/env.md) shows it, and `checkEnv`
  for a script that checks them before a deploy.
- **The documentation is one short file per task,** in `docs/`, which the
  package ships as `node_modules/@popcomputer/web/docs/`. The README keeps
  the overview and links to each file, and
  [`docs/which-api.md`](docs/which-api.md) names the file for each task. A
  link to one of the README's old sections finds it under the same heading
  in its file there.

## From 1.3 to 1.4

Your routes answer as before: a binding that names only its table still
loads any record its path names. What changes is that each binding now says
who may load its record, beside its table, instead of each action checking.
Install 1.4.0:

```bash
bun add @popcomputer/web@^1.4.0
```

`bun run check` then reports `require-binding-access` on each binding that
does not say. For each, give the option that does, and delete the check it
replaces:

- A record only its owner sees: `routeBinding(schema.projects, { ownedBy: 'userId' })`,
  whose column references the users table, `.references(() => user.id)`;
  `setupWeb` fails on one that doesn't. Delete the action's `if (project.userId !== auth.user.id) return yield* notFound('Project')`,
  and a guard layer that did only that. Another user's record is now the
  404 a missing one is, from the lookup's own query.
- A record anyone sees when a column says so: `{ publicWhen: { visibility: 'public' } }`,
  or `{ publicWhen: { isPublic: true } }`.
  Its owner's pages bind the same table a second time, with `ownedBy`,
  under another name and path.
- A record anyone sees: `{ public: true }`.
- A record a guard layer decides, such as an organization its membership
  guard checks: `{ guarded: true }`.
- A record loaded only under its parent: `scope: { project: { foreignKey: 'projectId' } }`,
  so the parent's option decides.

```diff
- bindings: { project: schema.projects, task: schema.tasks },
+ bindings: {
+   project: routeBinding(schema.projects, { ownedBy: 'userId' }),
+   task: routeBinding(schema.tasks, { scope: { project: { foreignKey: 'projectId' } } }),
+ },
```

To move binding by binding, report the rule as a warning until each says:
`webLint({ 'require-binding-access': 'warn' })`.

A guard that decides who may load a `guarded: true` record is made with
`guard(...)`: `guard(CurrentMember, Effect.gen(...))` in place of
`Layer.effect(CurrentMember, Effect.gen(...))`, as
[Guards and roles](docs/guards.md) shows. Three more changes:

- Hono must be 4.13.5 or later and Drizzle ORM 0.45.2 or later:
  `bun add hono@^4.13.5 'drizzle-orm@>=0.45.2 <1.0.0'` if yours are older.
- `url` and `nullableUrl` accept only `http:` and `https:` links. A form
  that took a `mailto:` link takes an email instead and builds the link in
  the page.
- A route's `cache` option stores nothing that read a request header, a
  cookie or request state. A cached page that read `Accept-Language`, say,
  renders afresh each time: give each language a path of its own to cache it.

## Tooling after the upgrade

- **`tsconfig.json`** needs the DOM library and JSX for React pages, and
  Cloudflare's types for bindings:

  ```json
  {
    "compilerOptions": {
      "target": "ES2022",
      "module": "ESNext",
      "moduleResolution": "bundler",
      "lib": ["ES2022", "DOM"],
      "jsx": "react-jsx",
      "types": ["bun", "@cloudflare/workers-types"],
      "strict": true,
      "skipLibCheck": true
    }
  }
  ```

- **The framework's lint rules** catch what types cannot see, such as an
  update without a `where`, a transaction that calls the network, or SQL
  built from a string:

  ```bash
  bun add -d oxlint
  ```

  ```ts
  // oxlint.config.ts
  import { defineConfig } from 'oxlint'
  import { webLint } from '@popcomputer/web/lint'

  export default defineConfig(webLint())
  ```

  Give `package.json` `"type": "module"`, or Node warns
  `MODULE_TYPELESS_PACKAGE_JSON` on every lint run.

- **One check command** replaces `popweb check`:

  ```json
  "scripts": {
    "check": "tsc --noEmit && oxlint && bun test"
  }
  ```

- **Point your agents at the rules.** Have your project's `AGENTS.md` (and
  `CLAUDE.md`) point at `node_modules/@popcomputer/web/AGENTS.md`, which
  matches the installed version. In Claude Code, you can also copy
  `node_modules/@popcomputer/web/skills/popcomputer-web` into
  `.claude/skills/` so the rules load in every session.

## Checklist

- [ ] The peer dependencies are in range, and `@popcomputer/web` is `^1.4.0`.
- [ ] Each route binding says who may load its record: `bunx oxlint` reports no `require-binding-access`.
- [ ] `bunx tsc --noEmit` passes.
- [ ] `bunx oxlint` passes.
- [ ] `bun test` passes, with tests on `testEnv`, `signedIn` and `readPage`.
- [ ] No removed names remain. This should print nothing:

  ```bash
  grep -rnE "effectRoutes|effectAuthRoutes|declare module '@popcomputer/web/(effect|react)'|validatedBody|requireAuth|isAuthenticated|asTrusted|__testLayer|TestLayer|effectifyBetterAuth|errorComponent|cache: false|popweb |Honertia|HON_" \
    --include='*.ts' --include='*.tsx' --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.wrangler .
  ```

- [ ] Nothing refers to the old package, including scripts that check for it
  at run time. This should print nothing either:

  ```bash
  grep -rni "honertia" --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.wrangler --exclude-dir=.git .
  ```

- [ ] `.popweb-applied.json` and any `popweb` scripts are gone.
- [ ] You have checked each item in
  [Changes no type error points at](#changes-no-type-error-points-at)
  against your application, especially cross-site writes, uploads,
  framing and the 404 messages a page shows.
- [ ] A preview deploy works before production.

## A worked example

The template, [popcomputer-web-demo](https://github.com/PatrickOgilvie/popcomputer-web-demo),
is an application written the way 1.2 teaches: sign-in and sign-up, records
only their owner sees, a public page, signed-in devices, and tests through
the application on D1. Compare your upgraded code with it, or start a new
application from it:

```bash
bun create PatrickOgilvie/popcomputer-web-demo my-app
```
