# @popcomputer/web for coding agents

Rules for writing an application on `@popcomputer/web`. Each rule names the one
API to use; the README explains the design and shows the full setup. Every
TypeScript example here and in the README type-checks against the package.

To use this file, point the application's own `AGENTS.md` or `CLAUDE.md` at
`node_modules/@popcomputer/web/AGENTS.md`. Replace a `CLAUDE.md` a project
template wrote, such as the one `bun init` writes for `Bun.serve` and
`bun:sqlite`: its instructions contradict these.

## Rules

1. **Declare once, in `setupWeb`, and register it.** `export const web =
   setupWeb(new Hono<Env>(), config)` in `src/app.ts` owns rendering, the
   database, auth, route binding parsers, pages, shared props, flash and the
   error page, and declares their types as values. Register it once with
   `declare module '@popcomputer/web' { interface Register { web: typeof web } }`;
   every other type derives from it. Never declare a type the config already
   declares. Do not add framework middleware or register routes on the Hono
   app by hand.
2. **Every handler is an action.** Wrap an `Effect.gen` in `action(...)` and
   register it on the `routes` that `setupWeb` returns, or that
   `web.services(...)` returns with the application's own services:
   `routes.get/post/put/patch/delete(paths.project, action, { name })`.
   Declare every path once in `src/paths.ts` (`project: '/projects/{project}'`)
   and pass it as `setupWeb`'s `paths`, so `routes`, `redirect`, `back` and
   `href` accept only declared paths. Build every URL from it:
   `redirect(paths.project, { project: id })` in actions,
   `href(paths.project, { project: id })` from `@popcomputer/web/paths` in
   React. Registrations chain. `routes` accepts only actions whose services
   the setup provides.
