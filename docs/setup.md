# Quick start

Every type an application uses is declared once, as a value, and the rest of
the application is typed by it: the database client, the Better Auth client,
the signed-in user, route models, pages, shared props and flash data.

## 1. Describe the Worker's bindings

```ts
// src/env.ts
import { Schema as S } from 'effect'
import { defineEnv, randomSecret, secret, variable, type EnvBindings } from '@popcomputer/web/env'

export const env = defineEnv({
  DATABASE_URL: secret(),
  BETTER_AUTH_SECRET: secret(S.String.check(S.isMinLength(32)), { generate: randomSecret }),
  PAYMENT_WEBHOOK_SECRET: secret(S.String.check(S.isStartingWith('whsec_'))),
  TIME_ZONE: variable(S.String, { optional: true }),
})

export type Bindings = EnvBindings<typeof env> & { KV: KVNamespace; SIGN_IN_LIMITER: RateLimit }

export type Env = { Bindings: Bindings }
```

The vars and secrets are declared once, and checked before an isolate
serves: [Vars and secrets](env.md) shows how.

## 2. Describe the pages

Each page's props are an Effect Schema in `src/pages.ts`, and each React
page takes its props from it: [Pages and props](pages.md) shows both.

## 3. Configure the application once, and register it

```ts
// src/app.ts
import { Hono } from 'hono'
import { Schema as S, Struct } from 'effect'
import { createTemplate, createVersion, setupWeb } from '@popcomputer/web'
import { betterAuthSession } from '@popcomputer/web/auth'
import { routeBinding } from '@popcomputer/web/effect'
import { tableSchema } from '@popcomputer/web/schema'
import { createAuth } from './auth'
import { createDb } from './db'
import { sendEmail } from './email'
import manifest from '../dist/manifest.json'
import { env, type Env } from './env'
import { pages } from './pages'
import { paths } from './paths'
import * as schema from './schema'

export const web = setupWeb(new Hono<Env>(), {
  version: createVersion(manifest),
  render: createTemplate({
    title: 'Projects',
    scripts: [manifest['src/main.tsx']?.file].filter(Boolean),
    styles: manifest['src/main.tsx']?.css ?? [],
  }),
  database: (c) => createDb(c.env.DATABASE_URL),
  schema,
  bindings: {
    project: routeBinding(schema.projects, { ownedBy: 'userId' }),
    showcase: routeBinding(schema.projects, { publicWhen: { isPublic: true } }),
    task: routeBinding(schema.tasks, { scope: { project: { foreignKey: 'projectId' } } }),
    organization: routeBinding(schema.organizations, { guarded: true }),
    member: routeBinding(schema.memberships, { scope: { organization: { foreignKey: 'organizationId' } } }),
  },
  pages,
  paths,
  auth: {
    client: (c, { db, backgroundTasks }) => createAuth({
      db,
      secret: c.env.BETTER_AUTH_SECRET,
      baseURL: new URL(c.req.url).origin,
      sendEmail: (email) => sendEmail(c.env, email),
      advanced: { backgroundTasks },
    }),
    // The user's fields are the user table's; pages see only `share`'s.
    session: betterAuthSession(tableSchema(schema.user)),
    // Slow password guessing: the binding wrangler.jsonc declares, and
    // Better Auth's rateLimit table, where failed sign-ins are counted.
    signInLimits: { limiter: 'SIGN_IN_LIMITER', table: schema.rateLimit },
    share: tableSchema(schema.user).mapFields(Struct.pick(['id', 'name', 'image'])),
  },
  shared: S.Struct({ unreadCount: S.Number }),
  flash: S.Struct({ success: S.String }),
  errors: { component: 'Error' },
  env,
})

declare module '@popcomputer/web' {
  interface Register {
    web: typeof web
  }
}

export const { app, routes } = web
export default app
```

Registering `setupWeb`'s result is the one declaration the rest of the
application reads its types from:

| Declared in `setupWeb` | Types |
| --- | --- |
| `new Hono<Env>()` | `BindingsService`, Effect `Config`, `testEnv`'s bindings |
| `env` | the vars and secrets in `Bindings`, through `EnvBindings`, checked when an isolate starts |
| `database` | `DatabaseService` and the `db` in `dbQuery`, `dbMutation`, `dbBatch` |
| `schema`, `bindings` | `bound('project')`, its keys, the model's row type and who may load it |
| `auth.client` | `AuthService`, and the endpoints `betterAuthRedirect` and `betterAuthCall` call |
| `auth.session` | `authorize()`, `currentUser`, `AuthUserService`, `signedIn` |
| `auth.share` | `auth.user` in `SharedProps` and `WebPage` (default: `id`, `name`, `image`) |
| `pages` | `render`, `jsonOrRender`, `WebPage`, `readPage` |
| `paths` | the paths `routes.get(...)` and the other registrations accept |
| `shared`, `flash` | `shareProps(effect)`, `share(key, value)`, `flash(key, value)`, `SharedProps`, `FlashData` |

