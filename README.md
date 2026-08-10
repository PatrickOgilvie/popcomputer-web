# Honertia

Inertia.js adapter for Hono with Effect.ts. Server-driven app with SPA behavior.

## Why Honertia

Honertia brings the Laravel/Inertia productivity loop to Hono and Cloudflare Workers, with Effect powering the backend control flow instead of ad-hoc promises and unchecked exceptions.

- **Server-driven SPA pages on Hono**: Render Inertia-style pages from Hono routes while keeping React/Vite on the client and Worker-friendly request handling on the server.
- **Effect-native route handlers**: Write actions as typed Effect programs with explicit services, structured failures, redirects, validation errors, and testable dependency layers.
- **One setup path for real apps**: `setupHonertia(app, config)` wires middleware, services, session parsing, the Effect runtime, and the shared error boundary.
- **Declarative route model binding**: Register a row schema once, use paths like `/projects/{project}`, and access parsed, parent-scoped models with `yield* bound('project')`.
- **Safe mutation boundaries**: `validateRequest`, scoped `dbMutation`, and `dbTransaction` make writes explicit and keep unvalidated request data out of database mutations.
- **Auth built in, not bolted on**: Better Auth helpers cover authenticated routes, guest-only routes, form actions, typed `authorize()`, session loading, and shared auth props.
- **Effect-aware cache wrapper**: Cache expensive reads with schema-checked serialization, TTLs, stale-while-revalidate, and Worker `waitUntil` background refreshes.
- **Agent-friendly CLI**: Generate actions, CRUD routes, features, OpenAPI specs, route listings, project checks, and migration previews from a single `honertia` binary.
- **Production observability hooks**: Structured errors and `EffectErrorObserverService` provide a single integration point for Sentry, PostHog, or any Effect-aware reporting pipeline.

Demo Worker: [PatrickOgilvie/honertia-worker-demo](https://github.com/PatrickOgilvie/honertia-worker-demo)

One-click demo deploy:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/PatrickOgilvie/honertia-worker-demo)

## Laravel-Style Helpers

Honertia keeps common app code small and expressive. The helpers are Effect-native, but the shape should feel familiar if you like Laravel controllers, form requests, redirects, cache wrappers, and route model binding.

```typescript
import { effectRoutes } from 'honertia/effect'
import { indexProjects, showProject, updateProject } from './actions/projects'

effectRoutes(app)
  .get('/projects', indexProjects, { name: 'projects.index' })
  .get('/projects/{project}', showProject, { name: 'projects.show' })
  .put('/projects/{project}', updateProject, { name: 'projects.update' })
```

```typescript
import { Effect } from 'effect'
import { action, authorize, bound, render } from 'honertia/effect'

export const showProject = action(
  Effect.gen(function* () {
    const project = yield* bound('project')
    yield* authorize((auth) => auth.user.id === project.userId)

    return yield* render('Projects/Show', { project })
  })
)
```

```typescript
import { Effect, Schema as S, Duration } from 'effect'
import { action, authorize, DatabaseService, HttpError, render } from 'honertia/effect'
import { cache } from 'honertia/cache'
import { eq } from 'drizzle-orm'
import { projects } from '~/db/schema'

const ProjectSummary = S.Struct({
  id: S.String,
  name: S.String,
  updatedAt: S.Date,
})

export const indexProjects = action(
  Effect.gen(function* () {
    const auth = yield* authorize()
    const db = yield* DatabaseService

    const userProjects = yield* cache(
      `users:${auth.user.id}:projects`,
      Effect.tryPromise(() =>
        db.query.projects.findMany({
          columns: { id: true, name: true, updatedAt: true },
          where: eq(projects.userId, auth.user.id),
          orderBy: (project, { desc }) => [desc(project.updatedAt)],
        })
      ),
      S.Array(ProjectSummary),
      { ttl: Duration.minutes(5), swr: Duration.minutes(1), version: true }
    ).pipe(
      Effect.mapError((cause) => new HttpError({
        status: 503,
        message: 'Projects are temporarily unavailable.',
        cause,
      }))
    )

    return yield* render('Projects/Index', { projects: userProjects })
  })
)
```

```typescript
import { Effect, Schema as S } from 'effect'
import {
  action,
  authorize,
  bound,
  validateRequest,
  DatabaseService,
  dbMutation,
  redirect,
  requiredString,
} from 'honertia/effect'
import { eq } from 'drizzle-orm'
import { projects } from '~/db/schema'

const UpdateProject = S.Struct({
  name: requiredString,
  description: S.optional(S.String),
})

export const updateProject = action(
  Effect.gen(function* () {
    const project = yield* bound('project')
    yield* authorize((auth) => auth.user.id === project.userId)

    const input = yield* validateRequest(UpdateProject, {
      errorComponent: 'Projects/Edit',
    })
    const db = yield* DatabaseService

    yield* dbMutation(db, input, async (tx, input) => {
      await tx
        .update(projects)
        .set(input)
        .where(eq(projects.id, project.id))
    })

    return yield* redirect(`/projects/${project.id}`)
  })
)
```

```typescript
import { render, redirect, notFound, forbidden, jsonOrRender } from 'honertia/effect'

return yield* render('Dashboard', { stats })
return yield* redirect('/login')
return yield* notFound('Project', projectId)
return yield* forbidden('You cannot edit this project')
return yield* jsonOrRender('Projects/Index', { projects })
```

## CLI Commands

`honertia` is shipped as a package binary. You can run commands with:

```bash
bunx honertia <command>
# or
npx honertia <command>
```

Commands that inspect routes import the entrypoint passed with `--app` and read
that Hono app's registry. The module may export the Hono app, the
`{ app, routes }` value returned by `setupHonertia`, or a `RouteRegistry`.
There is no need to populate a process-global registry.

### Generate Action

```bash
# Basic action
honertia generate:action projects/create --method POST --path /projects

# With authentication
honertia generate:action projects/create --method POST --path /projects --auth required

# With validation schema
honertia generate:action projects/create \
  --method POST \
  --path /projects \
  --auth required \
  --schema "name:string:required, description:string:nullable"

# With route model binding
honertia generate:action projects/update \
  --method PUT \
  --path "/projects/{project}" \
  --auth required \
  --schema "name:string:required"

# Preview without writing
honertia generate:action projects/create --preview

# JSON output for programmatic use
honertia generate:action projects/create --json --preview
```

Schema format: `fieldName:type:modifier`
- Types: `string`, `number`, `boolean`, `date`, `uuid`, `email`, `url`
- Modifiers: `required` (default), `nullable`, `optional`

### Generate CRUD

```bash
# Full CRUD
honertia generate:crud projects

# With schema for create/update
honertia generate:crud projects \
  --schema "name:string:required, description:string:nullable"

# Only specific actions
honertia generate:crud projects --only index,show

# Exclude actions
honertia generate:crud projects --except destroy

# Preview all generated files
honertia generate:crud projects --preview
```

### Generate Feature

```bash
# Custom action on a resource
honertia generate:feature projects/archive \
  --method POST \
  --path "/projects/{project}/archive" \
  --auth required

# With fields
honertia generate:feature users/profile \
  --method PUT \
  --path "/profile" \
  --fields "name:string:required, bio:string:nullable"
```

### Generate Inline Test Runner

```bash
honertia generate:tests-runner
honertia generate:tests-runner --scan src/actions,src/features
honertia generate:tests-runner --output tests/inline-actions.test.ts
honertia generate:tests-runner --preview
```

### List Routes

```bash
honertia routes --app src/index.ts              # Table format
honertia routes --app src/index.ts --json       # JSON for agents
honertia routes --app src/index.ts --minimal    # METHOD PATH only
honertia routes --app src/index.ts --method get # Filter by method
honertia routes --app src/index.ts --prefix /api
honertia routes --app src/index.ts --pattern '/projects/*'
```

### Project Check

```bash
honertia check --app src/index.ts           # Run all checks
honertia check --app src/index.ts --json    # JSON output with fix suggestions
honertia check --app src/index.ts --verbose # Detailed output
honertia check --app src/index.ts --only routes,naming
```

### OpenAPI Generation

```bash
honertia generate:openapi \
  --app src/index.ts \
  --title "My API" \
  --version "1.0.0" \
  --server https://api.example.com \
  --output openapi.json

# Only API routes
honertia generate:openapi --app src/index.ts --include /api

# Exclude internal routes
honertia generate:openapi --app src/index.ts --exclude /internal,/admin
```

### Database Migrations

```bash
honertia db status              # Show migration status
honertia db status --json       # JSON output
honertia db migrate             # Run pending migrations
honertia db migrate --preview   # Preview SQL without executing
honertia db rollback --preview  # Preview rollback SQL for latest applied migration
# Non-preview rollback execution is manual (run preview SQL yourself)
honertia db generate add_email  # Generate new migration
```

---

## Installation

```bash
bun add honertia hono effect

# Add these only when your app uses Better Auth and Drizzle
bun add better-auth drizzle-orm

# React/Inertia client and TypeScript tooling
bun add -d @types/bun @cloudflare/workers-types typescript vite @vitejs/plugin-react @inertiajs/react react react-dom
```

---

## Full-Stack Starter (D1 + Better Auth)

Honertia does not require a database or authentication. The starter below shows
the most common full-stack shape: Cloudflare D1, Drizzle, Better Auth, React,
and Inertia. For a public or stateless app, omit the database, auth, and route
binding pieces; the supported setup shapes are listed after the example.

### 1. src/types.ts

Use module augmentation for the services your actions consume. Database and
auth augmentations are optional when those services are not used.

```typescript
// src/types.ts
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type { Auth } from './lib/auth'
import * as schema from './db/schema'

// Database type
export type Database = DrizzleD1Database<typeof schema>

// Cloudflare bindings
export type Bindings = {
  DB: D1Database
  BETTER_AUTH_SECRET: string
  ENVIRONMENT?: string
  // Add KV, R2, Queue bindings as needed:
  // KV: KVNamespace
  // R2: R2Bucket
}

// Full environment type for Hono
export type Env = {
  Bindings: Bindings
}

// CRITICAL: Module augmentation for type-safe services
declare module 'honertia/effect' {
  interface HonertiaDatabaseType {
    type: Database
  }
  interface HonertiaAuthType {
    type: Auth
  }
  interface HonertiaBindingsType {
    type: Bindings
  }
}
```

Route binding output types are derived from the parser map passed to
`honertia.bindings`, not from the Drizzle database augmentation. The starter
declares that map next to app setup below; larger apps can export it from a
dedicated module.

### 2. src/db/schema.ts

Required by this starter's database and route model bindings, but not by
Honertia itself.

```typescript
// src/db/schema.ts
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import { relations } from 'drizzle-orm'

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
})

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
})

export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp' }),
  refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp' }),
  scope: text('scope'),
  password: text('password'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
})

export const verifications = sqliteTable('verifications', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
})

// Your app tables
export const projects = sqliteTable('projects', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
})

// Relations for query builder
export const usersRelations = relations(users, ({ many }) => ({
  projects: many(projects),
  sessions: many(sessions),
  accounts: many(accounts),
}))

export const projectsRelations = relations(projects, ({ one }) => ({
  user: one(users, { fields: [projects.userId], references: [users.id] }),
}))
```

