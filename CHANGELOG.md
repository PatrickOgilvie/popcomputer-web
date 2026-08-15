# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0-rc.1] - 2026-08-15

### Added

- **Effect-native Better Auth boundary**: `effectifyBetterAuth(auth)` mirrors the concrete, plugin-aware `auth.api` with Effect-returning endpoints while retaining the original argument and success types. Better Auth API failures are normalized into a typed failure union, and `raw` remains an explicit escape hatch.
- **Better Auth background-task ownership**: Auth factories receive a `backgroundTasks` service compatible with Better Auth's `advanced.backgroundTasks`. Cloudflare requests use `waitUntil`; local and test requests drain the promises before their scoped runtime is released.

### Changed

- **Effect 4 runtime and schema model**: The package now requires Effect 4 (`4.0.0-rc.109`) and uses its `Context.Service`, flattened `Cause`, managed-runtime `Exit`, and rewritten Schema APIs throughout source, generated code, and tests.

### Breaking

- **Effect 3 is no longer supported**: Applications must upgrade their Effect dependency and Effect-facing schemas, services, layers, and handlers to Effect 4. This release targets Effect `4.0.0-rc.109` and is therefore published as a prerelease.

### Fixed

- **Rejected auth responses preserve Better Auth headers**: Verified headers accumulated in resolved error responses or Better Auth `APIError` metadata now survive typed error mapping and the shared HTTP error renderer, with `Set-Cookie` values appended safely and framework representation headers retained. Thrown Better Auth redirects preserve their status, `Location`, and cookies instead of becoming 502 responses. APIError verification requires a valid numeric `statusCode`, so unverified thrown objects cannot inject response headers.
- **Better Auth façade protocol fidelity**: Explicit `asResponse: true` calls retain raw error responses in the success channel, and plugin domain results with a numeric `status` are only treated as HTTP envelopes when they also carry `headers` or `response`. Proxy reflection now reports only real endpoints and enumerates them consistently.
- **Pre-bridge background cleanup**: Auth promises are drained even when session loading or other middleware fails before the Effect bridge is reached.

## [0.3.0] - 2026-08-10

### Added

- **`@popcomputer/web` package identity**: The framework now publishes under the Popcomputer npm organization while remaining in Patrick Ogilvie's personal GitHub account. The package exposes the `popweb` executable and scoped subpath imports such as `@popcomputer/web/effect`.
- **Clean public names**: `setupWeb`, `web`, `webContext`, `webServices`, `PageService`, `PageRenderer`, and the `Web*Type` augmentation interfaces are the canonical API. Deprecated Honertia-named aliases remain in 0.3 to support controlled source migration.
- **Declarative, fail-closed route model binding**: Every binding now registers an Effect Schema in top-level `setupWeb({ bindings })`. Lookup parameters and database rows are parsed before `bound()` can expose them. Nested bindings must have a relationship discoverable from Drizzle metadata or an explicit `routeBinding(schema, { scope })`; an ambiguous child route now fails with a configuration error instead of silently querying without its parent constraint.
- **Precise database dependency failures**: `dbMutation` and `dbTransaction` now fail with tagged `DatabaseMutationFailed`, `DatabaseTransactionFailed`, or `DatabaseConstraintViolation` values. Common PostgreSQL, MySQL, and SQLite constraint codes are classified at the exception boundary, enabling narrow `Effect.catchTag` recovery without a broad `Error` channel.
- **Runtime-owned background Effects**: `background(operation, effect)` preserves the request Effect context, uses Cloudflare `waitUntil`, keeps the runtime alive until scheduled work settles, and reports failures to `EffectErrorObserverService` with the operation name. Non-Worker runtimes execute the work inline rather than dropping it.
- **Application-owned route metadata**: Each Hono app now owns its `RouteRegistry`. The `routes`, `check`, and `generate:openapi` commands load the selected application with `--app <entrypoint>`, removing correctness dependence on process-global registration state.

### Changed

- **One flat application setup and error boundary**: `setupWeb(app, config)` installs the middleware stack, Effect bridge, not-found renderer, and Hono error handler together, and returns `{ app, routes }`. `version`, `render`, `database`, `schema`, and `bindings` are top-level fields rather than being nested under another framework-named object. Typed failures, defects, plain Hono exceptions, and 404s share the same environment detection, redaction, rendering, status, logging, and observation policy.
- **One owner for each setup concern**: The setup root owns the renderer, database, schema, and route bindings; `auth` owns auth construction, session parsing, cookies, and public projection; `effect` owns only custom Effect services. This removes silent precedence between duplicate configuration sources while preserving schema and binding overrides on standalone `effectBridge()` and `effectRoutes()` composition seams.
- **Migration tracking rename without replay risk**: `popweb` writes `.popweb-applied.json` and falls back to reading `.honertia-applied.json`, so existing projects do not rediscover already-applied migrations.
- **One application-owned Effect runtime**: Effect is now a peer dependency aligned with `@popcomputer/document-graph`, preventing duplicate Context tag and runtime identities when both packages are installed in one application.
- **Authentication is parsed and safe by default**: `auth.client`, `auth.session`, and `auth.share` make the session boundary and public projection explicit. A null provider result means anonymous, provider exceptions become `SessionLookupUnavailable`, malformed sessions become `InvalidAuthSession`, and the default shared user is limited to `id`, `name`, and `image`.

### Breaking

- The npm package changes from `honertia` to `@popcomputer/web`; all package and subpath imports must use the new scoped name.
- The CLI executable changes from `honertia` to `popweb`.
- The canonical setup shape changes from `setupHonertia({ honertia: { version, render, ... } })` to flat `setupWeb({ version, render, ... })`.
- Route-model bindings backed by a database require a registered row parser. Nested bindings without provable or explicit scope no longer run unscoped.
- `effect.schema` and `effect.bindings` are not accepted by `setupWeb()`. Move them to top-level `schema` and `bindings` respectively.
- CLI route introspection requires `--app <entrypoint>` unless a registry is supplied through the programmatic API.
- Inertia error pages preserve the structured HTTP status instead of coercing failures to 200.

## [0.2.1] - 2026-08-02

### Changed

