# Lint rules

The type checker reports what the framework can see in types: a service the
setup does not provide, a failure an action leaves unhandled, a path that is
not declared. The rules in `@popcomputer/web/lint` report the mistakes types
cannot see, the ones a reviewer has to know to look for. They apply where a
file uses the framework: the action rules to files that import `action`, the
database rules inside `dbQuery`, `dbMutation`, `dbTransaction` and `dbBatch`,
the binding rule to `setupWeb`'s `bindings` and `routeBinding`.
The examples in `docs/`, the README and `AGENTS.md` pass them.

| Rule | Reports | Use instead |
| --- | --- | --- |
| `no-unscoped-write` | An `update` or `delete` with no `.where(...)`, which changes every row | `.where(...)` scoped by the bound model or the signed-in user |
| `no-write-in-db-query` | An `insert`, `update` or `delete` in `dbQuery` (fixable) | `dbMutation`, whose failures are typed |
| `no-external-work-in-transaction` | `fetch`, `background`, the cache, `Effect.sleep` or `Effect.promise` inside `dbTransaction` | The call before or after the transaction |
| `no-sql-interpolation` | `sql.raw(text)` or SQL built from a string with values in it | Drizzle's builder, or `` sql`... ${value}` ``, which binds values |
| `no-database-service-in-action` | `DatabaseService` or `$client` in an action module | `dbQuery`, `dbMutation`, `dbTransaction`, `dbBatch` |
| `no-raw-request-input` | `RequestService`'s `json()`, `parseBody()`, `query()` or `params()` | `validateRequest(Schema)`, or the endpoint's contract |
| `no-hono-context-in-action` | Hono's `c.req`, `c.env` or `c.json` inside an action | `validateRequest`, `config.string`, response helpers |
| `no-effect-runner-in-action` | `Effect.runPromise` and the other runners | `yield*` the Effect |
| `no-catch-all-in-action` | `Effect.catch`, `orDie`, `ignore` and the like over the database, `authorize()`, `bound()` or `validateRequest`, called or piped | `Effect.catchTag` for the failures the action answers |
| `no-raw-response-in-action` | `new Response(...)` | `json`, `text`, `file` (which serves uploads with `nosniff`), `noContent` |
| `no-provision-in-action` | `Effect.provide` in an action module | `web.services(...)`, or `routes.provide(layer)` |
| `require-background` | `waitUntil(...)` | `background('name', effect)` |
| `no-validation-in-endpoint` | `validateRequest` or `json` in an endpoint's action | The handler's argument, and the returned value |
| `require-binding-access` | A binding that does not say who may load its record: a bare table, or `routeBinding` without `ownedBy`, `publicWhen`, `public`, `guarded` or `scope`; or a `publicWhen` value written `undefined` | `routeBinding(schema.projects, { ownedBy: 'userId' })`, or the option that says who may; `publicWhen: { isPublic: true }` |
| `prefer-checked-config` | Effect's `Config.String('NAME')` and its siblings in an application of the framework | `config.string('NAME')`, which checks the name against the Worker's bindings |
| `no-auth-api-in-action` | `auth.api.signInEmail(...)` and Better Auth's other endpoints called from an action, which skips its rate limits | `betterAuthRedirect('signInEmail', { body }, ...)` or `betterAuthCall(...)` |
| `no-floating-effect` | A framework call that builds an Effect, written as a statement, so nothing runs it: `dbMutation(...)`, `flash(...)`, `redirect(...)`, `cart.set(...)`, `Effect.log(...)`; and `yield` without `*` | `yield* dbMutation(...)`, or `return` it |
| `no-module-level-mutable-state` | A module-scope `let` or `var`, or a module-scope `Map`, `Set` or array a function changes, outside tests, configuration, scripts and pages: a Worker's isolate shares it with every request, so one visitor's data can reach another's | Values inside the action, `web.services({ app })` for a service built once, `cache(key, effect, schema, { ttl, tags })` for data kept across requests |
| `no-testing-in-production` | An import of `@popcomputer/web/testing` (whose `signedIn` signs a request in with no session) from a file that is not a test | The helpers in tests only; `authorize()` or `currentUser` in the application |
| `no-server-imports-in-pages` | A page or component (under `src/pages/`, or importing `@popcomputer/web/react`) importing server code: `@popcomputer/web`, `/effect`, `/auth`, `/env`, `/cache`, `/drizzle`, `drizzle-orm`, the Drizzle schema, the env module or an action | Props declared in `src/pages.ts`, `href` from `@popcomputer/web/paths`, and `import type` for types |

## What each rule sees

The rules read one file's syntax. They follow its imports and the names it
declares, but resolve no module and run no type checker, so each has limits.
A limit listed here is a known boundary of the rule, not a way around it.