### 3. src/db/db.ts

Database client factory.

```typescript
// src/db/db.ts
import { drizzle } from 'drizzle-orm/d1'
import * as schema from './schema'
import type { Database } from '../types'

export function createDb(d1: D1Database): Database {
  return drizzle(d1, { schema })
}

// For local development with better-sqlite3:
// import Database from 'better-sqlite3'
// import { drizzle } from 'drizzle-orm/better-sqlite3'
// export function createDb(path: string): Database {
//   const sqlite = new Database(path)
//   return drizzle(sqlite, { schema })
// }
```

### 4. src/lib/auth.ts

Better-auth configuration.

```typescript
// src/lib/auth.ts
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import type { Database } from '../types'

export function createAuth(options: {
  db: Database
  secret: string
  baseURL: string
}) {
  return betterAuth({
    database: drizzleAdapter(options.db, {
      provider: 'sqlite',
    }),
    secret: options.secret,
    baseURL: options.baseURL,
    emailAndPassword: {
      enabled: true,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      updateAge: 60 * 60 * 24,     // 1 day
    },
  })
}

export type Auth = ReturnType<typeof createAuth>
```

### 5. src/index.ts

Main app entry point.

```typescript
// src/index.ts
import { Hono } from 'hono'
import { setupHonertia, createTemplate, createVersion } from 'honertia'
import { Schema as S } from 'effect'
import * as schema from './db/schema'
import { createDb } from './db/db'
import { createAuth } from './lib/auth'
import { registerRoutes } from './routes'
import type { Env } from './types'

// Import manifest (generated by Vite build)
// @ts-ignore - Generated at build time
import manifest from '../dist/manifest.json'

const app = new Hono<Env>()

const Project = S.Struct({
  id: S.String,
  name: S.String,
  userId: S.String,
})

const routeBindings = { project: Project }

declare module 'honertia/effect' {
  interface HonertiaRouteBindingsType {
    type: typeof routeBindings
  }
}

const AuthSession = S.Struct({
  user: S.Struct({
    id: S.String,
    email: S.String,
    name: S.NullOr(S.String),
    emailVerified: S.Boolean,
    image: S.NullOr(S.String),
    createdAt: S.DateFromSelf,
    updatedAt: S.DateFromSelf,
  }),
  session: S.Struct({
    id: S.String,
    userId: S.String,
    expiresAt: S.DateFromSelf,
    token: S.String,
    createdAt: S.DateFromSelf,
    updatedAt: S.DateFromSelf,
  }),
})

setupHonertia(app, {
  honertia: {
    version: createVersion(manifest),
    render: createTemplate((ctx) => ({
      title: 'My App',
      scripts: [manifest['src/main.tsx']?.file].filter(Boolean),
      styles: manifest['src/main.tsx']?.css ?? [],
    })),
    database: (c) => createDb(c.env.DB),
    schema,
    bindings: routeBindings,
  },
  auth: {
    client: (c, { db }) => createAuth({
      db,
      secret: c.env.BETTER_AUTH_SECRET,
      baseURL: new URL(c.req.url).origin,
    }),
    session: AuthSession,
    share: ({ user }) => ({ id: user.id, name: user.name, image: user.image }),
  },
  errors: { component: 'Error' },
})

registerRoutes(app)

export default app
```

Configuration has one owner at this application boundary: `honertia` owns the
renderer, database, schema, and route bindings; top-level `auth` owns the auth
client, session parser, cookie, and public projection; `effect` contains only
custom Effect services. Standalone `effectBridge()` and `effectRoutes()` calls
still accept schema and binding overrides because they compose outside
`setupHonertia()`.

### Supported Setup Shapes

Let TypeScript infer setup types from the configured factories; placeholder
generics are no longer needed.

| App shape | Configuration |
|---|---|
| Database-backed auth | `honertia.database` plus `auth.client: (c, { db }) => ...` |
| Stateless auth | `auth.client: (c) => ...`, with no database |
| Database without auth | `honertia.database`, with no `auth` block |
| No database or auth | Only `honertia.version` and `honertia.render` |

```typescript
// Minimal public/stateless setup
setupHonertia(app, {
  honertia: { version, render },
})
```

The preferred app form installs the middleware and shared not-found/error
boundary together and returns `{ app, routes }`. The returned registry is the
same app-owned registry populated by later `effectRoutes(app)` calls.

```typescript
const application = setupHonertia(app, {
  honertia: { version, render },
})

registerRoutes(app)
export { application }
export default app
```

### Migrating from 0.2.0

- Prefer `setupHonertia(app, config)` over wrapping the middleware form in
  `app.use('*', ...)`; the app form also installs the shared error boundary.
- Move `honertia.auth` to `auth.client`, `effect.schema` to
  `honertia.schema`, and `effect.bindings` to `honertia.bindings`.
- Configure `auth.session` to parse the server session and `auth.share` when
  the client needs more than the safe default `{ id, name, image }` user.
- Register an Effect Schema for every route binding and augment
  `HonertiaRouteBindingsType` with that parser map. Nested bindings now require
  an inferred Drizzle relationship or an explicit `routeBinding(..., { scope })`.
- Pass `--app <entrypoint>` to `routes`, `check`, and `generate:openapi`; route
  metadata belongs to the selected Hono app rather than process-global state.
- Remove explicit placeholder setup generics. Database presence and factory
  return types are inferred from configuration.
- Expect structured error pages to preserve their real HTTP status; they are
  no longer coerced to `200` for Inertia responses.

`createTemplate()` emits Inertia's script-element initial page payload:

```html
<script data-page="app" type="application/json">...</script>
<div id="app"></div>
```

If you provide a custom template renderer, use `serializePage(page)` from `honertia` for the JSON script body so `</script>` sequences inside props cannot close the element early.

### 6. src/routes.ts

Route definitions.

```typescript
// src/routes.ts
import type { Hono } from 'hono'
import type { Env } from './types'
import { effectRoutes } from 'honertia/effect'
import { effectAuthRoutes, RequireAuthLayer } from 'honertia/auth'

// Import your actions
import { loginUser, registerUser, logoutUser } from './actions/auth'
// import { listProjects, showProject, createProject } from './actions/projects'

export function registerRoutes(app: Hono<Env>) {
  // Auth routes (handles /login, /register, /logout, /api/auth/*)
  effectAuthRoutes(app, {
    loginComponent: 'Auth/Login',
    registerComponent: 'Auth/Register',
    loginAction: loginUser,
    registerAction: registerUser,
    logoutAction: logoutUser,
  })

  // Protected routes (require authentication)
  effectRoutes(app)
    .provide(RequireAuthLayer)
    .group((route) => {
      // Add your protected routes here
      // route.get('/', showDashboard)
      // route.prefix('/projects').group((route) => {
      //   route.get('/', listProjects)
      //   route.get('/{project}', showProject)
      //   route.post('/', createProject)
      // })
    })

  // Public routes (no auth required)
  effectRoutes(app).group((route) => {
    // route.get('/about', showAbout)
  })
}
```

### 7. src/main.tsx

Client-side entry point.

```tsx
// src/main.tsx
import './styles.css'
import { createInertiaApp } from '@inertiajs/react'
import { createRoot } from 'react-dom/client'

const pages = import.meta.glob('./pages/**/*.tsx')

createInertiaApp({
  resolve: (name) => {
    const page = pages[`./pages/${name}.tsx`]
    if (!page) {
      throw new Error(`Page not found: ${name}. Create src/pages/${name}.tsx`)
    }
    return page()
  },
  setup({ el, App, props }) {
    createRoot(el!).render(<App {...props} />)
  },
})
```

### 8. wrangler.toml (Cloudflare)

```toml
name = "my-app"
compatibility_date = "2024-01-01"
main = "src/index.ts"

[vars]
ENVIRONMENT = "development"

[[d1_databases]]
binding = "DB"
database_name = "my-app-db"
database_id = "your-database-id"

[site]
bucket = "./dist"
```

### 9. vite.config.ts

```typescript
// vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    manifest: 'manifest.json',
    rollupOptions: {
      input: 'src/main.tsx',
    },
  },
  resolve: {
    alias: {
      '~': path.resolve(__dirname, 'src'),
    },
  },
})
```

### 10. tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["bun-types", "@cloudflare/workers-types"],
    "paths": {
      "~/*": ["./src/*"]
    }
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

---

## Project Structure

```
src/
  index.ts          # App entry and setupHonertia()
  routes.ts         # Route definitions
  types.ts          # Service module augmentations
  main.tsx          # React/Inertia client entry
  styles.css        # Global styles
  db/
    db.ts           # Database factory (database apps)
    schema.ts       # Drizzle schema (database apps)
  lib/
    auth.ts         # Better Auth config (authenticated apps)
  actions/
    auth/
      login.ts
      register.ts
      logout.ts
    projects/
      index.ts
      show.ts
      create.ts
  pages/
    Auth/
      Login.tsx
      Register.tsx
    Projects/
      Index.tsx
      Show.tsx
      Create.tsx
    Error.tsx         # Error page component
wrangler.toml       # Cloudflare config
vite.config.ts      # Vite config
tsconfig.json       # TypeScript config
```

---

## Better Auth Form Actions

These actions are needed only when you enable the corresponding login,
registration, and logout routes. `effectAuthRoutes` can render guest pages
without form actions, and provides a default logout handler when
`logoutAction` is omitted.

`betterAuthFormAction` normalizes both thrown Better Auth `APIError` values and
resolved HTTP error responses. Form error mappers receive the same typed
`status`, `code`, and `message` fields in either mode.

### src/actions/auth/login.ts

```typescript
import { betterAuthFormAction } from 'honertia/auth'
import { Schema as S } from 'effect'
import { email, requiredString } from 'honertia/effect'

const LoginSchema = S.Struct({
  email: email,
  password: requiredString,
})

export const loginUser = betterAuthFormAction({
  schema: LoginSchema,
  errorComponent: 'Auth/Login',
  redirectTo: '/',
  errorMapper: (error) => {
    switch (error.code) {
      case 'INVALID_EMAIL_OR_PASSWORD':
        return { email: 'Invalid email or password' }
      case 'USER_NOT_FOUND':
        return { email: 'No account found with this email' }
      default:
        return { email: 'Login failed' }
    }
  },
  call: (auth, input, request) =>
    auth.api.signInEmail({
      body: { email: input.email, password: input.password },
      request,
      returnHeaders: true,
    }),
})
```

### src/actions/auth/register.ts