- **`setupHonertia()` now models database presence in its configuration type**: With the standard Honertia module augmentations, bindings, database, auth, and custom Effect services are inferred from `setupHonertia({...})` without explicit generics. The supported use cases are explicit:
  - **Database-backed auth**: Configure `database` and `auth`; the auth factory receives a required, inferred `db`. This is the normal Better Auth setup for persistent users, accounts, sessions, verification records, and database-dependent plugins. Application-side non-null assertions and impossible `db === undefined` guards are no longer needed.
  - **Stateless auth**: Configure `auth` without `database`; the auth factory receives only the request context. This supports Better Auth's intentional signed/encrypted-cookie mode without presenting a meaningless `db: undefined` service.
  - **Database without auth**: Configure `database` alone for applications that need persistence but no authentication.
  - **Neither database nor auth**: Configure only Honertia's core renderer and version for public or otherwise stateless applications.
  - **Migration from the 0.2.0 demo API**: Remove placeholder generic arguments such as `setupHonertia<Env, unknown, unknown, Services>(...)` and call `setupHonertia({...})`; the configured factories and service layer now supply those types. Explicit `unknown` no longer stands in for an absent database because database presence is represented deliberately rather than ambiguously.
- **Default console error output never contains raw `Error` objects**: `createErrorHandlers()` no longer writes raw `Error` objects to `console.error` in production. Explicit development environments retain structured terminal diagnostics; production emits a single-line, client-safe structured projection (code, tag, category, HTTP status, request id — with sensitive messages replaced) so platform logs such as `wrangler tail` keep a correlation signal. Full-detail production reporting belongs in `EffectErrorObserverService` or another configured telemetry sink.
- **Better Auth compatibility is tested against 1.6.25 and capped below 2.0**: Honertia's development dependency is pinned for reproducible integration tests, Drizzle test and demo dependencies are aligned with Better Auth's `^0.45.2` peer, and the optional Better Auth peer range continues to support 1.x without silently accepting a future breaking major.
- **The Effect-first error and observability contract is now explicit**: Expected application failures belong in Effect's typed error channel; defects thrown inside `effectHandler` or `effectRoutes` are observed by `EffectErrorObserverService`; exceptions from plain Hono handlers or middleware are rendered safely but remain outside that observer's reporting guarantee. Direct plain-Hono business handlers are documented as an anti-pattern, while framework middleware remains a supported boundary.

### Fixed

- **`betterAuthFormAction()` now handles resolved Better Auth error responses**: Better Auth 1.6 returns `Response` objects for server API calls that include a `Request`, including expected 401/422 login and registration failures. Honertia now normalizes thrown API errors, resolved HTTP error responses, and status envelopes before deciding whether to redirect. Verified Better Auth 4xx request rejections enter the existing `ValidationError` form-rendering path with typed `status`, `code`, and `message`; auth rate limits become `AuthRateLimitError` with a real 429 response and `Retry-After` guidance; 5xx and unknown dependency failures become safe `HttpError` values. Auth and error mapper callbacks also use the configured `AuthType` and exported `BetterAuthActionError`, removing application-side casts.

### Security

- **The external-error-reporting example no longer serializes raw errors**: Documentation now demonstrates an allowlisted structured telemetry projection instead of forwarding `event.error.message` and arbitrary metadata.
- **Unknown Better Auth dependency failures can no longer become client-visible validation messages**: Only resolved Better Auth error results or thrown `APIError` instances carrying a valid HTTP status are eligible for form error mapping. Arbitrary thrown objects with `message`, `code`, or `status` fields are classified as authentication-service failures, so database, network, and provider diagnostics cannot be rendered into production form errors.

## [0.2.0] - 2026-08-01

### Security

- **Nested route-model binding parent scoping is now enforced**: For a nested binding like `/workspaces/{workspace}/api-keys/{apiKey}`, the child lookup is now correctly constrained to the resolved parent (`WHERE id = ? AND workspace_id = ?`). Previously the parent constraint was **silently dropped** for every real-world schema: relation introspection stubbed Drizzle's `relations()` helpers and always threw internally (swallowed by a bare `catch`), and even the intended path indexed tables by SQL column name (`workspace_id`) where Drizzle keys them by JS property name (`workspaceId`). The child therefore resolved globally by id — a cross-tenant IDOR for any handler that trusted the bound model. Foreign keys are now discovered from the child table's inline `.references()` metadata first, then from `relations()` definitions evaluated with Drizzle's real helpers, and all lookups use JS property keys. Composite relations apply every child/parent column pair atomically rather than scoping by only the first pair. Regression-tested against the idiomatic camelCase-key / snake_case-column shape and composite tenant/parent relations on real SQLite tables.
- **Production JSON errors use an explicit client-safe projection**: `JsonErrorFormatter` now accepts a `safeMessages` option (enabled on the production formatters wired by `createErrorHandlers` and the Effect handler). When on, every 5xx message is replaced with a generic string regardless of category, 5xx `HttpError` bodies and unknown extensions are omitted, and validation details exclude the rejected input value while retaining useful field messages and paths. Previously, 5xx errors categorized as `http`, caller-provided bodies, and raw validation values (including passwords or tokens) could be serialized back to API/JSON clients. The message scrubbing logic is shared via `getClientSafeMessage()` so the JSON and Inertia paths cannot drift.
- **`CF_PAGES_BRANCH` no longer implies development mode**: Dev-mode detection in the Effect handler and `detectOutputFormat()` now requires an explicit `ENVIRONMENT=development` / `NODE_ENV=development`. `CF_PAGES_BRANCH` is set on *all* Cloudflare Pages deployments, including production, so keying dev errors off it exposed stack traces, source locations, and raw messages on production Pages sites. Pages previews that want verbose errors should set `ENVIRONMENT=development`.

### Added

