# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.2] - 2026-10-23

Nothing an application on 1.4.1 needs to change. One that passed `schema: { ...schema }` to `setupWeb` to get its nested bindings working under Vite's dev server can pass `schema` again.

### Fixed

- Route bindings find their tables under Vite's dev server. Vite gives an application's `import * as schema` as an object of getters, where Bun, Node and workerd give its tables as plain values, and the bindings read only plain values: under `vite dev` a nested binding scoped by its table's `.references()` or `relations()` failed every request with `WEB_RTE_603_RELATION_NOT_FOUND`, a binding named by an Effect Schema with `WEB_RTE_601_TABLE_NOT_FOUND`, and `setupWeb` checked no `ownedBy` column against Better Auth's `user` table, while the same application passed its tests. An application that passed `schema: { ...schema }` to get around it can pass `schema` again. Found by an agent building a blog on the framework, whose public post page answered 500 in development only.

### Verification

- 1088 tests pass, on Better Auth 1.7.10 and Effect 4.0.5. `docs/installation.md` names both as the versions tested.

## [1.4.1] - 2026-10-17

Documentation and tests only: nothing an application on 1.4.0 needs to change.

### Changed

- `docs/guards.md` says that on Postgres through Hyperdrive, whose query caching is on by default, a membership just removed or a role just lowered can still let its member through a guard for up to a minute, and to read memberships, roles and sessions through a Hyperdrive configuration with caching disabled.

### Verification

- A security regression suite, `tests/security/`, attacks the framework the way each class of bug attacked another framework, each file naming the advisories it guards against: a guarded path spelled another way, headers that tell a framework about the request, writes from another site in every body type and spelling, undeclared and prototype keys, uploads served back as pages, open redirects, signed cookies moved between names, page data breaking out of the HTML, a shared cache keeping one visitor's response, concurrent requests seeing each other's user, error detail in production, the client address, validators made slow, and the dependency floors. All 55 pass, and three classes the framework does not yet guard are listed as `todo`: a body size limit, a lint rule for `sql.identifier()` given request input, and Better Auth's account linking in the template.
- 1080 tests pass. Every test file and all 100 TypeScript examples across the 33 documents type-check against the built package and follow its lint rules.

## [1.4.0] - 2026-10-17

A binding that names only its table loads as before, and the new lint rule, on as an error, reports each such binding; `webLint({ 'require-binding-access': 'warn' })` makes it a warning while you move. Hono must be 4.13.5 or later and Drizzle ORM 0.45.2 or later, the first releases with the security fixes for the parts the package uses, and `url` and `nullableUrl` accept only `http:` and `https:` links.

### Added

- A binding says who may load its record, beside its table. `routeBinding(schema.projects, { ownedBy: 'userId' })` loads a record only for the signed-in user whose id the column holds: the lookup's query is scoped by the user, so anyone else gets the 404 a missing record gets, and a signed-out visitor is asked to sign in before the database is asked. `{ publicWhen: { visibility: 'public' } }` loads a record for anyone when its columns hold those values, each typed by its column, `{ public: true }` for anyone, and `{ guarded: true }` says a guard layer decides, such as an organization's membership guard. `RouteBindingAccess` types them. Giving two, or naming a column the table lacks, is a type error, and `setupWeb` rejects it when called (`WEB_RTE_606_BINDING_ACCESS_INVALID`, and the existing column error), as it rejects a `publicWhen` that names no column. An `ownedBy` column must reference the users table's `id`, the table `betterAuthSession` was given or Better Auth's `user`: one that references another table, or none, fails when `setupWeb` is called (`WEB_RTE_607_BINDING_OWNER_NOT_USER`), naming the binding to scope the record to instead, since compared with the user's id it would match no record. A record an organization owns loads under the organization's `guarded: true` binding, scoped to it.
- Registering a route checks its nested bindings: a binding whose `scope` names a binding the path lacks fails then, rather than on the route's first request, and so does a binding that says `public: true` under a parent that says who may load it, which would load for anyone on a path without the parent. The error names the `scope` to give it instead.
- A `guarded: true` binding is read by its guard: a route whose records are asked for, by its action, another layer or a `purges: true` that would read them, before a `guard(...)` it is provided has read the guarded one fails with `WEB_RTE_606_BINDING_ACCESS_INVALID`, so a route registered without its membership guard loads and purges nothing for anyone.
- Registering `cache` on a route whose record depends on the visitor, an `ownedBy` or `guarded` binding or one under them, fails: a shared cache answers before the Worker runs, so it would hand one visitor's record to the next. A page anyone may see binds the table a second time, with `publicWhen` or `public: true`, and caches there.
- `ownedBy` reads the signed-in user when the route's records load, so the user a layer the route provides gives, such as an API key's, owns records as the session's does, and a numeric id, as Better Auth gives with serial ids, matches its column.
- `guard(...)` makes the layer that decides whether a visitor may go on: from the Effect that decides, `guard(authorize(({ user }) => user.emailVerified))`; from a service and the Effect that finds it, `guard(CurrentMember, findMembership)`; or from a layer. Only a guard's reads vouch for a `guarded: true` record, so a layer that reads one for breadcrumbs or a log is no guard. `docs/guards.md` shows a membership guard, roles, and permissions named in one table, checked in the action, `yield* can('members.role')`, or for a group, `routes.provide(guard(can('projects.delete')))`.
- The `require-binding-access` lint rule reports a binding that says none of them: a bare table, an Effect Schema, or `routeBinding` without `ownedBy`, `publicWhen`, `public`, `guarded` or `scope`, under which its parent's option decides.

### Changed

- The documentation's examples say who may load each binding and no longer check ownership in the action. `docs/route-models.md` explains the options, `AGENTS.md`'s rule 6 asks for one, and `docs/guards.md` keeps guards for rules a column cannot state, such as an archived project or an organization's members. `UPGRADING.md` shows the move from 1.3.

### Fixed

- The peer ranges start at the first releases with the security fixes for the parts the package uses: Hono `^4.13.5` (cookie attributes, body parsing) and Drizzle ORM `>=0.45.2` (quoting in `sql.identifier()`). They allowed Hono 4.10 and Drizzle 0.30.
- `setupWeb`'s sign-in limits take the client's address only from Cloudflare's `CF-Connecting-IP`, which a client cannot write, and no longer fall back to `X-Forwarded-For`, which it can; `docs/auth.md`'s Better Auth configuration reads only `cf-connecting-ip` too.
- `upload()` refuses a file whose type is a list, such as `image/png;x=,text/html`, and keeps only a file's media type, `image/png`, so what an application stores is one type. `file()` sends a `Content-Type` that is not one media type as `application/octet-stream`, and shows any XML type inline only under `Content-Security-Policy: sandbox`. A browser reads a list by its last type, so in 1.3.0 an upload that began as a PNG could be served back as a page that ran script on the application's origin.
- The checks `betterAuthHandler` makes on Better Auth's sign-in and sign-up endpoints read the body by its media type in any case, and refuse one they cannot read with 415, so `Content-Type: Application/JSON` no longer sets a user field visitors may set only through the application's own forms, or signs in uncounted by the account's limit, as it did in 1.3.0. They read the path with repeated and trailing slashes dropped.
- A route's `cache` option no longer stores a response that read a request header, a cookie or request state, which Workers Cache's key does not hold, so a response a route's own layer signed in by an API key in a header of its own, or one in the visitor's language, is not served to the next visitor. It stored them publicly in 1.3.0 and earlier: `Authorization` and the session cookie were the only request state it checked.

### Security

- `url` and `nullableUrl` accept only `http:` and `https:` links. They accepted any string `new URL()` parses, so a `javascript:` or `data:` link passed validation, and a page that showed it in an `href`, such as a reading list's link to a book, ran its script on the application's origin when a visitor followed it. The scheme is read as a browser reads it, so `JavaScript:`, spaces or control characters before it and tabs inside it are refused too. Every other scheme, `mailto:` and `ftp:` included, fails with "Use a link that starts with https:// or http://.", as does a string that is not a link at all, which said "Invalid URL". Links already stored are not checked again. Found by an agent building an application on the framework, which had added its own check.


## [1.3.0] - 2026-10-17

Nothing an application on 1.2.4 needs to change. Declaring the Worker's vars and secrets with `@popcomputer/web/env` is optional, and the documentation moves from the README to `docs/`.

### Added

- `@popcomputer/web/env` declares the Worker's vars and secrets once: `defineEnv({ NAME: secret(schema, { generate }), OTHER: variable(schema, { optional: true }) })` in `src/env.ts`. `EnvBindings<typeof env>` types the bindings from it, so `c.env.NAME` and `config.string('NAME')` read the declared names. Each schema decodes from the string the Worker receives; one that does not, such as `S.Number`, is a type error. `randomSecret` makes a secret's value when nobody has to choose one, such as a signing key.
- `setupWeb`'s `env` checks each isolate's bindings against the declaration on its first request, Cron run or queue batch, before the database and auth clients are made, and again only for bindings it hasn't checked. A missing or invalid var or secret fails every request with `EnvInvalid` (code `WEB_CFG_306_ENV_INVALID`), naming each one and never a value; outside development the error page says only that the server failed, so the isolate logs each failure once, through Effect's logger, naming the problems. `routes.scheduled` and `routes.run` reject with it, and `routes.queue` leaves each message to retry. A test's bindings go through the same check.
- `checkEnv(env, values)` lists what is missing or invalid, without the values, for a script that runs outside the Worker, such as a check of `.dev.vars` or a deploy; `describeEnvProblem` says each in a sentence. The entrypoint imports only `effect`. `docs/env.md` shows both, and the Quick start declares its bindings this way.

### Changed

- The README's sections move to `docs/`, one short file per task, which the package ships: `node_modules/@popcomputer/web/docs/` matches the installed version, as `AGENTS.md` does. An agent reads the file a task needs instead of the whole README, whose tables a fetch tool that summarises it loses. `docs/which-api.md` names the API for each task and the file that explains it. The README keeps the overview and links to every file. The text moves as written, and no rule changes. `AGENTS.md`, the skill and `UPGRADING.md` point at `docs/`.
- The documentation check type-checks a `// scripts/<path>.ts` fence as a script beside the application.
- The documentation check type-checks and lints the examples in `docs/` too. It fails on a relative link or `#anchor` that names no file or heading, on a file in `docs/` the README does not link to, and on one longer than 250 lines.
- The README's installation asks for Node.js 22 or later, better 24, as the demo and web.popcomputer.com's setup prompt do: Wrangler needs 22, and portless is built for 24. It said 24.

## [1.2.4] - 2026-10-15

Documentation only: nothing an application on 1.2.3 needs to change. Found by agent runs of the setup prompt on web.popcomputer.com, and by comparing an upgraded application with its 0.4 version.

### Changed

- `UPGRADING.md` warns that every production 404 has the same message, whatever `notFound(...)` or `httpError(404, message)` said: a page that shows a failed request's message shows "Nothing was found at this address." instead, and only in production. A 404 whose message a page shows carries it in a body, `httpError(404, message, Schema, { message })`, which production keeps. Found by comparing an upgraded application with its 0.4 version. The README says the same where it lists what production replaces, and the guide installs 1.2.3.
- The documentation check type-checks and lints examples indented inside list items, which it skipped.
- The README's installation starts an application from the demo, `bun create PatrickOgilvie/popcomputer-web-demo my-app`.
- `AGENTS.md`, the skill and the README point `testD1` at `./migrations`, the folder wrangler applies D1 migrations from and the demo keeps them in, where they said `./drizzle`, drizzle-kit's default. The README says to set `migrations_dir` and drizzle-kit's `out` to the same folder. Found by three agent runs of the setup prompt on web.popcomputer.com.
- The README's installation says a new application needs Node.js 24, Bun and portless as a service, and links to the demo's one-time setup.
- `AGENTS.md` and the skill say to replace only a `CLAUDE.md` written for another setup, and to keep one that points here, as the demo's does: an agent read "a `CLAUDE.md` a project template wrote" as the demo's own.

## [1.2.3] - 2026-10-14

Found by benchmarking that application, upgraded, against its 0.4 version in a browser.

### Fixed

