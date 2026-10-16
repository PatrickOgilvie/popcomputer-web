# Lint rules

The type checker reports what the framework can see in types: a service the
setup does not provide, a failure an action leaves unhandled, a path that is
not declared. The rules in `@popcomputer/web/lint` report the mistakes types
cannot see, the ones a reviewer has to know to look for. They apply where a
file uses the framework: the action rules to files that import `action`, the
database rules inside `dbQuery`, `dbMutation`, `dbTransaction` and `dbBatch`.
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
| `prefer-checked-config` | Effect's `Config.String('NAME')` and its siblings in an application of the framework | `config.string('NAME')`, which checks the name against the Worker's bindings |
| `no-auth-api-in-action` | `auth.api.signInEmail(...)` and Better Auth's other endpoints called from an action, which skips its rate limits | `betterAuthRedirect('signInEmail', { body }, ...)` or `betterAuthCall(...)` |

A line that breaks a rule on purpose says why, as
`// oxlint-disable-next-line popcomputer-web/no-sql-interpolation -- the values are constants`.
`webLint({ 'no-catch-all-in-action': 'warn' })` changes a rule's severity, and
`webLint()` spreads into a larger configuration,
`defineConfig({ ...webLint(), ignorePatterns: ['dist'] })`.