Each value reaches the browser encoded through its schema, so a field the
schema does not name, such as the user's email, never leaves the server.
Inertia's own `usePage()` reads the same types from one more declaration:

```ts
// src/inertia.d.ts
import type { FlashData, SharedProps } from '@popcomputer/web/react'

declare module '@inertiajs/core' {
  interface InertiaConfig {
    sharedPageProps: SharedProps
    flashDataType: FlashData
  }
}
```

The database and Better Auth come from two small factories. On Postgres,
through Hyperdrive in production:

```ts
// src/db.ts
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

// Drizzle's driver-independent Postgres database: a PGlite client in tests
// has this type too, so testEnv accepts it in place of Hyperdrive's.
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>

export function createDb(url: string): Database {
  return drizzle(postgres(url), { schema })
}
```

Better Auth's factory, `src/auth.ts`, and the mailer it sends through, `src/email.ts`, are in
[Auth](auth.md#better-auths-client); the tables it reads and writes, in [Better Auth's tables](auth-tables.md).

On Cloudflare D1, `createDb` takes the binding instead,
`drizzle(c.env.DB, { schema })` from `drizzle-orm/d1`, and the adapter's
`provider` is `'sqlite'`. Type the database as `ReturnType<typeof createDb>` or
Drizzle's `DrizzleD1Database<typeof schema>`: either way `dbTransaction` is a
type error on D1, which has no interactive transactions.

Database-backed auth receives the database as an explicit dependency. The
alternatives below need no placeholders or explicit generics:

```ts
const version = createVersion(manifest)
const template = createTemplate({ title: 'Projects' })

// Public application
setupWeb(app, { version, render: template })

// Database without auth
setupWeb(app, {
  version,
  render: template,
  database: (c) => createDb(c.env.DATABASE_URL),
})

// Stateless auth
setupWeb(app, {
  version,
  render: template,
  auth: {
    client: (c, { backgroundTasks }) => createStatelessAuth({
      secret: c.env.BETTER_AUTH_SECRET,
      advanced: { backgroundTasks },
    }),
  },
})
```

`setupWeb` installs the middleware stack and error boundary and returns
`{ app, routes }`; for manual composition, see [Lower-level composition](lower-level.md).

## 4. Write actions and register routes

Each route's path is declared once in `src/paths.ts`, and each action is
registered on `routes`: [Actions and routes](actions.md) shows both.

## 5. Write the client

Forms take their fields from the schema their action validates, as
[Forms](forms.md) shows, and the client maps each page to its component, as
[Pages and props](pages.md#the-page-map) shows.

## 6. Wire the Worker

A route is registered when the module that registers it runs, so the
Worker's entry imports every module of registrations. A module nothing
imports leaves its routes answering 404, with no error to say why. Point
Wrangler's `main` at the entry, `"main": "src/worker.ts"` in
`wrangler.jsonc`:

```ts
// src/worker.ts
import { app } from './app'
import './routes'
import './auth-routes'
import './api-routes'

export default app
```

A Worker that also runs Cron Triggers or a Queue consumer exports their
handlers beside `fetch`, as [Scheduled and queued work](background.md#scheduled-and-queued-work)
shows. A test imports the same modules, or the entry itself, before its first
request.

Each file of the application declares one thing, and the rest reads it:

| File | Declares | Read by |
| --- | --- | --- |
| `src/env.ts` | the Worker's bindings | `new Hono<Env>()`, `config`, `testEnv`'s bindings |
| `src/schema.ts` | the Drizzle tables | `bindings`, `tableSchema`, `columnsOf`, cache tags, Better Auth |
| `src/db.ts`, `src/auth.ts`, `src/email.ts` | the database, Better Auth and mail clients | `setupWeb`'s `database` and `auth.client` |
| `src/paths.ts` | every route's path | `routes`, `redirect`, `back`, `href`, endpoint contracts |
| `src/pages.ts` | each page's props | `render`, `WebPage`, `readPage` |
| `src/forms.ts` | each form's fields | `validateRequest` in actions, `FormInput` in React |
| `src/endpoints.ts` | each JSON endpoint's contract | `action(endpoint, ...)`, `routes.endpoint`, `call`, `openApi` |
| `src/services.ts` | application services and their layers | `web.services(...)` in `src/app.ts` |
| `src/app.ts` | `setupWeb(...)`, its registration, and `web.services(...)` | every type above, and the routes |
| `src/routes.ts` and other route modules | the registrations | `src/worker.ts` |
| `src/actions/**` | one action per route | the route modules |
| `src/pages/**`, `src/main.tsx` | the React pages and the page map | the browser bundle |

The browser bundle may import `src/paths.ts`, `src/forms.ts` and
`src/endpoints.ts`, which import only `effect`, the validators and the paths.
Everything else is server code: a React page reads its props through
`WebPage`, which takes them from the registration, never by importing
`src/pages.ts`, which reads the tables.
