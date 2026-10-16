# Reading the type errors

The framework reports most mistakes as type errors where they are made, and
each names what is wrong. Fix the first error in a file before reading the
rest: one error inside an action or `setupWeb`'s configuration can make
TypeScript give up on the types that later errors are about.

| Where, and what it says | What it means | What to do |
| --- | --- | --- |
| A registration, `missingServices: "@popcomputer/web/Database"` | The action uses a service the setup does not provide | Configure it in `setupWeb` (`database`, `auth.client`, `services`), or `routes.provide(layer)` |
| A registration, `unhandledErrors: "PaymentDeclined"` | The action can fail with an error the boundary cannot answer | Turn it into a response with `Effect.catchTag`: `invalid`, `notFound`, `httpError`, `flash` then `back`. A failure the action cannot answer, such as another system being down: pipe that call through `Effect.orDie`, which answers 500. A list cut off with `... 7 more ...` shows whole with `"noErrorTruncation": true` in `tsconfig.json` |
| A registration, `missingRouteModels: "project"` | The action, or a guard it is registered under, calls `bound('project')`, and the path has no `{project}` | Register it on a path with the placeholder, or read the record by an id from `validateRequest` |
| A registration or `action(...)`, `Effect<..., unknown, unknown>` or `missingServices: "unnamed service"` | An earlier type error inside the action made its type unknown | Fix the first error inside the action |
| `render(...)`, props not assignable | The page's name or props differ from `src/pages.ts` | Change the props, or the page's schema |
| A path literal, `Not one of setupWeb's paths`, with `declaredPaths` | The path is not declared | Declare it in `src/paths.ts` and pass `paths.x` |
| `bound('...')`, `config.string('...')`, a key not assignable | A misspelled binding, or a var the bindings type does not declare | Use a name the error lists, or declare it in `src/env.ts`'s `defineEnv` |
| `Effect.catchTag('X', ...)`, `not assignable to parameter of type 'readonly [never, ...never[]]'` | The Effect no longer fails with `X` | Remove the handler |
| `Effect.catchTags({ X: ... })`, `not assignable to type '{ X: never; }'` | The same, for one of the handlers | Remove that handler |
| A `catchTag` in a helper written apart from its Effect, `{ readonly _tag: unknown }` not assignable | TypeScript cannot see the errors the helper handles | Write it inside `.pipe(...)`, or use `Effect.catchIf((error) => error instanceof X, ...)` |
| `setupWeb(...)` given `services` | Services are given after the registration | Move them to `export const { app, routes } = web.services({ app, request })`, after the `Register` declaration |
| Inside `setupWeb(...)`, many errors naming `DatabaseNotConfigured`, or `(c) => never` at `database` | One value in the configuration has a type error, so TypeScript infers none of its types | Fix the first error inside the `setupWeb` call |
| A database result, `This result's type is any` | The driver's types name Cloudflare's global types, which the program cannot find | Add `@cloudflare/workers-types`, or the file `wrangler types` writes, to `compilerOptions.types` |
| `dbTransaction(...)`, `Use dbBatch for atomic writes, or a driver with transactions.` | The database has no interactive transactions: Cloudflare D1, or a synchronous driver such as `bun:sqlite` | Write the statements as one `dbBatch` |
| A `dbBatch` on D1, `Drizzle cannot run db.run(sql) with parameters in a Cloudflare D1 batch` | Drizzle's D1 batch fails at runtime on a raw statement | Write the statement with the query builder |

What types cannot see, such as an update without a `where` or a network call
inside a transaction, the [lint rules](lint-rules.md) report.