```typescript
import { betterAuthFormAction } from 'honertia/auth'
import { Schema as S } from 'effect'
import { email, requiredString, password } from 'honertia/effect'

const RegisterSchema = S.Struct({
  name: requiredString,
  email: email,
  password: password({ min: 8, letters: true, numbers: true }),
})

export const registerUser = betterAuthFormAction({
  schema: RegisterSchema,
  errorComponent: 'Auth/Register',
  redirectTo: '/',
  errorMapper: (error) => {
    switch (error.code) {
      case 'USER_ALREADY_EXISTS':
      case 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL':
        return { email: 'An account with this email already exists' }
      default:
        return { email: 'Registration failed' }
    }
  },
  call: (auth, input, request) =>
    auth.api.signUpEmail({
      body: { name: input.name, email: input.email, password: input.password },
      request,
      returnHeaders: true,
    }),
})
```

### src/actions/auth/logout.ts

```typescript
import { betterAuthLogoutAction } from 'honertia/auth'

export const logoutUser = betterAuthLogoutAction({
  redirectTo: '/login',
})
```

### src/actions/auth/index.ts

```typescript
export { loginUser } from './login'
export { registerUser } from './register'
export { logoutUser } from './logout'
```

---

## Starter Page Components

### src/pages/Auth/Login.tsx

```tsx
import { useForm } from '@inertiajs/react'

export default function Login() {
  const { data, setData, post, processing, errors } = useForm({
    email: '',
    password: '',
  })

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    post('/login')
  }

  return (
    <form onSubmit={submit}>
      <div>
        <input
          type="email"
          value={data.email}
          onChange={(e) => setData('email', e.target.value)}
          placeholder="Email"
        />
        {errors.email && <span>{errors.email}</span>}
      </div>
      <div>
        <input
          type="password"
          value={data.password}
          onChange={(e) => setData('password', e.target.value)}
          placeholder="Password"
        />
        {errors.password && <span>{errors.password}</span>}
      </div>
      <button type="submit" disabled={processing}>
        Login
      </button>
    </form>
  )
}
```

### src/pages/Auth/Register.tsx

```tsx
import { useForm } from '@inertiajs/react'

export default function Register() {
  const { data, setData, post, processing, errors } = useForm({
    name: '',
    email: '',
    password: '',
  })

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    post('/register')
  }

  return (
    <form onSubmit={submit}>
      <div>
        <input
          type="text"
          value={data.name}
          onChange={(e) => setData('name', e.target.value)}
          placeholder="Name"
        />
        {errors.name && <span>{errors.name}</span>}
      </div>
      <div>
        <input
          type="email"
          value={data.email}
          onChange={(e) => setData('email', e.target.value)}
          placeholder="Email"
        />
        {errors.email && <span>{errors.email}</span>}
      </div>
      <div>
        <input
          type="password"
          value={data.password}
          onChange={(e) => setData('password', e.target.value)}
          placeholder="Password"
        />
        {errors.password && <span>{errors.password}</span>}
      </div>
      <button type="submit" disabled={processing}>
        Register
      </button>
    </form>
  )
}
```

### src/pages/Error.tsx

```tsx
interface ErrorProps {
  status: number
  title: string
  message: string
}

export default function Error({ status, title, message }: ErrorProps) {
  return (
    <div>
      <h1>{status}</h1>
      <h2>{title}</h2>
      <p>{message}</p>
      <a href="/">Go home</a>
    </div>
  )
}
```

---

## Full-Stack Starter Checklist

1. Install Honertia, Hono, Effect, and the optional database/auth packages used by this starter.
2. Add module augmentations for the services and route bindings your actions use.
3. Create the Drizzle schema, database factory, and Better Auth client.
4. Call `setupHonertia(app, config)` once, then register routes on that app.
5. Add only the auth actions and pages enabled in `effectAuthRoutes`.
6. Add the React/Inertia entry point and Error page.
7. Configure Wrangler, Vite, and TypeScript.
8. Run the app's build and type checks, then start `wrangler dev`.

---

## Action Examples

### Simple GET (Public Page)

```typescript
import { Effect } from 'effect'
import { action, render } from 'honertia/effect'

export const showAbout = action(
  Effect.gen(function* () {
    return yield* render('About', {})
  })
)
```

### GET with Authentication and Caching

```typescript
import { Effect, Schema as S, Duration } from 'effect'
import {
  action,
  authorize,
  render,
  DatabaseService,
  HttpError,
  cache,
} from 'honertia/effect'
import { eq } from 'drizzle-orm'
import { projects } from '~/db/schema'

const ProjectSchema = S.Struct({
  id: S.String,
  userId: S.String,
  name: S.String,
  description: S.NullOr(S.String),
  createdAt: S.Date,
  updatedAt: S.Date,
})

export const listProjects = action(
  Effect.gen(function* () {
    const auth = yield* authorize()
    const db = yield* DatabaseService

    // Cache expensive database query for 5 minutes
    const userProjects = yield* cache(
      `projects:user:${auth.user.id}`,
      Effect.tryPromise(() =>
        db.query.projects.findMany({
          where: eq(projects.userId, auth.user.id),
          orderBy: (p, { desc }) => [desc(p.createdAt)],
        })
      ),
      S.Array(ProjectSchema),
      { ttl: Duration.minutes(5) }
    ).pipe(
      Effect.mapError((cause) => new HttpError({
        status: 503,
        message: 'Projects are temporarily unavailable.',
        cause,
      }))
    )

    return yield* render('Projects/Index', { projects: userProjects })
  })
)
```

### GET with Route Model Binding

```typescript
import { Effect } from 'effect'
import { action, authorize, bound, render } from 'honertia/effect'

export const showProject = action(
  Effect.gen(function* () {
    const auth = yield* authorize()
    const project = yield* bound('project')  // Auto-fetched from {project} param

    return yield* render('Projects/Show', { project })
  })
)
```

### POST with Validation

```typescript
import { Effect, Schema as S } from 'effect'
import {
  action,
  authorize,
  validateRequest,
  DatabaseService,
  redirect,
  asTrusted,
  dbMutation,
  requiredString,
} from 'honertia/effect'
import { projects } from '~/db/schema'

const CreateProjectSchema = S.Struct({
  name: requiredString,
  description: S.optional(S.String),
})

export const createProject = action(
  Effect.gen(function* () {
    const auth = yield* authorize()
    const input = yield* validateRequest(CreateProjectSchema, {
      errorComponent: 'Projects/Create',
    })
    const db = yield* DatabaseService

    yield* dbMutation(db, async (db) => {
      await db.insert(projects).values(asTrusted({
        name: input.name,
        description: input.description ?? null,
        userId: auth.user.id,
      }))
    })

    return yield* redirect('/projects')
  })
)
```

### PUT with Route Binding and Validation

```typescript
import { Effect, Schema as S } from 'effect'
import {
  action,
  authorize,
  bound,
  validateRequest,
  DatabaseService,
  redirect,
  asTrusted,
  dbMutation,
  requiredString,
  forbidden,
} from 'honertia/effect'
import { eq } from 'drizzle-orm'
import { projects } from '~/db/schema'

const UpdateProjectSchema = S.Struct({
  name: requiredString,
  description: S.optional(S.String),
})

export const updateProject = action(
  Effect.gen(function* () {
    const auth = yield* authorize()
    const project = yield* bound('project')

    // Authorization check
    if (project.userId !== auth.user.id) {
      return yield* forbidden('You cannot edit this project')
    }

    const input = yield* validateRequest(UpdateProjectSchema, {
      errorComponent: 'Projects/Edit',
    })
    const db = yield* DatabaseService

    yield* dbMutation(db, async (db) => {
      await db.update(projects)
        .set(asTrusted({
          name: input.name,
          description: input.description ?? null,
        }))
        .where(eq(projects.id, project.id))
    })

    return yield* redirect(`/projects/${project.id}`)
  })
)
```

### DELETE with Route Binding

```typescript
import { Effect } from 'effect'
import {
  action,
  authorize,
  bound,
  DatabaseService,
  redirect,
  forbidden,
  dbMutation,
} from 'honertia/effect'
import { eq } from 'drizzle-orm'
import { projects } from '~/db/schema'

export const destroyProject = action(
  Effect.gen(function* () {
    const auth = yield* authorize()
    const project = yield* bound('project')

    if (project.userId !== auth.user.id) {
      return yield* forbidden('You cannot delete this project')
    }

    const db = yield* DatabaseService

    yield* dbMutation(db, async (db) => {
      await db.delete(projects).where(eq(projects.id, project.id))
    })

    return yield* redirect('/projects')
  })
)
```

### Real-World Transaction (Order Checkout)

Pass a validated/trusted transaction object as the second argument to
`dbMutation`/`dbTransaction` when you want strict write scoping.
Inside that callback, write methods only accept values that come from
that scoped object.

```typescript
import { Effect, Schema as S } from 'effect'
import {
  action,
  authorize,
  validate,
  validateRequest,
  DatabaseService,
  dbTransaction,
  mergeMutationInput,
  redirect,
  requiredString,
} from 'honertia/effect'
import { eq } from 'drizzle-orm'
import { orders, orderItems, inventory } from '~/db/schema'

const CheckoutSchema = S.Struct({
  productId: requiredString,
  quantity: S.NumberFromString,
})

const CheckoutTransactionSchema = S.Struct({
  createOrder: S.Struct({
    userId: S.String,
    status: S.Literal('pending'),
  }),
  createItem: S.Struct({
    productId: S.String,
    quantity: S.Number,
    // Reserve transaction-derived fields you plan to fill later.
    orderId: S.optional(S.String),
  }),
  updateInventory: S.Struct({
    reserved: S.Number,
  }),
})

export const checkout = action(
  Effect.gen(function* () {
    const auth = yield* authorize()
    const input = yield* validateRequest(CheckoutSchema, {
      errorComponent: 'Checkout/Show',
    })
    const db = yield* DatabaseService

    const txInput = yield* validate(CheckoutTransactionSchema, {
      createOrder: {
        userId: auth.user.id,
        status: 'pending',
      },
      createItem: {
        productId: input.productId,
        quantity: input.quantity,
      },
      updateInventory: {
        reserved: input.quantity,
      },
    })
    // For untyped/unknown payloads (e.g. external JSON), use validateUnknown(schema, raw)

    const order = yield* dbTransaction(db, txInput, async (tx, scoped) => {
      const [created] = await tx.insert(orders).values(scoped.createOrder).returning()

      const itemInsert = mergeMutationInput(scoped.createItem, {
        orderId: created.id,
      })
      await tx.insert(orderItems).values(itemInsert)

      await tx.update(inventory)
        .set(scoped.updateInventory)
        .where(eq(inventory.productId, scoped.createItem.productId))

      return created
    })

    return yield* redirect(`/orders/${order.id}`)
  })
)
```

### API Endpoint (JSON Response)

