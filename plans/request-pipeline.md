# Request pipeline refactor (1.x, non-breaking)

The design review of 1.0 → 1.10 (2026-11-01) found the app-facing API and the
leaf modules (`database`, `flash`, `cache`, `env`, `endpoint`) still deep and
idiomatic. The drift sits in the code that runs each request: `setup.ts`,
`middleware.ts`, `page-cache.ts`, `effect/routing.ts`, `effect/bridge.ts`,
`effect/handler.ts` and `effect/auth.ts`. Two choices cause most of it:

1. **The framework's services exist only inside Hono middleware.** So a routed
   request builds two `ManagedRuntime`s (`bridge.ts:812`, `routing.ts:1414`),
   and `routes.run`, `scheduled` and `queue` fake a GET to `/__popweb/run`,
   with the Effect in a `WeakMap<Request>` and failures returned through
   `failRun`. It also lets jobs type-check against request-only services.
2. **Modules coordinate through a mutable per-request object**
   (`request-context.ts`, 26 fields, 60 `openWebContext` calls in 7 modules).
   App settings are copied onto every request. Response output is queued there
   and written by `web()` after the route's cache policy has run, which then
   has to predict it (`withDeferredOutput`, `flash.setsCookie`).

Alongside those, some decisions have no single owner and the copies disagree:
which cookies are session cookies (4 rules), whether a request is personal
(3–4 checks), development mode (3 checks), Cookie header parsing (3 parsers),
route-model access validation (3 sites). And `createHandler` is 432 lines,
with route-model loading written as Promise code that builds the
`ownedBy`/`publicWhen` SQL inside the router.

This plan fixes those without breaking 1.x apps. Each step lands on its own,
with the commit gate green, in the order below.

## Ground rules

- **No public break.** Everything `src/index.ts` and `src/effect/index.ts`
  export keeps its signature and behaviour, including the hand-composition
  API in `docs/lower-level.md` (`web`, `webServices`, `webContext`,
  `effectBridge`, `effectRoutes`, `pageCache`, `privateByDefault`,
  `markPageDynamic`) and the `WebRequestContext` type. Fields the framework
  stops reading stay in the type, still written, marked `@deprecated`, until
  2.0.
- **A behaviour change is a fix or it waits.** Where unifying two copies
  changes what one of them answers (session cookies, dev mode, 404 shape),
  the step says so, the CHANGELOG lists it under Fixed, and a test pins the
  new answer.
- **Security fixes stay proven.** The pipeline carries both audits' fixes.
  Every step runs the full `bun test`, including `tests/security/`, the fuzz
  suite under `tests/fuzz/`, and the generated docs fragments.
- **State machines.** A step that touches `middleware.ts`, `flash.ts`,
  `page-cache.ts`'s version check, `cache.ts`, `render` in `responses.ts` or
  `sign-in-limits.ts` runs the `verify-state-machines` skill before its
  commit.
- **Gate.** `tsc --noEmit` (with the Effect language service), `bunx oxlint`,
  `bun test`, `popweb-fence debt --check`. The debt count may only go down.

## Measures

`bun scripts/pipeline-measures.ts` prints the counted ones. Run it before and
after each step. The rows it doesn't count are tallied by hand.

| Measure | Now | Target |
| --- | --- | --- |
| `ManagedRuntime.make` per routed request | 2 | 1 |
| `ManagedRuntime.make` per job | 2, plus a fake request | 1, no request |
| `createHandler` lines | 428 | ≤ 200 |
| `web()` middleware lines | 252 | ≤ 180 |
| `WebRequestContext` fields the framework reads | 26 | ≤ 12 |
| `openWebContext` calls outside request-context.ts | 50 | ≤ 20 |
| `failRun` calls | 3 | 0 |
| Session-cookie rules | 4 | 1 |
| Development-mode checks | 3 | 1 |
| Hand-written Cookie header parsers | 3 | 0 |
| Route-model access validation sites | 3 | 1 |
| `throw` / `async` in `src/effect`, `Reflect.get` in `src/` | 56 / 63 / 70 | trending down |

## Step 0 — Start clean and pin current behaviour (done)

- The fixes from the first review landed first (`c15aabd`, `a9cb222`,
  `fc6f042`).