- **First-class Cloudflare Workers Cache support**: A declarative `cache` route option emits correct Workers Cache headers with Inertia-aware guard rails — `Cache-Control: public, max-age=…[, stale-while-revalidate=…]` plus `Vary: X-Inertia` on successful GET/HEAD responses only; partial reloads are marked `no-store`; a handler's own stricter `Cache-Control` (`no-store`, `private`, `no-cache`) always wins over the route option; responses that set cookies are never publicly cached; and private requests — an `Authorization` header, a loaded `authUser`, or a Honertia-known session cookie (better-auth's cookies plus any `loadUser({ sessionCookie })` name) — are never publicly cached, with a once-per-route dev warning. Unrelated cookies (analytics, consent) do not disable caching. Bound routes automatically derive `Cache-Tag` values from their bindings (`project:123,projects`), and a `purges` option on mutating routes purges those same derived tags (or explicit ones) after success via the new `ResponseCacheService` — a typed client probing both documented runtime surfaces (`ctx.cache` and `cloudflare:workers`) that no-ops (with `isAvailable: false`) where the purge API is unavailable — including current dev/preview runtimes; programmatic purge is a staged platform capability until Cloudflare's rollout completes (cache headers and tags work everywhere today). On a cache hit the Worker never runs: zero CPU, no Effect runtime construction, no binding queries. Requires `"cache": { "enabled": true }` in wrangler config.
- **Typed request context (`honertiaContext` / `honertiaServices`)**: Framework per-request state (db, auth, authenticated user, renderer instance, Effect runtime wiring) now lives in one typed `HonertiaRequestContext` instead of ad-hoc string keys on Hono's context. Plain Hono middleware reads it with `honertiaContext(c)` (e.g. `const { authUser, db } = honertiaContext(c)`), and apps composing middleware manually wire services with `app.use('*', honertiaServices((c) => ({ db, auth })))` instead of hand-rolled `c.set('db', ...)`. `c.var.honertia` remains the supported public rendering API for plain Hono handlers.
- **`verifyOrigin()` middleware (opt-in CSRF defense-in-depth)**: Verifies the `Origin` (falling back to `Referer`) of state-changing requests against the request's own origin plus an optional allowlist. Wire it via `setupHonertia({ security: { verifyOrigin: { ... } } })` or `app.use('*', verifyOrigin(...))`. Header-less requests (native apps, server-to-server) are allowed by default; set `requireOrigin: true` for a strict browser-only surface.
- **Configurable shared-user projection**: `shareAuth(config)`, `shareAuthMiddleware(config)`, and `setupHonertia({ auth: { shareFields, mapSharedUser } })` can now limit which user fields are serialized to the client as `auth.user`. Previously the entire user record (email, admin flags, …) was embedded in every page payload.
- **`parseOptions` for validation (mass-assignment hardening)**: `validateRequest`, `validate`, and `validateUnknown` accept a `parseOptions` option, and route-level `body`/`query` validation accepts `parseOptions` in `EffectRouteOptions`. Pass `{ onExcessProperty: 'error' }` to reject request payloads carrying fields the schema does not declare (422 `ValidationError` naming the offending field) instead of silently discarding them. The default remains Effect Schema's `ignore`.
- **`RequestStateService` — request-scoped state shared with Hono middleware**: A new base service backed by Hono's context variables (`c.set`/`c.var`). An Effect action can publish a value (e.g. a verified API key's environment) that wrapping Hono middleware reads after `next()`, and can read values middleware set before the route ran — no more duplicate lookups on either side of the Effect boundary.
- **`prefixMiddleware()` on the route builder**: Attaches Hono middleware to the builder's whole prefix **including unmatched paths**, so cross-cutting response policy (error redaction, envelope shaping, security headers) also applies to 404s. Per-route `.middleware()` only runs when a route matches; a request to an unknown path under the prefix previously bypassed it entirely.

### Changed

- **`shareAuth` is now a factory** (`shareAuth()` instead of `shareAuth`). Calling it with no arguments preserves the previous full-user behavior. **Breaking** for code that referenced `shareAuth` as an `Effect` value directly.
- **`findRelation` is now async and returns complete JS-property column pairs**: It dynamically imports `drizzle-orm` and resolves `{ columnPairs: [{ foreignKey, references }, ...] }` as JS property keys (`workspaceId`) rather than SQL column names (`workspace_id`). Composite relations include every pair. **Breaking** for code that called `findRelation` directly.
- **Nested bindings that can now be scoped return 404 for cross-parent children**: Requests that previously (incorrectly) resolved a child belonging to a different parent now return 404. This is the security fix above viewed as a behavior change — apps that relied on the unscoped behavior for legitimate lookups should bind the child at the top level instead of nesting it.
- **`c.var.db` / `c.var.auth` / `c.var.authUser` are no longer set** (**Breaking**): Framework state moved to the typed request context — read it with `honertiaContext(c)`. Authentication construction moved from `honertia.auth: (c) => ...` (reading `c.var.db`) to top-level `auth.client: (c, { db }) => ...`. Apps wiring services manually must switch from `c.set('db', ...)` to the `honertiaServices()` middleware; providing `DatabaseService` through a custom Effect services layer is no longer supported for route model binding.
- **`userKey` / `authUserKey` options removed** (**Breaking**): `loadUser`, `shareAuthMiddleware`, `setupHonertia({ auth })`, and `effectBridge` no longer accept a configurable context key for the authenticated user; the user is published on the request context as `authUser`.
- **Unconfigured services fail at `yield*`, not at property access** (**Breaking**): `DatabaseService`/`AuthService` are provided to the Effect layer only when configured; the throwing proxy placeholders are gone. Yielding an unconfigured service is now itself a configuration error (previously, yielding without touching a property succeeded silently), rendered as the same structured `CFG_300`/`CFG_301` response with a setup hint. Routes that never yield the service are unaffected. Route model binding without a configured database now renders that configuration error instead of a misleading 404.

### Fixed

- **Partial reloads no longer evaluate filtered-out lazy shared props**: `honertia.render()` now computes the `only`/`except` partial filter before resolving shared props, so a `share(key, () => expensive())` closure that the client did not request is never invoked. Shared props overridden by an explicitly passed prop of the same name are also skipped. This restores the intended performance contract of partial/lazy props.
- **Default logout clears the `__Secure-` cookie variant**: The built-in logout handler in `effectAuthRoutes` now clears both the plain and `__Secure-` prefixed session cookie (matching `betterAuthLogoutAction`), so logout reliably revokes the cookie over HTTPS.
- **Dev warning for unscopable nested route-model bindings**: When a nested binding (e.g. `/users/{user}/posts/{post}`) cannot be scoped to its parent because no foreign key or relation is discoverable in the Drizzle schema, the child silently resolves by primary key alone — an IDOR footgun. Honertia now warns in development so the handler author adds an explicit ownership check, an inline `.references()`, or a `relations()` definition. (With the scoping fix above, this warning now only fires when the schema genuinely declares no link between the tables.)
- **Workers Cache purge rejections now fail the mutation**: The purge adapter parses Cloudflare's resolved result and requires `success: true`. A resolved `{ success: false, errors: [...] }` or malformed response now becomes `ResponseCachePurgeError` instead of being treated as success and leaving stale entries behind.
- **Cache tags now conform to Cloudflare's wire constraints**: Valid printable-ASCII tags remain unchanged; spaces, Unicode, control characters, and commas are percent-encoded identically for response headers and purges. Tags over Cloudflare's 1,024-character limit, response tag sets over 1,000 tags or 16 KB aggregate, and purge calls over 100 tags fail closed instead of sending data Cloudflare rejects or silently drops.