```typescript
import { Effect, Schema as S } from 'effect'
import { action, validateRequest, DatabaseService, HttpError, json } from 'honertia/effect'
import { like } from 'drizzle-orm'
import { projects } from '~/db/schema'

const SearchSchema = S.Struct({
  q: S.String,
  limit: S.optional(S.NumberFromString).pipe(S.withDefault(() => 10)),
})

export const searchProjects = action(
  Effect.gen(function* () {
    const { q, limit } = yield* validateRequest(SearchSchema)
    const db = yield* DatabaseService

    const results = yield* Effect.tryPromise({
      try: () => db.query.projects.findMany({
        where: like(projects.name, `%${q}%`),
        limit,
      }),
      catch: (cause) => new HttpError({
        status: 503,
        message: 'Project search is temporarily unavailable.',
        cause,
      }),
    })

    return yield* json({ results, count: results.length })
  })
)
```

### Action with Role Check

```typescript
import { Effect } from 'effect'
import { action, authorize, DatabaseService, HttpError, render } from 'honertia/effect'

export const adminDashboard = action(
  Effect.gen(function* () {
    // authorize() with callback checks role
    const auth = yield* authorize((a) => a.user.role === 'admin')
    const db = yield* DatabaseService

    const stats = yield* Effect.tryPromise({
      try: () => db.query.users.findMany({ limit: 100 }),
      catch: (cause) => new HttpError({
        status: 503,
        message: 'Admin statistics are temporarily unavailable.',
        cause,
      }),
    })

    return yield* render('Admin/Dashboard', { stats })
  })
)
```

### Action with Custom Error Handling

```typescript
import { Effect } from 'effect'
import {
  action,
  authorize,
  DatabaseService,
  RequestService,
  HttpError,
  render,
  notFound,
  httpError,
} from 'honertia/effect'
import { eq } from 'drizzle-orm'
import { projects } from '~/db/schema'

export const showProject = action(
  Effect.gen(function* () {
    const auth = yield* authorize()
    const db = yield* DatabaseService
    const request = yield* RequestService
    const projectId = request.param('id')

    const project = yield* Effect.tryPromise({
      try: () => db.query.projects.findFirst({
        where: eq(projects.id, projectId),
      }),
      catch: (cause) => new HttpError({
        status: 503,
        message: 'Project lookup is temporarily unavailable.',
        cause,
      }),
    })

    if (!project) {
      return yield* notFound('Project', projectId)
    }

    if (project.userId !== auth.user.id) {
      return yield* httpError(403, 'Access denied')
    }

    return yield* render('Projects/Show', { project })
  })
)
```

---

## Route-Level Validation and Metadata

Put body and query schemas on the route when the schema should be visible to
the route registry, project checks, and OpenAPI generation. Honertia validates
them before the action runs and provides the decoded values through
`validatedBody()` and `validatedQuery()`.

```typescript
import { Effect, Schema as S } from 'effect'
import {
  action,
  effectRoutes,
  json,
  validatedBody,
  validatedQuery,
} from 'honertia/effect'

const CreateProject = S.Struct({
  name: S.String,
})

const ProjectQuery = S.Struct({
  includeArchived: S.optional(S.String),
})

type CreateProjectInput = S.Schema.Type<typeof CreateProject>
type ProjectQueryInput = S.Schema.Type<typeof ProjectQuery>

const createProject = action(
  Effect.gen(function* () {
    const input = yield* validatedBody<CreateProjectInput>()
    const query = yield* validatedQuery<ProjectQueryInput>()
    return yield* json({ input, query }, 201)
  })
)

effectRoutes(app).post('/projects', createProject, {
  name: 'projects.create',
  body: CreateProject,
  query: ProjectQuery,
  parseOptions: { onExcessProperty: 'error' },
})
```

Use `validateRequest()` inside an action when you intentionally need its
configurable params/query/body merge profiles or an Inertia form component on
validation failure. Use route options when validation is part of the route's
declarative contract.

---

## Validation Examples

### String Validators

```typescript
import { Schema as S } from 'effect'
import {
  requiredString,    // Trimmed, non-empty
  nullableString,    // Empty string -> null
  email,             // Email format
  url,               // URL format
  uuid,              // UUID format
  alpha,             // Letters only
  alphaDash,         // Letters, numbers, dashes, underscores
  alphaNum,          // Letters and numbers
  min,               // min(5) - at least 5 chars
  max,               // max(100) - at most 100 chars
  size,              // size(10) - exactly 10 chars
} from 'honertia/effect'

const UserSchema = S.Struct({
  name: requiredString,
  bio: nullableString,
  email: email,
  website: S.optional(url),
  username: alphaDash.pipe(min(3), max(20)),
})
```

### Number Validators

```typescript
import { Schema as S } from 'effect'
import {
  coercedNumber,     // String -> number
  positiveInt,       // > 0
  nonNegativeInt,    // >= 0
  between,           // between(1, 100)
  gt,                // gt(0) - greater than
  gte,               // gte(0) - greater than or equal
  lt,                // lt(100)
  lte,               // lte(100)
} from 'honertia/effect'

const ProductSchema = S.Struct({
  price: coercedNumber.pipe(gte(0)),
  quantity: positiveInt,
  discount: S.optional(coercedNumber.pipe(between(0, 100))),
})
```

### Boolean and Date Validators

```typescript
import { Schema as S } from 'effect'
import {
  coercedBoolean,    // "true", "1", "on" -> true
  checkbox,          // HTML checkbox (defaults to false)
  accepted,          // Must be truthy (for terms acceptance)
  coercedDate,       // String -> Date
  nullableDate,      // Empty string -> null
  after,             // after(new Date()) - must be in future
  before,            // before('2025-12-31')
} from 'honertia/effect'

const EventSchema = S.Struct({
  isPublic: checkbox,
  termsAccepted: accepted,
  startDate: coercedDate.pipe(after(new Date())),
  endDate: S.optional(nullableDate),
})
```

### Password Validator

```typescript
import { Schema as S } from 'effect'
import { password } from 'honertia/effect'

const RegisterSchema = S.Struct({
  email: S.String,
  password: password({
    min: 8,
    letters: true,
    mixedCase: true,
    numbers: true,
    symbols: true,
  }),
})
```

### Full Form Example

```typescript
import { Schema as S } from 'effect'
import {
  requiredString,
  nullableString,
  email,
  coercedNumber,
  checkbox,
  coercedDate,
  between,
} from 'honertia/effect'

const CreateEventSchema = S.Struct({
  title: requiredString.pipe(S.maxLength(200)),
  description: nullableString,
  organizerEmail: email,
  maxAttendees: coercedNumber.pipe(between(1, 10000)),
  isPublic: checkbox,
  startDate: coercedDate,
  endDate: S.optional(coercedDate),
})

// In action
const input = yield* validateRequest(CreateEventSchema, {
  errorComponent: 'Events/Create',
  messages: {
    title: 'Please enter an event title',
    organizerEmail: 'Please enter a valid email address',
  },
  attributes: {
    maxAttendees: 'maximum attendees',
  },
})
```

### Request Input Sources

`validateRequest(schema)` uses the legacy merge order by default:
`params -> query -> body` (later sources win).

Use `options.request` to switch behavior:

```typescript
// Laravel-style input (query + body; route params excluded)
const input = yield* validateRequest(Schema, {
  request: 'laravel',
})

// Custom merge order + conflict policy
const input = yield* validateRequest(Schema, {
  request: {
    order: ['params', 'query', 'body'],
    onConflict: 'error', // 'last-wins' | 'first-wins' | 'error'
  },
})
```

If both `profile` and `order` are provided, `order` takes precedence.

---

## Route Model Binding Examples

Bindings are registered at setup with an Effect Schema. Honertia compiles the
lookup plan once, parses both the URL value and loaded row, and refuses to run a
nested route unless its parent scope can be proven.

```typescript
import { Schema as S } from 'effect'
import { routeBinding } from 'honertia/effect'

const User = S.Struct({ id: S.String, name: S.String })
const Post = S.Struct({ id: S.String, userId: S.String, title: S.String })
const routeBindings = { user: User, post: Post }

declare module 'honertia/effect' {
  interface HonertiaRouteBindingsType {
    type: typeof routeBindings
  }
}

setupHonertia(app, {
  honertia: {
    version,
    render,
    database: (c) => createDb(c.env.DB),
    schema,
    bindings: routeBindings,
  },
})
```

### Basic Binding (by ID)

```typescript
// Route: /projects/{project}
// Queries: SELECT * FROM projects WHERE id = :project

effectRoutes(app).get('/projects/{project}', showProject)

const showProject = action(
  Effect.gen(function* () {
    const project = yield* bound('project')
    return yield* render('Projects/Show', { project })
  })
)
```

### Binding by Slug

```typescript
// Route: /projects/{project:slug}
// Queries: SELECT * FROM projects WHERE slug = :project

effectRoutes(app).get('/projects/{project:slug}', showProject)
```

### Nested Binding (Scoped)

```typescript
// Route: /users/{user}/posts/{post}
// Queries:
//   1. SELECT * FROM users WHERE id = :user
//   2. SELECT * FROM posts WHERE id = :post AND user_id = :user.id

effectRoutes(app).get('/users/{user}/posts/{post}', showUserPost)

const showUserPost = action(
  Effect.gen(function* () {
    const user = yield* bound('user')
    const post = yield* bound('post')  // Already scoped to user
    return yield* render('Users/Posts/Show', { user, post })
  })
)
```

The child's foreign key is discovered from the Drizzle schema: first from an
inline `.references(() => users.id)` on the child table, then from a
`postsRelations = relations(posts, ...)` definition. This works with the
idiomatic camelCase-property / snake_case-column shape
(`userId: text('user_id')`).

If Drizzle cannot expose the relationship, declare it where the binding parser
is registered:

```typescript
bindings: {
  user: User,
  post: routeBinding(Post, {
    scope: { user: { foreignKey: 'userId' } },
  }),
}
```

If neither inferred nor explicit scope exists, the route fails closed with a
configuration error; Honertia never falls back to an unscoped child lookup.
Binding is resolution, not authorization, so policy checks still belong in the
handler.

### Mixed Notation

```typescript
// :version is a regular param, {project} is bound
effectRoutes(app).get('/api/:version/projects/{project}', showProject)

const showProject = action(
  Effect.gen(function* () {
    const request = yield* RequestService
    const version = request.param('version')  // Regular param
    const project = yield* bound('project')   // Database model
    return yield* json({ version, project })
  })
)
```

### With Param Validation

```typescript
// Validate UUID format before database lookup
effectRoutes(app).get(
  '/projects/{project}',
  showProject,
  { params: S.Struct({ project: uuid }) }
)
```

---

## Auth Examples

### Parsed Sessions and Public User Data

`setupHonertia` treats authentication as a boundary: `null` means anonymous, a
provider exception becomes `SessionLookupUnavailable`, and a response that
does not satisfy `auth.session` becomes `InvalidAuthSession`. Server session
data is never shared wholesale. The default public user contains only `id`,
`name`, and `image`; use `auth.share` for an explicit application projection.

```typescript
setupHonertia(app, {
  honertia: { version, render },
  auth: {
    client: (c) => createAuth(c.env),
    session: AuthSession,
    share: ({ user }) => ({
      id: user.id,
      displayName: user.name,
      avatar: user.image,
    }),
  },
})
```