3. **Declare every page's props as an Effect Schema** in `src/pages.ts` and
   pass the object as `setupWeb`'s `pages`. Take a table's columns from the
   table: `tableSchema(schema.projects).mapFields(Struct.pick(['id',
   'name']))` from `@popcomputer/web/schema`, and declare the signed-in user
   as `auth.session: betterAuthSession(tableSchema(schema.user))` (with
   `tableSchema(schema.session)` second when a plugin adds session fields),
   with Better Auth's `additionalFields: betterAuthFields(schema.user, { role: {
   input: false } })`. Type each React page as `WebPage<'Projects/Show'>`
   from `@popcomputer/web/react`; its props, the shared `auth.user` and
   `errors` follow. Type a form's fields as `FormInput<typeof Schema>`, from
   the schema its action validates. Declare props shared with every
   page in `shared`, computed when a page renders by
   `routes.provide(shareProps(effect))`, and flash values in `flash`.
4. **End every branch with a response helper:** `return yield* render(...)`,
   `redirect(...)`, `back(...)`, `json(Schema, value)`, `jsonOrRender(...)`,
   `file(...)`, `notFound(...)`, `forbidden(...)`, `invalid(...)` or
   `httpError(status, message, Schema, body)`. Declare an application cookie
   once, `cookie('cart', Schema, { path })`, and read, set and clear it
   through the declaration; sign one the server must trust
   (`signed: { secret: 'COOKIE_SECRET' }`), since an unsigned one holds
   whatever the visitor sends. `yield* flash(key, value)` before a redirect hands a
   message to the next page; a helper or guard layer that must send the
   visitor elsewhere fails with `redirectNow(path, params)`. Expected
   failures are typed Effect failures:
   turn a domain error into a response with `Effect.catchTags`, such as
   `invalid({ amount: error.message })` to show it beside its form field. A
   handler that ends differently per branch branches inside `Effect.gen`,
   whose branches TypeScript combines. Do not `throw` in an action. An
   endpoint's action (rule 13) returns its success value instead.
5. **Read request input only through `validateRequest(Schema)`,** or, in an
   endpoint's action, through its contract (rule 13). Build schemas
   from `@popcomputer/web/schema` validators (`requiredString`,
   `nullableString`, `coercedNumber`, `checkbox`, `email`, `uuid`, `isoDate`
   and `isoDateTime` for a day or a moment with its zone, ...), which
   accept form posts as well as JSON (an API rejects undeclared query
   parameters with `request: { order: ['query'] }, parseOptions: {
   onExcessProperty: 'error' }`), `nullable(...)` for a filter a GET form
   may send empty, and `upload({ types: [...] })` for files, served back with
   `file(...)`. A form that
   fails validation goes back to the page it came from (its Referer; without
   one, the page its route names, `routes.post(path, action, { form:
   paths.page })`, or its own path's page), which receives the
   field errors as `errors`; a JSON client gets a `422`. A key that route
   params, query and body provide with different values fails validation.
   Read headers and a raw body (a webhook signature) with `RequestService`.
6. **Load route models with `{param}` placeholders and `bound('param')`.**
   Name each model's Drizzle table in `setupWeb`'s `bindings`
   (`bindings: { project: schema.projects }`); the model is the table's row,
   checked against its columns. Bind every record a path names, nested ones
   scoped to their parent, a membership by its user too
   (`/orgs/{organization:slug}/members/{member:userId}` with
   `bindings: { member: schema.memberships }`), and never read a record's id
   from the path to query for it yourself (a plain parameter, such as an
   invitation token, or the id of a record served from the data cache, is
   read with `validateRequest` and looked up like any input);
   to lock a bound record inside `dbTransaction`, read it again by its id with
   `.for('update')`. On a route that needs a signed-in user, call
   `authorize()` before `bound()`: models load on the first `bound()` call,
   and a missing row is a 404. A record the user may not
   see answers `notFound(...)`, so its existence stays private; use
   `authorize((auth) => rule)` (a 403) for a record the user can see but not
   change. `bound('project')` type-checks only on a route whose path or
   prefix has `{project}`, in an action or in a layer guarding it.
7. **Authorize with `authorize()` or `authorize((auth) => rule, message)`.** Use
   `currentUser` when signing in is optional. Guard a group of routes with
   `routes.provide(RequireAuthLayer)`, which sends a signed-out visitor to
   `auth.signInPath`, or `routes.provide(RequireGuestLayer)`, which sends a
   signed-in one to `auth.homePath`. Validate a sign-in's password with
   `currentPassword`, which never trims it, and a new one with `password(...)`.
   Sign users in and up with an action that validates its form and returns
   `betterAuthRedirect('signInEmail', { body: input }, { redirectTo, errors })`
   from `@popcomputer/web/auth`, which sends the call through Better Auth's
   handler so the limits apply; call Better Auth for a result the action
   uses with `betterAuthCall(endpoint, { body })`. Never call `auth.api` from
   an action: it skips them. Limit password guessing with `setupWeb`'s
   `auth.signInLimits: { limiter: 'SIGN_IN_LIMITER', table: schema.rateLimit }`
   (a Workers Rate Limiting binding, and Better Auth's `rateLimit` table for
   each account's failures), sweep the table with
   `routes.scheduled(() => sweepSignInFailures)`, and keep
   `betterAuth({ rateLimit: { enabled: true, storage: 'memory' } })`. Better
   Auth's plugins (organizations, two-factor, magic links, OAuth providers)
   stay Better Auth's: call their endpoints by name the same way. Sign in
   through an OAuth provider (`socialProviders`, or `genericOAuth` for a
   company's own) with `betterAuthRedirect('signInSocial', ...)`, and serve
   its callback alone, `routes.get(paths.authCallback, betterAuthHandler())`,
   with `account: { accountLinking: { disableImplicitLinking: true } }` and
   `onAPIError: { errorURL }` in `betterAuth`; register
   `routes.all(paths.authApi, betterAuthHandler({ settable }))` only for
   Better Auth's client SDK, naming the `input: true` user fields visitors may
   set there. On D1, Better Auth writes each row in its own statement: write
   rows that must exist together, such as an organization and its owner, in
   your own `dbBatch`. Make the application's
   own record of a new member on their first visit, in a guard layer, since
   users from OAuth providers and magic links never pass through a sign-up
   action. A role a user
   holds per team or workspace lives on a membership row a guard layer
   reads (the organization plugin's `member` table), not on the user. Register a JSON
   API's routes on `routes.jsonApi()`, with their declared paths
   (`routes.jsonApi().provide(KeyAuth).get(paths.apiInvoices, ...)`), so every
   failure there answers JSON (a 401, not a redirect to sign in), and
   authenticate its keys in a layer that fails with
   `new UnauthorizedError({ message, challenge: 'Bearer' })`.
8. **Use the database only through `dbQuery`, `dbMutation`, `dbTransaction`
   and `dbBatch`:** `yield* dbQuery((db) => db.select()...)` to read,
   `dbMutation((db) => db.insert(...))` to write. Operations that must
   succeed together, with any Effect logic between them, go in
   `dbTransaction(Effect.gen(...))` (Postgres, MySQL, libsql); on Cloudflare
   D1, put the writes in one `dbBatch` and enforce limits inside the write
   statement, inserting a row only while a condition holds with
   `db.insert(table).select(db.select(rowOf(table, values)).from(...).where(condition))`. Write only validated input and values the server derives, and
   scope `where` clauses with bound models. State an invariant concurrent
   requests could break as a database constraint (`CHECK (stock >= 0)`, a
   unique idempotency key or webhook event id, or a trigger raising a named
   abort on D1) and handle `DatabaseConstraintViolation` by its `constraint`
   and `constraintName`, or show a named rule beside its fields with
   `constraintFieldErrors({ name: { field: 'message' } })`. Pipe a write through
   `uniqueFieldErrors({ column: 'message' })` to show a duplicate as a field
   error.
9. **Give the application's own services with `web.services({ app, request })`,**
   after registering `web`, in place of `export const { app, routes } = web`:
   `export const { app, routes } = web.services({ app: ProjectsLive, request:
   (c) => auditLogFor(c.env.KV) })`. The `routes` it returns accept actions
   that use them. `app` is for services built once and shared
   (configuration, in-memory caches), `request` for anything that holds the
   request's bindings (D1, KV, Hyperdrive). Define them with
   `Context.Service` and `Layer`, and read vars and secrets with
   `config.string('NAME')` and `config.redacted('KEY')`, Effect `Config`
   named by the Worker's bindings type, which reads the request's bindings.
   A layer's type is inferred, even when it uses `dbQuery`, `config` or
   `bound`.
10. **Run work that outlives the response with `background('name', effect)`.**
    Give the Worker's `scheduled` and `queue` handlers as
    `routes.scheduled((event) => effect)` and
    `routes.queue(MessageSchema, (message) => effect)`, which run the work with
    the application's services, never through a hidden route; test them with
    `testBatch` and `testEnv`.
11. **Give `cache: 'private'` to routes whose page reads something the framework
    cannot see,** such as an external `fetch()` or the current time, and
    `cache: 'no-store'` to one no cache may keep, such as a signed preview. Pages that
    read bindings, headers or bound models are already rendered per request.
    A route that changes records cached pages show purges them with
    `purges: true`, and an action adds other records it changed with
    `purgeCache(recordCacheTag('listings', id))`. Give data kept with
    `cache(key, effect, schema, { ttl, tags })` the same tags, so the same
    purges invalidate it. An API that authenticates each request (a bearer
    token) caches its data this way, after authenticating, never its
    response.
12. **Test through the app.** `app.request(path, init, testEnv(layer,
    bindings))` from `@popcomputer/web/testing` runs the real route;
    `signedIn(row)` signs the request in (pass the seeded user row when the
    user table has columns of its own), `testBrowser(app, env)` carries a
    visitor's cookies across requests, and `readPage(res, 'Name')` reads
    an `X-Inertia` response typed by the page registry. Test against the
    production database family: PGlite for Postgres (`testEnv`'s `database`),
    migrated with `applyMigrations`, and for D1 a database of each test's own
    from `testD1({ migrations: './drizzle' })`, stopped by
    `afterAll(() => databases.dispose())` in `bunfig.toml`'s preload. Replace a service
    that reaches another system with `Layer.succeed(Service, fake)` in the
    layer, stand in for an OAuth provider with `testOAuthProvider({ ... })`
    and sign people in through it with `signIn(browser, path, person)`, and move time with `testClock()`, which works when rules read the
    time through Effect's `Clock` or `DateTime.now`; `time.settle(request)`
    runs a request whose retries wait on the clock.
13. **Declare every JSON endpoint once, as a contract,** in `src/endpoints.ts`:
    `endpoint.post(paths.apiProjects, { body, success, status: 201, errors:
    { 409: SlugTaken } })` from `@popcomputer/web/endpoint`, with `query`,
    `body` and `headers` schemas for its input, `success` for its body and
    each failure a client tells apart as an `S.TaggedError` under its status.
    Declare a JSON number with Effect's schemas (`S.Int.check(S.isGreaterThan(0))`),
    not the form validators, which accept `"12"` for a form's sake.
    Give it `auth: true` when it needs a signed-in user, which the handler
    then receives as `auth`, rather than calling `authorize()` in it.
    Implement it with `action(endpoints.createProject, ({ auth, params, body }) =>
    Effect.gen(...))`, which receives the input decoded and returns the
    success value, and register it with `routes.endpoint(createProject)`,
    which takes the method and path from the contract. Do not call
    `validateRequest` or `json` in it. Test it with `call(endpoints.x, input,
    { fetch: (request) => app.request(request, undefined, env) })`, and
    publish `openApi(endpoints, { title, version, security })`. Pages' forms stay ordinary actions.

Every name has one entrypoint: `@popcomputer/web` for `setupWeb`, template
helpers and Hono middleware; `@popcomputer/web/effect` for actions, routes,
responses, pages, the database, services and errors;
`@popcomputer/web/schema` for validators; `@popcomputer/web/auth` for the
Better Auth integration; `@popcomputer/web/cache` for the KV cache;
`@popcomputer/web/drizzle` for `rowOf`; `@popcomputer/web/endpoint` for
`endpoint`, `call` and `openApi`, on the server and in clients alike;
`@popcomputer/web/lint` for `webLint`, in `oxlint.config.ts`;
`@popcomputer/web/react` for page component types; `@popcomputer/web/paths`
for `href`, in React and actions alike; `@popcomputer/web/testing` in tests.

## A complete action

```ts
// src/actions/projects/update.ts
import { eq } from 'drizzle-orm'
import { Effect, Schema as S } from 'effect'
import {
  action,
  authorize,
  bound,
  dbMutation,
  flash,
  notFound,
  redirect,
  validateRequest,
} from '@popcomputer/web/effect'
import { nullableString, requiredString } from '@popcomputer/web/schema'
import { paths } from '../../paths'
import { projects } from '../../schema'