## [0.1.45] - 2026-04-28

### Added

- **`serializePage(page)` helper**: Added a public helper for safely embedding an Inertia page object inside a `<script type="application/json">` initial page payload. The serializer follows the approach used by `@hono/inertia`, escaping forward slashes so `</script>` sequences inside props cannot close the script element early.

### Changed

- **`createTemplate()` now uses Inertia's script-element bootstrap payload**: The default template now emits:

  ```html
  <script data-page="app" type="application/json">...</script>
  <div id="app"></div>
  ```

  instead of storing the page object in a `data-page` attribute on the root div. This aligns Honertia with the newer Inertia script-element initial page transport and avoids HTML attribute encoding for large page props.

### Fixed

- **Test utilities now parse script-element page payloads**: `parseHtmlResponse()` and the default test app renderer now understand the new initial page payload format.

## [0.1.44] - 2026-04-05

### Added

- **`EffectErrorObserverService` — optional error reporting sink**: Register a single observer in `setupHonertia({ effect: { services } })` and receive every request-time Effect failure or defect, whether handled or not. This is the main integration point for PostHog, Sentry, and similar telemetry systems.

  ```typescript
  import { EffectErrorObserverService, type EffectErrorEvent } from '@popcomputer/web/effect'

  app.use('*', setupHonertia<Env>({
    effect: {
      services: (c) =>
        Layer.succeed(EffectErrorObserverService, {
          observe: (event: EffectErrorEvent) =>
            Effect.tryPromise({ try: () => reportToSentry(event), catch: () => undefined })
              .pipe(Effect.asVoid, Effect.catch(() => Effect.void)),
        }),
    },
  }))
  ```

- **`reportEffectError(error, options?)`**: Report intentionally recovered errors to the same observer. Use this with `Effect.tapError` when you catch an error and fall back gracefully but still want it tracked. The observer always receives it as a `source: 'user'`, `handling: 'handled'` event. `metadata` is optional.

  ```typescript
  yield* Effect.tryPromise({ ... }).pipe(
    Effect.tapError((error) => reportEffectError(error, { metadata: { area: 'home' } })),
    Effect.catch(() => Effect.succeed(false))
  )
  ```

- **Error observer events for defects and the temp-runtime path**: The observer now fires for all unhandled failure paths — typed failures, structured defects, generic defects, and the fallback unknown failure path. It also fires correctly when `effectHandler` or `EffectRouteBuilder` creates its own temporary runtime (i.e. when no `effectBridge` middleware is present), by propagating `EffectBridgeConfig` through Hono context.

### Fixed

- **`ValidationError` propagation from `EffectRouteBuilder` schema validation**: Body and query validation now runs through a proper `Exit`-aware wrapper (`runValidation`) instead of bare `Effect.runPromise`. Previously, a `ValidationError` thrown during schema validation could surface as an untyped exception rather than being handled by the structured error path.

## [0.1.43] - 2026-02-18

### Changed

- **`EffectRouteBuilder.provide()` now accepts context-aware layer requirements**: `provide()` can now take layers whose input environment depends on route context services (`BaseServices`), previously provided services, or bridge-level custom services. This aligns TypeScript with existing runtime behavior for patterns like global shared Inertia props.

### Fixed

- **`provide()` layer composition now resolves cross-layer dependencies**: Previously, `.provide(layerA).provide(layerB)` where `layerB` depends on `ServiceA` from `layerA` would type-check but fail at runtime with `Service not found`. The internal composition used `Layer.merge` (parallel, no dependency resolution) instead of `Layer.provideMerge` (sequential, feeds earlier outputs into later inputs). Layers provided via chained `.provide()` calls now correctly receive services from previously provided layers.

## [0.1.42] - 2026-02-12

### Added

- **Request input source configuration for `validateRequest`**: New `request` option controls how request data is extracted and merged. Supports built-in profiles (`'legacy'`, `'laravel'`) and fine-grained control with custom merge order and conflict handling policies (`'last-wins'`, `'first-wins'`, `'error'`).
  ```typescript
  // Laravel-style: query + body only (route params excluded)
  const input = yield* validateRequest(Schema, { request: 'laravel' })

  // Custom merge order with conflict detection
  const input = yield* validateRequest(Schema, {
    request: {
      order: ['params', 'query', 'body'],
      onConflict: 'error',
    },
  })
  ```

- **Exported request validation types**: `RequestValidationSource`, `RequestValidationProfile`, `RequestValidationConflict`, `RequestValidationOptions`, and `RequestValidationConfig` are now exported from `@popcomputer/web/effect` and `honertia`.

### Changed

- **JSON content type detection now supports `+json` suffixes**: Content types like `application/vnd.api+json` are now correctly parsed as JSON when extracting request body data.

## [0.1.41] - 2026-02-06

### Added

- **`honertia` CLI binary**: The package now ships an executable. Run CLI commands directly via `bunx honertia <command>` or `npx honertia <command>`. Supports all subcommands (`routes`, `check`, `db:migrate`, `generate:action`, `generate:crud`, `generate:feature`, `generate:openapi`, `generate:tests-runner`) with grouped aliases (`honertia generate action` = `honertia generate:action`).
  ```bash
  bunx honertia routes --json
  bunx honertia generate:action projects/create --method POST
  bunx honertia db:migrate --preview
  ```

- **Scoped mutation input for `dbMutation` and `dbTransaction`**: New overloads that accept a `Validated<I> | Trusted<I>` input object. Inside the callback, database write methods only accept values carrying the matching scope brand, preventing accidental ad-hoc writes.
  ```typescript
  const txInput = asTrusted({
    createProject: { name: input.name, userId: auth.user.id },
  })

  yield* dbMutation(db, txInput, async (db, scoped) => {
    await db.insert(projects).values(scoped.createProject)
  })
  ```