- A sign-in's new session outlives the cookies Better Auth's session lookup sends for the old one. When the browser held a session the database no longer had (revoked elsewhere, such as by a password reset or an admin), or one Better Auth was extending, the lookup's expiry or renewal was written after the response's own cookies, so a sign-in through Better Auth's handler, or an action returning Better Auth's cookies, looked accepted and the next page was signed out, or still the previous user. The lookup's cookies, sent since 1.0.0, are now written only for cookies the response does not set. `betterAuthRedirect` was not affected.

## [1.2.2] - 2026-10-14

Found by upgrading a second application, on 0.4.0, to 1.2.1.

### Fixed

- A failure answers an Inertia visit with Inertia's page protocol whatever its User-Agent says. A visit from a browser or agent whose User-Agent names a command-line or AI client (`curl`, `claude`, `CLI`), such as Claude's own browser, got a JSON error, which an Inertia client cannot read: a failed form now goes back to its page and an error renders the error page, as for any visit. Requests without `X-Inertia` from those clients still get JSON.
- Signing out of a Better Auth loaded on first use ends its session. An application that wraps Better Auth to keep it out of a Worker's startup gives endpoints with no `path`, so `betterAuthLogoutAction` could not find `signOut`, swallowed the error and only cleared the cookies: the session stayed valid in the database. It now uses Better Auth's sign-out path, and a `setupWeb` without a Better Auth instance fails loudly instead. `betterAuthRedirect` and `betterAuthCall`, which take any endpoint, say the wrapper is why they cannot send it, where they blamed a missing plugin.
- `web.services`' `request(c)` is called only when an action's runtime is built. It was called on every request, plain Hono routes included, so an application whose services read bindings or platform APIs did that work for every media file, redirect and `robots.txt`, and a test of such a route had to give bindings it never used.

### Changed

- `UPGRADING.md` covers what upgrading a 0.4 application found: Better Auth 1.7.0 to 1.7.2's required `account.issuer`, which 1.7.3 and later never write, so every sign-up fails until it is relaxed (with a rebuild for SQLite and D1); `effectAuthRoutes`' `/api/auth/*` handler for 0.x applications; server code that edits the template must find `<title inertia>`; packages that peer on Effect, and patches against their old versions; `pageCache: false`; 0.x's middleware form of `setupWeb`; session-derived values a `share` function added; `renderWithErrors`, `setErrors`, `betterAuthFormAction` and `buildContextLayer`; and keeping a test's own small application.
- The README says which User-Agents get JSON errors, how code outside an action recognises Better Auth's `APIError` without importing it, and what works through a wrapper that loads Better Auth on first use. AGENTS rule 7 says to give `auth.client` Better Auth's instance.

## [1.2.1] - 2026-10-14

### Changed

- The upgrade guide is `UPGRADING.md`, shipped in the package. It takes an application on any earlier release, or on the `honertia` package, to the current one, and moves the application's own code from Effect 3 to Effect 4, which is most of an upgrade from `honertia`: what Effect publishes and how to search it, packages first, the renames met most, each checked against Effect 4.0's published types, and the changes no type error shows. It maps `honertia` 0.1's setup, routes and auth routes, and lists what changes without a type error. The README's "Upgrading" and "Migrating from `honertia`" sections point to it, and its examples are type-checked with the README's.
- The `popcomputer-web` skill sends a project on an earlier release, or on `honertia`, to `UPGRADING.md` before its rules. It sent a `honertia` project to the README's migration table, which the guide replaces.

## [1.2.0] - 2026-10-14

Found by upgrading a real application, on the original `honertia` package and Effect 3, to 1.1.0.

### Fixed

- `testD1`'s `dispose()` removes the databases' files before it resolves. Miniflare removes its temporary directory on `dispose()` without waiting, and `bun test` exits as soon as the last `afterAll` resolves, so every run left one `miniflare-*` directory in the system's temporary directory: 4 MB for the template's tests, 90 MB for a larger application's, which filled a disk over a day of runs. `testD1` keeps its Miniflares' files in a directory of its own, `popweb-test-d1-*`, and removes it.
- A service a test fakes in `testEnv`'s layer replaces the one a route gives with `routes.provide()`, as it replaces those `web.services(...)` gives. The route's layer took precedence, so a service only some routes need, given on those routes as AGENTS rule 9 says, could not be faked, and tests faked the other system at its HTTP boundary instead. The test layer is built once a request, so a fake that keeps state keeps one.
- A defect's development error names it: an action's failure piped through `Effect.orDie`, such as a tagged `CrmUnavailable` with no message, read "An unhandled Effect defect occurred: " with nothing after it. It reads "... occurred: CrmUnavailable".

### Added

- `render(component, props, { status })` answers with a status, as a visit and as the Inertia page object: `render('Signing/LinkInvalid', {}, { status: 404 })` for a page that says what is missing. A page answered 200 always, so an action rendering a not-found page answered with a raw `Response`, which the lint rules refuse. `PageRenderOptions` types the options.
- Without a page registry, `render` takes props of any declared shape, interfaces included, whose values JSON carries (`PagePropShape`), and still refuses functions. Props had to fit `PageProps`'s index signature, which no `interface` does: `Index signature for type 'string' is missing in type 'ClauseNode'`.

### Changed

- AGENTS rule 4 and the README say what a failure an action cannot answer becomes: a defect, by piping that call through `Effect.orDie`, which answers 500 and reports the failure; never over `authorize()`, `bound()`, `validateRequest` or the database. The `unhandledErrors` type error's fix says so too. Applications invented an `HttpError(500)` with the failure as its cause, and `Effect.orDie`, side by side.
- "Reading the type errors" says that `"noErrorTruncation": true` shows the whole of an `unhandledErrors` list TypeScript cuts off with `... 7 more ...`.

## [1.1.0] - 2026-10-14

### Fixed

- A page loaded during a deploy reloads instead of staying blank. For a few seconds after `wrangler deploy`, the previous version can still answer at some edge locations, with a page naming the previous build's scripts, which the new deploy no longer serves; web.popcomputer.com rendered blank this way right after its 1.0 deploy. `createTemplate` inlines a script first in every page's head that reloads the page when one of the template's own scripts or stylesheets, now marked `data-popweb-asset`, fails to load, or a chunk Vite loads does (`vite:preloadError`): at once, then after 2 and 4 seconds, and no more than three times a minute in a tab, so it never loops. A script the application adds through `head` never reloads the page.

### Added

- `TEMPLATE_SCRIPT_HASH` from `@popcomputer/web` is the `Content-Security-Policy` source that allows the script `createTemplate` inlines, for an application that sends its own `script-src`.

## [1.0.0] - 2026-10-14

The first stable release. The `1.0.0-next` pre-releases below were never
published to npm, so an application on 0.7.0 reads this section and each of
theirs; `UPGRADING.md` takes it there step by step.

### Added

- A route names the page its form is on with `{ form: paths.page }`, its placeholders filled from the route's own, and a failed form without a same-origin `Referer` goes back there; a route whose path also has a page (a GET route) goes back to it without naming it. It went to `/`, so a test posting a form without visiting it first, as both round 16 clinic builders' did, landed home. `form` takes only a declared path whose placeholders the route provides.
- `testOAuthProvider({ authorizationUrl, tokenUrl, userInfoUrl, client })` from `@popcomputer/web/testing` stands in for an OAuth 2.0 provider: it answers the application's `fetch` requests to the provider's token and user info endpoints, refusing a code exchanged twice, a redirect or PKCE verifier other than its authorization's, or another client, as a real provider does. `signIn(browser, path, person)` signs a person in through the application's own route and Better Auth's callback; `authorization` and `callback` take the steps one at a time, and `accessTokens` holds the tokens it issued. Both builders of the round 15 exam wrote one of their own, one of them in 150 lines.
- `testD1({ migrations })` from `@popcomputer/web/testing` hands each test a newly created, migrated and empty D1 database on Miniflare, typed as the application's D1 binding, starting another Miniflare when one's databases run out; `dispose()` stops them. Miniflare is an optional peer. Both builders of the round 15 exam wrote this pool themselves.
- `betterAuthSession(tableSchema(schema.user), tableSchema(schema.session))` takes the session table too, so the fields Better Auth's plugins add to the session, such as the organization plugin's `activeOrganizationId` and the admin plugin's `impersonatedBy`, reach `authorize()` typed from their columns; the token stays `Redacted`. The session was Better Auth's base fields only, so a guard could not read the active organization.
- Tests of the seam between the framework and Better Auth drive an application written as the README says through sign-up, sign-in, sign-out, session renewal and revocation, two-factor, magic links, an OAuth provider, organizations and invitations, bearer tokens and admin bans and impersonation, on SQLite through Drizzle. Another test checks the README's Better Auth tables, for Postgres and D1, against the columns Better Auth's configuration needs, so a release that adds one fails there first.
- `setupWeb`'s `auth.signInLimits` slows password guessing whichever addresses it comes from. A Cloudflare Workers Rate Limiting binding counts each client address's sign-in, sign-up and password calls, and each account's sign-ins, at the edge. Better Auth's `rateLimit` table counts each account's failed sign-ins: after 10 in 15 minutes the account cools down for a minute, doubled by each further failure up to the window, and a sign-in during a cooldown is refused before its password is hashed. Only a failure writes a row, keyed by a hash of the account. `limiter` accepts only the bindings typed `RateLimit`. `sweepSignInFailures` from `@popcomputer/web/auth` deletes stale rows from a Cron Trigger, and `testRateLimiter()` from `@popcomputer/web/testing` stands in for the binding. Better Auth's own limits count only each address, so guesses spread across many addresses were never slowed, and with `storage: 'database'` every request to Better Auth wrote a row.

### Fixed

- `inArray(['member', 'admin'])` decodes to `'member' | 'admin'`, not `string`, without `as const`; the mismatch surfaced far away, at a database write.
- `betterAuthHandler()` answers Better Auth's own server error as a failure of the authentication service, with the application's error page or JSON envelope, not Better Auth's blank 500.
- `password()`'s documentation is on `password`; it sat above `currentPassword`, so `password`'s type showed none.
- A user Better Auth keeps without a database row, as its memory adapter and stateless sessions keep them, decodes with a field Better Auth left unset as `null`: a user an OAuth provider gave no image had `image: undefined`, which the session schema refused, so every request they made answered 500 ("Authentication provider returned an invalid session").
- A session Better Auth renews while loading it sends the browser its renewed cookie, and a session revoked elsewhere has its cookie cleared. The session was loaded through `auth.api.getSession`, which drops the cookies it sets, so the browser's cookie expired on its first date while the session lived on in the database, signing an active member out, and a revoked session's cookie was sent with every request.
- A failure Better Auth answers with a redirect, such as a used or expired magic link (`?error=INVALID_TOKEN`), fails `betterAuthRedirect` and `betterAuthCall` as a rejection does, with `error.code` naming it, so the action can show it. It counted as a success: the visitor was sent on to `redirectTo` without a session. Any other redirect Better Auth answers fails with `AuthRedirect`, which the error page follows.
- An Inertia visit that a response redirects to another site, such as an OAuth provider or a payment page, gets the 409 and `X-Inertia-Location` Inertia asks for, with the response's cookies, and Inertia loads the site as a full page. It got the redirect, which an Inertia visit cannot follow to another site.
- `betterAuthCall` and `betterAuthRedirect`'s `redirectTo` type an endpoint's result as the JSON Better Auth's handler answers, with dates as ISO strings: it was typed with `Date`s, so an endpoint whose success schema had `S.Date` failed after Better Auth had created the user. The bearer plugin's `set-auth-token` header reaches the response.
- A response that sets a cookie and no `Cache-Control`, such as a sign-in's, gets `no-store` rather than `private, no-cache`.
- The JSON error envelope's `httpStatus` is an integer, so its JSON Schema no longer admits `NaN` or `Infinity`.
- The page data `createTemplate` embeds writes every `<`, `>`, `&`, U+2028 and U+2029 as a JSON `\\u` escape. It escaped only `/`, so a value a visitor wrote containing `<!--<script>`, such as a product name, made the HTML parser read past the page data's closing tag: the page data no longer parsed and the page's scripts never loaded, for everyone viewing that page.
- `upload(...)` checks that a file's contents are what its declared type says: a PNG, JPEG, GIF, WebP, AVIF, HEIC, BMP, PDF or ZIP must start with its signature, and no other image may be markup, so an HTML page sent as `image/png` is refused ("The file is not a PNG image"). It trusted the type the browser declares. Decoding an upload now reads the file, so it decodes with `validateRequest` or `S.decodeUnknownEffect`, not synchronously.
- The README's sign-in schema validated the password with `requiredString`, which trims it, while sign-up kept it as typed: a password chosen with outer spaces never signed in. `currentPassword` from `@popcomputer/web/schema` validates a password to sign in with, required and never trimmed, and the README uses it. `password({ min: 1 })` reads "at least 1 character".
- The type declarations' examples for `RequireAuthLayer`, `RequireGuestLayer`, `createGuestLayer`, `intendedUrl` and `setupWeb` show the current APIs.