- `no-floating-effect`. Covers: an expression statement, anywhere in a file,
  that calls one of the framework's Effect constructors (the database
  operations, `authorize`, `bound`, `validateRequest`, the response helpers,
  `flash`, `share`, `responseHeader`, `purgeCache`, `background`,
  `betterAuthCall`, the data cache's calls) or any of Effect's own functions
  but its runners, through `.pipe(...)`, `void`, `&&`, `?:` and commas; a
  cookie declaration's `.set(...)`, `.read` and `.clear`, whether declared in
  the file or imported under a name ending in `Cookie`; and `yield` without
  `*` before any of them. Does not see: an Effect the application's own
  function returns (`notifyOwner(project)` as a statement), one assigned and
  never yielded, one built in an array or an object, a cookie imported under
  another name, or the framework imported through a file that re-exports it.
  The Effect language service sees all of these by type.
- `no-module-level-mutable-state`. Covers: `let` and `export let` at module
  scope, `var` anywhere outside a function, and a module-scope `const` holding
  a `new Map()`, `new Set()` or an array literal that a function changes
  (`.set`, `.add`, `.push`, `.delete` and the other mutating methods, or an
  assignment to one of its elements), in every file but tests (`*.test.ts`,
  `*.spec.ts`, `test-*.ts`, anything under `test/`, `tests/` or
  `__tests__/`, and the file `bunfig.toml`'s `[test] preload` names), tools'
  configuration (`*.config.ts`), declarations
  (`*.d.ts`), `scripts/`, and pages (under `src/pages/`, or importing
  `@popcomputer/web/react`), which run in one visitor's browser. A collection
  filled as the module loads and only read after is the same for every
  visitor, and passes. Does not see: an object literal whose properties a
  function changes, a class's static fields, state another module holds and
  this one changes, or a collection built by a function call
  (`const seen = makeCache()`). A local name that shadows a module-scope
  collection inside a function counts as the collection.
- `no-testing-in-production`. Covers: `import`, `export ... from`,
  `import('...')` and `require('...')` of `@popcomputer/web/testing` with the
  source written as a string, in any file that is not a test as
  `no-module-level-mutable-state` counts them. `import type` passes: the
  build erases it. Does not see: a production module importing a test
  helper that imports the testing helpers (`src/app.ts` importing
  `./test-db`), a source built at runtime, or a re-export of the helpers
  under another package's name.
- `no-server-imports-in-pages`. Covers: in a file under `src/pages/`, or one
  that imports `@popcomputer/web/react` (`import type` included), an import,
  re-export, `import()` or `require()` of the framework's server entrypoints
  (`@popcomputer/web`, `/effect`, `/auth`, `/env`, `/cache`, `/drizzle`),
  `drizzle-orm`, or the application's own server modules by name, relative
  or through a `@/` or `~/` alias: a file named `schema`, `auth-schema`,
  `env`, `db`, `auth`, `app`, `routes` or `worker`, or one in an `actions/`,
  `schema/` or `db/` folder. `import type` and `import { type X }` pass, so
  a form reads its action's schema as `FormInput<typeof Schema>`;
  `@popcomputer/web/paths`, `/schema` and `/endpoint` pass. Does not see: a
  component outside `src/pages/` that does not import
  `@popcomputer/web/react`, a server module under another name (`./data`), a
  module that imports server code itself (`../forms` importing `../db`),
  other path aliases, or server-only packages besides Drizzle, such as
  `better-auth` itself.

## The Effect language service

The language service's `floatingEffect` diagnostic finds every Effect that is
neither yielded nor assigned, by its type, so it sees the application's own
functions the lint rule cannot. It reaches `tsc` only once `tsc` is patched:
a `tsconfig.json` plugin runs in the editor's language server alone, and an
unpatched `tsc --noEmit` passes a floating Effect with exit code 0. On
TypeScript 7 the service ships as `@effect/tsgo`:

```bash
bun add -d @effect/tsgo
```

Name the plugin in `tsconfig.json` (its name stays `@effect/language-service`)
and patch the installed TypeScript on every install:

```json
{
  "compilerOptions": {
    "plugins": [{ "name": "@effect/language-service" }]
  }
}
```

```json
{
  "scripts": { "prepare": "effect-tsgo patch" }
}
```

`tsc --noEmit` then fails with `effect(floatingEffect)` on the statement, in
`.ts` and `.tsx` files alike: `floatingEffect` is an error by default, and an
Effect error sets `tsc`'s exit code unless the plugin's
`ignoreEffectErrorsInTscExitCode` says otherwise. It also reports `yield`
without `*` (`missingStarInYieldEffectGen`). `bun install` runs `prepare`;
an install with scripts turned off, such as `bun install --ignore-scripts` in
a CI job, leaves `tsc` unpatched, passing floating Effects again. On
TypeScript 5 or 6 the package is `@effect/language-service`, with
`"prepare": "effect-language-service patch"`.

## Turning a rule off

A line that breaks a rule on purpose says why, as
`// oxlint-disable-next-line popcomputer-web/no-sql-interpolation -- the values are constants`.
`webLint({ 'no-catch-all-in-action': 'warn' })` changes a rule's severity, and
`webLint()` spreads into a larger configuration,
`defineConfig({ ...webLint(), ignorePatterns: ['dist'] })`.