- `scripts/pipeline-measures.ts` prints the counted measures.
- `tests/effect/run.test.ts` now also pins, for jobs:
  - setupWeb's database built from the run's bindings, with testEnv's
    database in its place;
  - `web.services` app services built once, and request services built for
    each run and each queue message;
  - background work finishing before `run` resolves when there is no Worker
    execution context;
  - `routes.run` on a stack composed by hand (`web`, `webServices`,
    `effectBridge`, `effectRoutes`).

  `EnvInvalid` and the sign-in storage error were already pinned
  (`tests/env.test.ts:197`, `tests/effect/sign-in-limits.test.ts:573`).
- **Found a bug.** `run` releases the scoped services a builder is provided
  when the job's Effect ends, so background work the job handed the Worker
  reads a released service. A route keeps them until its background work
  settles. The test is `test.failing` in `run.test.ts`; step 3 fixes it and
  drops `.failing`.
- `tests/session-cookies.test.ts` pins, for ten cookie names, four
  decisions: whether the request is someone's own (the default
  `Cache-Control`, the page cache and the route cache share this check),
  whether the session lookup asks Better Auth, whether setting the cookie
  clears Inertia's history, and whether sign-out expires it. The
  disagreements are visible there: `__Host-better-auth.session_token` and
  `myapp.session_token` start a session for the history but are no one's own
  to the cache policy, and a cookie named `notsid` makes the lookup ask
  Better Auth for `sid`.
- The route `cache` option with output added later was already pinned:
  `tests/effect/response-cache.test.ts:768-830` runs cookie-setting, flash,
  `responseHeader` and session-lookup cases against setupWeb and a
  hand-composed stack.

## Step 1 — One owner for each scattered decision

Small, mostly mechanical. 1e touches only `binding.ts` and can run in
parallel with the rest; 1a–1d share files, so run them in sequence.