- **`mergeMutationInput` helper**: Merges additional fields (e.g., transaction-derived IDs) into a scoped mutation input while preserving its scope brand. Patch keys must already exist on the scoped input shape (enforced at compile time).
  ```typescript
  const itemInsert = mergeMutationInput(scoped.createItem, { orderId: created.id })
  ```

- **`MutationInput` type export**: The `MutationInput<Scope, A>` type is now exported from `@popcomputer/web/effect` for explicit type annotations on scoped mutation objects.

- **`validateUnknown` function**: New function for validating unknown/untyped data (external JSON, raw payloads). The original `validate` now enforces compile-time typed input (`data: I`), while `validateUnknown` accepts `data: unknown`.
  ```typescript
  // Typed -- compile-time check on field names
  yield* validate(CheckoutSchema, { status: 'pending', quantity: '2' })

  // Unknown -- for raw/external payloads
  yield* validateUnknown(CheckoutSchema, someUnknownPayload)
  ```

- **`createBodyParseValidationError` export**: Constructs a detailed `ValidationError` for malformed request bodies with actionable hints and structured `fieldDetails`.

- **OpenAPI YAML output format**: The `generate:openapi` command now supports `--format yaml`. New `formatOpenApiOutput(spec, format)` function exported from `@popcomputer/web/cli`.
  ```bash
  honertia generate:openapi --output openapi.yaml --format yaml
  ```

- **CLI generators now write files to disk**: `generate:action`, `generate:crud`, `generate:feature`, `generate:openapi`, and `generate:tests-runner` now create files on disk instead of only printing output. Use `--force` to overwrite existing files.
  ```bash
  honertia generate:action projects/create --method POST --path /projects
  honertia generate:action projects/create --force  # overwrite existing
  ```

- **`authUserKey` option in `EffectBridgeConfig`**: Specify which Hono context variable key holds the authenticated user instead of the hardcoded `'authUser'`.

- **`loadUser` session cookie optimization**: The middleware now checks for the session cookie before calling `auth.api.getSession()`. If absent, the auth API call is skipped entirely.

- **Migration `-- @down` marker support**: Migration SQL files can include a `-- @down` (or `-- down` or `-- rollback`) section. The CLI parses these into separate `upStatements` and `downStatements`.
  ```sql
  CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT);
  -- @down
  DROP TABLE users;
  ```

- **DB migration tracking via JSON file**: `dbMigrate` now persists applied migration state to `.honertia-applied.json` alongside migration files.

### Changed

- **BREAKING: `CacheClient.list` now supports cursor pagination metadata**: The `list` method now accepts an optional `cursor` and returns `{ keys, list_complete, cursor }` to align with paginated backends like Cloudflare KV. All custom `CacheClient` implementations must be updated.
  ```typescript
  list(options?: { prefix?: string; cursor?: string }): Effect.Effect<{
    keys: Array<{ name: string }>
    list_complete: boolean
    cursor?: string
  }, CacheClientError>
  ```