### Auth Routes Setup

```typescript
import { effectAuthRoutes } from 'honertia/auth'

effectAuthRoutes(app, {
  // Page components
  loginComponent: 'Auth/Login',
  registerComponent: 'Auth/Register',

  // Form actions
  loginAction: loginUser,
  registerAction: registerUser,
  logoutAction: logoutUser,

  // Paths (defaults shown)
  loginPath: '/login',
  registerPath: '/register',
  logoutPath: '/logout',
  apiPath: '/api/auth',

  // Redirects
  loginRedirect: '/',
  logoutRedirect: '/login',

  // Extended flows
  guestActions: {
    '/login/2fa': verify2FA,
    '/forgot-password': forgotPassword,
  },

  // CORS for API (if frontend on different origin)
  cors: {
    origin: ['http://localhost:5173'],
    credentials: true,
  },
})
```

### Login Action

```typescript
import { betterAuthFormAction, type BetterAuthActionError } from 'honertia/auth'
import { Schema as S } from 'effect'
import { email, requiredString } from 'honertia/effect'

const LoginSchema = S.Struct({
  email: email,
  password: requiredString,
})

const mapLoginError = (error: BetterAuthActionError) => {
  switch (error.code) {
    case 'INVALID_EMAIL_OR_PASSWORD':
      return { email: 'Invalid email or password' }
    case 'USER_NOT_FOUND':
      return { email: 'No account found with this email' }
    default:
      return { email: 'Login failed' }
  }
}

export const loginUser = betterAuthFormAction({
  schema: LoginSchema,
  errorComponent: 'Auth/Login',
  redirectTo: '/',
  errorMapper: mapLoginError,
  call: (auth, input, request) =>
    auth.api.signInEmail({
      body: { email: input.email, password: input.password },
      request,
      returnHeaders: true,
    }),
})
```

Auth rate limits fail with `AuthRateLimitError`, which renders as a protocol
429 JSON response (with `Retry-After`) rather than a form error. If you would
rather show the rate limit inside the login form, recover it into a
`ValidationError` before the handler sees it:

Only verified Better Auth HTTP rejections are passed to `errorMapper`.
Unexpected database, network, provider, or malformed thrown values remain
safe dependency failures and are not reused as client-visible form messages.

```typescript
import { Effect } from 'effect'
import { ValidationError } from 'honertia/effect'

export const loginUser = betterAuthFormAction({
  // ... as above
}).pipe(
  Effect.catchTag('AuthRateLimitError', (error) =>
    Effect.fail(
      new ValidationError({
        errors: { form: error.message },
        component: 'Auth/Login',
      })
    )
  )
)
```

### Register Action

```typescript
import { betterAuthFormAction, type BetterAuthActionError } from 'honertia/auth'
import { Schema as S } from 'effect'
import { email, requiredString, password } from 'honertia/effect'

const RegisterSchema = S.Struct({
  name: requiredString,
  email: email,
  password: password({ min: 8, letters: true, numbers: true }),
})

const mapRegisterError = (error: BetterAuthActionError) => {
  switch (error.code) {
    case 'USER_ALREADY_EXISTS':
    case 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL':
      return { email: 'An account with this email already exists' }
    default:
      return { email: 'Registration failed' }
  }
}

export const registerUser = betterAuthFormAction({
  schema: RegisterSchema,
  errorComponent: 'Auth/Register',
  redirectTo: '/',
  errorMapper: mapRegisterError,
  call: (auth, input, request) =>
    auth.api.signUpEmail({
      body: { name: input.name, email: input.email, password: input.password },
      request,
      returnHeaders: true,
    }),
})
```

### Logout Action

```typescript
import { betterAuthLogoutAction } from 'honertia/auth'

export const logoutUser = betterAuthLogoutAction({
  redirectTo: '/login',
})
```

### Auth Layers

```typescript
import { RequireAuthLayer, RequireGuestLayer } from 'honertia/auth'

// Require logged-in user (redirects to /login if not)
effectRoutes(app)
  .provide(RequireAuthLayer)
  .group((route) => {
    route.get('/dashboard', showDashboard)
    route.get('/settings', showSettings)
  })

// Require guest (redirects to / if logged in)
effectRoutes(app)
  .provide(RequireGuestLayer)
  .group((route) => {
    route.get('/login', showLogin)
    route.get('/register', showRegister)
  })
```

### Custom Guest Layers (Anonymous Users)

When using Better Auth's anonymous plugin, you may want anonymous users to access login/register pages to upgrade their accounts. By default, `RequireGuestLayer` blocks ALL authenticated users, including anonymous ones.

Use `createGuestLayer` to create a custom guest layer with a predicate:

```typescript
import { createGuestLayer, effectAuthRoutes } from 'honertia/effect'

// Allow anonymous users to access guest pages
const AllowAnonymousGuestLayer = createGuestLayer(
  (authUser) => authUser.user.isAnonymous === true  // Returns true if user should be allowed
)

// Use with effectAuthRoutes
effectAuthRoutes(app, {
  guestLayer: AllowAnonymousGuestLayer,
  loginComponent: 'Auth/Login',
  registerComponent: 'Auth/Register',
  loginAction: loginUser,
  registerAction: registerUser,
})

// Or use directly with effectRoutes
effectRoutes(app)
  .provide(AllowAnonymousGuestLayer)
  .group((route) => {
    route.get('/login', showLogin)
    route.get('/register', showRegister)
  })
```

The predicate receives the full `AuthUser` object and returns `true` if the user should be allowed through (treated as a "guest" for this route).

### Scoped Middleware

Use `.middleware()` to add Hono middleware to a specific route group. Unlike `app.use()` which applies globally, `.middleware()` scopes middleware to only the routes in that builder chain.

```typescript
import { effectRoutes, RequireAuthLayer } from 'honertia/effect'

// Middleware that ensures anonymous auth (redirects to create session if none exists)
effectRoutes(app)
  .middleware(ensureAuthMiddleware)  // Hono middleware - can redirect
  .provide(RequireAuthLayer)          // Effect layer - provides AuthUserService
  .prefix('/play')
  .group((route) => {
    route.get('/{gamemode:slug}', showGamePage)
  })

// Different middleware for different route groups
effectRoutes(app)
  .middleware(rateLimitMiddleware)
  .prefix('/api')
  .group((route) => {
    route.get('/stats', getStats)
  })
```

Use `.prefixMiddleware()` after `.prefix()` when middleware must wrap the
whole prefix, including unmatched paths and 404 responses:

```typescript
effectRoutes(app)
  .prefix('/api')
  .prefixMiddleware(redactErrorDetails)
  .group((route) => {
    route.get('/status', showStatus)
  })
```

**Key differences:**
- `.middleware()` adds Hono middleware that runs *before* the Effect handler (can redirect/short-circuit)
- `.prefixMiddleware()` wraps all requests under the builder prefix, including misses
- `.provide()` adds Effect layers that run *within* the Effect computation (dependency injection)

### `provide()` Layer Patterns

`provide()` supports two layer styles:

1. **Self-contained layer** (`R = never`)
   ```typescript
   effectRoutes(app).provide(Layer.succeed(RequestIdService, { id: 'req-123' }))
   ```
2. **Context-aware layer** (consumes route context services like `DatabaseService`, `HonertiaService`, or previously provided services)
   ```typescript
   import { Effect, Layer } from 'effect'
   import { DatabaseService, HonertiaService, HttpError } from 'honertia/effect'

   const SharePropsLayer = Layer.effectDiscard(
     Effect.gen(function* () {
       const db = yield* DatabaseService
       const honertia = yield* HonertiaService
       const organizations = yield* Effect.tryPromise({
         try: () => db.query.organizations.findMany(),
         catch: (cause) => new HttpError({
           status: 503,
           message: 'Organizations are temporarily unavailable.',
           cause,
         }),
       })
       honertia.share('organizations', organizations)
       honertia.share('authUserAvatarSeed', 'seed-123')
     })
   )

   effectRoutes(app)
     .provide(RequireAuthLayer)
     .provide(SharePropsLayer)
     .get('/dashboard', showDashboard)
   ```

| Level | Method | Scope |
|-------|--------|-------|
| `app.use('*', ...)` | Global | All routes |
| `setupHonertia(app, { middleware: [...] })` | Global | All routes via config |
| `effectRoutes(app).middleware(...)` | Builder | Routes in that chain only |
| `effectRoutes(app).prefix(...).prefixMiddleware(...)` | Prefix | Matching routes and 404s under the prefix |

### Manual Auth Check in Action

```typescript
import { authorize, isAuthenticated, currentUser } from 'honertia/effect'

// Require auth (fails if not logged in)
const auth = yield* authorize()

// Require specific role
const auth = yield* authorize((a) => a.user.role === 'admin')

// Check without failing
const isLoggedIn = yield* isAuthenticated  // boolean
const user = yield* currentUser            // AuthUser | null
```

---

## Error Handling Examples

### Effect-First Error Model