const UpdateProject = S.Struct({
  name: requiredString,
  description: nullableString,
})

export const updateProject = action(
  Effect.gen(function* () {
    const auth = yield* authorize()
    const project = yield* bound('project')

    if (project.userId !== auth.user.id) return yield* notFound('Project')

    const input = yield* validateRequest(UpdateProject)

    yield* dbMutation((db) =>
      db.update(projects).set(input).where(eq(projects.id, project.id))
    )
    yield* flash('success', 'Project saved.')

    return yield* redirect(paths.project, { project: project.id })
  })
)
```

Register it beside the other routes in `src/routes.ts`:

```ts
routes.put(paths.project, updateProject, { name: 'projects.update' })
```

Test it as the README's Testing section shows: request
`PUT /projects/project-1` with `testEnv(signedIn({ id: 'user-1' }),
testBindings)` and expect a `303` to `/projects/project-1`, a `404` for
another user, and, for an empty name, a `303` back to the form whose next page
has `errors.name` (a JSON request gets a `422`).

## Do not use

- `c.req.json()`, `c.req.parseBody()` or `c.env` inside actions.
- `DatabaseService` or raw `db` calls outside `dbQuery`, `dbMutation`,
  `dbTransaction` and `dbBatch`.
- `app.get(...)` or other routes on the Hono app; register on `routes`.
- Names from the old `honertia` package (`setupHonertia`, `HonertiaService`,
  `c.var.honertia`, ...): the README's migration table lists their
  replacements.

## Before finishing

Run the application's type check (`tsc --noEmit`), the package's lint rules
(`bunx oxlint`, with `oxlint.config.ts` exporting
`defineConfig(webLint())` from `@popcomputer/web/lint`) and `bun test`. Each
lint message names the API to use instead; fix the code rather than
disabling the rule, and when a line breaks one on purpose, say why in the
disable comment. A type error
at `routes.get(...)` names the problem: `missingServices` lists services the
setup does not provide (configure them in `setupWeb`, or `routes.provide(layer)`),
`unhandledErrors` lists failures that are not the package's errors (handle
them with `Effect.catchTag`, or fail with `HttpError`), and
`missingRouteModels` lists models the action or a provided guard reads with
`bound()` that the route's path does not bind. A type error at
`render(...)` means the page or its props differ from `src/pages.ts`.
`Argument of type 'string' is not assignable to parameter of type 'readonly
[never, ...never[]]'` at an `Effect.catchTag` means the Effect no longer fails
with that tag: remove the handler. The same error, or `... | { readonly _tag:
unknown }` is not assignable, at a `catchTag` written apart from an Effect,
as a reusable helper, means TypeScript cannot see the errors it handles:
write it inside `.pipe(...)`, or use `Effect.mapError` with an `instanceof`
check (`Effect.catchIf((error) => error instanceof X, ...)` when the error
type is a type parameter). `not assignable to type '{ EntitlementRequired: never; }'` at an
`Effect.catchTags` means the same of that tag: remove its handler. A registration, `routes.run` or an
`action(...)` reporting an `Effect<..., unknown, unknown>`, or
`missingServices: "unnamed service"`, means an earlier type error in the
action made its types unknown: fix that one first.
`'web' implicitly has type 'any'` (TS7022) means a value in `setupWeb`'s
configuration has a type that reads the registration, such as one using
`dbQuery`: give services to `web.services(...)`, after the registration, as
rule 9 shows.
Many errors naming `DatabaseNotConfigured`, or `(c) => never` at `database`,
while `setupWeb` has a database factory, mean one value in its configuration
has a type error, such as a page schema using a deleted import: TypeScript
then infers none of the configuration's types. Fix the first error inside the
`setupWeb` call.