- **BREAKING: `validate` now enforces typed input**: The `data` parameter changed from `unknown` to `I` (the schema's encoded type). Code passing untyped data must switch to `validateUnknown`.

- **SWR behavior in non-Worker environments**: When `ExecutionContextService.isAvailable` is `false`, stale entries within the SWR window are now recomputed synchronously instead of serving stale until SWR expiration.

- **Code generators scaffold `dbMutation`/`asTrusted` for mutations**: `generate:action`, `generate:crud`, and `generate:feature` now produce proper mutation patterns with `dbMutation`, `asTrusted`, and `redirect` for non-GET methods.

- **Generated inline tests use `setupHonertia` and cookie-based auth**: Tests now use the unified setup function and authenticate via session cookies instead of `X-Test-User` headers.

- **`db rollback` is now preview-only**: Running without `--preview` prints an error directing users to run the SQL manually.

- **`runGenerateOpenApi` is now async**: The function signature changed to `async function runGenerateOpenApi(...): Promise<void>`.

### Fixed

- **`cacheInvalidatePrefix` now invalidates across all pages**: Prefix invalidation now loops through paginated `list` results via cursor and deletes all matching keys, not just the first page.

- **Body parse validation errors now include actionable hints**: The `ValidationError` for malformed request bodies includes descriptive hints and populates `fieldDetails` with structured information.

- **Nested route model bindings use `and()` for compound where clauses**: Nested bindings (e.g., `/users/{user}/posts/{post}`) now use `and(eq(...), eq(...))` instead of chaining `.where()` calls, which in Drizzle replaces the previous condition.

- **Invalid regex in routes command no longer throws**: Passing an invalid regex pattern to `routesCommand` now returns an empty result with an error message instead of an unhandled exception.

## [0.1.40] - 2026-01-30

### Added

- **Cache key versioning for safe schema migrations**: New `version` option in cache functions automatically invalidates cache when schemas change. Use `version: true` for auto-hashing based on schema structure, or pass an explicit version string like `'v2'`.
  ```typescript
  // Auto-versioning: cache key becomes "a1b2c3:user:123" (schema hash prefix)
  const user = yield* cache(
    `user:${id}`,
    fetchUser(id),
    UserSchema,
    { ttl: Duration.hours(1), version: true }
  )

  // Explicit version: cache key becomes "v2:user:123"
  const user = yield* cache(
    `user:${id}`,
    fetchUser(id),
    UserSchema,
    { ttl: Duration.hours(1), version: 'v2' }
  )
  ```

- **`CacheGetOptions` type**: New options parameter for `cacheGet()` to support versioning.
  ```typescript
  const cached = yield* cacheGet(`user:${id}`, UserSchema, { version: true })
  ```

- **`CacheInvalidateOptions` type**: New options parameter for `cacheInvalidate()` to support versioned key invalidation.
  ```typescript
  yield* cacheInvalidate(`user:${id}`, { schema: UserSchema, version: true })
  ```

## [0.1.39] - 2026-01-30

### Added

- **`ExecutionContextService` for background task execution**: New service that wraps Cloudflare Workers' `waitUntil` API for running tasks after the response is sent. Provides both Effect-native `runInBackground(effect)` and raw `waitUntil(promise)` methods.
  ```typescript
  const ctx = yield* ExecutionContextService

  // Run analytics in background
  yield* ctx.runInBackground(
    Effect.tryPromise(() => fetch('https://analytics.example.com/events', {
      method: 'POST',
      body: JSON.stringify({ event: 'page_view', userId })
    }))
  )
  ```

- **Stale-while-revalidate (SWR) support for cache**: The `cache()` function now supports an optional `swr` option that returns stale values immediately while triggering a background refresh via `ExecutionContextService`.
  ```typescript
  const user = yield* cache(
    `user:${id}`,
    fetchUser(id),
    UserSchema,
    {
      ttl: Duration.hours(1),      // Fresh for 1 hour
      swr: Duration.minutes(5),    // Serve stale for 5 more minutes while refreshing
    }
  )
  ```

### Changed

- **Cache API now uses options object**: The `cache()` and `cacheSet()` functions now take an options object instead of a direct TTL parameter. This is a breaking change.
  ```typescript
  // Before
  cache(key, compute, schema, Duration.hours(1))

  // After
  cache(key, compute, schema, { ttl: Duration.hours(1) })
  ```

## [0.1.38] - 2026-01-29

### Changed

- **`AuthActionEffect` now includes `DatabaseService`**: Auth actions passed to `effectAuthRoutes` (loginAction, registerAction, logoutAction, guestActions) can now use `DatabaseService` without type errors. This enables common patterns like migrating anonymous user data during login.

## [0.1.37] - 2026-01-29

### Fixed

- **Module augmentation for `HonertiaAuthUserType` now works correctly with `authorize()`**: Previously, `authorize()` was defined in `action.ts` which imported `AuthUser` from `services.ts`. TypeScript resolved the type when processing `action.d.ts`, before user module augmentation was applied. Now `authorize()` is defined in `services.ts` alongside the `AuthUser` type, ensuring custom auth user types are correctly inferred.

## [0.1.36] - 2026-01-29

### Added

- **`createGuestLayer` factory function**: Create custom guest layers with predicates to allow certain authenticated users (e.g., anonymous users) to access guest-only pages like login/register for account upgrades.
  ```typescript
  import { createGuestLayer, effectAuthRoutes } from '@popcomputer/web/effect'

  // Allow anonymous users to access login/register to upgrade accounts
  const AllowAnonymousGuestLayer = createGuestLayer(
    (authUser) => authUser.user.isAnonymous === true
  )

  effectAuthRoutes(app, {
    guestLayer: AllowAnonymousGuestLayer,
    loginComponent: 'Auth/Login',
    registerComponent: 'Auth/Register',
  })
  ```

- **`guestLayer` option in `effectAuthRoutes`**: Replace the default `RequireGuestLayer` with a custom layer for guest-only routes (login, register, guestActions). This enables anonymous user upgrade flows with Better Auth's anonymous plugin.

## [0.1.35] - 2026-01-29

### Added

- **`.middleware()` method on `EffectRouteBuilder`**: Allows adding Hono middleware that runs before the Effect handler. Use this for middleware that needs to redirect or short-circuit requests before the Effect computation runs (e.g., auth redirects for anonymous sessions, rate limiting).
  ```typescript
  effectRoutes(app)
    .middleware(ensureAuthMiddleware)  // Runs first, can redirect
    .provide(RequireAuthLayer)         // Provides services within Effect
    .group((route) => {
      route.get('/article/{article:slug}', showArticle)
    })
  ```
  This solves the architectural gap where Hono middleware (for flow control like redirects) needed to be registered separately from Effect layers (for dependency injection).

## [0.1.34] - 2026-01-29

### Added

- **`HonertiaAuthUserType` augmentable interface**: Allows customizing the `AuthUser` type returned by `authorize()` and other auth functions via module augmentation. This enables typed access to custom user fields (like `isAnonymous`, `isAdmin`, `role`) without casting.
  ```typescript
  // In your types.d.ts
  declare module '@popcomputer/web/effect' {
    interface HonertiaAuthUserType {
      type: AuthUser // Your custom auth user type
    }
  }

  // Then use without casting
  const { user } = yield* authorize()
  user.isAnonymous // typed correctly
  ```
- **`DefaultAuthUser` interface**: The standard Better Auth user/session structure, now exported as a named interface for reference

## [0.1.33] - 2026-01-29

### Fixed

- **Route model binding now works with PostgreSQL and MySQL**: Previously, route model binding used the SQLite-specific `.get()` method which doesn't exist in PostgreSQL or MySQL Drizzle drivers. Now uses the cross-database `.limit(1)` pattern that works with all Drizzle-supported databases.

## [0.1.32] - 2026-01-17

### Added

- **CacheService**: New Effect service for caching expensive database operations with automatic serialization
  - Backed by Cloudflare KV by default, automatically provided when `c.env.KV` is available
  - Swappable for Redis, Memcached, or any custom implementation via Layer
  - `cache(key, compute, schema, ttl)` - Get from cache or compute and store with type-safe serialization
  - `cacheGet(key, schema)` - Get value from cache (returns `Option`)
  - `cacheSet(key, value, schema, ttl)` - Store value in cache
  - `cacheInvalidate(key)` - Delete a single cache key
  - `cacheInvalidatePrefix(prefix)` - Delete all keys matching a prefix (with concurrency limit)
  ```typescript
  const projects = yield* cache(
    `projects:user:${auth.user.id}`,
    Effect.tryPromise(() => db.query.projects.findMany({ where: eq(projects.userId, auth.user.id) })),
    S.Array(ProjectSchema),
    Duration.minutes(5)
  )
  ```
- **CacheClient interface**: Abstraction layer for cache implementations with `get`, `put`, `delete`, `list` methods
- **CacheClientError**: Error class for cache client operations
- **CacheError**: Tagged error for high-level cache function failures
- Comprehensive cache documentation in README with setup, usage patterns, custom implementations, and testing examples
- `@popcomputer/web/cache` export path for standalone cache imports
- 20 cache-specific tests covering all cache operations, error handling, and integration patterns

## [0.1.22] - 2026-01-09

### Added

- **Structured error system with dev/prod filtering**: Errors now include rich metadata in development (code, title, hint, fixes, source location, docs URL) while automatically hiding sensitive details in production
- **Error catalog**: Centralized error definitions with unique codes (e.g., `HON_CFG_100_DATABASE_NOT_CONFIGURED`)
- **Environment-aware error formatting**: Automatically detects development mode via `ENVIRONMENT`, `NODE_ENV`, or `CF_PAGES_BRANCH`
- **Safe message filtering**: Configuration, internal, and database errors show generic messages in production

## [0.1.21] - 2026-01-09

### Added

- **Automatic param schema inference for route model binding**:
  - Added `columnTypeToSchema` and `inferParamsSchema` utilities to `binding.ts`.
  - These functions allow automatic inference of Effect Schemas for route parameters based on Drizzle column types, enabling type-safe validation of URL params for bound models.
  - Supports UUID, integer, bigint, numeric, boolean, and string column types for validation.

## [0.1.20] - 2026-01-09

### Added

- **BindingsService**: New Effect service for accessing Cloudflare bindings (KV, D1, R2, Queues, etc.) directly from actions
  ```typescript
  const { KV } = yield* BindingsService
  const value = yield* Effect.tryPromise(() => KV.get('my-key'))
  ```
- **HonertiaBindingsType**: Module augmentation interface for typed bindings - reference the same `Bindings` type you use for Hono
- **RequestContext.env**: Access environment bindings via `request.env` in RequestService
- `HonertiaConfigurationError` for improved configuration error handling with hints

### Changed

- Simplified `setupHonertia` API - no longer requires passing a custom service type parameter just to access Cloudflare bindings
- Improved generic types on `HonertiaFullConfig` and `HonertiaSetupConfig` for better type inference of `database` and `auth` factories
- Rewrote "Custom Services" documentation to recommend `BindingsService` for simple binding access, reserving `effect.services` for complex scenarios (rate limiters, services needing initialization/mocking)
- Updated "Typed Services via Module Augmentation" section showing how to define types once and use everywhere

## [0.1.19] - 2026-01-08

### Changed

- Made the honertia config errors slightly more helpful

## [0.1.18] - 2026-01-08

### Changed

- **BREAKING**: Consolidated `setupHonertia` configuration - `database`, `auth`, and `schema` now go in the `honertia` object instead of separate config
  - Before: `setupHonertia({ honertia: {...}, effect: { database, schema } })`
  - After: `setupHonertia({ honertia: { database, auth, schema, ... } })`
- `setupHonertia` now automatically sets `c.var.db` and `c.var.auth` - no need for manual middleware
- Schema is now stored in Hono context and shared across all `effectRoutes()` calls - no need to pass schema to each route group
- Removed `database` from `EffectBridgeConfig` (now in `HonertiaFullConfig`)
- Error hint for missing schema now correctly references `setupHonertia({ honertia: { schema } })`

### Added

- `HonertiaFullConfig` interface extending `HonertiaConfig` with `database`, `auth`, and `schema` options
- Helpful error messages when using `DatabaseService` or `AuthService` without configuring them:
  - `DatabaseService is not configured. Add it to setupHonertia: setupHonertia({ honertia: { database: (c) => createDb(...) } })`
  - `AuthService is not configured. Add it to setupHonertia: setupHonertia({ honertia: { auth: (c) => createAuth(...) } })`
- Error `hint` prop now passed to error component in dev mode (shows configuration examples)
- `getEffectSchema()` helper to retrieve schema from Hono context
- Comprehensive test suite for `setupHonertia` configuration (14 tests)

### Fixed

- Auth factory now has access to `c.var.db` (database is set up first)

## [0.1.17] - 2026-01-08

### Changed

- Error handling strategy: most errors now throw to Hono's `onError` handler for rendering via Honertia's error component, instead of returning raw JSON
  - `RouteConfigurationError` and unexpected errors throw to `onError` for proper error page rendering
  - `ForbiddenError` and `HttpError` still return JSON responses (useful for API routes)
  - `ValidationError` re-renders forms with errors or redirects back
  - `UnauthorizedError` redirects to login
  - `NotFoundError` uses Hono's `notFound()` handler
- Effect handler defects now throw to Hono's `onError` handler instead of returning 500 JSON

### Added

- `toThrowableError()` internal function to preserve error metadata (status, hints) when re-throwing
- Comprehensive Error Handling documentation in README with:
  - Built-in error types table showing HTTP status and handling behavior
  - Detailed usage examples for each error type
  - Error handling flow diagram
  - `registerErrorHandlers()` setup guide

### Fixed

- Error type imports in README now correctly reference `@popcomputer/web/effect` instead of `honertia`

## [0.1.16] - 2026-01-08

### Added

- Route model binding now provides a helpful `RouteConfigurationError` when schema is not configured, with clear error messages and hints for setup
- `RouteConfigurationError` is exported and handled in all relevant places (errors, handler, index)
- Route model binding integration tests for missing schema configuration

### Fixed

- Route model binding no longer fails silently when schema is missing; instead, a 500 error with a clear message and hint is returned

## [0.1.15] - 2026-01-08

### Added

- Helpful error types when services are not configured via module augmentation
  - `DatabaseService` shows: "DatabaseService type not configured. Add module augmentation..."
  - `AuthService` shows: "AuthService type not configured..."
  - `bound('project')` shows: "Cannot infer type for bound('project'). Schema not configured..."
  - `dbTransaction` shows: "Database client does not support transactions..." when transaction method is missing
- Compile-time type tests for `Validated`/`Trusted` branding and `SafeTx` wrappers
- Exported `pluralize` function from `@popcomputer/web/effect`

### Fixed

- `bound('project')` now correctly infers types by pluralizing to match schema keys (`project` → `projects`)
- `Pluralize<K>` type now handles double consonants correctly (`buzz` → `buzzes`, `quiz` → `quizzes`)
- Exported `BoundModel<K>` type for explicit typing when needed

## [0.1.14] - 2026-01-07

### Fixed

- Module augmentation now works correctly - `HonertiaDatabaseType` and `HonertiaAuthType` are empty interfaces that users can augment with `type` and `schema` properties
- Added `DatabaseType`, `SchemaType`, and `AuthType` helper types that extract augmented types with sensible defaults

## [0.1.13] - 2026-01-07

### Fixed

- Added `BoundModels` to `BaseServices` type - handlers using `bound()` now correctly satisfy route builder type constraints
- Fixed `HonertiaDatabaseType` interface for proper module augmentation - removed index signature and made `schema` non-optional so user declarations don't conflict with base interface modifiers

## [0.1.12] - 2026-01-07

### Added

- **Laravel-style route model binding**: Routes now support `{param}` syntax that automatically resolves database models
  - `effectRoutes(app, { schema }).get('/projects/{project}', handler)` queries the `projects` table by `id`
  - `{param:column}` syntax for binding by non-id columns: `/projects/{project:slug}`
  - Nested routes auto-scope via Drizzle relations: `/users/{user}/posts/{post}` queries posts where `userId = user.id`
  - `bound('project')` accessor to retrieve resolved models in handlers
  - Zero overhead for routes without `{bindings}` syntax
- Route helpers now accept a `params` schema to validate route parameters and automatically return 404s when the schema fails
- `BoundModels` service and `bound()` helper exported from `@popcomputer/web/effect`
- `parseBindings()` and `toHonoPath()` utilities for custom route handling
- `drizzle-orm` as optional peer dependency for route model binding
- `schema` property on `HonertiaDatabaseType` for typed route model binding
- Comprehensive test suite for route binding with 75+ test cases

## [0.1.11] - 2026-01-06

### Fixed

- Safe write wrappers now accept single branded values even when the underlying `values` signature is inferred as array-only.

## [0.1.10] - 2026-01-06

### Changed

- Brands for validated/trusted inputs are now nominal so merges/spreads require explicit re-branding via `asTrusted`.
- Updated db helper docs and examples to explain the explicit trust boundary and show safe merge patterns.

### Added

- Branding safety tests now cover explicit trusted merges and ensure spreads drop branding.

## [0.1.9] - 2026-01-05

### Fixed

- Module augmentation now actually works in emitted `.d.ts` files; `DatabaseService` and `AuthService` preserve `HonertiaDatabaseType['type']` and `HonertiaAuthType['type']`.
- Module augmentation no longer conflicts with interface merging by using index-signature placeholders and if not we will move onto something else lol.

### Changed

- `DatabaseService` and `AuthService` now expose the augmented types directly (no extra wrapper needed - probably).

### Removed

- `TypedDatabase` and `TypedAuth` alias exports. Hopefully this preserves the clean `yield* DatabaseService` that I was willing to sacrifice everything for. 

## [0.1.8] - 2026-01-05

### Fixed

- Module augmentation for `HonertiaDatabaseType` and `HonertiaAuthType` now works correctly (interfaces use `type` property directly instead of conditional types that were evaluated at library compile time)

## [0.1.7] - 2026-01-05

### Added

- `HonertiaDatabaseType` and `HonertiaAuthType` augmentable interfaces for typed services via module augmentation
- TypeScript section in README explaining how to use module augmentation for `DatabaseService` and `AuthService`
- Documentation clarifying query-level vs `authorize()` checks for resource ownership

### Changed

- `DatabaseService` and `AuthService` now use augmentable interfaces instead of `unknown`

## [0.1.6] - 2026-01-05

### Added

- `ValidateOptions` interface with JSDoc documentation for all options
- Better error handling for malformed JSON request bodies (returns clear `ValidationError` instead of confusing field errors)
- Tests for `attributes` option through `validateRequest`
- Tests for nested field paths (`user.email`), array indices (`tags.1`), and deeply nested paths
- README documentation for all `validateRequest` options (`errorComponent`, `messages`, `attributes`)

### Changed

- Simplified `validate` function signature from curried `validate(schema, options)(data)` to direct `validate(schema, data, options)`
- Simplified `formatSchemaErrors` path extraction logic
- Improved `getValidationData` error handling

## [0.1.5] - 2026-01-05

### Changed

- Changed how `dbTransaction` works so that the API is more consistent

## [0.1.4] - 2026-01-05

### Added

- `action` wrapper for Effect-based actions
- `authorize` helper for authentication and authorization checks
- `dbTransaction` helper for database transactions with automatic rollback

### Changed

- Actions are now composed via `yield*` helpers/services instead of factory functions

### Removed

- Action factories `effectAction`, `dbAction`, `authAction`, `simpleAction`
- Action helpers `injectUser`, `dbOperation`, `prepareData`, `preparedAction`

## [0.1.3] - 2026-01-05

### Added

- `betterAuthFormAction` factory for streamlined form-based authentication (login/register)
- `betterAuthLogoutAction` factory for logout with automatic cookie clearing
- `loginAction`, `registerAction`, `logoutAction` options for `effectAuthRoutes` config
- `guestActions` option for registering additional guest-only POST routes (2FA, forgot password, etc.)
- `AuthActionEffect` type export for typing custom auth actions
- Error mapping support to translate better-auth error codes to field-level validation errors
- Dynamic `redirectTo` support (string or function) for auth actions
- Automatic Set-Cookie header forwarding from better-auth responses
- Fallback cookie clearing when better-auth doesn't return Set-Cookie headers
- Comprehensive test coverage for auth form actions

### Changed

- `effectAuthRoutes` now supports unified auth route configuration (pages + actions in one call)
- README now documents the full better-auth form action pattern with examples

## [0.1.2] - 2026-01-04

### Changed

- `createVersion` now accepts Vite manifest entries (including `file`, `css`, and `assets`)
- README Tailwind v4 setup docs now reference manifest-driven scripts/styles

## [0.1.1] - 2026-01-04

### Added

- Custom services support for Effect bridge/routes via the `services` layer hook
- Custom services support in `setupHonertia` effect configuration
- Cloudflare bindings documentation and examples for custom services
- Custom services tests covering `setupHonertia` and route-only usage

### Changed

- Effect route builder typing to include custom services in handler requirements

## [0.1.0] - 2026-01-03

### Added

- Initial release
- Inertia.js-style server-driven SPA adapter for Hono
- Effect.js integration with per-request runtime
- Laravel-inspired validation with Effect Schema
- Type-safe route handlers returning `Response | Redirect`
- Services: `DatabaseService`, `AuthService`, `AuthUserService`, `HonertiaService`, `RequestService`, `ResponseFactoryService`
- Authentication layers: `RequireAuthLayer`, `RequireGuestLayer`
- Route grouping with `effectRoutes()` and `effectAuthRoutes()`
- Response helpers: `render`, `renderWithErrors`, `redirect`, `json`, `notFound`, `forbidden`
- Validation helpers: `requiredString`, `nullableString`, `email`, `password`, `coercedNumber`, etc.
- Action factories: `effectAction`, `dbAction`, `authAction`
- React integration with `HonertiaPage` type
- Full Cloudflare Workers compatibility