Honertia application actions should express expected failures through Effect's
typed error channel. Use `Effect.fail(...)` (or Honertia's response helpers)
for validation, authorization, not-found, dependency, and other failures that
can occur during normal operation. Reserve `throw new Error(...)` for defects:
unexpected programmer errors or violated invariants.

| Location | Failure style | `EffectErrorObserverService` | Production response |
|---|---|---:|---|
| `effectHandler` / `effectRoutes` | `Effect.fail(typedError)` | Observed if it reaches the request boundary | Typed Honertia response |
| `effectHandler` / `effectRoutes` | `throw new Error(...)` | Observed as a defect | Safe 500 response |
| Plain Hono handler or middleware | `throw new Error(...)` | Not observed | Safe error response; external reporting is application-owned |

Direct Hono middleware remains appropriate for framework concerns such as CORS,
static assets, and third-party integrations. Putting application actions or
business logic in plain Hono handlers bypasses Honertia's typed Effect error and
observability guarantees and is therefore an anti-pattern in an Effect-first
Honertia application.

When Honertia's Hono error handlers catch an exception outside Effect, they
still return a client-safe response. Detailed console diagnostics are emitted
only in explicitly configured development environments. In production, the
default handlers write one redacted structured line per error to the console
(code, tag, category, HTTP status, request id — never raw exception text), so
platform logs such as `wrangler tail` retain a correlation signal. For full
detail, use a Hono-compatible telemetry integration if code outside Effect
needs reporting.

### Typed Effect Failures

```typescript
import {
  notFound,
  forbidden,
  httpError,
  ValidationError,
  UnauthorizedError,
} from 'honertia/effect'

// 404 Not Found
return yield* notFound('Project', projectId)

// 403 Forbidden
return yield* forbidden('You cannot edit this project')

// Custom HTTP error
return yield* httpError(429, 'Rate limit exceeded', { retryAfter: 60 })

// Manual validation error
yield* Effect.fail(new ValidationError({
  errors: { email: 'This email is already taken' },
  component: 'Auth/Register',
}))

// Manual unauthorized
yield* Effect.fail(new UnauthorizedError({
  message: 'Session expired',
  redirectTo: '/login',
}))
```

Database helpers keep dependency failures precise: `dbMutation` fails with
`DatabaseMutationFailed | DatabaseConstraintViolation`, while `dbTransaction`
fails with `DatabaseTransactionFailed | DatabaseConstraintViolation`. This
makes recovery composable without catching every JavaScript `Error`:

```typescript
yield* dbMutation(db, input, saveProject).pipe(
  Effect.catchTag('DatabaseConstraintViolation', () =>
    Effect.fail(new ValidationError({
      errors: { name: 'A project with this name already exists' },
      component: 'Projects/Create',
    }))
  )
)
```

### Error Handler Setup

```typescript
import { setupHonertia } from 'honertia'

setupHonertia(app, {
  honertia: { version, render },
  errors: {
    component: 'Error',
    showDevErrors: true,
    envKey: 'ENVIRONMENT',
    devValue: 'development',
  },
})
```

This one boundary handles typed Effect failures, defects, Hono exceptions, and
not-found responses with the same redaction, rendering, and logging policy.

### External Error Reporting

Honertia can report request-time failures and defects from `effectHandler` and
`effectRoutes` to one optional observer service. You define that observer once
in `setupHonertia(app, { effect: { services } })`, and the same observer receives:

- unhandled Effect request failures and defects
- user-reported handled/recovered failures via `reportEffectError(...)`

This is the main integration point for PostHog, Sentry, or any other external reporting system. The observer is best-effort: if it is not installed, nothing happens; if it fails, request behavior does not change. Honertia's default console diagnostics are full terminal output when development is explicitly configured, and a single redacted structured line in production — raw `Error` objects are never written to the console by the default handlers.

`EffectErrorObserverService` does not observe exceptions thrown by plain Hono
handlers or middleware because those errors never enter an Effect runtime.
If you deliberately keep application code on that boundary, configure reporting
through Hono or your telemetry provider's Hono integration.

```typescript
import { Effect, Layer } from 'effect'
import { setupHonertia } from 'honertia'
import {
  EffectErrorObserverService,
  type EffectErrorEvent,
} from 'honertia/effect'

function makeErrorObserver(apiKey?: string) {
  return Layer.succeed(EffectErrorObserverService, {
    observe: (event: EffectErrorEvent) => {
      if (!apiKey) return Effect.void

      return Effect.tryPromise({
        try: () =>
          fetch('https://eu.i.posthog.com/capture/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              api_key: apiKey,
              event:
                event.source === 'framework'
                  ? 'honertia_unhandled_error'
                  : 'honertia_handled_error',
              properties: {
                handling: event.handling,
                kind: event.kind,
                honertiaCode: event.structured?.code ?? null,
                honertiaTag: event.structured?.tag ?? null,
                category: event.structured?.category ?? null,
                httpStatus: event.structured?.httpStatus ?? null,
                requestId: event.structured?.requestId ?? null,
              },
            }),
          }),
        catch: () => undefined,
      }).pipe(Effect.asVoid, Effect.catchAll(() => Effect.void))
    },
  })
}

setupHonertia(app, {
  honertia: {
    version,
    render,
    database: (c) => createDb(c.env.DB),
    schema,
  },
  auth: {
    client: (c, { db }) => createAuth({
      db,
      secret: c.env.BETTER_AUTH_SECRET,
      baseURL: new URL(c.req.url).origin,
    }),
  },
  effect: {
    services: (c) => makeErrorObserver(c.env.POSTHOG_API_KEY),
  },
})
```

Replace the `fetch(...)` block with `Sentry.captureException(...)` or any other telemetry client if you prefer. The important part is that the reporting sink is configured once, at app setup, instead of inside every action. Build telemetry from structured fields or your own explicitly safe metadata; do not serialize `event.error`, whose message or cause may contain credentials, database output, or request values.

The observer receives events with this shape:

```typescript
type EffectErrorEvent = {
  source: 'framework' | 'user'
  handling: 'unhandled' | 'handled'
  kind: 'failure' | 'defect'
  error: unknown
  structured?: HonertiaStructuredError
  metadata?: Record<string, unknown>
}
```

Framework-emitted events use `source: 'framework'` and `handling: 'unhandled'`. User-emitted events use `source: 'user'` and `handling: 'handled'`.

### Reporting Recovered Errors from Userland

Unhandled request failures are reported automatically by Honertia. Use `reportEffectError(...)` only when you intentionally recover from an error and still want it forwarded to the same observer.

```typescript
import { Effect } from 'effect'
import { action, render, reportEffectError } from 'honertia/effect'

export const showHome = action(
  Effect.gen(function* () {
    const hasPendingNotifications = yield* Effect.tryPromise({
      try: () => hasPendingNotificationsForUser(),
      catch: (error) => error,
    }).pipe(
      Effect.tapError((error) =>
        reportEffectError(error, {
          // the metadata object can be anything you want to forward onto your
          // reporting service - use it to add any extra context that would be helpful
          metadata: {
            area: 'home',
            operation: 'hasPendingNotificationsForUser',
            fallbackStrategy: 'assume_no_pending_notifications',
            userImpact: 'notifications_badge_hidden',
          },
        })
      ),
      Effect.catchAll(() => Effect.succeed(false))
    )

    return yield* render('Home', { hasPendingNotifications })
  })
)
```

For the common case, the minimal form is enough:

```typescript
Effect.tapError((error) => reportEffectError(error))
```

`reportEffectError(error)` always expands to a handled user failure event. `metadata` is optional and only needed when extra context helps with debugging or analytics.

### Error Page Component

```tsx
// src/pages/Error.tsx
interface ErrorProps {
  status: number
  code: string
  title: string
  message: string
  hint?: string           // Only in dev
  fixes?: Array<{ description: string }>  // Only in dev
  source?: { file: string; line: number } // Only in dev
}

export default function Error({ status, title, message, hint, fixes }: ErrorProps) {
  return (
    <div className="error-page">
      <h1>{status}</h1>
      <h2>{title}</h2>
      <p>{message}</p>
      {hint && <p className="hint">{hint}</p>}
      {fixes?.map((fix, i) => <div key={i}>{fix.description}</div>)}
    </div>
  )
}
```

---

## Response Helpers

```typescript
import {
  render,
  renderWithErrors,
  redirect,
  json,
  notFound,
  forbidden,
  httpError,
} from 'honertia/effect'

// Render page with props
return yield* render('Projects/Index', { projects })

// Render with validation errors
return yield* renderWithErrors('Projects/Create', {
  name: 'Name is required',
})

// Redirect (303 for POST, 302 otherwise)
return yield* redirect('/projects')
return yield* redirect('/login', 302)

// JSON response
return yield* json({ success: true })
return yield* json({ error: 'Not found' }, 404)

// Error responses
return yield* notFound('Project')
return yield* forbidden('Access denied')
return yield* httpError(429, 'Rate limited')
```

---

## Response Caching (Workers Cache)

Honertia has first-class support for Cloudflare Workers Cache — a response
cache in **front** of your Worker. On a cache hit your Worker never runs:
zero CPU billing, no Effect runtime, no database queries.

Enable it in your wrangler config first:

```json
{ "cache": { "enabled": true } }
```

Then declare caching per route:

```typescript
effectRoutes(app).get('/pricing', showPricing, {
  cache: { maxAge: 300, staleWhileRevalidate: 3600 },
})
```

Honertia owns the correctness rules so you don't have to:

- headers are applied to successful GET/HEAD responses only;
- HTML and JSON page objects are separate variants (`Vary: X-Inertia`);
- partial reloads are marked `no-store` (unbounded variant space);
- a handler's own stricter `Cache-Control` (`no-store`, `private`,
  `no-cache`) always wins over the route option;
- responses that set cookies are never publicly cached;
- private requests are never publicly cached: an `Authorization` header, a
  loaded `authUser`, or a session cookie (better-auth's cookies, plus any
  custom name configured via `auth.sessionCookie`) all disable
  caching for that request, with a once-per-route dev warning. Unrelated
  cookies (analytics, consent, `__cf_bm`) do **not** disable caching, so
  real browser traffic still gets cache hits.

If you authenticate with custom cookies outside Honertia's auth, register
the cookie name via `auth: { sessionCookie: 'your_cookie' }` in
`setupHonertia()` or don't
mark those routes cacheable — Workers Cache serves hits without running
your Worker, so no in-handler auth check can protect a cached response.

Bound routes tag their responses automatically — `GET /projects/{project}`
emits `Cache-Tag: project:123,projects` — and mutating routes can purge the
same derived tags with zero manual bookkeeping:

```typescript
effectRoutes(app).put('/projects/{project}', updateProject, {
  purges: true, // purges project:{id} and projects after success
})
```

For manual purging (or purge-everything on deploy), use the typed service:

```typescript
import { ResponseCacheService } from 'honertia/effect'

const cache = yield* ResponseCacheService
yield* cache.purge({ tags: ['projects'] })
```

Outside a Workers runtime (tests, local tooling) the service reports
`isAvailable: false` and purges no-op.

