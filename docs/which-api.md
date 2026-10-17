# Which API for which task

Each task has one API. When the one you need is not here, the type checker
and the lint rules name it where an action reaches for something else.

**Requests and responses**

| Task | Use | See |
| --- | --- | --- |
| Read form, query or JSON input | `validateRequest(Schema)` | [Validating input](validation.md) |
| Read a header, or the raw body a webhook signs | `RequestService`'s `header(name)` and `raw()` | [Webhooks](webhooks.md) |
| Accept a file | `upload({ types, maxBytes })` in the schema | [User input in](validation.md#user-input-in) |
| Render a page | `render('Projects/Show', props)` | [Actions and routes](actions.md) |
| Redirect after a write | `redirect(paths.project, { project: id })` | [Responses](actions.md#responses-and-failures) |
| Go back to the page the request came from | `back(paths.projects)` | [Responses](actions.md#responses-and-failures) |
| Send the visitor elsewhere from a helper or a guard | `redirectNow(paths.onboarding)` | [Responses](actions.md#responses-and-failures) |
| Show a domain error beside a form field | `invalid({ amount: 'Too low.' })` | [Rules live in services](services.md#rules-live-in-services-actions-decide-what-a-failure-means) |
| Hand a message to the next page | `flash('success', 'Saved.')` | [Flash and failed forms](forms.md#flash-messages-and-failed-forms) |
| Answer a JSON API | an `endpoint` contract, implemented with `action(endpoint, handler)` | [JSON endpoints](endpoints.md) |
| Answer JSON from a page's action | `json(Schema, value)` or `jsonOrRender('Page', props)` | [JSON responses](json.md#json-responses-declared-by-a-schema) |
| Answer a failure with a body a client reads | `httpError(status, message, Schema, body)` | [Failures a client reads](json.md#failures-a-client-reads) |
| Hide a record the visitor may not see | Its binding's `ownedBy` or `publicWhen`, or `notFound('Project')` in a guard | [Who may load a record](route-models.md#who-may-load-a-record) |
| Refuse a visitor who can see the record | `authorize((auth) => rule)`, or `forbidden(message)` | [Auth](auth.md) |
| Serve a file or a download | `file(body, { contentType, filename })` | [Serving an upload back](responses.md#serving-an-upload-back) |
| Answer a poll that has nothing new | `ifChanged(etag, response)` | [Files, headers and polling](responses.md#files-headers-and-polling) |
| Add a header to every response of some routes | `responseHeader(name, value)` in a guard layer | [Files, headers and polling](responses.md#files-headers-and-polling) |
| Keep a value in the visitor's browser | `cookie(name, Schema, options)`, declared once | [Cookies](responses.md#cookies) |
| Answer a CORS preflight | `routes.options(path, action(noContent(headers)))` | [Files, headers and polling](responses.md#files-headers-and-polling) |

**Routes, models and pages**

| Task | Use | See |
| --- | --- | --- |
| Declare a URL, and build links to it | `paths` in `src/paths.ts`, `href(paths.project, params)` | [Actions and routes](actions.md) |
| Load the record a URL names | `bindings: { project: routeBinding(schema.projects, { ownedBy: 'userId' }) }`, then `bound('project')` | [Route model binding](route-models.md) |
| Say who may load it | `ownedBy: 'userId'` for its owner, `publicWhen: { isPublic: true }`, `public: true`, or `guarded: true` when a guard decides | [Who may load a record](route-models.md#who-may-load-a-record) |
| Guard a group of routes | `routes.provide(guard(effect))`, or `RequireAuthLayer` | [A guard guards a group of routes](guards.md#a-guard-guards-a-group-of-routes) |
| Check a role or a permission | `yield* can('members.role')` in the action, after a membership `guard(CurrentMember, ...)` | [Roles belong to memberships](guards.md#roles-belong-to-memberships-read-by-a-guard) |
| Show the same props on every page | `shared` in `setupWeb`, computed by `shareProps(effect)` | [Props every page shows](pages.md#props-every-page-shows) |
| Declare a page's props | a schema in `src/pages.ts`, typed in React as `WebPage<'Name'>` | [Describe the pages](pages.md#describe-the-pages) |
| Take a page's fields from a table | `tableSchema(table).mapFields(Struct.pick([...]))` | [Describe the pages](pages.md#describe-the-pages) |
| Type a form | `useForm<FormInput<typeof Schema>>`, `FormErrors<typeof Schema>` | [Forms](forms.md) |
| Type the error page | `WebErrorPage` | [The error page](pages.md#the-error-page) |

**Auth**

| Task | Use | See |
| --- | --- | --- |
| Require a signed-in user | `authorize()` | [Auth](auth.md) |
| Read the user when signing in is optional | `currentUser` | [Auth](auth.md) |
| Sign in or sign up | `validateRequest`, then `betterAuthRedirect('signInEmail', { body }, { redirectTo, errors })` | [Signing in and out](sign-in.md) |
| Return to the page the visitor wanted | `intendedUrl(fallback)` | [Signing in and out](sign-in.md) |
| Call Better Auth for a result | `betterAuthCall('enableTwoFactor', { body }, { errors })` | [Signing in and out](sign-in.md) |
| Sign out | `betterAuthLogoutAction({ redirectTo, clear })` | [Signing in and out](sign-in.md) |
| Limit password guessing | `auth.signInLimits`, `sweepSignInFailures` | [Limiting password guessing](auth.md#limiting-password-guessing) |
| Use a Better Auth plugin: organizations, two-factor, magic links | its endpoints by name with `betterAuthRedirect` and `betterAuthCall` | [Better Auth's plugins](auth-plugins.md) |
| Sign in through an OAuth provider, a company's own or GitHub's | `betterAuthRedirect('signInSocial', ...)`, and `betterAuthHandler()` on the callback alone | [Signing in with an OAuth provider](auth-plugins.md#signing-in-with-an-oauth-provider) |
| Add a field to the user | a column on the user table, with `betterAuthFields` | [Auth](auth.md) |
| Authenticate an API key | a layer failing with `new UnauthorizedError({ message, challenge: 'Bearer' })` | [Caching an API](data-cache.md#caching-an-api-that-authenticates-each-request) |

**The database**

| Task | Use | See |
| --- | --- | --- |
| Read | `dbQuery((db) => ...)` | [The database](database.md) |
| Write | `dbMutation((db) => ...)` | [The database](database.md) |
| Write several things together (Postgres, MySQL, libsql) | `dbTransaction(Effect.gen(...))` | [The database](database.md) |
| Write several things together on Cloudflare D1 | `dbBatch((db) => [...])` | [Constraints](constraints.md) |
| Insert only while a condition holds, on D1 | `db.insert(table).select(db.select(rowOf(table, values))...)` | [Constraints](constraints.md) |
| Keep a rule concurrent requests could break | a constraint (`CHECK`, unique, exclusion, trigger) | [Constraints](constraints.md) |
| Show a duplicate beside its field | `uniqueFieldErrors({ slug: 'Taken.' })` | [The database](database.md) |
| Show a named rule beside its fields | `constraintFieldErrors({ name: { field: message } })` | [Constraints](constraints.md) |
| Select exactly the columns a page shows | `columnsOf(table, Schema)` | [Describe the pages](pages.md#describe-the-pages) |

**Services, background work and caching**

| Task | Use | See |
| --- | --- | --- |
| Provide a service | `web.services({ app, request })`, after registering `web` | [Application services](services.md) |
| Declare the Worker's vars and secrets | `defineEnv` with `secret(schema, { generate })` and `variable(schema)`, passed as `setupWeb`'s `env` | [Vars and secrets](env.md) |
| Check vars and secrets in a script, before a deploy | `checkEnv(env, values)` | [Vars and secrets](env.md#checking-them-before-a-deploy) |
| Read a var or a secret | `config.string('NAME')`, `config.redacted('KEY')` | [Application services](services.md) |
| Work after the response | `background('name', effect)` | [Work after the response](background.md#work-after-the-response) |
| Run a Cron Trigger or a Queue consumer | `routes.scheduled(job)`, `routes.queue(Schema, handle)` | [Scheduled and queued work](background.md#scheduled-and-queued-work) |
| Cache computed data | `cache(key, effect, Schema, { ttl, tags })`, with `kvCache` in `web.services` | [The data cache](data-cache.md) |
| Cache a public page for a time | the route's `cache` option | [Workers Cache](page-cache.md#time-based-caching-with-workers-cache) |
| Refresh cached pages and data after a write | `purges: true`, `purgeCache(recordCacheTag(table, id))` | [Workers Cache](page-cache.md#time-based-caching-with-workers-cache) |
| Tag a cached page with records it read | `tagCache(recordCacheTag(table, id))` | [Workers Cache](page-cache.md#time-based-caching-with-workers-cache) |

**Testing**

| Task | Use | See |
| --- | --- | --- |
| Run a request through the application | `app.request(path, init, testEnv(layer, bindings, { database }))` | [Testing](testing.md) |
| Sign a request in | `signedIn(user)` in `testEnv`'s layer | [Testing](testing.md) |
| Read a page, JSON, a failure or a cookie | `readPage`, `readJson`, `readError`, `readErrorPage`, `readCookie` | [Reading a response](testing.md#reading-a-response) |
| Make several requests as one visitor, or follow a redirect | `testBrowser(app, env)` and its `follow(res)` | [One visitor](testing.md#one-visitor-across-requests) |
| Replace a service that reaches another system | `Layer.succeed(Service, fake)` in `testEnv`'s layer | [Fakes](testing.md#fakes-for-other-systems) |
| Move time | `testClock()` | [Time](testing.md#time) |
| Use the production database family | PGlite, migrated with `applyMigrations`, or a D1 database of each test's own from `testD1` | [A database for tests](test-database.md) |
| Sign in through an OAuth provider in a test | `testOAuthProvider({ ... })`, then `signIn(browser, path, person)` | [Signing in with an OAuth provider](auth-plugins.md#signing-in-with-an-oauth-provider) |
| Run a Queue consumer | `testBatch(bodies)` | [Scheduled and queued work](background.md#scheduled-and-queued-work) |
