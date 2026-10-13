# @popcomputer/web for coding agents

Rules for writing an application on `@popcomputer/web`. Each rule names the one
API to use; the README explains the design and shows the full setup. Every
TypeScript example here and in the README type-checks against the package.

To use this file, point the application's own `AGENTS.md` or `CLAUDE.md` at
`node_modules/@popcomputer/web/AGENTS.md`.

## Rules

1. **Compose once.** `setupWeb(app, config)` in `src/app.ts` owns rendering,
   the database, auth, route binding parsers and the error page. Do not add
   framework middleware by hand.
2. **Every handler is an action.** Wrap an `Effect.gen` in `action(...)` and
   register it on the `routes` that `setupWeb` returns:
   `routes.get/post/put/patch/delete(path, action, { name })`. Registrations
   chain. `routes` accepts only actions whose services the setup provides.
3. **End every branch with a response helper:** `return yield* render(...)`,
   `redirect(...)`, `json(...)`, `jsonOrRender(...)`, `notFound(...)`,
   `forbidden(...)` or `httpError(...)`. Expected failures are typed Effect
   failures. Do not `throw` in an action.
4. **Read request input only through `validateRequest(Schema)`.** Build schemas
   from `@popcomputer/web/schema` validators (`requiredString`,
   `nullableString`, `coercedNumber`, `checkbox`, `email`, `uuid`, ...), which
   accept form posts as well as JSON. Pass `errorComponent` for form pages.
   A key that route params, query and body provide with different values
   fails validation.
5. **Load route models with `{param}` placeholders and `bound('param')`.**
   Register each model's Effect Schema in `setupWeb`'s `bindings` and augment
   `WebRouteBindingsType` with the same object. Never query by a route
   parameter yourself. Call `authorize()` before `bound()` when the route
   needs a signed-in user: models load on the first `bound()` call, and a
   missing row is a 404.
6. **Authorize with `authorize()` or `authorize((auth) => rule)`.** Use
   `currentUser` when signing in is optional.
7. **Write only inside `dbMutation(db, asTrusted({ ... }), (tx, values) => ...)`**
   or `dbTransaction`. Put exactly the columns being written in `asTrusted`,
   pass `values` to `.values()` or `.set()`, and scope `where` clauses with
   bound models.
8. **Run work that outlives the response with `background('name', effect)`.**
9. **Give `cache: false` to routes whose page reads something the framework
   cannot see,** such as an external `fetch()` or the current time. Pages that
   read bindings, headers or bound models are already rendered per request.
10. **Test through the app.** `app.request(path, init, testEnv(layer,
    bindings))` from `@popcomputer/web/testing` runs the real route;
    `signedIn(user)` signs the request in. Assert on `X-Inertia` JSON responses.

Every name has one entrypoint: `@popcomputer/web` for `setupWeb`, template
helpers and Hono middleware; `@popcomputer/web/effect` for actions, routes,
responses, services and errors; `@popcomputer/web/schema` for validators;
`@popcomputer/web/auth` for the Better Auth integration;
`@popcomputer/web/cache` for the KV cache; `@popcomputer/web/testing` in tests.

## A complete action

```ts
// src/actions/projects/update.ts
import { eq } from 'drizzle-orm'
import { Effect, Schema as S } from 'effect'
import {
  action,
  asTrusted,
  authorize,
  bound,
  DatabaseService,
  dbMutation,
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
    const project = yield* bound('project')
    yield* authorize((auth) => auth.user.id === project.userId)

    const input = yield* validateRequest(UpdateProject, {
      errorComponent: 'Projects/Edit',
    })
    const db = yield* DatabaseService

    yield* dbMutation(db, asTrusted(input), (tx, values) =>
      tx.update(projects).set(values).where(eq(projects.id, project.id))
    )

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
testBindings)` and expect a `303` to `/projects/project-1`, a `403` for
another user, and a `422` for an empty name.

## Do not use

- `c.req.json()`, `c.req.parseBody()` or `c.env` inside actions.
- `db.insert`, `db.update` or `db.delete` outside `dbMutation`/`dbTransaction`.
- Names from the old `honertia` package (`setupHonertia`, `HonertiaService`,
  `c.var.honertia`, ...): the README's migration table lists their
  replacements.

## Before finishing

Run the application's type check (`tsc --noEmit`) and `bun test`. A type error
at `routes.get(...)` names the problem: `missingServices` lists services the
setup does not provide (configure them in `setupWeb`, or `routes.provide(layer)`),
and `unhandledErrors` lists failures that are not the package's errors (handle
them with `Effect.catchTag`, or fail with `HttpError`).