### Changed

- The README says what an OAuth sign-in leaves the application to decide: the `?error=` codes a refused sign-in lands with, refusing an email the provider has not verified by throwing from `databaseHooks.user.create.before`, and whether name and email follow the provider (`overrideUserInfo`). Its `createAuth` comment says Better Auth's own limits also cover signing in and up, three from one address in ten seconds. The `testD1` example resolves the migrations folder from the module, not the working directory.
- The README's memberships example binds the member a path names, `/orgs/{organization:slug}/members/{member:userId}` with `member: schema.memberships` among the bindings, so `bound('member')` loads the organization's membership of that user and another organization's member is a 404. It read the user's id as a plain parameter and queried for it, which both round 15 builders copied. AGENTS rule 6 says to bind every record a path names.
- `kvCache` keeps its keys under `popweb:cache:`, so a KV namespace can hold the application's other data, as the README's own audit log example does, which the cache never reads, lists or deletes. Its keys were the cache keys as given, so `cacheInvalidatePrefix('user:')` deleted any key of the namespace starting `user:`, and `cacheInvalidatePrefix('')` every key in it. Entries a deployed application cached before are read as misses, computed again, and expire on their own.
- A Better Auth call that fails hands the application's response only Better Auth's cookies, and a redirect's `Location`, not its other headers: they described Better Auth's own answer, such as its `Content-Type` and `Content-Length`. A call to Better Auth's handler that throws, whatever it throws, is a failure of the authentication service (502) whose message no visitor sees; the handler answers every rejection itself, as a response.
- `auth.signInLimits` does not count a sign-in through an identity provider (`/sign-in/social`, `/sign-in/oauth2`, `/sign-in/sso`) against the client's address: it checks no password here, and an office signing in together through one address hit the limit.
- The README has a section on signing in with an OAuth provider, a company's own through Better Auth's `genericOAuth` or one Better Auth knows: `signInSocial` from an action, Better Auth's handler registered on the provider's callback alone rather than on all of `/api/auth/*`, implicit account linking off so an account reporting someone's email is not given theirs, `onAPIError.errorURL` on the application's page, Better Auth's limit on sign-ins from one address, and a test standing in for the provider through `fetch`. The plugins section says why to check roles before calling the organization plugin, and that on D1 Better Auth writes each row on its own, so an organization and its owner go in the application's own `dbBatch`. Both builders of the round 15 exam had to find each of these in Better Auth's source.
- `betterAuthHandler` is a function: `routes.all(paths.authApi, betterAuthHandler())`. Better Auth's sign-up and update-user, which it exposes, write the user fields declared `input: true` without the application's actions checking them, so once the registered Better Auth declares one, TypeScript asks for those visitors may set there, `betterAuthHandler({ settable: ['timeZone'] })`, and the handler refuses a request setting any other with a 400.
- `better-auth`'s peer range is `>=1.7.7 <1.8.0`, the releases the Better Auth tests pass against, in place of every 1.x. A test fails if the installed Better Auth is outside it.
- `betterAuthLogoutAction` signs out through Better Auth's request handler, as every other call does, rather than its server API.
- The README makes a new member's own records, such as a profile, on their first visit, in a guard layer, rather than in sign-up's `redirectTo`: users Better Auth creates from an OAuth provider or a magic link never pass through a sign-up action. A new section, "Better Auth's plugins", shows where organizations, two-factor, OAuth providers and magic links meet the application.
- The README's page caching and its upgrade guide say a response that sets a cookie and no `Cache-Control` gets `no-store`.
- The README's tests get a fresh PGlite database per test from a snapshot of the migrated one, `dumpDataDir` then `loadDataDir`: about 70 ms a test against about 450 ms to create and migrate even a one-table database. On D1, one Miniflare with a database per test is disposed in a `bunfig.toml` preload, since an undisposed one keeps `workerd` running after `bun test` exits. The first test example reads its page with `readPage`, and the README says why `readJson` beats `await res.json()`.
- The README gives Better Auth's tables for Postgres and Cloudflare D1, including `rateLimit`, where `auth.signInLimits` counts failed sign-ins; the setup keeps Better Auth's own limits in memory. Both were checked by signing up, signing in and being rate limited against them. Installation names the development tools and their versions (drizzle-kit, `@cloudflare/workers-types`, PGlite, Miniflare) and the module type `oxlint.config.ts` needs. The webhook example rejects a signature that is not 64 hex digits before verifying it.
- Every response gets, unless it sets its own, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` and refused framing (`X-Frame-Options: DENY`, `frame-ancestors 'none'` added to its `Content-Security-Policy`), so another site cannot frame a page to trick a visitor into clicking. `security.headers` takes `{ frames: 'same-origin' }`, or `false` for none; `securityHeaders` from `@popcomputer/web` adds them to a lower-level composition.
- `readMigrations(folder)` from `@popcomputer/web/testing` returns drizzle-kit's migrations as statements, for a database that runs many at once: a fresh D1 database migrates in one `batch`.
- `setupWeb`'s `auth.homePath` names where a signed-in visitor goes from a page for guests; `RequireGuestLayer`, and `createGuestLayer` without its own destination, send them there instead of always to `/`.
- The application's own services are given after the registration, `export const { app, routes } = web.services({ app, request })`, in place of `setupWeb`'s `services` option, which is now a type error and throws with directions. `setupWeb`'s type no longer includes them, so a service layer's type is inferred even when it uses `dbQuery`, `config` or `bound`: the annotation every such layer needed, and the `'web' implicitly has type 'any'` (TS7022) error reported at `web` without it, are gone. The routes `web.services` returns accept actions using the services; `web.routes` remains for an application without services of its own. `services.app` is still built once per isolate, a request service still replaces an application service with the same tag, and `testEnv`'s layers replace both.
- The README follows services moving to `web.services(...)`. Layers' types are inferred, so the advice to annotate them and the tradeoff it described are gone. The type-error table names the `services` option `setupWeb` no longer takes. Upgrade step 5 moves `effect.services`, and a pre-release's `services`, to `web.services`. The data cache, scheduled work and testing say "the `app` and `request` layers".
- The README's caching section opens with subsections for the data cache, tagging cached data, store failures and work after the response, and its first example caches a `dbQuery` rather than a promise read outside it.
- The README's Testing is split into subsections: a request through the application, reading a response (with every reader), one visitor across requests, fakes for other systems, time, and what test files share. The task index links to them.
- The README's "Responses and failures" is split into subsections: flash and failed forms, cookies, files, headers and polling, JSON clients, JSON responses declared by a schema, failures a client reads, reporting failures, and the error page. The "Which API for which task" rows link to the subsection that answers them.

### Removed

- `effectifyBetterAuth`, with `BetterAuthEffectApi`, `BetterAuthEffectClient`, `BetterAuthBoundaryFailure` and `BetterAuthActionResult`, from `@popcomputer/web/auth`. It called Better Auth's server API, which skips its rate limits and origin checks, beside `betterAuthRedirect` and `betterAuthCall`, which send calls through its handler: two ways in, one of them unsafe in an action. Code outside an action calls Better Auth's own `auth.api`.

## [1.0.0-next.6] - 2026-10-13

Changes since 1.0.0-next.5.

### Fixed

- Production's 404 message reads "Nothing was found at this address.", for an API's client as for a visitor, in place of "The page you requested was not found."

- `authorize()` without a check is typed as failing only with `UnauthorizedError`; a check adds `ForbiddenError`, whose message `authorize(check, message)` sets.

- A failed form's field errors, and flash values, pass through a request that only redirects, such as a home page sending visitors to their dashboard, to the next page that renders. They were cleared by the redirect, so a form posted without a `Referer`, which goes back to `/`, showed no errors.

### Added

- An endpoint contract's `auth: true` requires a signed-in user: the action runs only for one, receiving it as `auth`, and anyone else is answered 401 before the input is read. `openApi` lists the 401 of such an endpoint and the security schemes its new `security` option names, the 404 of an endpoint whose path names a record, and the limits a validator's checks add, such as `requiredString.check(S.isMaxLength(200))`'s `maxLength`.
- `isoDate` and `isoDateTime` from `@popcomputer/web/schema` accept a calendar day written `YYYY-MM-DD`, kept as that string, and a moment with its time zone, as a `Date`, refusing days the calendar lacks and times without a zone. JSON Schema describes them as `format: date` and `format: date-time`.
- `testEnv(bindings, { database })` takes bindings without a layer, for a test whose visitors sign in through the application.
- `routes.scheduled((event) => effect)` and `routes.queue(Schema, (body, message) => effect)` return the Worker's `scheduled` and `queue` handlers, running each job with the application's services and type-checking it as a registration does. The queue handler decodes each message's body with the schema, acknowledges a message whose work succeeds, and logs and retries one whose body does not decode or whose work fails. `testBatch(bodies)` from `@popcomputer/web/testing` makes a batch that records each message's outcome.

- `call(endpoint, input, options)` takes input that leaves out the fields that may be null, such as a `nullable(...)` filter, and a `testBrowser` is a `fetch` it sends with: `call(endpoints.listPlaces, { query: { minRating: 3 } }, browser)`.
- `setupWeb`'s `version` and `render` are optional. An application without `render` is an API: it answers only JSON, failures and unknown paths included, whatever the client asks for, and rendering a page is a configuration error naming the fix.
- `BoundRequirements<'project'>` from `@popcomputer/web/effect` names what an Effect reading route models with `bound()` requires, for a helper whose type is written out, in place of `BoundModels | RouteModel<'project'>`.
- The lint rule `prefer-checked-config` reports Effect's `Config.String('NAME')` and its siblings where the framework's `config.string('NAME')` reads the same binding and checks its name.
- The lint rule `no-auth-api-in-action` reports a Better Auth endpoint called through `auth.api` in an action, and `no-catch-all-in-action` reports broad recovery piped point-free, as `authorize().pipe(Effect.orDie)`.

### Changed

- The release these pre-releases lead to is 1.0.0, not 0.8.0. The pre-releases are renumbered `1.0.0-next.N`, keeping their numbers: a build packed as `0.8.0-next.N` is `1.0.0-next.N`, and an application on one reads the sections newer than `1.0.0-next.N`.
- A route's `cache: false` is `cache: 'private'`, which says what the response gets: each request renders the page, and only the visitor's browser keeps it (`private, no-cache`), beside `cache: 'no-store'`, which no cache keeps.
- `routes.prefix(prefix)` takes the declared paths under the prefix, whole, in an application that declares its paths: `routes.prefix('/orgs/{org}').get(paths.orgSettings, ...)` registers `/orgs/{org}/settings`, and a path that is not declared, or not under the prefix, is a type error. A prefixed route's page was declared twice before: relative under the prefix, and whole in `src/paths.ts` for `href` and `redirect`. Without declared paths, a path relative to the prefix still works. An endpoint registers under a prefix its path starts with.
- `betterAuthRedirect(endpoint, input, options)` and `betterAuthCall(endpoint, input, options)` name a Better Auth endpoint on `auth.api`, as `betterAuthRedirect('signInEmail', { body: input }, { redirectTo, errors })`, and send the call through Better Auth's request handler, so its rate limits, origin checks and plugins' hooks apply: a server call through `auth.api`, which the callback form made, skips them, leaving sign-in forms open to password guessing. Better Auth's types check the endpoint's name and body, and type its result for `redirectTo` (sign-up's `{ token, user }`); the call no longer passes `headers`, `asResponse` or `returnHeaders`. The README's auth setup turns on Better Auth's rate limits, which it enables only when `NODE_ENV` is `production`, with database storage shared across Worker isolates and Cloudflare's client address header. `errors` may leave fields `undefined`.
- Each `testBrowser` sends its own client address (`CF-Connecting-IP`, `X-Forwarded-For`), so per-client rate limits count browsers apart.
- `testBrowser(app, env).follow(res)` follows any redirect, keeping the cookies it set, including one a test requested with `app.request`. `followRedirect(app, res, env)` is removed: use `testBrowser(app, env).follow(res)`.

- The README's helper that reads a route model is typed with `BoundRequirements<'project'>`, and the upgrade guide from 0.7 renames `cache: false` to `cache: 'private'` and uses `BoundRequirements` in its route model step.
- The README documents `routes.prefix(...)` with declared paths: Quick start's step 4 says what a prefix binds and that each route under it takes its whole declared path, and the memberships pattern registers its routes under one.
- The README's patterns show roles per organization in full. The role lives on a membership row, a guard layer reads it and provides it as a service, and an action states the role it needs. A visitor who is not a member gets 404, and a member without the role 403.
- The README's route model binding section is split by question: what a model is, when it loads, how nested models are scoped, what a lookup column must name, plain parameters, and reading a model from a helper. The last has a type-checked helper whose type carries `RouteModel<'project'>`, and the section says how to lock a bound record in a transaction.
- The README's "Reading the type errors" says where each of the framework's type errors appears, what it means and what to do. It covers the registration's `missingServices`, `unhandledErrors` and `missingRouteModels`, a stale `catchTag`, TS7022 at `setupWeb`, and the D1 errors.
- The README's patterns show several forms on one page in full. A rename form on each row of the project list names its own Inertia error bag, so its errors don't appear in the create form beside it, which has a `name` field too.
- The README's Quick start has a sixth step, "Wire the Worker". It shows the entry module that imports every module of registrations, since a module nothing imports leaves its routes answering 404. It also gives a table of the application's files and what each declares.
- The README's patterns show cursor pagination in full: an action reading its query through `validateRequest`, a keyset query over a timestamp and an id, and the page's `next` cursor. It explains why a Postgres timestamp behind a cursor needs millisecond precision and a time zone. `Projects/Index` in the README's examples carries `next`.
- The README's "Which API for which task" indexes each task an application performs by the one API that does it, with the section that shows it.
- The README's Quick start has a fifth step, "Write the client". It covers a form page typed with `FormInput`, the sign-in page, a page reading shared props, the error page, and `main.tsx`, whose page map makes a page without a component a type error. Form schemas live in `src/forms.ts`, which actions and pages both import. The README's React examples type-check against `@inertiajs/react`.
- The README's upgrade guide from 0.7 shows the 0.7 code each step replaces. It adds the steps it missed: imports from one entrypoint and the removed synonyms, the removed route validation options, and the CLI. It also lists the changes no type error points at, such as origin verification and upload families. The webhook pattern refuses through `httpError` and acknowledges with `noContent`.

## [1.0.0-next.5] - 2026-10-13

Changes since 1.0.0-next.4.

### Added

- Endpoint contracts, from the new `@popcomputer/web/endpoint` entrypoint, which imports only `effect`: `endpoint.get/post/put/patch/delete(path, { query, body, headers, success, status, errors })` declares a JSON endpoint once. `action(endpoint, ({ params, query, body, headers }) => effect)` implements it with its input decoded (invalid input answers 422 before the handler runs) and returns the success value, which is encoded through `success`, so only declared fields leave the server; a failure declared under `errors` (a tagged schema) is answered with its status, its `_tag` as the envelope's `tag` and its fields as `body`. `routes.endpoint(action)` registers it on the contract's method and path and answers JSON, and reports an undeclared failure as `unhandledErrors`. `call(endpoint, input, { fetch })` sends typed input and reads `{ ok, value }` or `{ ok: false, error }`, with declared failures decoded and the rest as `EndpointFailure`; `endpointRequest` and `readEndpoint` are its two halves. `openApi(endpoints, info)` describes every endpoint as an OpenAPI 3.1 document, giving validators that accept form posts the JSON type a client sends.
- `HttpError` takes a `tag` the JSON envelope reports in place of `HttpError`.
- Lint rules ship with the package, from `@popcomputer/web/lint`, as an Oxlint (and ESLint) plugin: `defineConfig(webLint())` in `oxlint.config.ts` turns them on. They report what types cannot see: an `update` or `delete` without `.where(...)`, a write in `dbQuery` (fixable), network, cache or sleep calls inside `dbTransaction`, SQL built from strings, request input read around `validateRequest`, `DatabaseService` in actions, broad recovery over the database or `authorize()`, raw `Response`s, `Effect.provide` and runners in actions, `waitUntil`, and `validateRequest` or `json` in an endpoint's action. Each message names the API to use instead. The README's and AGENTS.md's examples are linted with them.
- `responseHeader(name, value)` adds a header to whatever response the request ends with, failures included, from an action or a guard layer.
- `routes.options(path, action)` registers an OPTIONS route, such as a CORS preflight, and `noContent(headers)` answers 204 with no body or content type.
- `betterAuthCall(call, { errors })` from `@popcomputer/web/auth` calls Better Auth for a result the action uses, mapping its failures as `betterAuthRedirect` does.
- `ACTIVE_CONTENT_TYPES` is exported from `@popcomputer/web/schema`.
- `UnauthorizedError`'s `challenge`, such as `'Bearer'`, is sent as `WWW-Authenticate` on a JSON 401, whatever headers the request carried.
- `FormErrors<typeof Schema>` from `@popcomputer/web/react` types a form's field errors by the fields of its schema.
- `testBrowser` names the page it last showed as the `Referer` of a form it posts, and `setCookie(name, value, path)` gives it a cookie.

### Fixed

- A write run in `dbQuery` by mistake that breaks a constraint is a defect naming `dbMutation`, rather than a `DatabaseError` that field-error mappings silently missed.
- `testBrowser.follow` refuses a response the browser did not receive, rather than following it without its cookies.
- `betterAuthRedirect` keeps Better Auth's session cookie when `redirectTo` fails after Better Auth signed the visitor in, such as a sign-up whose follow-up refuses; the visitor was left signed out of the account just created.
- The development error page of a violation of a named constraint shows the `constraintFieldErrors` entry that would map it.

## [1.0.0-next.4] - 2026-10-13

Changes since 1.0.0-next.3.

### Added

- `constraintFieldErrors({ name: { field: message } })` shows a violation of a named constraint of any kind (a `CHECK`, an exclusion constraint, a trigger) as field errors.
- `FormInput<typeof Schema>` from `@popcomputer/web/react` types a form's fields from the schema its action validates them with.
- `cookie(name, Schema, { signed: { secret } })` signs the value with the secret in that binding (HMAC-SHA256); a value without a valid signature reads as none.
- `testBrowser(app, env)` from `@popcomputer/web/testing` keeps a visitor's cookies across requests, sending each to the paths it covers and dropping the ones a response clears, and follows redirects.
- `betterAuthLogoutAction({ clear: [cookie] })` clears declared application cookies on sign-out; `cookieNames` is documented as replacing Better Auth's session cookie names.
- A `{param:column}` naming no column of its binding's table fails when the route is registered, listing the table's column keys.
- `ifChanged(etag, response)` answers `304 Not Modified` before running the response's Effect, for a body that costs a query to build.
- `readCookie(response, cookie)` from `@popcomputer/web/testing` reads the value a response set for a declared cookie.
- A cookie's `path` takes `{param}` placeholders, filled from the route that sets it.

### Fixed

- An upload's size limit reads in decimal units: `maxBytes: 10_000_000` is `10 MB`, not `9.5 MB`.
- `createGuestLayer`'s `redirectTo` takes a declared path, as other redirect targets do; the removed `createErrorHandlers` no longer appears in the published types.
- A malformed body sent without a JSON or form media type says it could not be read as JSON, rather than asking for a matching Content-Type.
- A cookie whose value's JSON form is a string is stored as it is, so a cookie an application wrote by hand reads the same after it adopts `cookie()`; one stored as a JSON string by 1.0.0-next.3 reads too. Setting a value the schema rejects is a defect naming the cookie.
- `WWW-Authenticate: Bearer` accompanies a JSON 401 only when the request sent a bearer token.

## [1.0.0-next.3] - 2026-10-13

Changes since 1.0.0-next.2.

### Added

- `cookie(name, Schema, options)` declares an application cookie once: actions read it (`Option`), set it and clear it through the declaration, and the response carries what they set, beside flash, through a redirect.
- `json` and `text` take an `etag`: the response carries it, and a request whose `If-None-Match` names it gets `304 Not Modified` with no body.
- `rowOf` takes a column of the table the insert selects from as a value.
- `tagCache(...tags)` tags a cached response with records the action read beyond its route's bindings, such as the translation a fallback page shows, so purging them refreshes it.
- The route option `cache: 'no-store'` keeps a response out of every cache, browsers included, for a page only its link should show.
- `readError(res).errors` is always present, empty when no field failed (`TestErrorResponse`).

### Fixed

- A route binding given as `tableSchema(table, overrides)` loads from that table; it looked for a table named after the parameter and failed every request. A `routeBinding` `table` option naming no table of setupWeb's schema fails when setupWeb is called, listing the schema's keys.
- `{param}` on a table without an `id` column looks the record up by the table's primary key, such as a `code` key, instead of failing every request.
- The package's exports carry a `default` condition, so tools that load a schema file with `require`, such as drizzle-kit, can load one that imports the package.
- A malformed body answers 400, as its envelope says, rather than 422; a failure is labelled `Required Field Missing` only when every invalid field is missing.
- A body sent without a JSON media type, as `fetch` sends a string (`text/plain`), is read as JSON instead of as no fields; one that is not JSON is a 400.
- A tagged union's unknown kind is reported on its `_tag` (`spec._tag: Choose one of: Threshold, Absence`), the field a form chooses it with.
- A blank number or date input, which a form sends as an empty string, reads `This field is required`, as a missing one does, rather than `Expected a number`.
- A JSON 401 for a request with a bearer token, or on a `jsonApi()` route, carries `WWW-Authenticate: Bearer`.
- `invalidateCacheTags` takes `CacheTag`s, as the other tag APIs do.

## [1.0.0-next.2] - 2026-10-13

Changes since 1.0.0-next.1.

### Breaking

- Route `cache.tags`, `purges`, `purgeCache` and the data cache's `tags` take the schema's tables, by their key in the schema, and record tags (`CacheTag`), once the application registers its schema: a tag naming a table by its SQL name, which nothing ever purged, is a type error. `recordCacheTag` returns a record tag of that table.
- `DatabaseConstraintViolation`'s `constraint` adds `'exclusion'` (Postgres's exclusion constraints) and `'trigger'` (a SQLite or D1 trigger's `RAISE(ABORT, 'name')`, with the name as `constraintName`); both were a `DatabaseError`, a 500.

### Added

- `rowOf(table, values)` from `@popcomputer/web/drizzle` builds an insert-select's fields from the table: every column in its order, the values given bound as their columns encode them, and the rest their defaults, so a conditional insert on D1 (`db.insert(t).select(db.select(rowOf(t, values)).from(...).where(condition))`) names no column by hand.
- `validateRequest(Schema, { redirectTo })` sends a failed form to the page given, such as a wizard's step, with its errors.
- `httpError(status, message, Schema, body, { headers })` carries headers, such as `Retry-After`, beside a typed body.

### Fixed

- `readPage` and `readErrorPage` explain an asset version conflict (409) instead of asking for the `X-Inertia` header the request sent.
- A route under a prefix with `{placeholders}`, such as `routes.prefix('/orgs/{org}').get('/settings', ...)`, answered 404: the prefix's placeholders were registered literally. They are now route parameters and bind models, and `purges: true` under such a prefix purges them.
- Page props, shared props, flash values and the shared `auth.user` are encoded from their schema's type, which is what the React page receives as JSON: a schema built from validators, such as a filter form's, serves as a page's props, where a date in it failed with `Expected JSON value`.
- `ensureArray` reports a failing item under its index (`tags.1`), as `S.Array` does.
- `required(message)` shows its message when the field is missing, such as an unselected radio group, as well as when it is blank.
- `nullable(Group)` reads a form group whose every field is blank as `null`.
- A value outside a set of options reads `Choose one of: approver, finance` rather than Effect's `Expected "approver" | "finance"`, and one matching no kind of a union of objects says so rather than printing the schema.

## [1.0.0-next.1] - 2026-10-13

Changes since the previous pre-release. Every pre-release now has its own
version, so an upgrade names what changed since the one installed.

### Added

- `routes.jsonApi()` declares a group of routes as a JSON API: every request to them is a JSON client, whatever headers it sends, so a client without `Accept` or `Authorization` gets a 401 instead of a redirect to sign in, and the JSON envelope for every failure.
- Origin verification answers through the error boundary, so a refused visit gets the error page and a JSON client the envelope, and lets a request with an `Authorization` header through, since a browser never adds one cross-site by itself. A route registered twice says so.
- `BatchStatement` names a statement `dbBatch` takes, for a helper that returns statements; a raw `db.run(sql)` beside query-builder statements in a D1 batch is a type error too.

## [1.0.0-next.0] - 2026-10-13

Changes since 0.7.0. Pre-release builds before 1.0.0-next.1 all carried this
version.

### Breaking

- `setupWeb` verifies the `Origin` (or `Referer`) of state-changing requests by default, refusing another site's with 403; requests without either header pass. `security: { verifyOrigin: false }` turns it off, and `allowedOrigins` lists other origins that post.
- `upload`'s type families, such as `image/*`, leave out types a browser runs script in (`image/svg+xml`, HTML, XML), which are accepted only when named. `file()` sends `X-Content-Type-Options: nosniff`, and a body of such a type shown inline, without a `filename`, gets `Content-Security-Policy: sandbox`: an uploaded SVG served back ran script on the application's origin.
- `validateRequest` nests form and query fields named `lines[0][quantity]` or `lines.0.quantity` into objects and lists, and reads every value of a `tags[]` field, so a list in a form post or a multipart post (which Inertia sends for a form with a file) decodes as it does from JSON; such a form failed with `lines: This field is required`. `RequestContext` has `queries()`, and its `parseBody()` gives each value of a field sent more than once: a hand-built `RequestContext` adds `queries`.
- A request that asks for no HTML is a JSON client when it sends an `Accept` header (`fetch`'s `*/*`) or an `Authorization` header, as well as when it asks for or sends JSON: its failures are JSON (a 422 with the field errors, a 401 instead of a redirect to sign in), and `prefersJson` and `jsonOrRender` answer it with JSON. An API client with a bearer token got an HTML error page, and a revoked key was redirected to `/login`. Browsers, which ask for HTML, and Inertia visits are unchanged.
- `bound('project')` requires `RouteModel<'project'>`, which a route whose path or prefix has `{project}` provides, so an action or a guard layer reading a model its route does not bind is a type error at the registration (`missingRouteModels`) instead of a `RouteConfigurationError` at request time. `routes.run` binds no models. A helper annotated `Effect.Effect<A, E, BoundModels>` adds `RouteModel<'project'>`, and `BoundModels.fromModels(models)` binds the models it holds.
- `cacheInvalidate` and `cacheInvalidatePrefix` report a store failure to `EffectErrorObserverService` and succeed, instead of failing with `CacheError` (503): they follow a write that has already happened, so the 503 told the visitor a saved change had failed. The entry stays until it expires.
- `signedIn` gives a user without a `name` the name `Test User` instead of `null`, which fits Better Auth's `user` table, whose `name` is not null.
- `readPage(...).flash` is typed by setupWeb's `flash` declaration (`FlashData`) instead of `Record<string, unknown>`.
- A `{param}` without a parser in `bindings` is a plain parameter, read with `validateRequest`, beside the route's models. `bound()` failed on any route that mixed the two, because every placeholder was loaded as a model. `bound('param')` for a plain parameter fails with a configuration error naming it, and route parameter validation and cache tags cover only the route's models.
- `purges: true` on a route whose path has no `{param}` throws at registration, naming the route; it purged nothing. List the tags such a route changes, as in `purges: ['posts']`.
- Responses the `cache` route option stores vary on `Cookie` as well as `X-Inertia`. Workers Cache served a guest's cached page to a signed-in member (`auth.user: null`) and to a form redirecting back with flashed errors; now any request with a cookie renders afresh. A signed-in request on a cached route gets `Cache-Control: no-store` instead of no header and a development warning.
- `setupWeb` gives every response without a `Cache-Control` header `private, no-cache` (`DEFAULT_CACHE_CONTROL`, applied by `privateByDefault()`). With Workers Cache enabled, a response without one is stored for a heuristic lifetime and served to other visitors.
- Cache tags name records by primary key: a bound page carries `{table}:{primary key}` for each record it reads (`recordCacheTag(table, key)`), and `purges: true` purges the records its route's bindings name plus the table of the record it writes. A page read through `/posts/{post:slug}` is now purged by `PUT /posts/{post}`; tags used to name the route parameter (`post:hello-world`), so the two never matched. Bound pages no longer carry a collection tag, so a write to one record no longer purges every other record's page; an index declares the table in its `tags`. A route whose action never loaded its models loads them after it succeeds to name their records.
- `redirect(path, params, query)` fills a route path's placeholders and always answers 303: `redirect(paths.project, { project: project.id })`. The status argument is removed; a `Redirect` value can still carry another status.
- An application declares each type once, in `setupWeb`, and registers the result once: `export const web = setupWeb(new Hono<Env>(), config)` and `declare module '@popcomputer/web' { interface Register { web: typeof web } }`. The bindings type comes from the Hono environment, the database and auth types from the `database` and `auth.client` factories, the signed-in user from `auth.session`, route models from `bindings`, and pages from `pages`. The augmentation interfaces `WebDatabaseType`, `WebAuthType`, `WebBindingsType`, `WebAuthUserType`, `WebRouteBindingsType` and `WebPagesType`, which restated those types, are removed with `SessionParserOption`; `auth.session` is never separately required, since the user type is what it decodes. A test or hand-composed application registers types directly with `WebDeclaration<{ database: ... }>`.
- `auth.share` is an Effect Schema of the public user, through which the signed-in user is encoded as the `auth.user` page prop, instead of a projection function; a field it does not name never reaches the browser. `shareAuth` and `shareAuthMiddleware` take `{ schema }` instead of `project`, `fields` and `mapUser`.
- `SharedProps` from `@popcomputer/web/react` is derived from the registration (`auth.user` from `auth.share`, plus the `shared` props) instead of an interface the application augments.
- `dbTransaction` runs an Effect instead of a promise callback: `dbTransaction(Effect.gen(function* () { ... }))`. Inside it `DatabaseService` is the transaction, so every `dbQuery` and `dbMutation` the Effect runs, including those of services it calls, takes part, and domain logic between writes stays Effect code. The transaction commits when the Effect succeeds and rolls back when it fails, failing with the Effect's own typed error instead of a `DatabaseError`.
- Auth routes are ordinary routes on `routes`. `effectAuthRoutes`, which registered pages, actions and Better Auth's API on the Hono app, is removed with `AuthRoutesConfig` and `AuthActionEffect`, and `betterAuthFormAction` is replaced by `betterAuthRedirect(call, { redirectTo, errors })`, which a sign-in or sign-up action calls after its own `validateRequest`, so it can use the validated input for anything else first. `betterAuthHandler` forwards `routes.all('/api/auth/*', ...)` to Better Auth's API.
- A signed-out visitor goes to setupWeb's `auth.signInPath` (default `/login`) instead of a hard-coded `/login`: `authorize()` and `RequireAuthLayer` fail with an `UnauthorizedError` without `redirectTo`, and the boundary resolves it. `betterAuthLogoutAction` redirects to `/` by default.
- `RequestContext` has `raw()`, the request itself, for adapters that forward it.
- `WebPage<Props>` includes the shared props and `errors`, so `WithSharedProps` is removed. The `PageProps` exported from `@popcomputer/web` and `@popcomputer/web/react`, a second type of that name, is removed.
- `jsonOrRender` responses vary on `Accept` as well as `X-Inertia`, so a cache no longer serves a page's JSON to a visit or its HTML to an API client.
- A form submission that fails validation redirects back (303) to the page it came from, which receives the field errors as `errors` on its next render, as Inertia expects. The page renders with all of its own props; `errorComponent` re-rendered the form with only `errors`, so an edit page lost the record it edits. `validateRequest`'s `errorComponent` option, `betterAuthFormAction`'s `errorComponent`, `ValidationError.component` and `renderWithErrors` are removed. Errors go under the form's error bag when Inertia sends `X-Inertia-Error-Bag`. Invalid query parameters on a page visit render the error page with 422, and JSON clients get a 422 as before.
- `PageService` has `flash(key, value)` in place of `setErrors`.
- Database operations read the request's client from `DatabaseService` and give their callback the application's Drizzle client with its own types: `dbMutation(db, input, (tx, values) => ...)` is `dbMutation((db) => ...)`, and `dbTransaction(db, ...)` is `dbTransaction(async (tx) => ...)`. The `SafeTx` wrapper that required `asTrusted` or validated values erased the table type of `insert`, `update` and `delete`, so `.returning()` rows were `{ [x: string]: any }` and `.values()` and `.set()` checked no columns. Drizzle's own types now check every column, and `validateRequest`, the only way an action reads request input, removes undeclared keys. `asTrusted`, `Trusted`, `Validated`, `SafeTx`, `MutationInput` and `mergeMutationInput` are removed, and `validateRequest` returns the decoded value unbranded.
- `DatabaseMutationFailed` and `DatabaseTransactionFailed` are one `DatabaseError` with an `operation` (`query`, `mutation`, `transaction` or `batch`), with the code `WEB_DB_501_OPERATION_FAILED`. `DatabaseConstraintViolation` has `columns` and an optional `constraintName`.
- `dbTransaction` is a type error for a driver whose transactions are synchronous, such as `bun:sqlite`: its `transaction()` commits as soon as the callback returns, before any awaited write runs, so earlier writes stayed committed when a later one failed. On D1, which rejects `BEGIN`, a transaction is a defect whose message names `dbBatch`.
- `RequestContext.json()` returns `Promise<unknown>` instead of a caller-chosen type.
- `signedIn(user)` accepts partial user fields only when Better Auth's default session fits the application's signed-in user; an application whose `auth.session` adds required fields, such as a `role`, passes them, since they have no test default.
- `setupWeb` has one signature instead of overloads for applications with and without a database, so a configuration mistake is reported against the configuration rather than against the last overload.
- The data cache is an application service: provide a store with `kvCache(c.env.KV)` from `@popcomputer/web/cache` in `services.request`. Requests no longer get a `CacheService` backed by a binding named `KV`, or one that failed every call when that binding was absent. `cache()` fails only with its computation's errors: an unreachable store, or an entry that no longer matches the schema, computes the value instead and reports the failure to `EffectErrorObserverService`. `cacheGet` reads such an entry as absent. `cacheGet`, `cacheSet`, `cacheInvalidate` and `cacheInvalidatePrefix` fail with `CacheError`, now one of the package's errors (`WEB_SVC_702_CACHE_UNAVAILABLE`, 503). `CacheClientError` is removed; `CacheClient` implementations fail with `CacheError`.
- `setupWeb`'s `effect: { services }` option is `services: { request }`, and `services.app` adds services built once per isolate and shared by every request. Passing `effect` is a type error and throws with directions. Request services replace application services with the same tag; test layers from `testEnv` replace both.
- `setupWeb(app, config)` returns `{ app, routes }` where `routes` is the route builder for the application, typed by the setup: an action registered on it may use the core services, `DatabaseService` only when `database` is configured, `AuthService` only when `auth.client` is, and the services of `effect.services` and `routes.provide(layer)`. Anything else, or a failure that is not one of the package's errors, is a type error at the registration naming it (`missingServices: "@popcomputer/web/Database"`, `unhandledErrors: "PaymentDeclined"`). `routes` replaces the `RouteRegistry` setupWeb returned; `routes.toJson()` lists the routes and `routes.getRegistry()` returns the registry. `effectRoutes(app)` remains for hand-composed applications and accepts every framework service.
- Routes no longer validate input themselves: the `body`, `query`, `response`, `validateBody`, `validateResponse` and `parseOptions` route options are removed, with `validatedBody`, `validatedQuery`, `ValidatedBodyService` and `ValidatedQueryService`. `validatedBody<T>()` returned whatever type its caller named, whatever the route's schema was. Validate inside the action with `validateRequest(Schema, { request: { order: ['body'] }, parseOptions })`, which returns the schema's type. (`validateResponse` was never implemented.)
- `RouteRegistry` keeps `register`, `all`, `find`, `findByName`, `count`, `has` and `toJson`. `byMethod`, `byPrefix`, `findByPathAndMethod`, `clear` and `toTable` are removed, and route metadata no longer carries schemas, `handlerName` or `sourceLocation`; `toJson()` returns `{ method, path, fullPath, bindings, name }`.
- Route models load when the action first calls `bound()`, instead of before the action runs. A `{param}` the action never reads with `bound()` no longer answers 404 for a missing row, and `bound()` fails with `NotFoundError` (404) when the row is missing. `BoundModels` is a loader service with a `get(key)` method rather than a map; provide fixed models to an action run outside a route with `BoundModels.fromModels({ project })`.
- `validateRequest` fails with a `ValidationError` when route params, query and body provide the same key with different values (`WEB_VAL_006_SOURCE_CONFLICT`, naming the field and both sources). It merged them with the later source winning, so a body field such as `{ "id": "..." }` silently replaced the route's `{id}` parameter. Pass `request: { onConflict: 'last-wins' }` to restore the merge, or `request: { order: ['body'] }` to read only the body.
- The `request.profile` option of `validateRequest` (`'legacy'` or `'laravel'`) and the `RequestValidationProfile` and `RequestValidationConfig` types are removed. `request.order` selects the sources: `['query', 'body']` is the former `'laravel'` profile.
- The default auth user's `session.token` is `Redacted<string>`, decoded with `Schema.RedactedFromValue(Schema.String)`, so returning or rendering the auth user cannot expose the session secret. Read it with `Redacted.value`. An application's own `auth.session` decides its token's type.
- Structured error fixes are `{ description, code? }`: what to change, and code to write when there is some. The `id`, `type`, `confidence`, `automated`, `operations` and `postActions` fields are removed; their "automated" edits anchored on `setupWeb({`, which never matched `setupWeb(app, {`, and nothing applied them. Structured errors no longer carry `source` (never populated) or `docs` (every error linked to one README section that documents no codes), and the error page props no longer include `source` or `docsUrl`.
- Production JSON error responses no longer include `fixes`, which described the application's setup to clients. Development responses and error pages still do.
- Error codes the package never emitted are removed: `VAL_002_FIELD_INVALID`, `VAL_005_TYPE_COERCION_FAILED`, `AUTH_103_INVALID_CREDENTIALS`, `RES_201_ALREADY_EXISTS`, `RES_202_GONE`, `CFG_304_BINDINGS_NOT_CONFIGURED`, `DB_500_CONNECTION_FAILED` and `RTE_602_PARAM_VALIDATION`.
- The `Honertia*` and `honertia*` aliases are removed: `setupHonertia` and its nested `honertia: { ... }` configuration, the `honertia` middleware and `c.var.honertia`, `honertiaContext`, `honertiaServices`, `HonertiaService`, `HonertiaRenderer`, `HonertiaConfig`, `HonertiaInstance`, `HonertiaPage`, `HonertiaRequestContext`, `HonertiaProvidedServices`, `HonertiaApplication`, `HonertiaSetupConfig`, `HonertiaFullConfig`, and the `HonertiaDatabaseType`, `HonertiaAuthType`, `HonertiaBindingsType`, `HonertiaAuthUserType` and `HonertiaRouteBindingsType` augmentation interfaces. `UPGRADING.md` lists each replacement.
- Names without a `Web*` replacement are renamed: `HonertiaConfigurationError` is `ConfigurationError` (`_tag: 'ConfigurationError'`), `HonertiaStructuredError` is `StructuredError`, `HEADERS.HONERTIA` is `HEADERS.INERTIA`, and error codes use the `WEB_` prefix instead of `HON_` (for example `WEB_VAL_001_FIELD_REQUIRED`). The unused `CFG_303_HONERTIA_NOT_CONFIGURED` code is removed.
- Every export has one entrypoint. The root no longer re-exports `@popcomputer/web/effect`, `/effect` no longer re-exports the validators (import them from `/schema`), the KV cache (`cache`, `cacheGet`, `cacheSet`, `cacheInvalidate`, `cacheInvalidatePrefix`, `CacheError`, `CacheService`, `CacheClientError`: import them from `/cache`) or the Better Auth integration (`effectAuthRoutes`, `betterAuthFormAction`, `betterAuthLogoutAction`, `effectifyBetterAuth`, `loadUser`, `shareAuth`, `shareAuthMiddleware` and their types: import them from `/auth`), `/schema` no longer re-exports the validation helpers (import `validateRequest` and `asTrusted` from `/effect`), and `/auth` no longer re-exports services, errors and guards (import them from `/effect`). `PAGE_CACHE_TAG` is exported from `/effect` only.
- Synonyms are removed in favour of one API each: `effectHandler`, `effect` and `handle` (register actions with `effectRoutes`); `requireAuth` (use `authorize()`); `requireGuest` and `isAuthenticated` (use `currentUser`); `validate` (use `validateUnknown`); `asValidated` (validation brands its own output; use `asTrusted` for server-derived values); `optionalString` (an alias of `nullableString`); the `S` re-export from `/schema` (import `Schema` from `effect`); and `getGlobalRegistry`, `resetGlobalRegistry` and `findAppRouteRegistry` (`effectRoutes` registers with the app's registry, which `setupWeb` returns).
- Internal plumbing is no longer exported: `buildContextLayer`, `getEffectRuntime`, `getEffectSchema`, `getEffectBindings`, `errorToResponse`, `getStructuredFromThrown`, `classifyDatabaseFailure`, `pluralize`, `parseBindings`, `toHonoPath`, `deriveCacheTags`, `ResponseFactoryService`, `serializePage`, `getValidationData`, `formatSchemaErrors`, `formatSchemaErrorsWithDetails`, the error catalog, formatter and context helpers, and the structured error types other than `StructuredError` and `FieldError`. `ErrorCodes` remains.
- `setupWeb` takes the app: `setupWeb(app, config)`. The middleware-only form `app.use('*', setupWeb(config))`, which skipped the error boundary, is removed, as are `createErrorHandlers` and the `WebFullConfig` type. `registerErrorHandlers` remains for lower-level composition.
- The `popweb` CLI and the `@popcomputer/web/cli` entrypoint are removed, along with the package's `tsx` dependency. The package now has no runtime dependencies. In place of each command:
  - `generate:action`, `generate:crud`, `generate:feature`, `generate:tests-runner`: write actions and tests by hand from the README examples. The generators produced code that failed its own tests, wrote two files to `index.ts` for CRUD, and did not bundle for Workers.
  - `routes`: `setupWeb(app, config)` returns `routes`, a `RouteRegistry`; `routes.toJson()` lists every route.
  - `check`: the type checker and the configuration errors raised at runtime.
  - `db`: `drizzle-kit` or `wrangler d1 migrations`. The CLI kept a separate `.popweb-applied.json` record of applied migrations that could disagree with the database.
  - `generate:openapi`: no replacement yet.
- Test utilities move to `@popcomputer/web/testing`, which exports two functions:
  - `testEnv(layer, bindings?)` builds a request env for `app.request` whose layer's services replace the request's own. It replaces passing a layer as `env.__testLayer`, which is no longer read: an env built from configuration could carry that string key, while `testEnv` attaches its layer where only the package can read it.
  - `signedIn(user)` replaces `TestLayer.Auth.withUser(user)`.

  `describeRoute`, `createRouteTester`, `generateTestCases`, `TestLayer`, `TestCaptureService` and `EmailService` are removed. `describeRoute`'s `as: 'user'` option never signed the request in, and `TestLayer.Database.inMemory` returned every row whatever the query's `where` condition. Assert on responses instead: an `X-Inertia` request returns the page object as JSON.
- `bound(key)` fails with `RouteConfigurationError` (code `RTE_600_BINDING_NOT_FOUND`, with a hint naming the missing `{key}` placeholder) when the route does not bind `key`. It failed with `BoundModelNotFound`, which no route accepted as a handler error, so `effectRoutes(app).get('/projects/{project}', showProject)` with an action that called `bound()` did not type-check. `BoundModelNotFound` is removed; replace `Effect.catchTag('BoundModelNotFound', ...)` with `Effect.catchTag('RouteConfigurationError', ...)`.

### Added

- `dbBatch` takes a list built at run time, such as one statement per line of a form, and returns its results as a list; an empty list runs nothing.
- A route registered after an earlier route whose path matches it, such as `/products/new` after `/products/{product}`, throws at registration naming the order that works; it was never reached. Configuration errors thrown when the application starts carry their fix in the message.
- `cache()` no longer requires `ExecutionContextService`: a service built on it keeps the framework service out of its interface, and a stale value refreshes inline without one.
- The type error for `dbTransaction` on Cloudflare D1, or a driver without transactions, prints its text, naming `dbBatch`.
- A unique index on an expression, such as `lower(handle)`, is reported by its name on SQLite and D1 (`UNIQUE constraint failed: index '...'`), so `uniqueFieldErrors`'s `constraints` map it to its field; it was read as a column named `index`.
- A form posted while signed out goes to sign in with the page the form was on as `?redirect=`.
- `ErrorResponse` from `@popcomputer/web/schema` is the JSON error envelope as an Effect Schema, which a client decodes failures with; `ErrorResponseBody` is its type. `httpError(status, message, Schema, body)` checks and encodes an error's body through a schema, a test reads it with `readError(res, Schema)`, and a client decodes it with `errorResponseWith(Schema)`.
- `cache(key, effect, schema, { ttl, tags })` tags an entry with the cache tags a route's `purges` and `purgeCache` name: the route that purges one of them after a write invalidates the data along with the cached responses. `purgeCache` also works in `routes.run`.
- `testClock`'s `settle(request, maxTurns?)` runs a request that waits on the test clock to the end, moving the clock to the end of each pending sleep in turn, so an action retrying with `Schedule.exponential` waits exactly its delays.
- `setupWeb` checks its bindings when it is called: a `scope` that names no other binding, or a `foreignKey` or `references` column its table lacks, throws a `RouteConfigurationError` naming the fix, instead of failing every request to the routes that use the binding. `routeBinding(table, { scope })` types `foreignKey` by the table's columns.
- `uniqueFieldErrors`'s `constraints` match a composite key's columns in any order, in camelCase or snake_case, and the development error page of an unmapped unique violation shows the `constraints` entry that would map it.
- A data cache entry stored after the current time, as when a test sets its clock back, is a miss.
- `WebErrorPage` from `@popcomputer/web/react` types the error page component, and `readErrorPage(response)` from `@popcomputer/web/testing` reads it in a test, with the invalid fields of a page visit as `errors`.
- `betterAuthRedirect`'s and `betterAuthLogoutAction`'s `redirectTo`, and `auth.signInPath`, take declared paths, as `redirect` does.
- `tableSchema(table, overrides)` checks the columns `overrides` names with the schemas given, such as a JSON column's or a `$type<...>()` narrowing's, and derives the rest from the table.
- `uniqueFieldErrors(messages, { constraints })` names unique constraints by the field they belong on, for an index on an expression such as `lower(email)`, which reports no columns, or a composite key that belongs on another field. A constraint violation's message on development pages names the constraint and its columns.
- Once setupWeb declares `paths`, a path literal given to `redirect`, `redirectNow`, `back`, `href` or `intendedUrl` must be a declared path or an absolute URL, so a misspelled path is a type error naming the fix; a URL computed at runtime is a string and passes. `back(fallback, params)` fills its fallback's placeholders.
- `json(Schema, value)` answers with a value checked against a schema and encoded through its JSON form, as page props are, and `readJson(response, Schema)` from `@popcomputer/web/testing` decodes it in a test, so a JSON API's response shape is declared once. `readError` explains a response that is not JSON.
- `betterAuthFields(schema.user, { role: { input: false } })` from `@popcomputer/web/auth` is Better Auth's `user.additionalFields` for the named columns of the user table: each field's type, enum values and whether sign-up requires it follow the column, so a user's fields are declared once, in the table.
- `columnsOf(table, schema)` from `@popcomputer/web/schema` is the table's columns a schema's fields name, for a query's `select`, so a page schema decides what its query reads: `db.select({ ...columnsOf(projects, ProjectCard), openTasks: count(tasks.id) })`.
- `ErrorResponseBody` from `@popcomputer/web/effect` types the JSON envelope every failure answers a JSON client with, and `readError(response)` from `@popcomputer/web/testing` reads it in a test. `routes.run` takes `testEnv`'s bindings, so a test runs a scheduled job with its fakes.
- `config` from `@popcomputer/web/effect` is Effect `Config` for the Worker's vars and secrets, each name checked against the bindings the Hono app's type declares: `config.string('REGION')`, `config.redacted('API_KEY')`, `config.duration('HOLD_TTL')`. A misspelled name is a type error instead of a default silently taken.
- A JSON client's 422 carries `errors`, each invalid field's message by name, as a form's page receives them, beside `validation`.
- `redirectNow(path, params)` redirects from anywhere in an action, such as a helper or a guard layer, by failing with the redirect, which the boundary answers; values flashed before it reach the next page. `Redirect` is one of the package's errors.
- `routes.run(effect, env, ctx)` runs an Effect with the application's services outside a request, from a Worker's `scheduled` or `queue` handler: the database, `services`, `Config` from the bindings, `background()` and the builder's provided layers work as in an action. It resolves with the Effect's value and rejects with its failure; an Effect needing a service the setup does not provide is a type error naming it.
- `tableSchema(table)` from `@popcomputer/web/schema` is an Effect Schema struct of a Drizzle table's row, each column checked against its type, nullability and enum values, so page props and the signed-in user take their fields from the table: `tableSchema(schema.projects).mapFields(Struct.pick(['id', 'name']))`. Table route bindings check rows with it.
- `betterAuthSession(user)` from `@popcomputer/web/auth` is setupWeb's `auth.session` with the given user schema, as in `betterAuthSession(tableSchema(schema.user))`, so the user's fields are declared once, in the table. `BetterAuthSessionRecord` is Better Auth's session record.
- `purgeCache(...tags)` adds cache tags for the route to purge once the action succeeds, with its `purges`: records the action changed that the route does not name, such as the listing an accepted offer sold. A failed action purges nothing.
- `followRedirect(app, response, env)` from `@popcomputer/web/testing` follows a redirect as the browser would after a form, as an Inertia visit sending the cookies the response set, so the next page receives its `flash` and `errors`.
- `invalid({ field: message })` sends a form back with field errors, as `validateRequest` does, to show a domain error beside its field: `Effect.catchTag('OfferTooLow', (error) => invalid({ amount: error.message }))`. `back(fallback)` redirects to the same-origin page the request came from.
- `testClock(start)` from `@popcomputer/web/testing` gives a test one clock that every request it makes reads (`Clock`, `DateTime.now`), moved with `await time.advance('8 days')` or `time.set(date)`.
- The README's "Patterns from real applications" collects what building applications taught: rules in services with failures mapped at the action, constraints for invariants under concurrency, guard layers, webhooks, several forms on a page, list fields, cursor pagination, header counts, cached public pages and background work.
- `setupWeb`'s `paths` takes the application's route paths, as `src/paths.ts` declares them, and `routes` then registers only on those paths: a path that is not declared is a type error at its registration. A builder under `.prefix()` takes relative paths and is not checked.
- A route binding can name its Drizzle table: `bindings: { project: schema.projects }`. `bound('project')` is the table's row type, each loaded row is checked against the table's columns (types, nullability and enum values), and the parameter name need not match the table (`{ author: schema.users }`). An Effect Schema still parses a row differently, such as a column narrowed with `$type<...>()`.
- `shareProps(effect)` computes props every page shares, such as a header's unread count, when a page renders: `routes.provide(shareProps(Effect.gen(...)))`. It returns any of setupWeb's `shared` props, encoded through their schema, and never runs for a redirect or a JSON response.
- `href(path, params, query)` from the new `@popcomputer/web/paths` entrypoint builds a link from a route path, with its parameters typed from the path's placeholders (`{project}`, `{page:slug}`). An application declares each path once, in a module of paths that server and React code both import, and registers, redirects and links with it.
- setupWeb's `shared` and `flash` options declare, as Effect Schema structs, the props shared with every page and the values `flash` hands to the next page. `share(key, value)` and `flash(key, value)` accept only their fields and encode values through them; `SharedProps` and `FlashData` type them in React, and pointing Inertia's `InertiaConfig` at them types `usePage()`.
- A signed-out visit to a guarded page carries the page to the sign-in path as `?redirect=`, and `intendedUrl(fallback)` returns it after signing in, reading the parameter from the request or the sign-in page's `Referer`. Only paths on the same site are returned.
- `testEnv(layer, bindings, { database })` gives a test request its own database in place of setupWeb's `database` factory: the database operations, route model binding and the Better Auth client all use it, such as an in-process PGlite database.
- `applyMigrations(folder, run)` from `@popcomputer/web/testing` applies drizzle-kit's SQL migrations through any driver, such as Miniflare's D1 or PGlite.
- `ValidationError` has an optional `redirectTo`: a failed form submission goes to that page with its field errors instead of back, such as a wizard's last step sending errors to an earlier one.
- `file(body, { contentType, filename })` answers with a file: text, bytes, a web stream or an Effect `Stream`, inline or as a download. `json` and `text` take `{ status, headers }` as well as a status.
- `betterAuthRedirect`'s `redirectTo` can be a function of Better Auth's result returning a path or an Effect, so a sign-up can land on, or first create, the new user's own page.
- `dbQuery(query, schema)` decodes the result with an Effect Schema; a result the schema rejects fails with `DatabaseError`.
- `readPage(response, 'Projects/Show')` from `@popcomputer/web/testing` reads an Inertia page response typed by the page registry, and rejects with a message naming what the response was when it is not that page.
- `upload({ types, maxBytes })` and `nullableUpload(...)` from `@popcomputer/web/schema` validate multipart file fields; a file input left empty is no file.
- Effect `Config` reads the Worker's bindings in `services.app`, `services.request` and actions: `Config.String('BASE_URL')` reads a var and `Config.Redacted('API_KEY')` a secret. `services.app` is built with the first request's bindings. Service layers may fail with `ConfigError`, and a missing binding fails the request with `WEB_CFG_305_INVALID_CONFIG`, naming the binding in development.
- A page registry: each page component's props as an Effect Schema, passed as setupWeb's `pages`. `render` and `jsonOrRender` then accept only registered pages and check props against the schema, and encode them as JSON through it, so a `Date` reaches the client as an ISO string. `WebPage<'Projects/Show'>` types the React component with the JSON form of the same props (`Jsonify`).
- `render` and `jsonOrRender` run in a `Web.render` span naming the component.
- `ErrorPageProps` from `@popcomputer/web/react` types the error page component.
- `flash(key, value)` hands a value to the next page the user sees, as Inertia 3's page `flash` field: the page a redirect renders, or the page the same request renders. Flash data and failed-form errors travel in a short-lived `HttpOnly` cookie (`__Host-` over HTTPS) that the next visit reads and clears; Inertia prefetches leave it for the visit.
- `dbQuery((db) => ...)` for reads, failing with `DatabaseError`.
- `dbBatch((db) => [...statements])` applies statements atomically on drivers with batches (Cloudflare D1, libsql, Neon HTTP) and returns each statement's typed result.
- `uniqueFieldErrors({ slug: 'Taken.' })`, a pipeable combinator that turns a unique violation on a listed column into a `ValidationError` for that field.
- `skills/popcomputer-web/SKILL.md`, shipped in the package: the `AGENTS.md` rules as a Claude skill, generated by `scripts/build-skill.ts` and checked by the test suite. It replaces the former `honertia` skill.
- `AGENTS.md`, shipped in the package: rules for coding agents that name the one API to use for each task, with a complete action whose behavior the test suite checks.

### Fixed

- A misspelled path literal's type error shows why and lists the declared paths; it read `not assignable to parameter of type 'never'`.
- `uniqueFieldErrors`'s `constraints` also names a constraint by its columns, joined with commas, as SQLite and D1 report one: they report no constraint name, so a mapping by name never matched there.
- An invalid bound row's error names the field that failed its schema.
- `kvCache` keeps an entry at least 60 seconds, the shortest expiry Workers KV accepts; `cache()` with a shorter `ttl` failed every write and never cached. `cache()` still treats an entry as fresh only for its `ttl`.
- `HttpError.rateLimited(seconds)` sends `Retry-After` as a header as well as in the body.
- A binding `scope` can name any earlier binding of its route, not only the one before it, and a scope naming no binding before it fails with an error listing the ones it can name; it was ignored, and the route failed with a hint to add the scope it had.
- `WebPage` is a React function component (it returns React's `ReactNode`), so a page renders as JSX and resolves in `createInertiaApp`; its return type admitted any object, which React 19's types reject. `@types/react` is an optional peer dependency.
- `PageName` is the registered page names as a plain type, so `const name: PageName = 'Missing'` is a type error and `{ [Name in PageName]: ... }` checks a map of every page. TypeScript took its keys through the registered pages' constraint, `Record<string, ...>`, which admitted any string.
- `dbTransaction` is a type error on Cloudflare D1 when the database type is Drizzle's `DrizzleD1Database<typeof schema>`, which has no `$client` to recognize D1 by; D1 is also recognized by its run result.
- A page visit with invalid query parameters renders the error page with the field errors as `errors`, as a form's page receives them; they were only in its message.
- `readPage` names the error page's message when the response rendered it instead of the expected page, such as a binding a service could not read.
- A route binding whose lookup column matches more than one row, such as a slug unique only within its organization, fails with `RouteConfigurationError` (`WEB_RTE_605_BINDING_AMBIGUOUS`) naming the fix, instead of loading whichever row came first.
- A database result typed `any` is an error type naming the fix (`UntypedDatabaseResult`), so `result.meta.changes` no longer type-checks unchecked. Drizzle's D1 result types name Cloudflare's global types, which are `any` without `@cloudflare/workers-types` in tsconfig's `types`.
- `db.run(sql)` in a Cloudflare D1 `dbBatch` is a type error naming the query builder; Drizzle's D1 batch fails at runtime on it.
- A `DatabaseError`'s message on development pages and in logs names the driver's reason, along its cause chain (Drizzle's failed query, then the driver's error), so a failed batch no longer reads only "Database batch failed and was rolled back." Production still replaces database messages with a generic one.
- `upload({ types })` compares a file's media type without its parameters and in any case, so `text/plain;charset=utf-8`, which Bun and browsers send for text files, is a `text/plain` file.
- A request `testEnv(signedIn(user))` signs in gets the signed-in cache policy (`no-store`, `X-Popweb-Cache: BYPASS`) where no Cache API exists, as in tests, as a session cookie does; it got `private, no-cache`.
- `readPage(...).props.errors` reads a field's message as `string | Readonly<Record<string, string>>` (`TestFieldErrors`), so `expect(page.props.errors.name).toBe('...')` type-checks; Inertia's intersection type made it `string & Record<string, string>`.
- A page rendered for a user signed in without a session cookie, as `testEnv(signedIn(...))` signs a test request in, gets the signed-in cache policy (`BYPASS`, `no-store`), so tests can check it.
- Failed background work and cache store failures are logged through Effect's logger when no `EffectErrorObserverService` is installed, as errors and warnings respectively. They were silent.
- `cache()` serves values that hold dates: a value is stored through its schema's JSON codec (`Schema.toCodecJson`), so it decodes back to itself. A `Date` came back as a string the schema rejected, so the value was computed on every call and the decode failure went only to the error observer. `cache`, `cacheGet` and `cacheSet` accept a schema of any encoded form (`CacheSchema<V>`).
- An absent required field reports "This field is required", as an empty one does, instead of Effect's "Missing key".
- Every 404 has the same message in production, so a response cannot tell a missing record from one the visitor may not see by the resource name in the message (`notFound('Team')` against a missing `{team}` binding).
- `flash()` reaches the next page when the action's response sets cookies of its own, such as `betterAuthRedirect`'s session: Hono replaced the response's `Set-Cookie` headers when the flash cookie was added.
- Route model binding loads through the request's `DatabaseService`, so a database a test provides with `testEnv` serves `bound()` as it serves `dbQuery`. It used the `database` factory's client.
- `WebPage` types `errors` as Inertia does, so a field error and an error bag's fields (`errors.createProject.name`) both read as strings.
- `testEnv` layers apply to page visits while the page cache is on: the cache tracks bindings through a copy of the request env, and the copy lost the layer, so a test-signed-in GET ran as a guest.
- A `services.app` layer that fails to build, such as one reading a missing binding, is built again by the next request instead of failing every later request in the isolate.
- Validators for optional input accept an absent key: `checkbox` decodes it to `false`, the `nullable*` validators to `null`, `filled(schema, value)` to its default and `ensureArray` to `[]`. They failed with "Missing key", so a plain HTML form with an unchecked checkbox, or a page whose query string omitted a filter, failed validation.
- Expected failures (4xx) are no longer logged as errors; only 5xx responses are.
- `ForbiddenError`, `AuthRateLimitError` and `HttpError` render the application's error page for page and HTML requests, with their status, as `NotFoundError` does. They answered every client with JSON, which an Inertia client shows as an invalid-response modal. An `HttpError` with a `body` still answers with JSON.
- An `HttpError` with a 4xx status the catalog does not list (403, 409, 418, ...) has the code `WEB_HTTP_4XX_CLIENT_ERROR` and the title "Request Failed" instead of `WEB_HTTP_500_INTERNAL_ERROR` and "Internal Server Error".
- A request that `testEnv(signedIn(user))` signs in shares that user as the `auth.user` page prop, and the page cache does not store its response, as for a session cookie. Pages saw `auth.user: null`.
- Database constraint violations are classified through Drizzle, which wraps every driver error in a `DrizzleError` and keeps the driver's in `cause`; they were reported as `DatabaseMutationFailed`. SQLite violations (bun:sqlite, libsql, D1) are classified as `unique`, `foreign-key`, `not-null` or `check` instead of `unknown`, from the extended result code or SQLite's message.
- README and `AGENTS.md` examples type-check against the built declarations in `dist`, and a fixture application that registers its setup checks every type derived from it. Declaration emit can resolve an exported type before any application registers, which checks against `src` cannot see.
- `ResponseCachePurgeError` is one of the package's errors (`WEB_SVC_703_CACHE_PURGE_FAILED`, 500), so an action that calls `ResponseCacheService.purge`, as the README shows, can be registered.
- `WebPage` and `WithSharedProps` without props default to no page props instead of every prop being `never`, so shared props such as `errors` type-check.
- Actions that call `background()` or `cache()` type-check when registered: the route service type omitted `ExecutionContextService` and `CacheService`, which every request provides.
- A signed-out request could tell whether a route's record existed: route model bindings were queried before the action and its guards ran, so `/projects/{project}` answered 404 for a missing project and redirected to sign-in for an existing one, even behind `RequireAuthLayer`. Bindings now load when the action calls `bound()`, after the guards.
- An error's own hint, such as which `{placeholder}` a route is missing or how to install `drizzle-orm`, is now its first fix suggestion; hints were dropped before reaching the output. Configuration fixes show code for the current API (`setupWeb(app, { database: (c) => createDb(c.env.DATABASE_URL) })`, an ESM schema import) instead of `require("./db/schema")` and `drizzle(c.env.DB)`.
- Error context reads the matched route pattern with `routePath(c)` from `hono/route` instead of `c.req.routePath`, which Hono 5 removes.
- A JSON request body that is not an object (`null`, an array, a string or a number) fails validation with `422` instead of crashing the request with `500`.
- Route builder methods (`get`, `post`, `put`, `patch`, `delete`, `all`, `group`) return the builder, so registrations chain as the README shows. They returned `undefined`, and a chained call threw a `TypeError`.
- Every test file type-checks, each in its own program, as part of `bun run test:types`. Bun runs tests without type-checking, and 22 files had drifted from the package's types.
- README examples type-check against the package, and `bun run test:types` checks every TypeScript example in the README and `AGENTS.md`. Corrected examples: the `background` call takes an operation name, Workers Cache routes register through `effectRoutes(app)`, `src/routes.ts` imports its app, alternative setups read bindings the `Bindings` type declares, `authorize` predicates use a field of the default user, and the lower-level composition example is a complete module that passes its `Env` to `webServices`.

### Changed

- The package version is `1.0.0-next.0` while these changes are unreleased.
- A `shareProps` computation that fails is reported to `EffectErrorObserverService`, and the page renders without its props, instead of failing every page as a defect.
- A misspelled `config` name's type error lists the binding names it accepts.
- The package ships `CHANGELOG.md`.
- The README documents testing against the production database family (PGlite for Postgres, Miniflare's D1 for D1), `readPage`, uploads and request headers, predicate guards, `file`, where a failed form goes, what Workers Cache cannot see (cookies), what `purges: true` purges.
- `bound(key)` accepts only the keys of the registered bindings, so a misspelled key is a type error at the call (`BoundKey`).
- `dbTransaction` is a type error on Cloudflare D1 (a database whose driver client prepares and batches statements but has no `transaction`), naming `dbBatch`. It failed at runtime.
- A request built with `testEnv` that declares no `ENVIRONMENT` or `NODE_ENV` binding renders errors with development details, so a failing test shows why. Pass `ENVIRONMENT: 'production'` to test production error pages.
- `AGENTS.md` and the README describe the page registry, flash and failed-form redirects, the database operations, Effect `Config` and the auth routes. The canonical action calls `authorize()` before `bound()` and answers another member's record with 404, so its existence stays private. React page examples are type-checked with the package's React types.
- `testEnv(layer, bindings)` takes any of the bindings the application's Hono environment declares, with their declared types, so a misspelled or mistyped binding is a type error.
- `validateRequest` and `validateUnknown` report every invalid field (`errors: 'all'`) instead of the first, so a form shows all of its errors at once. Pass `parseOptions: { errors: 'first' }` for the previous behavior.
- Public operations run in spans named after them: `Web.authorize`, `Web.validateUnknown`, `Web.validateRequest`, `Web.bound`, `Web.background`, `Web.dbMutation`, `Web.dbTransaction`, `Web.cache`, `Web.cacheGet`, `Web.cacheSet`, `Web.cacheInvalidate` and `Web.cacheInvalidatePrefix`. An application that installs an Effect tracer, such as an OpenTelemetry exporter, sees where request time goes.
- The package's errors are `Schema.TaggedError` classes instead of `Data.TaggedError`, so their fields are checked when they are constructed. Construction, `_tag`, `Effect.catchTag` and the fields are unchanged; `FieldError.path` is `readonly string[]`.
- The `hono` peer range is `^4.10.0` (was `>=4.0.0`) and the `drizzle-orm` peer range is `>=0.30.0 <1.0.0` (was `>=0.30.0`). Hono releases before 4.10 fail to type-check the package, and the open upper bounds admitted Hono 5 and Drizzle 1.0, which both break it: Hono 5 removes `c.req.routePath` and changes `app.onError`, and Drizzle 1.0 removes the relation helpers route model binding reads.
- Tested against Effect 4.0.3, Hono 4.13.13, Better Auth 1.7.7 and Drizzle ORM 0.45.4.
- The package is built and type-tested with TypeScript 7. Emitted JavaScript is unchanged and declarations differ only in formatting, so applications on TypeScript 5.x keep working.

## [0.7.0] - 2026-10-12

### Added

- Pages are cached at Cloudflare's edge by default. `setupWeb` serves a page from the Cache API, before database, auth or rendering work, when producing it read nothing request-specific: no binding on `c.env` (D1, KV, R2, Durable Objects, service bindings), no request header or request state through `RequestService`/`RequestStateService`, and no route model binding. Anything else renders on every request. Cached pages are keyed by deploy, via the `CF_VERSION_METADATA` version metadata binding when present or the asset version otherwise, and browsers always revalidate them. Signed-in requests, `Authorization`, app cookies, partial reloads, stale Inertia versions and development bypass the cache, and a page is stored only if the final response, after all middleware, sets no cookie and no other `Cache-Control`. The `X-Popweb-Cache` header reports `HIT`, `MISS`, `DYNAMIC` or `BYPASS`.
- `cache: false` on a route always renders it fresh; `pageCache: false` in `setupWeb` turns the page cache off; `markPageDynamic(c)` marks a page dynamic from Hono middleware; `pageCache({ version })` adds the cache to lower-level compositions.
- `PAGE_CACHE_TAG` (`popweb:page`), a Cache-Tag on every page the `cache` route option stores in Workers Cache.

### Changed

- Signed-in requests (a session cookie or `Authorization`) whose response sets no `Cache-Control` now get `Cache-Control: no-store`.

### Fixed

- Apps without `drizzle-orm` installed bundle for Cloudflare Workers again. Route model binding loaded the optional peer with `import('drizzle-orm')`, which esbuild (used by Wrangler) and Bun must resolve at build time, so every Worker build failed with `Could not resolve "drizzle-orm"` unless the package was installed. The import now sits in a `try` block, which those bundlers leave for runtime when the package is missing; apps that install `drizzle-orm` still bundle it. A binding route that runs without it fails with `RouteConfigurationError` (`HON_CFG_305_INVALID_CONFIG`) and an install hint.
- The `cache` route option no longer lets browsers keep pages. A cached HTML document names its deploy's hashed assets, which the next deploy removes, so a visitor returning within `maxAge` could load scripts that no longer exist and see a blank page. HTML documents and Inertia page objects now get `Cache-Control: public, max-age=0, must-revalidate`, and `maxAge` and `staleWhileRevalidate` move to `Cloudflare-CDN-Cache-Control`, so only Cloudflare keeps pages. Cached responses that are not pages, such as JSON APIs and text, are unchanged.

## [0.6.0] - 2026-10-09

### Breaking

- Effect 4 stable is required. The `effect` peer range is `^4.0.0` (tested with 4.0.2) and no longer accepts `4.0.0-rc.*` prereleases.

### Added

- `vite.script()` and `vite.hmrHead()` accept the dev server's origin (a string or `URL`) as well as a port, exported as the `ViteDevServer` type. Invalid ports and non-HTTP(S) origins fail with `HonertiaConfigurationError`.

### Fixed

- The package runs on Effect 4.0 stable. 0.5.0 declared `^4.0.0-rc.109`, which admitted Effect 4.0.x, but called `SchemaTransformation.transformOrFail` and `Schema.isLengthBetween`, which Effect renamed before 4.0.0, so importing it failed at runtime. Schema helpers now use `transformEffect` and `isBetweenLength`.
- `generate:openapi` keeps documented request and response objects closed (`additionalProperties: false`). Effect 4.0 leaves undeclared properties open by default, which would otherwise loosen every generated contract on upgrade.
- The built-in pattern validators (`digits`, `digitsBetween`, `ipv4`, `ipv6`, `macAddress`, `email`, `alpha`, `alphaDash`, `alphaNum`) and the patterns emitted by `generate:action` and `generate:feature` use Unicode (`u`) regular expressions. Effect 4.0 exports a JSON Schema `pattern` only for Unicode patterns, so these validators would otherwise disappear from generated OpenAPI documents. Matching is unchanged.
- `popweb` runs when started through the `node_modules/.bin/popweb` symlink. The entrypoint check compared the symlink path with the module path, so installed projects got no output and exit code 0. Both paths are now compared after resolving symlinks.
- `createTemplate` marks its `<title>` with Inertia's `inertia` attribute, so `<Head title>` replaces it. Previously the document had two titles and browsers showed the static one.
- `bun run test` builds the package before running tests, so generated-code tests import the current `dist/` instead of a stale or missing build.

## [0.5.0] - 2026-09-12

### Breaking

- `TestCaptureService.get` is an Effect value instead of a zero-argument method. Use `yield* capture.get` instead of `yield* capture.get()`.
- Numeric form coercion, numeric route bindings, and persisted cache timestamps reject non-finite numbers. `nullableString` continues to coerce scalars but rejects objects and arrays.

### Changed

- Cache freshness and timestamps use the Effect clock. Auth test fixtures also use the provided clock for session expiry, and `createRequestTracker` accepts a Clock service for deterministic request timestamps.
- Database transaction and route-layer types preserve their inferred clients, service requirements, and typed failures more precisely.
- Effect workflows use typed failures, Schema decoding, and simpler composition. Native Hono, SDK, CLI, and test-runner exceptions are documented in `LINTING.md`.
- Cache and background-work tests use TestClock and Deferred to control time and completion.

### Fixed

- `declined` correctly decodes negative form values such as `0`, `"false"`, `"no"`, and `"off"` to `false`.
- Migration tracking JSON is validated. Malformed tracking data and unexpected filesystem failures return errors instead of being accepted or treated as empty migration history.
- CLI health checks reject unknown `--only` check names.
- Structured error messages preserve literal replacement text and avoid coercing arbitrary object parameters into diagnostics.

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
