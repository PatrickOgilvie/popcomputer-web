# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.44] - 2026-04-05

### Added

- **`EffectErrorObserverService` — optional error reporting sink**: Register a single observer in `setupHonertia({ effect: { services } })` and receive every request-time Effect failure or defect, whether handled or not. This is the main integration point for PostHog, Sentry, and similar telemetry systems.

  ```typescript
  import { EffectErrorObserverService, type EffectErrorEvent } from 'honertia/effect'

  app.use('*', setupHonertia<Env>({
    effect: {
      services: (c) =>
        Layer.succeed(EffectErrorObserverService, {
          observe: (event: EffectErrorEvent) =>
            Effect.tryPromise({ try: () => reportToSentry(event), catch: () => undefined })
              .pipe(Effect.asVoid, Effect.catchAll(() => Effect.void)),
        }),
    },
  }))
  ```

- **`reportEffectError(error, options?)`**: Report intentionally recovered errors to the same observer. Use this with `Effect.tapError` when you catch an error and fall back gracefully but still want it tracked. The observer always receives it as a `source: 'user'`, `handling: 'handled'` event. `metadata` is optional.

  ```typescript
  yield* Effect.tryPromise({ ... }).pipe(
    Effect.tapError((error) => reportEffectError(error, { metadata: { area: 'home' } })),
    Effect.catchAll(() => Effect.succeed(false))
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

- **Exported request validation types**: `RequestValidationSource`, `RequestValidationProfile`, `RequestValidationConflict`, `RequestValidationOptions`, and `RequestValidationConfig` are now exported from `honertia/effect` and `honertia`.

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

- **`MutationInput` type export**: The `MutationInput<Scope, A>` type is now exported from `honertia/effect` for explicit type annotations on scoped mutation objects.

- **`validateUnknown` function**: New function for validating unknown/untyped data (external JSON, raw payloads). The original `validate` now enforces compile-time typed input (`data: I`), while `validateUnknown` accepts `data: unknown`.
  ```typescript
  // Typed -- compile-time check on field names
  yield* validate(CheckoutSchema, { status: 'pending', quantity: '2' })

  // Unknown -- for raw/external payloads
  yield* validateUnknown(CheckoutSchema, someUnknownPayload)
  ```

- **`createBodyParseValidationError` export**: Constructs a detailed `ValidationError` for malformed request bodies with actionable hints and structured `fieldDetails`.

- **OpenAPI YAML output format**: The `generate:openapi` command now supports `--format yaml`. New `formatOpenApiOutput(spec, format)` function exported from `honertia/cli`.
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
  import { createGuestLayer, effectAuthRoutes } from 'honertia/effect'

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
  declare module 'honertia/effect' {
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
- `honertia/cache` export path for standalone cache imports
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

- Error type imports in README now correctly reference `honertia/effect` instead of `honertia`

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
- Exported `pluralize` function from `honertia/effect`

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
- `BoundModels` service and `bound()` helper exported from `honertia/effect`
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
