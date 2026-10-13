---
name: popcomputer-web
description: Rules and a canonical action for building applications on @popcomputer/web (formerly honertia), the Effect-native, server-driven web framework on Hono, Inertia, Better Auth, Drizzle and Cloudflare Workers. Use whenever writing or changing code in a project whose package.json depends on @popcomputer/web or honertia - actions, routes, pages, validation, route model binding, auth, database writes, caching, background work or tests - and when the user mentions popcomputer, @popcomputer/web, popweb or honertia. Do not use for plain Hono APIs without Inertia or Effect projects without this framework.
---

# @popcomputer/web for coding agents

These rules are the package's `AGENTS.md`. When the project has
`node_modules/@popcomputer/web/AGENTS.md`, read that copy: it matches the
installed version. For a new application, follow the Quick start in
`node_modules/@popcomputer/web/README.md`.

A project that imports from `honertia` is on the framework's former package.
Migrate it with the README's "Migrating from `honertia`" table before
applying these rules.

Rules for writing an application on `@popcomputer/web`. Each rule names the one
API to use; the README explains the design and shows the full setup. Every
TypeScript example here and in the README type-checks against the package.

## Rules

1. **Compose once.** `setupWeb(app, config)` in `src/app.ts` owns rendering,
   the page registry, the database, auth, route binding parsers and the error
   page. Do not add framework middleware or register routes on the Hono app
   by hand.
2. **Every handler is an action.** Wrap an `Effect.gen` in `action(...)` and
   register it on the `routes` that `setupWeb` returns:
   `routes.get/post/put/patch/delete(path, action, { name })`. Registrations
   chain. `routes` accepts only actions whose services the setup provides.
3. **Register every page's props as an Effect Schema** in `src/pages.ts`,
   pass the object as `setupWeb`'s `pages`, and augment `WebPagesType` with
   it. Type each React page as `WebPage<'Projects/Show'>` from
   `@popcomputer/web/react`. Never declare a page's props twice.
4. **End every branch with a response helper:** `return yield* render(...)`,
   `redirect(...)`, `json(...)`, `jsonOrRender(...)`, `notFound(...)`,
   `forbidden(...)` or `httpError(...)`. `yield* flash(key, value)` before a
   redirect hands a message to the next page. Expected failures are typed
   Effect failures. Do not `throw` in an action.
5. **Read request input only through `validateRequest(Schema)`.** Build schemas
   from `@popcomputer/web/schema` validators (`requiredString`,
   `nullableString`, `coercedNumber`, `checkbox`, `email`, `uuid`, ...), which
   accept form posts as well as JSON. A form that fails validation goes back
   to the page it came from, which receives the field errors as `errors`;
   a JSON client gets a `422`. A key that route params, query and body
   provide with different values fails validation.
6. **Load route models with `{param}` placeholders and `bound('param')`.**
   Register each model's Effect Schema in `setupWeb`'s `bindings` and augment
   `WebRouteBindingsType` with the same object. Never query by a route
   parameter yourself. Call `authorize()` before `bound()`: models load on the
   first `bound()` call, and a missing row is a 404. A record the user may not
   see answers `notFound(...)`, so its existence stays private; use
   `authorize((auth) => rule)` (a 403) for a record the user can see but not
   change.
7. **Authorize with `authorize()` or `authorize((auth) => rule)`.** Use
   `currentUser` when signing in is optional. Guard a group of routes with
   `routes.provide(RequireAuthLayer)` or `routes.provide(RequireGuestLayer)`.
   Sign users in and up with an action that validates its form and returns
   `betterAuthRedirect(...)` from `@popcomputer/web/auth`.
8. **Use the database only through `dbQuery`, `dbMutation`, `dbTransaction`
   and `dbBatch`:** `yield* dbQuery((db) => db.select()...)` to read,
   `dbMutation((db) => db.insert(...))` to write. Several writes that must
   succeed together go in `dbTransaction` (Postgres, MySQL, libsql) or
   `dbBatch` (Cloudflare D1). Write only validated input and values the server
   derives, and scope `where` clauses with bound models. Pipe a write through
   `uniqueFieldErrors({ column: 'message' })` to show a duplicate as a field
   error.
9. **Provide application services in `setupWeb`'s `services`:** `app` for
   services built once and shared (configuration, in-memory caches), `request`
   for anything that holds the request's bindings (D1, KV, Hyperdrive).
   Define them with `Context.Service` and `Layer`, and read vars and secrets
   with Effect `Config` (`Config.String('NAME')`, `Config.Redacted('KEY')`),
   which reads the Worker's bindings.
10. **Run work that outlives the response with `background('name', effect)`.**
11. **Give `cache: false` to routes whose page reads something the framework
    cannot see,** such as an external `fetch()` or the current time. Pages that
    read bindings, headers or bound models are already rendered per request.
12. **Test through the app.** `app.request(path, init, testEnv(layer,
    bindings))` from `@popcomputer/web/testing` runs the real route;
    `signedIn(user)` signs the request in. Assert on `X-Inertia` JSON responses.

Every name has one entrypoint: `@popcomputer/web` for `setupWeb`, template
helpers and Hono middleware; `@popcomputer/web/effect` for actions, routes,
responses, pages, the database, services and errors;
`@popcomputer/web/schema` for validators; `@popcomputer/web/auth` for the
Better Auth integration; `@popcomputer/web/cache` for the KV cache;
`@popcomputer/web/react` for page component types; `@popcomputer/web/testing`
in tests.

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

    return yield* redirect(`/projects/${project.id}`)
  })
)
```

Register it beside the other routes in `src/routes.ts`:

```ts
routes.put('/projects/{project}', updateProject, {
  name: 'projects.update',
})
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

Run the application's type check (`tsc --noEmit`) and `bun test`. A type error
at `routes.get(...)` names the problem: `missingServices` lists services the
setup does not provide (configure them in `setupWeb`, or `routes.provide(layer)`),
and `unhandledErrors` lists failures that are not the package's errors (handle
them with `Effect.catchTag`, or fail with `HttpError`). A type error at
`render(...)` means the page or its props differ from `src/pages.ts`.