> **Runtime status (July 2026):** cache headers and tags are pure HTTP and
> work everywhere today. The *programmatic purge* API is still rolling out
> to Workers runtimes — Honertia probes both documented surfaces
> (`ctx.cache` and `cloudflare:workers`'s `cache` export) and no-ops with
> `isAvailable: false` until your runtime exposes it. Check
> `cache.isAvailable` if you depend on purges.

## Data Caching (KV)

Honertia provides a `CacheService` for caching expensive database operations. It's automatically provided and backed by Cloudflare KV by default, but can be swapped for Redis, Memcached, or any other implementation. This is the data cache *inside* your actions — it composes with the response cache above.

### Setup

Add KV to your `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "KV"
id = "your-kv-namespace-id"
```

Update your bindings type in `src/types.ts`:

```typescript
export type Bindings = {
  DB: D1Database
  BETTER_AUTH_SECRET: string
  KV: KVNamespace  // Add this
}
```

No additional registration needed - `CacheService` is automatically available in all actions.

### Basic Usage

```typescript
import { Effect, Schema as S, Duration } from 'effect'
import {
  action,
  authorize,
  render,
  DatabaseService,
  HttpError,
  cache,
} from 'honertia/effect'
import { eq } from 'drizzle-orm'
import { projects } from '~/db/schema'

const ProjectSchema = S.Struct({
  id: S.String,
  userId: S.String,
  name: S.String,
  description: S.NullOr(S.String),
  createdAt: S.Date,
  updatedAt: S.Date,
})

export const listProjects = action(
  Effect.gen(function* () {
    const auth = yield* authorize()
    const db = yield* DatabaseService

    // Cache the database query for 5 minutes
    const userProjects = yield* cache(
      `projects:user:${auth.user.id}`,
      Effect.tryPromise({
        try: () =>
          db.query.projects.findMany({
            where: eq(projects.userId, auth.user.id),
            orderBy: (p, { desc }) => [desc(p.createdAt)],
          }),
        catch: (cause) => cause,
      }),
      S.Array(ProjectSchema),
      { ttl: Duration.minutes(5) }
    ).pipe(
      Effect.mapError((cause) => new HttpError({
        status: 503,
        message: 'Projects are temporarily unavailable.',
        cause,
      }))
    )

    return yield* render('Projects/Index', { projects: userProjects })
  })
)
```

### Cache Functions

| Function | Description |
|----------|-------------|
| `cache(key, compute, schema, options)` | Get from cache or compute and store |
| `cacheGet(key, schema, options?)` | Get value from cache (returns `Option`) |
| `cacheSet(key, value, schema, options)` | Store value in cache |
| `cacheInvalidate(key, options?)` | Delete a single cache key |
| `cacheInvalidatePrefix(prefix)` | Delete all keys with prefix |

The `options` parameter is an object with the following properties:

| Property | Type | Description |
|----------|------|-------------|
| `ttl` | `Duration.DurationInput` | Time-to-live for cached values (required) |
| `swr` | `Duration.DurationInput` | Stale-while-revalidate window (optional) |
| `version` | `string \| boolean` | Explicit key prefix, or `true` for a schema hash (optional) |

### Cache Invalidation

Invalidate cache when data changes:

```typescript
import { Effect, Schema as S } from 'effect'
import {
  action,
  authorize,
  validateRequest,
  DatabaseService,
  redirect,
  asTrusted,
  dbMutation,
  requiredString,
  cacheInvalidate,
} from 'honertia/effect'
import { projects } from '~/db/schema'

const CreateProjectSchema = S.Struct({
  name: requiredString,
  description: S.optional(S.String),
})

export const createProject = action(
  Effect.gen(function* () {
    const auth = yield* authorize()
    const input = yield* validateRequest(CreateProjectSchema, {
      errorComponent: 'Projects/Create',
    })
    const db = yield* DatabaseService

    yield* dbMutation(db, async (db) => {
      await db.insert(projects).values(
        asTrusted({
          name: input.name,
          description: input.description ?? null,
          userId: auth.user.id,
        })
      )
    })

    // Invalidate the user's project list cache
    yield* cacheInvalidate(`projects:user:${auth.user.id}`)

    return yield* redirect('/projects')
  })
)
```

### Invalidate by Prefix

Delete all cache keys matching a prefix:

```typescript
import { cacheInvalidatePrefix } from 'honertia/effect'

// Invalidate all caches for a user
yield* cacheInvalidatePrefix(`user:${userId}:`)

// Invalidate all project-related caches
yield* cacheInvalidatePrefix('projects:')
```

### Manual Get/Set

For more control over cache operations:

```typescript
import { Effect, Option, Schema as S, Duration } from 'effect'
import { cacheGet, cacheSet } from 'honertia/effect'

const UserSchema = S.Struct({
  id: S.String,
  name: S.String,
  email: S.String,
})

// Check cache first
const cached = yield* cacheGet(`user:${id}`, UserSchema)

if (Option.isSome(cached)) {
  return cached.value
}

// Compute value
const user = yield* fetchUser(id)

// Store in cache
yield* cacheSet(`user:${id}`, user, UserSchema, { ttl: Duration.hours(1) })

return user
```

### Using CacheService Directly

For advanced use cases, access the underlying service:

```typescript
import { Effect } from 'effect'
import { CacheService } from 'honertia/effect'

const handler = action(
  Effect.gen(function* () {
    const cache = yield* CacheService

    // Raw get (returns string | null)
    const raw = yield* cache.get('my-key')

    // Raw put
    yield* cache.put('my-key', JSON.stringify({ data: 'value' }), {
      expirationTtl: 3600, // seconds
    })

    // Delete
    yield* cache.delete('my-key')

    // List keys by prefix
    const page = yield* cache.list({ prefix: 'user:' })
    const keys = page.keys
  })
)
```

### Custom Cache Implementation

Swap out Cloudflare KV for Redis or any other backend by providing a custom `CacheService` layer:

```typescript
import { Effect, Layer } from 'effect'
import { CacheService, CacheClientError, type CacheClient } from 'honertia/effect'
import { createClient } from 'redis'

const createRedisCacheClient = (redisUrl: string): CacheClient => {
  const client = createClient({ url: redisUrl })

  return {
    get: (key) =>
      Effect.tryPromise({
        try: () => client.get(key),
        catch: (e) => new CacheClientError('Redis get failed', e),
      }),
    put: (key, value, options) =>
      Effect.tryPromise({
        try: () =>
          client.set(key, value, options?.expirationTtl ? { EX: options.expirationTtl } : undefined),
        catch: (e) => new CacheClientError('Redis set failed', e),
      }).pipe(Effect.asVoid),
    delete: (key) =>
      Effect.tryPromise({
        try: () => client.del(key),
        catch: (e) => new CacheClientError('Redis delete failed', e),
      }).pipe(Effect.asVoid),
    list: (options) =>
      Effect.tryPromise({
        try: async () => {
          const keys = await client.keys(options?.prefix ? `${options.prefix}*` : '*')
          return {
            keys: keys.map((name) => ({ name })),
            list_complete: true,
          }
        },
        catch: (e) => new CacheClientError('Redis keys failed', e),
      }),
  }
}

// Provide in your app setup
const RedisCacheLayer = Layer.succeed(
  CacheService,
  createRedisCacheClient(process.env.REDIS_URL!)
)
```

### Testing with Cache

Create a test layer that uses an in-memory store:

```typescript
import { Effect, Layer, Option, Schema as S, Duration } from 'effect'
import { CacheService, cache, cacheGet, cacheInvalidate, type CacheClient } from 'honertia/effect'
import { describe, it, expect } from 'bun:test'

const makeTestCache = (): Layer.Layer<CacheService> => {
  const store = new Map<string, { value: string; expiresAt: number }>()

  const client: CacheClient = {
    get: (key) =>
      Effect.sync(() => {
        const entry = store.get(key)
        if (!entry || entry.expiresAt < Date.now()) {
          store.delete(key)
          return null
        }
        return entry.value
      }),
    put: (key, value, options) =>
      Effect.sync(() => {
        const ttlMs = (options?.expirationTtl ?? 3600) * 1000
        store.set(key, { value, expiresAt: Date.now() + ttlMs })
      }),
    delete: (key) =>
      Effect.sync(() => {
        store.delete(key)
      }),
    list: (options) =>
      Effect.sync(() => ({
        keys: [...store.keys()]
          .filter((k) => !options?.prefix || k.startsWith(options.prefix))
          .map((name) => ({ name })),
        list_complete: true,
      })),
  }

  return Layer.succeed(CacheService, client)
}

const TestSchema = S.Struct({
  id: S.String,
  name: S.String,
})

describe('cache', () => {
  it('returns cached value on second call', () =>
    Effect.gen(function* () {
      let callCount = 0

      const compute = Effect.sync(() => {
        callCount++
        return { id: '1', name: 'Test' }
      })

      const first = yield* cache('test:1', compute, TestSchema, { ttl: Duration.hours(1) })
      const second = yield* cache('test:1', compute, TestSchema, { ttl: Duration.hours(1) })

      expect(first).toEqual(second)
      expect(callCount).toBe(1) // Only computed once
    }).pipe(Effect.provide(makeTestCache()), Effect.runPromise))

  it('recomputes after invalidation', () =>
    Effect.gen(function* () {
      let callCount = 0

      const compute = Effect.sync(() => {
        callCount++
        return { id: '1', name: `Call ${callCount}` }
      })

      yield* cache('test:1', compute, TestSchema, { ttl: Duration.hours(1) })
      yield* cacheInvalidate('test:1')
      yield* cache('test:1', compute, TestSchema, { ttl: Duration.hours(1) })

      expect(callCount).toBe(2) // Computed twice
    }).pipe(Effect.provide(makeTestCache()), Effect.runPromise))

  it('returns Option.none for missing keys', () =>
    Effect.gen(function* () {
      const result = yield* cacheGet('nonexistent', TestSchema)
      expect(Option.isNone(result)).toBe(true)
    }).pipe(Effect.provide(makeTestCache()), Effect.runPromise))
})
```

### Cache Key Patterns

Recommended cache key patterns:

```typescript
// User-scoped data
`user:${userId}:profile`
`user:${userId}:settings`
`user:${userId}:notifications`

// Resource lists
`projects:user:${userId}`
`posts:category:${categoryId}`

// Individual resources
`project:${projectId}`
`user:${userId}`

// Computed data
`stats:daily:${date}`
`leaderboard:weekly`

// API responses
`api:weather:${city}`
`api:exchange:${currency}`
```

### Stale-While-Revalidate (SWR)

The cache supports the stale-while-revalidate pattern for improved latency and resilience. When enabled, stale values are returned immediately while a background refresh is triggered. In environments without `ExecutionContext`, stale entries are recomputed synchronously instead.

```typescript
import { Effect, Duration } from 'effect'
import { cache, DatabaseService } from 'honertia/effect'

const UserSchema = S.Struct({
  id: S.String,
  name: S.String,
  email: S.String,
})

// Basic usage with TTL only
const user = yield* cache(
  `user:${id}`,
  fetchUser(id),
  UserSchema,
  { ttl: Duration.hours(1) }
)

// With stale-while-revalidate
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

**How SWR works:**

| Cache State | Behavior |
|-------------|----------|
| Fresh (age < TTL) | Return cached value immediately |
| Stale (TTL < age < TTL + SWR) | Return stale value immediately, trigger background refresh |
| Expired (age > TTL + SWR) | Compute new value synchronously |
| Cold (no cache) | Compute new value synchronously |

**Benefits:**
- **Faster responses**: Users always get an immediate response (stale or fresh)
- **Reduced latency spikes**: No waiting for slow database queries during cache refresh
- **Graceful degradation**: If the background refresh fails, stale data is still served

**Real-world example:**

```typescript
import { Effect, Duration, Schema as S } from 'effect'
import { action, authorize, cache, render, DatabaseService, HttpError } from 'honertia/effect'
import { eq } from 'drizzle-orm'
import { projects } from '~/db/schema'

const ProjectListSchema = S.Array(
  S.Struct({
    id: S.String,
    name: S.String,
    createdAt: S.Date,
  })
)

export const indexProjects = action(
  Effect.gen(function* () {
    const auth = yield* authorize()
    const db = yield* DatabaseService

    // Cache project list with SWR
    // - Fresh for 5 minutes
    // - Serve stale for 1 additional minute while refreshing in background
    const userProjects = yield* cache(
      `projects:user:${auth.user.id}`,
      Effect.tryPromise(() =>
        db.query.projects.findMany({
          where: eq(projects.userId, auth.user.id),
          orderBy: (p, { desc }) => [desc(p.createdAt)],
        })
      ),
      ProjectListSchema,
      {
        ttl: Duration.minutes(5),
        swr: Duration.minutes(1),
      }
    ).pipe(
      Effect.mapError((cause) => new HttpError({
        status: 503,
        message: 'Projects are temporarily unavailable.',
        cause,
      }))
    )

    return yield* render('Projects/Index', { projects: userProjects })
  })
)
```

### Runtime-Owned Background Tasks

`background(operation, effect)` owns the whole lifecycle: it preserves the
current Effect context, extends Cloudflare's request lifetime with `waitUntil`,
and sends failures to `EffectErrorObserverService` with the operation name. In
non-Worker runtimes it runs safely before request completion instead of being
silently dropped.

```typescript
import { Effect } from 'effect'
import { action, authorize, background, render } from 'honertia/effect'

export const dashboard = action(
  Effect.gen(function* () {
    const auth = yield* authorize()

    yield* background(
      'analytics.page-view',
      Effect.tryPromise(() =>
        fetch('https://analytics.example.com/events', {
          method: 'POST',
          body: JSON.stringify({
            event: 'page_view',
            userId: auth.user.id,
            page: 'dashboard',
            timestamp: Date.now(),
          }),
        })
      )
    )

    return yield* render('Dashboard', { user: auth.user })
  })
)
```

**Background API:**

| Function | Description |
|--------|-------------|
| `background(operation, effect)` | Schedule named, observed, runtime-owned work |

**Common use cases:**

```typescript
import { Effect } from 'effect'
import {
  background,
  authorize,
  DatabaseService,
  dbMutation,
  asTrusted,
  BindingsService,
} from 'honertia/effect'

// Audit logging
const auditLog = (action: string, details: Record<string, unknown>) =>
  Effect.gen(function* () {
    const user = yield* authorize()
    const db = yield* DatabaseService

    yield* background(
      'audit-log.persist',
      dbMutation(db, async (tx) => {
        await tx.insert(auditLogs).values(asTrusted({
          userId: user.user.id,
          action,
          details,
          timestamp: new Date(),
        }))
      })
    )
  })

// Webhook delivery with retries
const deliverWebhook = (url: string, payload: unknown) =>
  Effect.gen(function* () {
    yield* background(
      'webhook.deliver',
      Effect.tryPromise(() =>
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
      ).pipe(
        Effect.retry({ times: 3 }),
        Effect.catchAll((error) =>
          Effect.logError('Webhook delivery failed', { url, error })
        )
      )
    )
  })

// Conditional background work
const maybeNotifySlack = (message: string) =>
  Effect.gen(function* () {
    const bindings = yield* BindingsService

    if (bindings.SLACK_WEBHOOK_URL) {
      yield* background(
        'slack.notify',
        Effect.tryPromise(() =>
          fetch(bindings.SLACK_WEBHOOK_URL, {
            method: 'POST',
            body: JSON.stringify({ text: message }),
          })
        )
      )
    }
  })
```

**Important notes:**
- Cloudflare tasks extend the request lifetime without blocking the response.
- Failures are observed and do not change an already-produced response.
- Local development and tests execute the Effect before the request completes.
- Recover with `catchTag` inside the task only when the application has a real fallback.

### Cache Key Versioning

Cache versioning ensures cache correctness when your data schema changes. Without versioning, schema changes can cause decode errors or serve stale data with the wrong shape.

**The Problem:**

```typescript
// Version 1 of your schema
const UserSchemaV1 = S.Struct({
  id: S.String,
  name: S.String,
  email: S.String,
})

// You deploy with cached data...

// Version 2 adds a required field
const UserSchemaV2 = S.Struct({
  id: S.String,
  name: S.String,
  email: S.String,
  avatar: S.String,  // New required field!
})

// Cached V1 data fails to decode with V2 schema → Runtime error
```

**Solution 1: Auto Schema Versioning (Recommended)**

Pass `version: true` to automatically version cache keys based on a hash of the schema structure. When you change the schema, the hash changes, and old cached data is automatically bypassed.

```typescript
import { Effect, Duration, Schema as S } from 'effect'
import { cache, DatabaseService } from 'honertia/effect'

const UserSchema = S.Struct({
  id: S.String,
  name: S.String,
  email: S.String,
})

// Cache key becomes "a1b2c3:user:123" (hash:key)
const user = yield* cache(
  `user:${id}`,
  fetchUser(id),
  UserSchema,
  { ttl: Duration.hours(1), version: true }
)
```

**When to use `version: true`:**
- You want automatic cache invalidation when schemas evolve
- You're iterating quickly on data structures during development
- You want zero-downtime deployments without manual cache clearing

**When NOT to use `version: true`:**
- You need cache hits to survive deployments (use explicit versions instead)
- Schema changes are intentionally backward-compatible
- You're caching data that doesn't depend on schema structure

**Solution 2: Explicit Version Strings**

For more control, pass an explicit version string. Bump it manually when your schema changes.

```typescript
// Cache key becomes "v2:user:123"
const user = yield* cache(
  `user:${id}`,
  fetchUser(id),
  UserSchema,
  { ttl: Duration.hours(1), version: 'v2' }
)
```

**When to use explicit versions:**
- You want cache hits to survive deployments
- You need predictable cache keys for debugging
- You're coordinating schema changes across services

**Full Example: User Profile with Versioned Cache**

```typescript
import { Effect, Duration, Schema as S } from 'effect'
import {
  action,
  authorize,
  cache,
  cacheInvalidate,
  asTrusted,
  render,
  redirect,
  DatabaseService,
  HttpError,
  validateRequest,
  dbMutation,
} from 'honertia/effect'
import { eq } from 'drizzle-orm'
import { users } from '~/db/schema'

// Schema definition - changing this auto-invalidates cache when version: true
const UserProfileSchema = S.Struct({
  id: S.String,
  name: S.String,
  email: S.String,
  bio: S.NullOr(S.String),
  avatarUrl: S.NullOr(S.String),
})

// GET /profile - cached with auto-versioning
export const showProfile = action(
  Effect.gen(function* () {
    const auth = yield* authorize()
    const db = yield* DatabaseService

    const profile = yield* cache(
      `user:profile:${auth.user.id}`,
      Effect.tryPromise(() =>
        db.query.users.findFirst({
          where: eq(users.id, auth.user.id),
          columns: { id: true, name: true, email: true, bio: true, avatarUrl: true },
        })
      ),
      UserProfileSchema,
      {
        ttl: Duration.hours(1),
        swr: Duration.minutes(5),
        version: true,  // Auto-invalidates when UserProfileSchema changes
      }
    ).pipe(
      Effect.mapError((cause) => new HttpError({
        status: 503,
        message: 'Profile is temporarily unavailable.',
        cause,
      }))
    )

    return yield* render('Profile/Show', { profile })
  })
)

// PUT /profile - invalidate cache after update
export const updateProfile = action(
  Effect.gen(function* () {
    const auth = yield* authorize()
    const input = yield* validateRequest(UpdateProfileSchema, {
      errorComponent: 'Profile/Edit',
    })
    const db = yield* DatabaseService

    yield* dbMutation(db, async (db) => {
      await db.update(users)
        .set(asTrusted({ name: input.name, bio: input.bio }))
        .where(eq(users.id, auth.user.id))
    })

    // Invalidate with same versioning strategy
    yield* cacheInvalidate(`user:profile:${auth.user.id}`, {
      schema: UserProfileSchema,
      version: true,
    })

    return yield* redirect('/profile')
  })
)
```

**Versioning with `cacheGet` and `cacheInvalidate`:**

When using manual cache operations, pass the same version option:

```typescript
import { cacheGet, cacheSet, cacheInvalidate } from 'honertia/effect'

// Get with auto-versioning
const cached = yield* cacheGet(`user:${id}`, UserSchema, { version: true })

// Set with explicit version
yield* cacheSet(`user:${id}`, user, UserSchema, {
  ttl: Duration.hours(1),
  version: 'v2',
})

// Invalidate with versioning - requires schema when using version
yield* cacheInvalidate(`user:${id}`, { schema: UserSchema, version: true })

// Simple invalidation (no versioning)
yield* cacheInvalidate(`user:${id}`)
```

**How Schema Hashing Works:**

The auto-versioning feature uses the djb2 hash algorithm on the serialized schema AST:

1. Schema structure is serialized to a string representation
2. A fast, deterministic hash is computed (djb2)
3. The hash is prepended to the cache key

This means:
- Same schema definition → same hash → cache hits work
- Changed schema structure → different hash → cache miss, fresh data computed
- Adding/removing fields, changing types, or modifying constraints all change the hash

**Cache Options Reference:**

| Option | Type | Description |
|--------|------|-------------|
| `ttl` | `Duration.DurationInput` | Time-to-live for cached values (required) |
| `swr` | `Duration.DurationInput` | Stale-while-revalidate window (optional) |
| `version` | `string \| boolean` | `true` = auto schema hash, `string` = explicit prefix (optional) |

---

## Services Reference

| Service | Description | Usage |
|---------|-------------|-------|
| `DatabaseService` | Drizzle database client | `const db = yield* DatabaseService` |
| `AuthService` | Better-auth instance | `const auth = yield* AuthService` |
| `AuthUserService` | Current user session | `const user = yield* AuthUserService` |
| `BindingsService` | Cloudflare bindings | `const { KV } = yield* BindingsService` |
| `CacheService` | KV-backed cache client | `const cache = yield* CacheService` |
| `ExecutionContextService` | Low-level runtime lifetime access | Prefer `yield* background(name, effect)` |
| `RequestService` | Request context | `const req = yield* RequestService` |

### Using BindingsService

```typescript
import { Effect } from 'effect'
import { action, BindingsService, json } from 'honertia/effect'

const handler = action(
  Effect.gen(function* () {
    const { KV, R2, QUEUE } = yield* BindingsService

    const cached = yield* Effect.tryPromise(() => KV.get('key')).pipe(Effect.orDie)
    yield* Effect.tryPromise(() => QUEUE.send({ type: 'event' })).pipe(Effect.orDie)

    return yield* json({ cached })
  })
)
```

---

## Environment

```toml
# wrangler.toml
[vars]
ENVIRONMENT = "production"
```

```bash
# Secrets (not in source control)
wrangler secret put BETTER_AUTH_SECRET
```

---

## Testing

Generated actions include colocated inline tests. Generate one runner when you
want Bun to discover all action and feature tests:

```bash
honertia generate:tests-runner
bun test
```

For named-route integration tests, `describeRoute` reads metadata from the
specific app instead of a global registry:

```typescript
import { describeRoute } from 'honertia/effect'
import app from '../src/index'

describeRoute('projects.index', app, (test) => {
  test('renders the project list', {
    expect: {
      status: 200,
      component: 'Projects/Index',
    },
  })
})
```

Useful commands:

```bash
# Test one generated action
bun test src/actions/projects/create.ts

# Test a resource
bun test src/actions/projects/

# Validate routes, names, bindings, and registration
honertia check --app src/index.ts --verbose
```

---

## License

MIT