**1a. Session cookies.** New `src/session-cookies.ts`, built once from
setup: Better Auth's cookie prefix (default `better-auth`, or
`advanced.cookiePrefix`) and `auth.sessionCookie`. It exposes
`isSessionCookie(name)`, `sentIn(cookieHeader)`, `statesAfter(setCookies)`
(today's `sessionCookieStates`, `endsSession` and `startsSession`) and
`logoutCookies()`. It replaces:
- `middleware.ts:390-430`, which matches a `.session_token` suffix;
- `response-cache.ts:384`, which matches the `better-auth.` prefix;
- `auth.ts:320`, which does substring matching;
- `auth.ts:1203`, the logout list.

Behaviour change (Fixed): every consumer uses the same rule. For privacy
checks, the rule must never call fewer cookies personal than today's widest
copy does. Run `verify-state-machines` (HistoryClear).

Done. `src/session-cookies.ts` holds the rule: Better Auth's cookies under
any prefix, by the `better-auth.` prefix or a `session_token`,
`session_data`, `account_data` or `dont_remember` suffix, plus registered
names, each under `__Secure-` and `__Host-`. Two departures from the
wording above:
- The privacy checks read cookie names with the module's own reader, not
  Hono's `parse`. `parse` drops a pair whose value it finds invalid, and a
  session cookie it dropped would read as a guest's.
- `betterAuthLogoutAction` cannot read `auth.sessionCookie` until step 2's
  `WebSetup` service exists. It expires Better Auth's cookies the request
  sent, and a registered name only when given it as `cookieNames`.

HistoryClear's four configs gave what the skill requires, and the replay
tests passed.

**1b. Development mode.** One `isDevelopment(env, errors)` honouring
`errors.envKey` / `devValue` (today only `handler.ts:114` does), used by
`page-cache.ts:449` and `routing.ts:439`. Behaviour change (Fixed):
development warnings follow `envKey`.

Done. `src/development.ts` holds `isDevelopment` and `declaresEnvironment`.
The error page keeps `showDevErrors` and testEnv's default on top. The page
cache runs before setupWeb copies `errors` onto the request, so setupWeb
passes `errors` to it as an `@internal` `development` option; step 2's
`WebSetup` replaces that.

**1c. Cookie header parsing.** `page-cache.ts:503`, `response-cache.ts:406`
and `middleware.ts:435` use Hono's parser: `getCookie(c)` from
`hono/cookie`, as `flash.ts` does, or `parse` from `hono/utils/cookie`
where only the header is at hand.
`getSetCookie` is always present on Workers and Bun, so drop the fallbacks at
`handler.ts:315` and `auth.ts:1163`.

Done, differently: 1a moved every privacy check onto `src/session-cookies.ts`'s
name reader, for the reason given there, so Hono's parser serves only where a
value is read and checked, as `flash.ts` does. Both `getSetCookie` fallbacks
are gone.

**1d. "Is this request personal?"** Audit `page-cache.ts:216`,
`page-cache.ts:459`, `routing.ts:448` (`hasPrivateRequestState`) and
`middleware.ts:194`. Where they ask the same question, use one predicate in
`page-cache.ts`. Where they differ on purpose, the predicate takes the
difference as a named argument. No behaviour change.

Done. `page-cache.ts` holds `carriesCredentials(c, registered?)` (an
`Authorization` header or a session cookie) and `isPersonalRequest(c)` (that,
or a visitor signed in by the session lookup or a layer).
`defaultCacheControl` is `isPersonalRequest`. The page cache asks
`carriesCredentials` with its own session-cookie names, since it runs before
the session lookup. The route cache asks `isPersonalRequest` or
`readRequestState`. `middleware.ts:194` asks a different question, whether
the page goes to a signed-in visitor, which encrypts its history, so it
stays apart. The route cache now also counts a render's `signedIn`, which
that render had already passed on as `readRequestState`.

**1e. Route-model access validation.** One
`bindingAccess(name, definition, table)` returns the compiled access or a
`RouteConfigurationError`. One `restrictedBindings(bindings, configured)`
walk finds which bindings are restricted. `assertBindingsConfig`,
`compileBindingPlan` and `assertRouteAccess` call them. The option list lives
in one constant that `lint/bindings.ts` imports, through a module with no
`effect` import so the lint plugin stays light. This was review finding 7.

Done. `bindingAccess(name, definition, table?)` returns the compiled access
or the error; setup throws it with its hint, `compileBindingPlan` as it is.
`compileBindingPlan` runs the registration's `routeAccess` walk instead of
its own, since a stack composed by hand can reach it unchecked.
`src/binding-access.ts` holds the option names for `binding.ts` and
`lint/bindings.ts`. `hasColumn`, a copy of `isColumnProperty`, is gone.

Done when the measures for 1a–1e hit their targets and the step 0 matrix
shows only the intended changes.

## Step 2 — App settings leave the request

`setupWeb` builds one immutable `WebSetup` value: error boundary, sign-in and
home paths, body limit, schema, bindings, pages, shared, flash, session
cookies (1a), history, version. It provides it as a `WebSetup` service in the
app layer, and middleware closes over it.

- Internal readers stop reading `openWebContext(c).x ?? default`. The
  defaults (`'/login'`, `DEFAULT_BODY_LIMIT`, ...) live in one
  `webSetup(config)` constructor.
- `effectBridge(config)` and `effectRoutes(app)` build a `WebSetup` from
  their own config through the same constructor, so hand-composed stacks get
  the same defaults.
- Delete the internal plumbing: `setEffectBridgeConfig`,
  `getEffectBridgeConfig`, `getEffectSchema`, `getEffectBindings`, the
  `declaredBindings` WeakMap and the three-way
  `bridgeConfig?.x ?? getEffectX(c)` reads in `createHandler`. Keep any of
  these that are exported, as thin readers.
- `errorBoundary`, `signInPath`, `homePath`, `bodyLimit`, `schema`,
  `bindings` and `bridgeConfig` on `WebRequestContext` are still written,
  marked `@deprecated`, and read by nothing in `src/`.

Done when no file in `src/` reads those fields, and the per-route values that
depend only on setup (model bindings, the params schema, guarded bindings,
purge tables) are computed at registration instead of on every request.

Done, with one departure. `src/web-setup.ts` holds `WebSetup`, its
`webSetup(options)` constructor with every default, `setupOf(c)` and the
`WebSetupService`. setupWeb builds one and its first middleware hands each
request the same value, before the page cache. A stack composed by hand
passes its settings between middleware through the request:
`loadUser({ sessionCookie })` tells `web()` and the page cache, and
`effectBridge({ schema, bindings })` tells the routes. So in 1.x the request
carries one reference to the immutable setup, not closures; `setupOf` builds
a hand-composed stack's value from what its middleware registered. Closing
over it everywhere waits for 2.0, when the hand-composition exports go.
- The error boundary, the bridge's body limit, the routes, `web()`'s
  history clear and the page cache read `setupOf(c)`. The copied fields are
  still written, marked `@deprecated`, and read only by `setupOf`'s
  hand-composed fallback.
- `pageCache`'s `@internal` `development` option from 1b is gone.
- `betterAuthLogoutAction` reads `WebSetupService`, so sign-out's fallback
  expires `auth.sessionCookie`'s name.
- `getEffectSchema` and `getEffectBindings` are gone.
  `setEffectBridgeConfig` stays until step 3 rewrites the bridge.
- A route works out its model bindings, params schema and guarded bindings
  on its first request, not on every one. Registration can't do it: a
  hand-composed stack gives effectBridge its bindings, which only a request
  carries.

## Step 3 — One services factory; jobs stop faking requests

New internal module `src/effect/services-layer.ts`:

- `appRuntime(setup)`: once per isolate, from `config.app` and the bindings
  configuration. Keep today's rule that a failed build isn't kept.
- `requestServices(setup, c)`: a Layer, not middleware:
  - `DatabaseService` from `database(c)`, or testEnv's database;
  - `AuthService` from `auth.client(c, { db, backgroundTasks })`;
  - `SignInLimits`.
  - The env check and the sign-in limits' storage check become failures of
    this layer (`EnvInvalid` and the storage error), not `throw` plus
    `failRun`.
  - `web.services({ request })` stays lazy: built only when an action runs.
- `httpServices(c)`: only the services that need a Hono request:
  `RequestService`, `RequestStateService`, `PageService`, `CookieService`,
  `ResponseHeaders`, `ResponseFactoryService`.

Then:

- **Routed requests build one runtime.** `createHandler` composes app context
  + request services + HTTP services + route layers + test services, and runs
  them under one `ManagedRuntime`. That runtime keeps today's lifetime: scoped
  services live until background work settles. `effectBridge` stops building
  a runtime eagerly. It builds one lazily only for code that asks:
  `getEffectRuntime`, shared props, testEnv's signed-in user.
- **Jobs run directly.** `routes.run(effect, env, ctx)` builds a Hono
  `Context` with `new Context(new Request('http://localhost/'), { env,
  executionCtx })` (Hono exports the class). That context exists only to feed
  the `(c) => …` factories. `run` provides the app runtime's context,
  request services and the builder's layers, runs with `runPromiseExit`, and
  runs purges in the same Effect. `scheduled` and `queue` call it. The queue
  builds the app layer once per batch and keeps each message's run isolated.
- **Delete** `RUN_PATH`, `installRunner`, `runJobs`, `appsWithRunner`,
  `failRun` and its three callers, the 204 check, and the "Register catch-all
  routes after setupWeb" error. Update `docs/background.md`.
- **Compatibility.** A builder from `effectRoutes(app)` with no setup has no
  factory to call. For those hand-composed stacks, `run` keeps the request
  path until 2.0, behind one function that only they reach.
- **Job types (decision).** `RunCheck` checks against job services, which are
  the route services minus the HTTP services above. Code that calls
  `validateRequest`, `authorize`, `json` or `render` in a job compiles today
  and fails at run time against the fake request. See "Decisions" for whether
  this ships in 1.x.

Done when a routed request makes one `ManagedRuntime.make`, a job makes one
and fetches nothing, and `failRun` is gone. `run.test.ts` and the background
tests must pass, with the scoped-service lifetime test's `.failing` dropped:
a job's runtime owns its builder's layers until its background work settles,
as a route's does.

Done, in a different shape than the plan above:
- **No `services-layer.ts`.** The bridge's `requestServicesFactory` builds
  each request's layer: app runtime context, request services, Config. The
  app runtime is still built once per isolate, and a failed build is still
  not kept. `createEffectBridge(config)` gives `{ middleware, prepare }`,
  and `effectBridge` is its middleware.
  - `prepare(c)` records the layer as `requestLayer` and builds testEnv's
    services once, in a scope of the request's own. It returns what
    releases them once background work settles (`disposeAfterBackground`).
  - `ctx.runtime` became a getter that builds a runtime only when read, and
    is deprecated.
- **Database and auth stay in setupWeb.** The session lookup is middleware
  and needs auth before the route runs, so they could not move into a
  Layer. `prepareServices(c)` builds them and returns the env or storage
  failure instead of throwing. The middleware throws it; a job rejects
  with it.
- **One runtime per routed request.** The route builds it from
  `requestLayer`, then its own layers, then testEnv's services.
- **Jobs.** setupWeb declares `prepareJob` with `declareAppJobs`. `run`
  builds a Hono `Context`, readies the services through `prepareJob`, and
  builds one runtime from them and the builder's layers. It runs the job
  and its purges, and releases everything after background work settles.
  The lifetime test passes without `.failing`.
  - A job runs through no HTTP middleware, the application's included. A
    test pins it, and the CHANGELOG says so.
- **Hand-composed stacks keep `runThroughRequest`**, the old route, the
  `runJobs` WeakMap and `failRun` (decision 3). So `failRun` has one call
  left, in the route's purge, not none.
- **Decision 1 is not taken yet**: jobs still type-check against the
  request-only services.

Measures: `ManagedRuntime.make` sites 3 -> 4, but per request 2 -> 1 and per
job 2 plus a fake request -> 1. The four sites are the app runtime (once per
isolate), the route, the job and the deprecated getter. `failRun` calls 3 ->
1. Disable directives stay at 80.

## Step 4 — One owner for response output

New `src/effect/response-output.ts`: a per-request `ResponseOutput` holding
application cookies, the session lookup's cookies, added headers and the
flash commit. It exposes `cookie`, `header`, `sessionLookupCookies` and
`applyTo(response)`. The rules about which cookies win (a response's own over
the session lookup's renewal) and their order live here, once.

- The route handler applies output and commits flash before its cache
  policy, which then reads the finished response: a `Set-Cookie` means
  private. Delete `withDeferredOutput` (`routing.ts:480-506`) and
  `flash.setsCookie`.
- `web()` applies output only to responses no route finished: plain Hono
  handlers, Better Auth's handler, middleware errors. The output records
  whether it has been applied. `answeredCookies` reads the output's ordered
  list instead of rebuilding the order. `web()` copies the response at most
  once.
- `responseCookies`, `sessionLookupCookies`, `responseHeaders` and `flash`
  on `WebRequestContext` are mirrored and marked `@deprecated`.
- Run `verify-state-machines` (Flash, HistoryClear).

Done when `withDeferredOutput` and `setsCookie` are gone, and the step 0
cache-option tests and the flash, middleware, render-options and security
tests pass.

Done. `src/response-output.ts` owns what a response carries beside its
body:
- `queueCookie`, `queueSessionLookupCookies` and `queueHeader` are the only
  writers, called by the cookie jar, the session lookup and
  `ResponseHeaders`.
- `finishResponse(c, response)` finishes a response once, in order: an
  Inertia visit's followable redirect (302 to 303, another site to 409,
  each keeping the response's cookies), the history clear, then the flash
  cookie, the app's cookies, the lookup's cookies the response doesn't set,
  and the queued headers, copying the headers at most once.
- The route finishes its response before its cache option reads it, and
  `web()` finishes only what no route did. A test plants the bug of
  finishing twice.
- `withDeferredOutput`, `PER_RECIPIENT_HEADERS` and `flash.setsCookie` are
  gone. Flash gives `cookie(status)`, and `commit` is a wrapper over it.
  `web()`'s own copies of the redirect and cookie helpers are gone.

One departure: the three queue fields stay as the module's storage, not
deprecated mirrors of a new object. Only `historyCleared` and `finished`
are new, as `ctx.output`. `HistoryClear` and `Flash` were re-run and give
what the skill requires.

## Step 5 — Route models become an Effect owned by `binding.ts`

- `routeModels(plan)` in `binding.ts` returns the Layer providing
  `BoundModels`, `RouteRecords` and `GuardVerdicts`. It is written with
  `Effect.gen` and reads through `dbQuery`. It decodes with
  `S.decodeUnknownExit` instead of `Effect.runPromise` (`binding.ts:906-923`,
  `routing.ts:891`, `auth.ts:350`). Failures are yielded, not thrown and
  caught again by `instanceof`.
- The access SQL (`routing.ts:996-1011`), the guard-ordering state (the
  `decided` set and the loading lock) and record tags move with it.
  `binding.ts` owns who may load a record. Routing imports one function
  instead of twelve internals.
- One parameter decode. `ensureParams` and the per-request
  `inferParamsSchema` go, and the public `params` option runs through the
  same path. Behaviour change (decision): a malformed parameter answers the
  framework's `NotFoundError` (error page or JSON envelope) instead of Hono's
  `c.notFound()`.
- A failed binding query keeps answering 500, now as a `DatabaseError` with a
  span, piped through `Effect.orDie`.

Done when `resolveBindings` and `loadModels` are gone from `routing.ts`,
`createHandler` is about 250 lines or fewer, and the binding, guard,
route-model, security and fuzz (`leaks`, `strangerWrites`) tests pass.

Done, in `src/effect/route-models.ts` beside `binding.ts`, not inside it:
`binding.ts` already holds 1,200 lines of configuration and compilation.
- The module holds `RouteRecords`, `routeModelsOnce` (now also the
  compiled plan, memoised, as an Effect) and `routeModelsLayer(request)`.
  That layer gives `BoundModels`, `RouteRecords` and `GuardVerdicts`, with
  the `decided` set, the loading lock and the positions it needs.
- `loadRecords` is the old `resolveBindings` as an `Effect.gen`. It decodes
  the param with `S.decodeUnknownOption`, adds the access SQL to the same
  query, reads through `dbQuery` (a failure is a `DatabaseError` defect),
  and decodes the row with `decodeBoundRow`, now an Effect. 404, 401 and
  configuration failures are yielded, not thrown and caught again.
- `routing.ts` imports three names from it and none of `binding.ts`'s
  loader internals. `decodeBindingParam` is gone.
- Planting the access filter's removal fails 12 security, binding, guard
  and fuzz tests.

Decision 2 is not taken: `ensureParams` still answers a malformed
parameter with Hono's 404, its params schema now worked out once per
route.

## Step 6 — Cache policy has one recorder and one finisher

- `finishRouteResponse(response, option, facts)` in `response-cache.ts`
  handles `'no-store'`, `'private'` and the object form, including the
  development warning. `createHandler` calls it once and ends there,
  reaching the ≤ 200-line target.
- One privacy recorder replaces `markPageDynamic`, `markRouteCacheDynamic`,
  `keepPageOutOfCache` and the flags `readRequestState`, `signedIn`,
  `cacheControlByDefault` and `pageCache.dynamic`: `observe(reason)`, with
  reasons such as request state, signed in, guard, middleware and database.
  The page cache, the route cache and the default `Cache-Control` each decide
  from the recorded reasons. `markPageDynamic` stays exported, as
  `observe('application')`.
- This step carries the most leak risk, so it goes last. Run
  `verify-state-machines` (the page version check), the page-cache,
  response-cache and `tests/security/production.test.ts` suites, and the
  fuzz suite with a raised run count.

Done when `WebRequestContext` keeps one cache field, `page-cache.ts` exports
are back near 1.0's 11 (plus the kept wrappers), and every step 0 test still
passes.

Done:
- **One recorder.** `src/privacy.ts` holds `recordPrivacy(c, reason)`,
  `keptFrom(c, 'page' | 'route')` and `renderedSignedIn(c)`, with one table
  of what each reason keeps out:
  - `request` (a header, the raw request, request state, `markPageDynamic`):
    the page and route caches;
  - `setup` (setupWeb's database factory, the app's middleware): the route
    cache only;
  - `guard` and `data`: the page cache only;
  - `signed-in`: both, and the default `Cache-Control` says `no-store`.
  That is exactly what the five flags did.
- **What it replaced.** `markRouteCacheDynamic` and `keepPageOutOfCache`
  are gone, and `observedRequestContext` takes a reason. `markPageDynamic`
  stays exported, as `request`. `signedIn`, `readRequestState` and the page
  cache's `dynamic` are deprecated mirrors that the framework reads nowhere.
- **`cacheControlByDefault` stays.** It says whether `privateByDefault` is
  installed, which is not a reason a response is private.
- **One finisher.** `applyRouteCacheOption(response, option, facts)` in
  `response-cache.ts` applies `no-store`, `private` and the object form.
  `recordingTags`, `routePurgesOf` and `purgingOnSuccess` took the purge and
  record-tag composition out of `createHandler`, which is now 175 lines.
- **Plants.** Taking any reason out of the table fails a test: request 9,
  setup 1, guard 2, data 4. `signed-in` failed none until
  `tests/privacy.test.ts` pinned it. A page rendered to a visitor signed in
  by a route's own layer, as an API key's would be, must stay out of the
  page cache. That test passes on HEAD's code too, so it pins existing
  behaviour.
- **Checks.** The fuzz suite ran at 20,000 runs with a random seed, and
  HistoryClear's four configs gave what the skill requires. The page
  version check is untouched.

## Step 7 — Effect-way cleanups

Independent and small. Any order after step 3.

- `background()` uses a request-scoped `FiberSet`, replacing the
  `Set<Promise>`, the drain loop and the second tracker
  (`bridge.ts:364-462`).
- The error boundary matches `AppError` exhaustively (`Match.valueTags` or
  `catchTags` inside the Effect), so a new error type must be answered. It
  passes the structured error as a value instead of through the
  `structuredErrorsByCause` WeakMap (`handler.ts:467-581`).
- The sign-in limits' statements go through `dbQuery` / `dbMutation`.
- `expiresTheCookie` takes `now` from the request's Effect `Clock`, so
  `testClock()` moves it.

Done in part. Two items are done, two are not:
- **Error boundary: done.** `handler.ts` holds an `ANSWERS` table keyed by
  every `AppError` tag (auth redirect, form, sign in, retry after, its own
  body, redirect, error page), and the boundary dispatches on it. Taking
  one entry out of the table fails `tsc`. The `structuredErrorsByCause`
  WeakMap and `getStructuredFromThrown` are gone: `renderErrorResponse`
  takes the structured error as an argument.
- **Sign-in limits: done.** The four statements run through `dbQuery` and
  `dbMutation` (`readCounts`, `writeCounts`), each still one statement.
  SignInLimits' configs gave what the skill requires, and its line
  references are current again; they had drifted before this step.
- **Cookie expiry: not changed, on purpose.** Better Auth writes `Expires`
  from the real clock and the browser judges it by its own. Reading
  Effect's `Clock` would make a test that moves `testClock()` see live
  sessions end and raise a false history clear. The reason is recorded at
  the function.
- **Background `FiberSet`: not done.** `FiberSet.make` needs a `Scope`, but
  the supervisor is built outside Effect, before any runtime, because
  Better Auth's `waitUntil` hook needs it. It also tracks raw promises,
  which a FiberSet cannot hold. The change would add `runSync` scaffolding
  and keep the promise tracker, which is no simpler than the tested
  supervisor. Worth revisiting in 2.0, if the hand-composition exports go
  and the supervisor can live in the request's runtime.

## Decisions for the owner

1. **Job types in 1.x?** Taking request-only services away from `run`,
   `scheduled` and `queue` breaks compilation only of jobs that already fail
   at run time. Recommendation: ship it in 1.x as a fix, with an UPGRADING
   note.

   Taken on 2026-11-02: in 1.x. `RunCheck` refuses `RequestService`,
   `RequestStateService`, `PageService`, `ResponseFactoryService`,
   `CookieService` and `ResponseHeaders` with `requestOnlyServices` and a
   fix. `tests/worker-types.ts` pins it for `validateRequest`, `render`,
   `json` and a cookie's `set`; on the types before, those jobs compiled.
   The CHANGELOG's paragraph on what an application may need to change says
   so.
2. **Malformed route parameters answer `NotFoundError`** (step 5) instead of
   Hono's bare 404. Recommendation: yes, as a fix; it matches every other 404.
3. **Hand-composed `routes.run`.** Keep the request path for builders without
   a setup until 2.0 (recommended), or drop it in 1.x.

## Not in this plan (2.0 or separate work)

- Service methods returning Effects (`PageRenderer.render`, `CookieJar.set`,
  `RequestContext.json`).
- Removing the hand-composition exports, and narrowing `WebRequestContext` to
  `authUser`.
- Making the default page cache opt-in.
- The Action-pattern API items: naming the task/adapter split
  (`action(form(Schema), handler)`), one way to say where a failed form goes,
  `jsonApi()` only for endpoint contracts, a typed queue producer
  (`job(name, Schema, handle)`), and fixing `docs/testing.md:57`'s claim that
  a page action runs directly under `Effect.provide`.
- `defineEnv` schemas reaching Effect `Config`.
- Moving the fence to its own package.

## Releases

Steps 0–3 can ship as 1.11 and steps 4–7 as 1.12. Each gets a CHANGELOG
section listing its Fixed behaviour changes, and the dogfood apps re-run
against the packed tarball before release.
