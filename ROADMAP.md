# Honertia Roadmap: Agent-First Framework Design

> Frameworks like Laravel were built for human programmers. Honertia is designed for AI agent workflows—specifically optimized for how Claude Code's tools (`Read`, `Edit`, `Grep`, `Glob`, `Bash`) interact with codebases.

This document outlines principles and features that make Honertia uniquely suited for AI-assisted development.

---

## Table of Contents

0. [The Honertia CLI: Agent-First Tooling](#0-the-honertia-cli-agent-first-tooling)
   - [Effect-First Architecture](#01-effect-first-architecture)
   - [Composable Action Primitives](#02-composable-action-primitives)
1. [Explicit Over Implicit](#1-explicit-over-implicit)
2. [Colocated Metadata](#2-colocated-metadata)
3. [Machine-Readable Error Messages](#3-machine-readable-error-messages)
4. [Grep-Friendly Patterns](#4-grep-friendly-patterns)
5. [Schema as Source of Truth](#5-schema-as-source-of-truth)
6. [Minimal Indirection](#6-minimal-indirection)
7. [Built-in Introspection](#7-built-in-introspection)
8. [Atomic, Reversible Operations](#8-atomic-reversible-operations)
9. [Test Generation Hooks](#9-test-generation-hooks)
10. [Context-Efficient Documentation](#10-context-efficient-documentation)

---

## 0. The Honertia CLI: Agent-First Tooling

### Summary

A comprehensive CLI that is the primary interface for AI agents—generating complete features with real integration tests, introspecting the application, and validating configuration.

### The Vision

The Honertia CLI isn't just a collection of utilities. It's designed as **the primary way agents interact with Honertia projects**. When an agent runs `honertia generate:action`, it gets:

- A complete action file with proper imports
- Real integration tests that hit actual routes
- Schema definitions inferred from the route
- Type-safe test helpers

No mocks. No stubs. Tests that exercise the real middleware stack, real validation, real database.

### Why Real Integration Tests?

Traditional test generation creates mocks:

```typescript
// Traditional mock-based test (what we DON'T want)
test('creates project', async () => {
  const mockDb = { insert: vi.fn() }
  const mockAuth = { user: { id: '123' } }

  // This doesn't test the real route at all
  const result = await createProject(mockDb, mockAuth, { name: 'Test' })

  expect(mockDb.insert).toHaveBeenCalled()
})
```

Problems with mocks:
- Tests pass but production breaks
- Mock behavior drifts from real implementation
- Doesn't test middleware, validation, auth layers
- Agent must understand mock setup patterns

Honertia's approach—**test the actual routes**:

```typescript
// Honertia integration test (what we DO want)
import { describeRoute } from 'honertia/test'

describeRoute('projects.create', (route) => {
  route.test('rejects unauthenticated requests', {
    expect: { status: 302, location: '/login' },
  })

  route.test('validates required fields', {
    as: 'user',
    body: {},
    expect: { status: 422, errors: { name: 'required' } },
  })

  route.test('creates project with valid data', {
    as: 'user',
    body: { name: 'Test Project' },
    expect: { status: 303, location: '/projects' },
    assert: async (ctx) => {
      const project = await ctx.db.query.projects.findFirst({
        where: eq(projects.name, 'Test Project'),
      })
      expect(project).toBeDefined()
      expect(project.userId).toBe(ctx.user.id)
    },
  })
})
```

This tests:
- The actual Hono route registration
- The actual Effect middleware stack
- The actual `RequireAuthLayer`
- The actual `validateRequest()` with real schema
- The actual database insertion
- The actual redirect response

### CLI Command Overview

```bash
# ─────────────────────────────────────────────────────────────
# GENERATION - Create complete features with tests
# ─────────────────────────────────────────────────────────────

# Generate a single action with integration tests
honertia generate:action projects/create \
  --method POST \
  --path /projects \
  --auth required \
  --schema "name:string:required, description:string:nullable"

# Generate full CRUD (5 actions + 5 test files)
honertia generate:crud projects \
  --fields "name:string:required, description:string:nullable, status:enum(draft,published)"

# Generate a colocated feature (route + action + tests in one file)
honertia generate:feature projects/archive \
  --method POST \
  --path "/projects/{project}/archive"

# ─────────────────────────────────────────────────────────────
# INTROSPECTION - Query the application structure
# ─────────────────────────────────────────────────────────────

# List all routes (table format)
honertia routes

# List routes as JSON (for programmatic use)
honertia routes --json

# Filter routes
honertia routes --method POST
honertia routes --path "/projects"
honertia routes --middleware auth

# Show route details
honertia routes:show projects.create

# List all schemas
honertia schemas

# Show schema details (as TypeScript or JSON Schema)
honertia schemas:show CreateProjectSchema --format typescript
honertia schemas:show CreateProjectSchema --format json-schema

# Analyze a handler
honertia handlers:show createProject

# ─────────────────────────────────────────────────────────────
# TESTING - Run and generate tests
# ─────────────────────────────────────────────────────────────

# Run all tests
honertia test

# Run tests for specific route
honertia test --route projects.create

# Generate missing tests for existing routes
honertia test:generate

# Show test coverage per route
honertia test:coverage

# ─────────────────────────────────────────────────────────────
# VALIDATION - Check project health
# ─────────────────────────────────────────────────────────────

# Full project validation
honertia check

# Specific checks
honertia check:routes    # All handlers exist, no orphan routes
honertia check:schemas   # All schemas are valid
honertia check:types     # TypeScript compilation
honertia check:db        # Database connection + migrations

# ─────────────────────────────────────────────────────────────
# DATABASE - Migrations and seeding
# ─────────────────────────────────────────────────────────────

# Show migration status
honertia db:status

# Run pending migrations
honertia db:migrate

# Rollback last migration
honertia db:rollback

# Preview migration (show SQL without running)
honertia db:migrate --preview

# Generate migration from schema diff
honertia db:generate "add_status_to_projects"

# Seed database
honertia db:seed

# ─────────────────────────────────────────────────────────────
# DEVELOPMENT
# ─────────────────────────────────────────────────────────────

# Start dev server
honertia dev

# Production build
honertia build

# Type check
honertia typecheck
```

### Generated Action Example

When an agent runs:
```bash
honertia generate:action projects/create \
  --method POST \
  --path /projects \
  --auth required \
  --schema "name:string:required, description:string:nullable"
```

It generates two files:

**`src/actions/projects/create.ts`**
```typescript
import { Effect, Schema as S } from 'effect'
import {
  action,
  authorize,
  validateRequest,
  DatabaseService,
  asTrusted,
  dbMutation,
  redirect,
  requiredString,
  nullableString,
} from 'honertia/effect'
import { schema } from '~/db'

// ─────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────

export const CreateProjectSchema = S.Struct({
  name: requiredString,
  description: nullableString,
})

export type CreateProjectInput = S.Schema.Type<typeof CreateProjectSchema>

// ─────────────────────────────────────────────────────────────
// Route Metadata (used by router and tests)
// ─────────────────────────────────────────────────────────────

export const route = {
  name: 'projects.create',
  method: 'POST',
  path: '/projects',
  auth: 'required',
  schema: CreateProjectSchema,
} as const

// ─────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────

export const createProject = action(
  Effect.gen(function* () {
    const auth = yield* authorize()
    const input = yield* validateRequest(CreateProjectSchema, {
      errorComponent: 'Projects/Create',
    })

    const db = yield* DatabaseService

    const project = yield* dbMutation(db, async (tx) => {
      const [created] = await tx.insert(schema.projects).values(asTrusted({
        ...input,
        userId: auth.user.id,
      })).returning()
      return created
    })

    return yield* redirect(`/projects/${project.id}`)
  })
)
```

**`tests/actions/projects/create.test.ts`**
```typescript
import { describe } from 'bun:test'
import { describeRoute, createTestApp } from 'honertia/test'
import { createProject, route } from '~/actions/projects/create'

// Register the route for testing
const app = createTestApp((routes) => {
  routes.post(route.path, createProject, { name: route.name })
})

describeRoute(route.name, app, (test) => {
  // ─────────────────────────────────────────────────────────────
  // Authentication Tests
  // ─────────────────────────────────────────────────────────────

  test('redirects unauthenticated users to login', {
    body: { name: 'Test' },
    expect: {
      status: 302,
      headers: { location: '/login' },
    },
  })

  // ─────────────────────────────────────────────────────────────
  // Validation Tests
  // ─────────────────────────────────────────────────────────────

  test('requires name field', {
    as: 'user',
    body: {},
    expect: {
      status: 422,
      errors: { name: expect.stringContaining('required') },
    },
  })

  test('rejects empty name', {
    as: 'user',
    body: { name: '   ' },
    expect: {
      status: 422,
      errors: { name: expect.stringContaining('required') },
    },
  })

  test('accepts null description', {
    as: 'user',
    body: { name: 'Test', description: null },
    expect: { status: 303 },
  })

  // ─────────────────────────────────────────────────────────────
  // Success Tests
  // ─────────────────────────────────────────────────────────────

  test('creates project and redirects', {
    as: 'user',
    body: { name: 'My Project', description: 'A test project' },
    expect: {
      status: 303,
      headers: { location: expect.stringMatching(/^\/projects\//) },
    },
    assert: async (ctx) => {
      // Verify database state
      const project = await ctx.db.query.projects.findFirst({
        where: eq(schema.projects.name, 'My Project'),
      })

      expect(project).toBeDefined()
      expect(project.name).toBe('My Project')
      expect(project.description).toBe('A test project')
      expect(project.userId).toBe(ctx.user.id)
    },
  })

  test('trims whitespace from name', {
    as: 'user',
    body: { name: '  Trimmed Name  ' },
    expect: { status: 303 },
    assert: async (ctx) => {
      const project = await ctx.db.query.projects.findFirst({
        orderBy: [desc(schema.projects.createdAt)],
      })
      expect(project.name).toBe('Trimmed Name')
    },
  })
})
```

### The Test Helper API

The `describeRoute` helper is the core of the testing system:

```typescript
import { describeRoute, createTestApp } from 'honertia/test'

// Create app with routes registered
const app = createTestApp((routes) => {
  routes.post('/projects', createProject, { name: 'projects.create' })
  routes.get('/projects', listProjects, { name: 'projects.list' })
  routes.get('/projects/{project}', showProject, { name: 'projects.show' })
})

describeRoute('projects.create', app, (test) => {
  // Test definition options:
  test('test name', {
    // ─── Request ───────────────────────────────────────────
    as: 'user',              // 'user' | 'admin' | 'guest' | User object
    body: { ... },           // Request body (auto-serialized)
    query: { page: '1' },    // Query parameters
    headers: { ... },        // Additional headers
    params: { id: '123' },   // Route parameters (for parameterized routes)

    // ─── Expected Response ─────────────────────────────────
    expect: {
      status: 200,                              // HTTP status
      headers: { location: '/projects' },       // Response headers
      body: { ... },                            // JSON body (deep equality)
      errors: { name: 'required' },             // Validation errors
      props: { projects: expect.any(Array) },   // Inertia props
      component: 'Projects/Index',              // Inertia component
    },

    // ─── Custom Assertions ─────────────────────────────────
    assert: async (ctx) => {
      // ctx.db - Database instance
      // ctx.user - Authenticated user (if as: 'user')
      // ctx.response - Raw Response object
      // ctx.body - Parsed response body

      const project = await ctx.db.query.projects.findFirst()
      expect(project.userId).toBe(ctx.user.id)
    },

    // ─── Setup/Teardown ────────────────────────────────────
    setup: async (ctx) => {
      // Run before this test
      const project = await ctx.factory.project.create()
      return { project }  // Available in assert as ctx.data.project
    },

    teardown: async (ctx) => {
      // Run after this test (even on failure)
    },
  })
})
```

### Test Factories

Generated alongside actions:

```typescript
// tests/factories.ts (auto-generated from schemas)
import { Factory } from 'honertia/test'
import { schema } from '~/db'

export const factories = {
  user: Factory.define(schema.users, () => ({
    id: Factory.uuid(),
    email: Factory.email(),
    name: Factory.name(),
    createdAt: Factory.date(),
  })),

  project: Factory.define(schema.projects, (ctx) => ({
    id: Factory.uuid(),
    name: Factory.words(2),
    description: Factory.nullable(Factory.sentence()),
    userId: ctx.refs.user?.id ?? Factory.uuid(),
    createdAt: Factory.date(),
  })),
}

// Usage in tests
const user = await ctx.factory.user.create()
const project = await ctx.factory.project.create({ userId: user.id })

// Create with associations
const project = await ctx.factory.project.create({
  user: true,  // Auto-creates associated user
})
```

### Route Registry

The CLI needs a route registry to enable introspection. Routes register themselves:

```typescript
// src/routes.ts
import { effectRoutes, RouteRegistry } from 'honertia/effect'
import { createProject, route as createProjectRoute } from './actions/projects/create'
import { listProjects, route as listProjectsRoute } from './actions/projects/list'

export function registerRoutes(app: Hono<Env>) {
  effectRoutes(app)
    .provide(RequireAuthLayer)
    .group((route) => {
      // Routes with metadata for introspection
      route.post(createProjectRoute.path, createProject, {
        name: createProjectRoute.name,
        schema: createProjectRoute.schema,
      })

      route.get(listProjectsRoute.path, listProjects, {
        name: listProjectsRoute.name,
      })
    })
}

// Export registry for CLI
export const routes = RouteRegistry.fromApp(app)
```

### CLI Implementation Architecture

```
packages/
├── honertia/              # Core framework
│   ├── src/
│   │   ├── effect/
│   │   ├── test/          # Test utilities
│   │   │   ├── index.ts
│   │   │   ├── describe-route.ts
│   │   │   ├── test-app.ts
│   │   │   ├── factory.ts
│   │   │   └── assertions.ts
│   │   └── ...
│   └── package.json
│
└── @honertia/cli/         # CLI package
    ├── src/
    │   ├── index.ts           # CLI entry point
    │   ├── commands/
    │   │   ├── generate/
    │   │   │   ├── action.ts
    │   │   │   ├── crud.ts
    │   │   │   └── feature.ts
    │   │   ├── routes/
    │   │   │   ├── list.ts
    │   │   │   └── show.ts
    │   │   ├── test/
    │   │   │   ├── run.ts
    │   │   │   ├── generate.ts
    │   │   │   └── coverage.ts
    │   │   ├── check/
    │   │   │   ├── all.ts
    │   │   │   ├── routes.ts
    │   │   │   └── schemas.ts
    │   │   └── db/
    │   │       ├── status.ts
    │   │       ├── migrate.ts
    │   │       └── rollback.ts
    │   ├── templates/
    │   │   ├── action.ts.hbs
    │   │   ├── action-test.ts.hbs
    │   │   ├── crud/
    │   │   │   ├── list.ts.hbs
    │   │   │   ├── create.ts.hbs
    │   │   │   ├── show.ts.hbs
    │   │   │   ├── update.ts.hbs
    │   │   │   └── delete.ts.hbs
    │   │   └── feature.ts.hbs
    │   └── introspection/
    │       ├── route-analyzer.ts
    │       ├── schema-extractor.ts
    │       └── handler-analyzer.ts
    └── package.json
```

### Agent Workflow Example

A typical agent workflow with the CLI:

```
User: "Add a feature to archive projects"

Agent:
1. Check existing routes
   $ honertia routes --path "/projects"

   GET    /projects              projects.list
   POST   /projects              projects.create
   GET    /projects/{project}    projects.show
   DELETE /projects/{project}    projects.delete

2. Generate the archive action with tests
   $ honertia generate:action projects/archive \
       --method POST \
       --path "/projects/{project}/archive" \
       --auth required

3. Verify generation
   $ honertia routes --path "/projects"

   ... existing routes ...
   POST   /projects/{project}/archive    projects.archive

4. Run tests to verify
   $ honertia test --route projects.archive

   ✓ redirects unauthenticated users to login
   ✓ returns 404 for non-existent project
   ✓ archives project and redirects

5. Customize the handler (if needed)
   # Agent reads and edits src/actions/projects/archive.ts

6. Run full test suite
   $ honertia test
```

### JSON Output for Programmatic Use

All commands support `--json` for agent consumption:

```bash
$ honertia routes --json
{
  "routes": [
    {
      "name": "projects.create",
      "method": "POST",
      "path": "/projects",
      "handler": "createProject",
      "file": "src/actions/projects/create.ts",
      "line": 42,
      "middleware": ["auth"],
      "schema": "CreateProjectSchema"
    }
  ]
}

$ honertia check --json
{
  "status": "error",
  "checks": [
    { "name": "routes", "status": "pass", "message": "15 routes registered" },
    { "name": "schemas", "status": "pass", "message": "8 schemas valid" },
    { "name": "handlers", "status": "fail", "message": "Missing handler: updateProject", "file": "src/routes.ts", "line": 23 }
  ],
  "errors": [
    {
      "code": "HON_CLI_001",
      "message": "Handler 'updateProject' not found",
      "file": "src/routes.ts",
      "line": 23,
      "fix": {
        "type": "generate",
        "command": "honertia generate:action projects/update --method PUT --path /projects/{project}"
      }
    }
  ]
}
```

### Why This Matters for Agents

1. **Single command = complete feature**: No manual wiring of routes, tests, types
2. **Real tests, not mocks**: Tests catch actual bugs, not mock mismatches
3. **Structured output**: `--json` everywhere for programmatic consumption
4. **Error recovery**: Check commands identify issues with fix commands
5. **Introspection**: Agents can query app structure without parsing code
6. **Consistency**: Generated code follows exact patterns every time

---

## 0.1. Effect-First Architecture

### Summary

Effect isn't just the runtime—it's the foundation for type inference, testing, error handling, and the CLI itself. One schema, infinite derived types.

### The Philosophy

Effect provides:
- **Type-safe error channels**: Every failure is typed, no `catch (e: unknown)`
- **Dependency injection via services**: Testable by design, swap layers for testing
- **Composable effects**: Build complex operations from simple primitives
- **Schema-driven types**: Define once, infer everywhere

This isn't "use Effect for async"—it's "Effect is the type system for your entire application."

### One Schema, Everything Inferred

The core insight: define a schema once, derive everything else.

```typescript
// src/features/projects/schema.ts
import { Schema as S } from 'effect'
import { requiredString, nullableString, uuid } from 'honertia/effect'

// ═══════════════════════════════════════════════════════════════
// THE SINGLE SOURCE OF TRUTH
// ═══════════════════════════════════════════════════════════════

export const ProjectSchema = S.Struct({
  id: uuid,
  name: requiredString.pipe(S.minLength(3), S.maxLength(100)),
  description: nullableString,
  status: S.Literal('draft', 'published', 'archived'),
  userId: uuid,
  createdAt: S.Date,
  updatedAt: S.Date,
})

// ═══════════════════════════════════════════════════════════════
// EVERYTHING BELOW IS INFERRED - NO MANUAL TYPE DEFINITIONS
// ═══════════════════════════════════════════════════════════════

// TypeScript type - inferred from schema
export type Project = S.Schema.Type<typeof ProjectSchema>
// => { id: string, name: string, description: string | null, status: 'draft' | 'published' | 'archived', ... }

// Create schema - pick fields, all types flow through
export const CreateProjectSchema = ProjectSchema.pipe(
  S.pick('name', 'description'),
)
export type CreateProject = S.Schema.Type<typeof CreateProjectSchema>
// => { name: string, description: string | null }

// Update schema - pick + partial, types still inferred
export const UpdateProjectSchema = ProjectSchema.pipe(
  S.pick('name', 'description', 'status'),
  S.partial,
)
export type UpdateProject = S.Schema.Type<typeof UpdateProjectSchema>
// => { name?: string, description?: string | null, status?: 'draft' | 'published' | 'archived' }

// Route params schema - for route model binding
export const ProjectParamsSchema = S.Struct({
  project: uuid,  // Matches {project} in route path
})

// API response schema - compose from base
export const ProjectResponseSchema = S.Struct({
  project: ProjectSchema,
})

// List response with pagination - compose
export const ProjectListResponseSchema = S.Struct({
  projects: S.Array(ProjectSchema),
  pagination: S.Struct({
    page: S.Number,
    limit: S.Number,
    total: S.Number,
  }),
})
```

### Route Definition with Full Type Inference

Routes infer everything from schemas:

```typescript
// src/features/projects/routes.ts
import { defineRoutes } from 'honertia/effect'
import {
  ProjectSchema,
  CreateProjectSchema,
  UpdateProjectSchema,
  ProjectParamsSchema,
  ProjectListResponseSchema,
  ProjectResponseSchema,
} from './schema'

export const projectRoutes = defineRoutes({
  // Types for params, body, and response are all inferred
  'projects.list': {
    method: 'GET',
    path: '/projects',
    response: ProjectListResponseSchema,
    // handler params are fully typed:
    // (ctx: { query: { page?: number, limit?: number } }) => Effect<ProjectListResponse, AppError, Services>
  },

  'projects.create': {
    method: 'POST',
    path: '/projects',
    body: CreateProjectSchema,        // Request body validation + types
    response: ProjectResponseSchema,  // Response types
    auth: 'required',
    // handler params are fully typed:
    // (ctx: { body: CreateProject, user: AuthUser }) => Effect<ProjectResponse, AppError, Services>
  },

  'projects.show': {
    method: 'GET',
    path: '/projects/{project}',
    params: ProjectParamsSchema,      // URL params validation + types
    response: ProjectResponseSchema,
    // handler params are fully typed:
    // (ctx: { params: { project: string }, bound: { project: Project } }) => Effect<...>
  },

  'projects.update': {
    method: 'PUT',
    path: '/projects/{project}',
    params: ProjectParamsSchema,
    body: UpdateProjectSchema,
    response: ProjectResponseSchema,
    auth: 'required',
    // handler params are fully typed:
    // (ctx: { params, body: UpdateProject, bound: { project: Project }, user }) => Effect<...>
  },

  'projects.delete': {
    method: 'DELETE',
    path: '/projects/{project}',
    params: ProjectParamsSchema,
    auth: 'required',
  },
})

// Type inference for handlers
export type ProjectRoutes = typeof projectRoutes
```

### Handlers with Full Type Safety

Handlers receive fully typed context:

```typescript
// src/features/projects/handlers.ts
import { Effect } from 'effect'
import { action, authorize, asTrusted, dbMutation, DatabaseService, render, redirect } from 'honertia/effect'
import { eq, sql } from 'drizzle-orm'
import { projectRoutes } from './routes'
import { schema } from '~/db'

// The handler type is inferred from the route definition
export const listProjects = projectRoutes['projects.list'].handler(
  // ctx is fully typed: { query: { page?: number, limit?: number } }
  Effect.gen(function* (ctx) {
    const db = yield* DatabaseService
    const user = yield* authorize()

    const { page = 1, limit = 20 } = ctx.query

    const projects = yield* Effect.tryPromise(() =>
      db.query.projects.findMany({
        where: eq(schema.projects.userId, user.user.id),
        offset: (page - 1) * limit,
        limit,
      })
    )

    const total = yield* Effect.tryPromise(() =>
      db.select({ count: sql`count(*)` })
        .from(schema.projects)
        .where(eq(schema.projects.userId, user.user.id))
    )

    // Return type must match ProjectListResponseSchema
    return { projects, pagination: { page, limit, total: total[0].count } }
  })
)

export const createProject = projectRoutes['projects.create'].handler(
  // ctx is fully typed: { body: CreateProject, user: AuthUser }
  Effect.gen(function* (ctx) {
    const db = yield* DatabaseService

    // ctx.body is Validated<CreateProject> - type-safe, validated
    const project = yield* dbMutation(db, async (tx) => {
      const [created] = await tx.insert(schema.projects)
        .values(asTrusted({
          ...ctx.body,
          userId: ctx.user.user.id,
        }))
        .returning()
      return created
    })

    // Return type must match ProjectResponseSchema
    return { project }
  })
)

export const showProject = projectRoutes['projects.show'].handler(
  // ctx is fully typed: { bound: { project: Project } }
  Effect.gen(function* (ctx) {
    // ctx.bound.project is already fetched and typed as Project
    return { project: ctx.bound.project }
  })
)
```

### Effect Services for Testing

Everything is a service, everything is testable:

```typescript
// src/services/email.ts
import { Context, Effect, Layer } from 'effect'

// Define the service interface
export class EmailService extends Context.Tag('EmailService')<
  EmailService,
  {
    send: (to: string, subject: string, body: string) => Effect.Effect<void, EmailError>
  }
>() {}

// Production implementation
export const EmailServiceLive = Layer.succeed(EmailService, {
  send: (to, subject, body) =>
    Effect.tryPromise({
      try: () => sendgrid.send({ to, subject, html: body }),
      catch: (e) => new EmailError({ cause: e }),
    }),
})

// Test implementation - captures sent emails
export const EmailServiceTest = Layer.succeed(EmailService, {
  send: (to, subject, body) =>
    Effect.sync(() => {
      testEmails.push({ to, subject, body })
    }),
})

// Use in handlers
export const inviteUser = action(
  Effect.gen(function* () {
    const email = yield* EmailService
    const input = yield* validateRequest(InviteSchema)

    yield* email.send(
      input.email,
      'You have been invited',
      `<p>Click here to join...</p>`
    )

    return yield* redirect('/team')
  })
)
```

### CLI Commands as Effects

The CLI itself is Effect-based:

```typescript
// @honertia/cli/src/commands/generate/action.ts
import { Effect, Console } from 'effect'
import { FileSystem, Path } from '@effect/platform'
import { CliConfig, TemplateService } from '../../services'

export const generateAction = (name: string, options: GenerateOptions) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const config = yield* CliConfig
    const templates = yield* TemplateService

    // Validate the action name
    const parsed = yield* parseActionName(name)

    // Generate file paths
    const actionPath = path.join(config.actionsDir, `${parsed.path}.ts`)
    const testPath = path.join(config.testsDir, `${parsed.path}.test.ts`)

    // Check for existing files
    const actionExists = yield* fs.exists(actionPath)
    if (actionExists && !options.force) {
      return yield* Effect.fail(
        new FileExistsError({ path: actionPath, suggestion: 'Use --force to overwrite' })
      )
    }

    // Generate from templates
    const actionContent = yield* templates.render('action', {
      name: parsed.name,
      method: options.method,
      path: options.path,
      schema: options.schema,
      auth: options.auth,
    })

    const testContent = yield* templates.render('action-test', {
      name: parsed.name,
      routeName: parsed.routeName,
      method: options.method,
      path: options.path,
      auth: options.auth,
    })

    // Write files
    yield* fs.writeFileString(actionPath, actionContent)
    yield* fs.writeFileString(testPath, testContent)

    // Output for agent consumption
    yield* Console.log(JSON.stringify({
      success: true,
      files: [
        { path: actionPath, type: 'action' },
        { path: testPath, type: 'test' },
      ],
    }))
  }).pipe(
    // Typed error handling
    Effect.catchTags({
      FileExistsError: (e) => Console.error(JSON.stringify({
        error: true,
        code: 'FILE_EXISTS',
        message: e.message,
        fix: { command: `honertia generate:action ${name} --force` },
      })),
      TemplateError: (e) => Console.error(JSON.stringify({
        error: true,
        code: 'TEMPLATE_ERROR',
        message: e.message,
      })),
    })
  )
```

### Testing with Layer Composition

Tests compose layers for isolation:

```typescript
// tests/features/projects/create.test.ts
import { Effect, Layer } from 'effect'
import { describeRoute, TestLayer } from 'honertia/test'
import { createProject } from '~/features/projects/handlers'
import { projectRoutes } from '~/features/projects/routes'

// Test layer with in-memory database and captured emails
const TestEnv = Layer.mergeAll(
  TestLayer.Database.inMemory,
  TestLayer.Email.captured,
  TestLayer.Auth.withUser({ id: 'user-1', role: 'user' }),
)

describeRoute(projectRoutes['projects.create'], TestEnv, (test) => {
  test('creates project with valid data', {
    body: { name: 'Test Project', description: null },
    expect: {
      status: 200,
      body: {
        project: {
          name: 'Test Project',
          description: null,
          userId: 'user-1',  // From TestLayer.Auth
        },
      },
    },
    assert: async (ctx) => {
      // ctx.db is the test database
      const projects = await ctx.db.query.projects.findMany()
      expect(projects).toHaveLength(1)
    },
  })

  test('sends notification email', {
    body: { name: 'Notify Project' },
    assert: async (ctx) => {
      // ctx.emails is from TestLayer.Email.captured
      expect(ctx.emails).toHaveLength(1)
      expect(ctx.emails[0].subject).toContain('Project created')
    },
  })
})

// Test with different auth layer
const AdminEnv = Layer.mergeAll(
  TestLayer.Database.inMemory,
  TestLayer.Auth.withUser({ id: 'admin-1', role: 'admin' }),
)

describeRoute(projectRoutes['projects.create'], AdminEnv, (test) => {
  test('admin can create projects for any user', {
    body: { name: 'Admin Project', userId: 'other-user' },
    expect: {
      status: 200,
      body: { project: { userId: 'other-user' } },
    },
  })
})
```

### Type-Safe Error Handling

Errors are part of the type signature:

```typescript
// src/features/projects/errors.ts
import { Data } from 'effect'

export class ProjectNotFoundError extends Data.TaggedError('ProjectNotFoundError')<{
  projectId: string
}> {}

export class ProjectPermissionError extends Data.TaggedError('ProjectPermissionError')<{
  projectId: string
  userId: string
  action: 'view' | 'edit' | 'delete'
}> {}

export class ProjectValidationError extends Data.TaggedError('ProjectValidationError')<{
  field: string
  message: string
}> {}

// Handler with typed errors
export const deleteProject = projectRoutes['projects.delete'].handler(
  Effect.gen(function* (ctx) {
    const db = yield* DatabaseService

    // Effect.Effect<Project, ProjectNotFoundError>
    const project = yield* Effect.tryPromise(() =>
      db.query.projects.findFirst({
        where: eq(schema.projects.id, ctx.params.project),
      })
    ).pipe(
      Effect.flatMap((p) =>
        p ? Effect.succeed(p) : Effect.fail(new ProjectNotFoundError({ projectId: ctx.params.project }))
      )
    )

    // Effect.Effect<void, ProjectPermissionError>
    if (project.userId !== ctx.user.user.id) {
      return yield* Effect.fail(
        new ProjectPermissionError({
          projectId: project.id,
          userId: ctx.user.user.id,
          action: 'delete',
        })
      )
    }

    yield* dbMutation(db, async (tx) => {
      await tx.delete(schema.projects).where(eq(schema.projects.id, project.id))
    })

    return yield* redirect('/projects')
  })
)

// The type signature shows all possible errors:
// Effect.Effect<
//   Redirect,
//   ProjectNotFoundError | ProjectPermissionError | DatabaseError,
//   DatabaseService | AuthUserService
// >
```

### Schema-Driven OpenAPI Generation

OpenAPI specs generated from Effect Schemas:

```typescript
// honertia generate:openapi
import { generateOpenAPI } from 'honertia/openapi'
import { projectRoutes } from '~/features/projects/routes'
import { userRoutes } from '~/features/users/routes'

const spec = generateOpenAPI({
  info: { title: 'My API', version: '1.0.0' },
  routes: [projectRoutes, userRoutes],
})

// Generates full OpenAPI 3.1 spec with:
// - Paths from route definitions
// - Request bodies from body schemas
// - Response schemas from response definitions
// - Parameter schemas from params definitions
// - Error responses from error types
```

### Why Effect-First Matters for Agents

1. **Single source of truth**: Change the schema, types update everywhere
2. **Compile-time safety**: Agents get type errors before runtime
3. **Testable by design**: Layer composition makes testing trivial
4. **Explicit dependencies**: `yield*` shows what a handler needs
5. **Typed errors**: No surprise `catch (e: unknown)` hunting
6. **Inferrable**: Agents can understand types from schemas without reading implementations

---

## 0.2. Composable Action Primitives

### Summary

Small, reusable building blocks that compose via `yield*`. The more standardized the primitives, the less room for error.

### The Philosophy

Traditional frameworks give you many ways to do the same thing:
- Get the user from `req.user`, `ctx.state.user`, `@CurrentUser()` decorator, middleware injection...
- Validate with `express-validator`, `joi`, `zod`, manual checks...
- Handle errors with try/catch, middleware, decorators, magic...

Honertia constrains the solution space intentionally:

```typescript
// There is ONE way to get the authenticated user
const auth = yield* authorize()

// There is ONE way to validate input
const input = yield* validateRequest(schema)

// There is ONE way to get a bound model
const project = yield* bound('project')

// There is ONE way to access the database
const db = yield* DatabaseService
```

This isn't limiting—it's liberating. Agents (and humans) always know exactly how to do something.

### Current Primitives

Honertia provides these composable primitives:

```typescript
// ═══════════════════════════════════════════════════════════════
// AUTHENTICATION & AUTHORIZATION
// ═══════════════════════════════════════════════════════════════

// Get authenticated user (fails if not logged in)
const auth = yield* authorize()
// => { user: User, session: Session }

// Get authenticated user with permission check
const auth = yield* authorize((a) => a.user.role === 'admin')
// => { user: User, session: Session } or ForbiddenError

// Check authentication without failing
const isLoggedIn = yield* isAuthenticated
// => boolean

// Get user if logged in, null otherwise
const maybeUser = yield* currentUser
// => AuthUser | null

// ═══════════════════════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════════════════════

// Validate request body/query against schema
const input = yield* validateRequest(CreateProjectSchema, {
  errorComponent: 'Projects/Create',
})
// => Validated<{ name: string, description: string | null }>

// Standalone validation for typed server-derived objects
const txInput = yield* validate(CheckoutTransactionSchema, {
  createOrder: { userId: auth.user.id, status: 'pending' },
})
// => Compile-time schema key checking + runtime validation

// Standalone validation for unknown payloads (not tied to request, e.g. external JSON)
const data = yield* validateUnknown(schema, rawData)
// => Validated<T>

// ═══════════════════════════════════════════════════════════════
// ROUTE MODEL BINDING
// ═══════════════════════════════════════════════════════════════

// Get bound model from route parameter (404 if not found)
const project = yield* bound('project')
// => Project (already fetched, guaranteed to exist)

// With nested scoping (e.g., /users/{user}/posts/{post})
const user = yield* bound('user')
const post = yield* bound('post')  // Automatically scoped to user

// ═══════════════════════════════════════════════════════════════
// DATABASE
// ═══════════════════════════════════════════════════════════════

// Get database instance
const db = yield* DatabaseService
// => Database

// Safe mutation (requires Validated or Trusted input)
yield* dbMutation(db, async (db) => {
  await db.insert(projects).values(validatedInput)
})

// Transaction with automatic rollback
yield* dbTransaction(db, async (tx) => {
  await tx.insert(projects).values(...)
  await tx.update(accounts).set(...)
})

// ═══════════════════════════════════════════════════════════════
// RESPONSES
// ═══════════════════════════════════════════════════════════════

// Render Inertia page
return yield* render('Projects/Index', { projects })

// Render with validation errors
return yield* renderWithErrors('Projects/Create', { name: 'Required' })

// Redirect
return yield* redirect('/projects')
return yield* redirect('/projects', 302)

// JSON response
return yield* json({ success: true })
return yield* json({ error: 'Not found' }, 404)

// ═══════════════════════════════════════════════════════════════
// ERROR HELPERS
// ═══════════════════════════════════════════════════════════════

// 404 Not Found
return yield* notFound('Project')
return yield* notFound('Project', projectId)

// 403 Forbidden
return yield* forbidden('You cannot edit this project')

// Custom HTTP error
return yield* httpError(429, 'Rate limited', { retryAfter: 60 })
```

### Composition Patterns

Primitives compose in predictable ways:

```typescript
// Pattern 1: Auth → Validate → Mutate → Redirect
export const createProject = action(
  Effect.gen(function* () {
    const auth = yield* authorize()
    const input = yield* validateRequest(CreateProjectSchema, {
      errorComponent: 'Projects/Create',
    })
    const db = yield* DatabaseService

    const txInput = asTrusted({
      createProject: {
        ...input,
        userId: auth.user.id,
      },
    })

    yield* dbMutation(db, txInput, async (db, txInput) => {
      await db.insert(projects).values(txInput.createProject)
    })

    return yield* redirect('/projects')
  })
)

// Pattern 2: Bound Model → Render
export const showProject = action(
  Effect.gen(function* () {
    const project = yield* bound('project')
    return yield* render('Projects/Show', { project })
  })
)

// Pattern 3: Auth → Bound Model → Permission Check → Mutate
export const deleteProject = action(
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

// Pattern 4: Optional Auth → Conditional Logic
export const showDashboard = action(
  Effect.gen(function* () {
    const user = yield* currentUser

    if (user) {
      const db = yield* DatabaseService
      const projects = yield* Effect.tryPromise(() =>
        db.query.projects.findMany({
          where: eq(schema.projects.userId, user.user.id),
        })
      )
      return yield* render('Dashboard/Authenticated', { projects })
    }

    return yield* render('Dashboard/Guest', {})
  })
)
```

### Creating Custom Primitives

Extend Honertia with domain-specific primitives:

```typescript
// src/primitives/rate-limit.ts
import { Effect } from 'effect'
import { BindingsService, httpError, authorize } from 'honertia/effect'

/**
 * Rate limit the current user
 * @example const allowed = yield* rateLimit('create-project', 10, 60)
 */
export const rateLimit = (
  action: string,
  limit: number,
  windowSeconds: number
) =>
  Effect.gen(function* () {
    const auth = yield* authorize()
    const { KV } = yield* BindingsService

    const key = `rate:${action}:${auth.user.id}`
    const current = parseInt((yield* Effect.tryPromise(() => KV.get(key))) ?? '0')

    if (current >= limit) {
      return yield* httpError(429, 'Rate limit exceeded', {
        retryAfter: windowSeconds,
      })
    }

    yield* Effect.tryPromise(() =>
      KV.put(key, String(current + 1), { expirationTtl: windowSeconds })
    )

    return true
  })

// Usage in handlers
export const createProject = action(
  Effect.gen(function* () {
    yield* rateLimit('create-project', 10, 60)  // 10 per minute

    const auth = yield* authorize()
    const input = yield* validateRequest(CreateProjectSchema)
    // ...
  })
)
```

```typescript
// src/primitives/feature-flag.ts
import { Effect } from 'effect'
import { BindingsService, forbidden } from 'honertia/effect'

/**
 * Check if a feature flag is enabled
 * @example yield* requireFeature('new-dashboard')
 */
export const requireFeature = (flag: string) =>
  Effect.gen(function* () {
    const { FLAGS } = yield* BindingsService

    const enabled = yield* Effect.tryPromise(() => FLAGS.get(flag))

    if (enabled !== 'true') {
      return yield* forbidden(`Feature '${flag}' is not enabled`)
    }

    return true
  })

/**
 * Check feature without failing
 * @example const hasFeature = yield* checkFeature('beta-features')
 */
export const checkFeature = (flag: string) =>
  Effect.gen(function* () {
    const { FLAGS } = yield* BindingsService
    const value = yield* Effect.tryPromise(() => FLAGS.get(flag))
    return value === 'true'
  })
```

```typescript
// src/primitives/audit.ts
import { Effect } from 'effect'
import { DatabaseService, asTrusted, authorize, dbMutation } from 'honertia/effect'
import { schema } from '~/db'

/**
 * Log an audit event
 * @example yield* audit('project.created', { projectId: project.id })
 */
export const audit = (event: string, metadata: Record<string, unknown> = {}) =>
  Effect.gen(function* () {
    const auth = yield* authorize()
    const db = yield* DatabaseService

    yield* dbMutation(db, async (tx) => {
      await tx.insert(schema.auditLogs).values(asTrusted({
        event,
        userId: auth.user.id,
        metadata: JSON.stringify(metadata),
        timestamp: new Date(),
      }))
    })
  })

// Usage: audit trail for sensitive operations
export const deleteProject = action(
  Effect.gen(function* () {
    const project = yield* bound('project')
    const db = yield* DatabaseService

    yield* dbMutation(db, async (db) => {
      await db.delete(projects).where(eq(projects.id, project.id))
    })

    yield* audit('project.deleted', { projectId: project.id, name: project.name })

    return yield* redirect('/projects')
  })
)
```

```typescript
// src/primitives/cache.ts
import { Effect } from 'effect'
import { BindingsService } from 'honertia/effect'

/**
 * Cache-aside pattern
 * @example const data = yield* cached('stats', 300, () => computeStats())
 */
export const cached = <T>(
  key: string,
  ttlSeconds: number,
  compute: () => Promise<T>
) =>
  Effect.gen(function* () {
    const { KV } = yield* BindingsService

    // Try cache first
    const cached = yield* Effect.tryPromise(() => KV.get(key, 'json'))
    if (cached) return cached as T

    // Compute and cache
    const value = yield* Effect.tryPromise(compute)
    yield* Effect.tryPromise(() =>
      KV.put(key, JSON.stringify(value), { expirationTtl: ttlSeconds })
    )

    return value
  })

// Usage
export const showStats = action(
  Effect.gen(function* () {
    const stats = yield* cached('dashboard-stats', 300, async () => {
      const db = yield* DatabaseService
      return computeExpensiveStats(db)
    })

    return yield* render('Dashboard/Stats', { stats })
  })
)
```

### Primitive Discovery for Agents

All primitives follow the same pattern, making them discoverable:

```typescript
// Every primitive:
// 1. Is a function that returns an Effect
// 2. Is used with yield*
// 3. Has typed parameters and return values
// 4. Has typed errors in the Effect signature
// 5. Composes with other primitives

// Grep patterns for finding primitives:
// yield* authorize     - Authentication
// yield* bound         - Route model binding
// yield* validate      - Validation
// yield* render        - Page rendering
// yield* redirect      - Redirects
// yield* json          - JSON responses
// yield* notFound      - 404 errors
// yield* forbidden     - 403 errors
// yield* httpError     - Custom HTTP errors
// yield* DatabaseService - Database access
// yield* BindingsService - Environment bindings

// Custom primitives follow the same pattern:
// yield* rateLimit     - Rate limiting
// yield* audit         - Audit logging
// yield* cached        - Caching
// yield* requireFeature - Feature flags
```

### Why Primitives Matter for Agents

1. **Constrained solution space**: There's ONE way to do each thing
2. **Discoverable via grep**: All use `yield*`, all follow same pattern
3. **Type-safe composition**: Effect tracks dependencies and errors
4. **Testable**: Each primitive can be mocked via Layer composition
5. **Documentable**: Each primitive has a single, clear purpose
6. **Extensible**: New primitives follow the same pattern

### Anti-Patterns to Avoid

```typescript
// ❌ DON'T: Access context directly
const user = c.var.auth.user  // Breaks type safety, not testable

// ✅ DO: Use the primitive
const auth = yield* authorize()

// ❌ DON'T: Manual validation
if (!input.name || input.name.length < 3) {
  throw new Error('Invalid name')
}

// ✅ DO: Use schema validation
const input = yield* validateRequest(CreateProjectSchema)

// ❌ DON'T: Raw database queries with unvalidated input
await db.insert(projects).values(req.body)  // SQL injection risk

// ✅ DO: Use validated input with dbMutation
const input = yield* validateRequest(schema)
yield* dbMutation(db, async (db) => {
  await db.insert(projects).values(input)
})

// ❌ DON'T: Catch-all error handling
try {
  // ... lots of code
} catch (e) {
  console.error(e)
  return new Response('Error', { status: 500 })
}

// ✅ DO: Let Effect handle errors, use typed error primitives
if (!project) {
  return yield* notFound('Project', projectId)
}
```

---

## 1. Explicit Over Implicit

### Summary

Every behavior should be traceable in the code. No magic, no hidden conventions—what you see is what executes.

### Description

Human frameworks optimize for terseness and "magic" (Laravel's facades, Rails' conventions, auto-discovery). This works because humans can hold conventions in memory and enjoy the elegance of minimal code.

AI agents have different needs:
- **Limited context windows**: Can't hold all conventions in memory
- **Tool-based interaction**: Relies on `Grep` and `Read` to understand behavior
- **Pattern matching**: Needs explicit patterns to apply consistently
- **Precise string matching**: The `Edit` tool requires exact matches

When behavior is implicit, agents must search documentation, read framework internals, or guess. Explicit code means agents can trace any behavior by following the code.

### Current State

Honertia already excels here compared to traditional frameworks:

```typescript
// Current: Services are explicitly yielded
export const listProjects = Effect.gen(function* () {
  const db = yield* DatabaseService           // Explicit: database dependency
  const user = yield* AuthUserService         // Explicit: auth dependency
  const props = yield* fetchProjects(db, user)
  return yield* render('Projects/Index', props)
})

// Current: Routes are explicit method calls
effectRoutes(app)
  .provide(RequireAuthLayer)                  // Explicit: auth requirement
  .get('/projects', listProjects)             // Explicit: method + path + handler
```

Compare to Laravel's implicit approach:
```php
// Laravel: Where does $request come from? What middleware applies?
// Must check routes/web.php, kernel.php, route groups...
Route::get('/projects', [ProjectController::class, 'index']);

class ProjectController {
    public function index(Request $request) {  // Magic injection
        return Inertia::render('Projects/Index', [
            'projects' => $request->user()->projects  // Magic relationship
        ]);
    }
}
```

### Desired End State

Continue improving explicitness:

```typescript
// Future: Route metadata explicitly attached
effectRoutes(app).get('/projects', listProjects, {
  name: 'projects.index',                      // Named routes for generation
  middleware: ['auth', 'verified'],            // Explicit middleware list
  params: S.Struct({ page: S.optional(positiveInt) }),
  meta: {
    title: 'Project List',
    permissions: ['projects.view'],
  },
})

// Future: Handler shows all dependencies in signature
export const listProjects = action({
  requires: [DatabaseService, AuthUserService],  // Visible at a glance
  handler: Effect.gen(function* () {
    const db = yield* DatabaseService
    const user = yield* AuthUserService
    // ...
  }),
})
```

### How to Improve

| Area | Current | Improvement |
|------|---------|-------------|
| Route registration | Method chaining | Add optional metadata object to all route methods |
| Service requirements | Visible via `yield*` | Add `requires` array for static analysis |
| Middleware | Via `.provide()` | Also support inline array for visibility |
| Component mapping | Convention (`Pages/X`) | Add explicit `componentPath` config |

**Implementation priority**: Medium. Current explicitness is good; improvements are refinements.

---

## 2. Colocated Metadata

### Summary

Keep everything about a feature in one place—route definition, validation schema, types, handler logic, and tests.

### Description

Human developers often prefer separation of concerns: routes in one file, controllers in another, validation in a third. This works because humans navigate codebases mentally.

AI agents benefit from colocation:
- **Reduced context switching**: One `Read` call gets everything
- **Fewer file searches**: No need to `Glob` for related files
- **Atomic understanding**: Complete feature knowledge in one read
- **Easier edits**: Changes stay in one file

### Current State

Honertia currently follows a Laravel-style separation:

```
src/
├── routes.ts              # Route definitions
├── actions/
│   └── projects/
│       ├── list.ts        # Handler logic
│       └── create.ts
├── pages/
│   └── Projects/
│       └── Index.tsx      # React component
└── db/
    └── schema.ts          # Database schema
```

Actions do colocate validation with logic:
```typescript
// src/actions/projects/create.ts
const CreateProjectSchema = S.Struct({
  name: requiredString,
  description: nullableString,
})

export const createProject = action(
  Effect.gen(function* () {
    const input = yield* validateRequest(CreateProjectSchema, {
      errorComponent: 'Projects/Create',
    })
    // ... handler logic
  })
)
```

### Desired End State

Full feature colocation with optional extraction:

```typescript
// src/features/projects/list.ts - Everything in one file

// 1. Types
interface ProjectListProps {
  projects: Project[]
  pagination: Pagination
}

// 2. Route metadata
export const route = {
  method: 'GET',
  path: '/projects',
  name: 'projects.index',
  middleware: ['auth'],
} as const

// 3. Params schema (with auto-inference to route options)
export const params = S.Struct({
  page: S.optional(positiveInt).pipe(S.withDefault(() => 1)),
  limit: S.optional(positiveInt).pipe(S.withDefault(() => 20)),
})

// 4. Handler
export const handler = action(
  Effect.gen(function* () {
    const { page, limit } = yield* validateRequest(params)
    const db = yield* DatabaseService
    const user = yield* authorize()

    const projects = yield* Effect.tryPromise(() =>
      db.query.projects.findMany({
        where: eq(schema.projects.userId, user.user.id),
        offset: (page - 1) * limit,
        limit,
      })
    )

    return yield* render('Projects/Index', { projects, pagination: { page, limit } })
  })
)

// 5. Inline tests (opt-in)
export const tests = {
  'lists user projects': async (t) => {
    const user = await t.createUser()
    const project = await t.createProject({ userId: user.id })
    const res = await t.request(route.path, { user })
    t.expect(res.props.projects).toContainEqual(project)
  },

  'requires authentication': async (t) => {
    const res = await t.request(route.path)
    t.expect(res.status).toBe(302)
    t.expect(res.headers.location).toBe('/login')
  },
}
```

Route registration becomes automatic:
```typescript
// src/routes.ts
import { registerFeatures } from 'honertia/effect'

// Auto-discovers and registers all features
registerFeatures(app, {
  features: import.meta.glob('./features/**/*.ts'),
  auth: RequireAuthLayer,
})
```

### How to Improve

| Area | Current | Improvement |
|------|---------|-------------|
| Route + Handler | Separate files | Support `export const route` convention |
| Schema + Handler | Same file | Already good |
| Tests | Separate `tests/` dir | Support `export const tests` for colocation |
| Props types | In page component | Support `export interface Props` in feature file |
| Auto-registration | Manual per-route | Add `registerFeatures()` with glob |

**Implementation priority**: High. This significantly improves agent workflow.

---

## 3. Machine-Readable Error Messages

### Summary

Errors should be structured data with actionable fix suggestions, not prose descriptions.

### Description

Agents learn from errors. The current error → fix loop is:
1. Agent tries something
2. Gets error message
3. Parses message to understand problem
4. Searches for fix approach
5. Applies fix

Structured errors short-circuit this:
1. Agent tries something
2. Gets structured error with fix suggestions
3. Applies suggested fix

This is particularly powerful for framework-specific errors where the fix is well-known.

### Current State

Honertia has a sophisticated structured error system:

```typescript
// src/effect/error-catalog.ts
export const ErrorCodes = {
  // Configuration errors (100-199)
  DATABASE_NOT_CONFIGURED: 'HON_CFG_100',
  AUTH_NOT_CONFIGURED: 'HON_CFG_101',
  SCHEMA_NOT_CONFIGURED: 'HON_CFG_102',
  // ...
} as const

// Error creation with full context
const error = createStructuredError({
  code: ErrorCodes.DATABASE_NOT_CONFIGURED,
  category: 'configuration',
  title: 'Database Not Configured',
  message: 'DatabaseService is not configured.',
  hint: 'Add database to setupHonertia config',
  fixes: [{
    description: 'Add database factory to setupHonertia',
    confidence: 'high',
    code: `database: (c) => createDb(c.env.DATABASE_URL)`,
  }],
  source: captureSourceLocation(),
  docsUrl: 'https://honertia.dev/docs/database',
})
```

Multiple output formatters exist:
- `JsonErrorFormatter`: Machine-readable
- `TerminalErrorFormatter`: Pretty CLI output
- `InertiaErrorFormatter`: Frontend display

### Desired End State

Extend the error system for full agent integration:

```typescript
// Future: Errors include complete fix context
const error = createStructuredError({
  code: ErrorCodes.BINDING_TABLE_NOT_FOUND,
  category: 'configuration',
  title: 'Route Binding Table Not Found',
  message: `Table 'project' not found in schema for route binding.`,

  // Existing
  hint: 'Ensure the table exists in your Drizzle schema',

  // New: Multiple fix strategies
  fixes: [
    {
      description: 'Add projects table to schema',
      confidence: 'high',
      type: 'create_file',
      file: 'src/db/schema.ts',
      code: `export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  userId: uuid('user_id').references(() => users.id),
})`,
    },
    {
      description: 'Use a different binding name that matches existing table',
      confidence: 'medium',
      type: 'edit',
      file: 'src/routes.ts',
      search: '/projects/{project}',
      replace: '/projects/{item}',  // If 'items' table exists
    },
  ],

  // New: Related files for context
  relatedFiles: [
    'src/db/schema.ts',
    'src/routes.ts',
  ],

  // New: Similar errors with different solutions
  similarErrors: [
    { code: 'HON_CFG_102', reason: 'Schema not passed to setupHonertia' },
  ],
})

// Future: Agent-specific formatter
const AgentErrorFormatter = {
  format: (error: StructuredError) => ({
    ...error,

    // Pre-formatted for Edit tool
    editCommands: error.fixes
      .filter(f => f.type === 'edit')
      .map(f => ({
        file_path: f.file,
        old_string: f.search,
        new_string: f.replace,
      })),

    // Pre-formatted for Bash tool
    bashCommands: error.fixes
      .filter(f => f.type === 'command')
      .map(f => f.command),
  }),
}
```

### How to Improve

| Area | Current | Improvement |
|------|---------|-------------|
| Fix suggestions | Text descriptions | Add `type`, `file`, `code` fields |
| File context | Source location only | Add `relatedFiles` array |
| Edit-ready fixes | None | Add `search`/`replace` for Edit tool |
| Command fixes | None | Add `command` field for Bash tool |
| Error correlation | None | Add `similarErrors` for disambiguation |

**Implementation priority**: High. This directly improves agent error recovery.

---

## 4. Grep-Friendly Patterns

### Summary

Design code patterns that are easy to search with `Grep` and `Glob` tools.

### Description

Agents use `Grep` extensively to:
- Find where a function is used
- Locate route definitions
- Discover schema definitions
- Track down error sources

Patterns should be:
- **Unique**: Distinguishable from similar patterns
- **Consistent**: Same pattern everywhere
- **Literal**: Avoid regex-unfriendly characters when possible
- **Prefix-based**: Start with distinguishing text

### Current State

Honertia uses consistent patterns:

```typescript
// Routes - searchable via "effectRoutes" or ".get('/path'"
effectRoutes(app).get('/projects', handler)
effectRoutes(app).post('/projects', handler)

// Services - searchable via "yield* ServiceName"
const db = yield* DatabaseService
const user = yield* AuthUserService

// Schemas - searchable via "S.Struct" or schema name
const CreateProjectSchema = S.Struct({ ... })

// Actions - searchable via "action(" or "Effect.gen"
export const createProject = action(Effect.gen(function* () { ... }))

// Errors - searchable via "new ErrorType" or "ErrorCodes.NAME"
new ValidationError({ ... })
createStructuredError({ code: ErrorCodes.DATABASE_NOT_CONFIGURED, ... })
```

### Desired End State

Formalize patterns with grep-optimized conventions:

```typescript
// Future: Standardized prefixes for all definitions

// Routes: Always start with ROUTE_
export const ROUTE_PROJECTS_LIST = effectRoutes(app)
  .get('/projects', listProjects)

// Or use a tagged template
export const routes = defineRoutes`
  GET  /projects           -> listProjects    @auth
  POST /projects           -> createProject   @auth
  GET  /projects/{project} -> showProject     @auth
`

// Actions: Prefix with ACTION_ for easy grep
export const ACTION_LIST_PROJECTS = action(...)
export const ACTION_CREATE_PROJECT = action(...)

// Schemas: Suffix with Schema
export const CreateProjectSchema = S.Struct({ ... })
export const UpdateProjectSchema = S.Struct({ ... })

// Services: Always PascalCase with Service suffix
export const DatabaseService = Context.Tag<Database>('DatabaseService')
export const CacheService = Context.Tag<Cache>('CacheService')

// Error codes: Namespaced with category
HON_CFG_100_DATABASE_NOT_CONFIGURED
HON_AUTH_200_UNAUTHORIZED
HON_VAL_300_SCHEMA_MISMATCH

// File naming conventions
src/
├── routes/
│   ├── projects.route.ts      # .route.ts suffix
│   └── users.route.ts
├── actions/
│   ├── projects.action.ts     # .action.ts suffix
│   └── users.action.ts
├── schemas/
│   ├── projects.schema.ts     # .schema.ts suffix
│   └── users.schema.ts
└── services/
    ├── cache.service.ts       # .service.ts suffix
    └── email.service.ts
```

Search examples:
```bash
# Find all routes
grep -r "effectRoutes\|defineRoutes" src/

# Find all project-related actions
grep -r "ACTION_.*PROJECT" src/

# Find schema definitions
glob "**/*.schema.ts"

# Find service usages
grep "yield\* CacheService" src/
```

### How to Improve

| Area | Current | Improvement |
|------|---------|-------------|
| Route definitions | `effectRoutes(app).method()` | Add `ROUTE_` prefix convention |
| Action exports | `export const actionName` | Add `ACTION_` prefix convention |
| Schema exports | `const XSchema` | Enforce `Schema` suffix |
| File naming | Mixed | Enforce `.route.ts`, `.action.ts`, etc. |
| Error codes | `HON_CFG_100` | Add descriptive suffix: `HON_CFG_100_DATABASE_NOT_CONFIGURED` |

**Implementation priority**: Medium. Add to style guide and linting.

---

## 5. Schema as Source of Truth

### Summary

TypeScript types and Effect Schemas drive everything—validation, documentation, client types, test factories.

### Description

Traditional frameworks duplicate type definitions:
- Database schema
- Validation rules
- API documentation (OpenAPI)
- Client types
- Test fixtures

This creates drift. Schema-first means one definition generates all others.

### Current State

Honertia uses Effect Schema for validation:

```typescript
// Schema defines validation
const CreateProjectSchema = S.Struct({
  name: requiredString.pipe(S.minLength(3), S.maxLength(100)),
  description: nullableString,
})

// Infer TypeScript type from schema
type CreateProjectInput = S.Schema.Type<typeof CreateProjectSchema>

// Use in handler
const input = yield* validateRequest(CreateProjectSchema, {
  errorComponent: 'Projects/Create',
})
```

Drizzle schema provides database types:
```typescript
// Database schema
export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description'),
  userId: uuid('user_id').references(() => users.id),
})

// Infer types
export type Project = typeof projects.$inferSelect
export type NewProject = typeof projects.$inferInsert
```

### Desired End State

Full schema-driven generation:

```typescript
// src/features/projects/schema.ts

// Single schema definition
export const ProjectSchema = S.Struct({
  id: uuid,
  name: requiredString.pipe(S.minLength(3), S.maxLength(100)),
  description: nullableString,
  userId: uuid,
  createdAt: S.Date,
  updatedAt: S.Date,
}).pipe(
  // Metadata for generation
  S.annotations({
    title: 'Project',
    description: 'A user project',
    examples: [{ id: '...', name: 'My Project', ... }],
  })
)

export const CreateProjectSchema = ProjectSchema.pipe(
  S.pick('name', 'description'),
  S.annotations({ title: 'Create Project' })
)

export const UpdateProjectSchema = ProjectSchema.pipe(
  S.pick('name', 'description'),
  S.partial,
  S.annotations({ title: 'Update Project' })
)

// Auto-generated from schemas:

// 1. TypeScript types
export type Project = S.Schema.Type<typeof ProjectSchema>
export type CreateProject = S.Schema.Type<typeof CreateProjectSchema>

// 2. OpenAPI spec (via generator)
// honertia generate:openapi -> dist/openapi.json

// 3. Client SDK types (via generator)
// honertia generate:client -> src/client/types.ts

// 4. Test factories (via generator)
// honertia generate:factories -> tests/factories.ts
export const projectFactory = Factory.define<Project>(() => ({
  id: faker.string.uuid(),
  name: faker.company.name(),
  description: faker.lorem.sentence(),
  userId: faker.string.uuid(),
  createdAt: faker.date.past(),
  updatedAt: faker.date.recent(),
}))

// 5. Database migration (via generator)
// honertia generate:migration -> src/db/migrations/001_create_projects.ts
```

Route registration with schema inference:
```typescript
// Routes automatically infer from schemas
effectRoutes(app).crud('/projects', {
  model: ProjectSchema,
  create: CreateProjectSchema,
  update: UpdateProjectSchema,
  actions: {
    list: listProjects,
    create: createProject,
    show: showProject,
    update: updateProject,
    delete: deleteProject,
  },
})
// Generates:
// GET    /projects          -> list
// POST   /projects          -> create  (validates CreateProjectSchema)
// GET    /projects/{project} -> show
// PUT    /projects/{project} -> update (validates UpdateProjectSchema)
// DELETE /projects/{project} -> delete
```

### How to Improve

| Area | Current | Improvement |
|------|---------|-------------|
| Type inference | Manual or via `S.Schema.Type` | Auto-export types with schemas |
| OpenAPI generation | None | Add `honertia generate:openapi` |
| Client types | None | Add `honertia generate:client` |
| Test factories | Manual | Add `honertia generate:factories` |
| CRUD scaffolding | Manual routes | Add `.crud()` method |
| Schema annotations | Basic | Extend for examples, descriptions |

**Implementation priority**: High. Reduces boilerplate and ensures consistency.

---

## 6. Minimal Indirection

### Summary

Prefer flat, direct code paths. Avoid deep inheritance, service containers, and multi-file jumps.

### Description

Agents struggle with:
- Deep call stacks requiring multiple `Read` operations
- Abstract base classes with many overrides
- Service containers that resolve at runtime
- "Where is this actually defined?" hunts

Direct code means:
- Follow one function call, find the implementation
- No base classes to check
- Dependencies are parameters, not injected magic

### Current State

Honertia is already quite direct:

```typescript
// Services are explicitly yielded, not auto-injected
const db = yield* DatabaseService
const user = yield* AuthUserService

// No abstract base classes
export const listProjects = action(
  Effect.gen(function* () {
    // Implementation right here
  })
)

// Layers are explicit
effectRoutes(app)
  .provide(RequireAuthLayer)  // Visible layer
  .get('/projects', handler)
```

Compare to typical OOP frameworks:
```typescript
// Deep indirection example (what to avoid)
class ProjectController extends AuthenticatedController {
  // AuthenticatedController extends BaseController
  // BaseController extends Controller
  // Must read 4 files to understand
}

// Service container magic
class ProjectService {
  constructor(
    private readonly db: DatabaseService,      // Where does this come from?
    private readonly cache: CacheService,      // Auto-injected
    private readonly events: EventService,     // Must check DI config
  ) {}
}
```

### Desired End State

Keep current patterns and formalize anti-patterns:

```typescript
// Preferred: Flat composition
export const listProjects = action(
  Effect.gen(function* () {
    const db = yield* DatabaseService
    const user = yield* authorize()

    // Logic inline, not in a separate "service" class
    const projects = yield* Effect.tryPromise(() =>
      db.query.projects.findMany({
        where: eq(schema.projects.userId, user.user.id),
      })
    )

    return yield* render('Projects/Index', { projects })
  })
)

// Allowed: Extract reusable logic as plain functions
const fetchUserProjects = (db: Database, userId: string) =>
  Effect.tryPromise(() =>
    db.query.projects.findMany({
      where: eq(schema.projects.userId, userId),
    })
  )

export const listProjects = action(
  Effect.gen(function* () {
    const db = yield* DatabaseService
    const user = yield* authorize()
    const projects = yield* fetchUserProjects(db, user.user.id)
    return yield* render('Projects/Index', { projects })
  })
)

// Avoid: Deep inheritance
// class ProjectController extends ResourceController<Project> { }

// Avoid: Separate "service" classes for simple operations
// class ProjectService { findAll() { ... } }

// Avoid: Event-based indirection
// events.emit('project.created', project)  // Where is this handled?
```

### How to Improve

| Area | Current | Improvement |
|------|---------|-------------|
| Service pattern | Effect Context.Tag | Already optimal |
| Inheritance | Not used | Document as anti-pattern |
| Event systems | Not used | Prefer explicit calls |
| Middleware | Hono chains | Keep visible in setup |

**Implementation priority**: Low. Document patterns in style guide.

---

## 7. Built-in Introspection

### Summary

Let agents query the framework about itself: routes, schemas, configuration, and runtime state.

### Description

Agents frequently need to answer:
- "What routes accept POST to /users?"
- "What schema does this route expect?"
- "What middleware applies to this route?"
- "What services does this handler require?"

Currently, agents must read source files and parse code. Built-in introspection provides structured answers.

### Current State

Limited introspection exists:
- Error system captures source locations
- Runtime can be queried for active services
- No route listing or schema export

```typescript
// Current: Must read source to understand routes
// No programmatic route listing
```

### Desired End State

Full introspection CLI and programmatic API:

```typescript
// CLI: Route introspection
$ honertia routes
┌──────────┬────────────────────────┬─────────────────────┬────────────────┐
│ Method   │ Path                   │ Handler             │ Middleware     │
├──────────┼────────────────────────┼─────────────────────┼────────────────┤
│ GET      │ /                      │ showDashboard       │ auth           │
│ GET      │ /projects              │ listProjects        │ auth           │
│ POST     │ /projects              │ createProject       │ auth           │
│ GET      │ /projects/{project}    │ showProject         │ auth           │
│ DELETE   │ /projects/{project}    │ deleteProject       │ auth           │
└──────────┴────────────────────────┴─────────────────────┴────────────────┘

$ honertia routes --method POST
# Only POST routes

$ honertia routes --path "/projects"
# Routes matching path

$ honertia routes --json
# JSON output for programmatic use

// CLI: Schema introspection
$ honertia schema CreateProjectSchema
{
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "minLength": 3,
      "maxLength": 100
    },
    "description": {
      "type": "string",
      "nullable": true
    }
  },
  "required": ["name"]
}

$ honertia schema CreateProjectSchema --typescript
export interface CreateProject {
  name: string
  description?: string | null
}

// CLI: Handler introspection
$ honertia handler listProjects
Handler: listProjects
File: src/actions/projects/list.ts:15
Services:
  - DatabaseService
  - AuthUserService (via authorize)
Returns: Response (render)
Component: Projects/Index

// CLI: Configuration check
$ honertia config
Database: configured (Drizzle)
Auth: configured (better-auth)
Schema: configured (12 tables)
Routes: 15 registered
Environment: development

$ honertia config --validate
✓ Database connection successful
✓ Auth configuration valid
✓ All route handlers resolve
✓ All schemas are valid

// Programmatic API
import { introspect } from 'honertia/cli'

const routes = await introspect.routes()
const schema = await introspect.schema('CreateProjectSchema')
const handler = await introspect.handler('listProjects')
```

Build-time route registration with metadata:
```typescript
// Route builder stores metadata
const builder = effectRoutes(app)
  .get('/projects', listProjects, { name: 'projects.list' })
  .post('/projects', createProject, { name: 'projects.create' })

// Metadata accessible
builder.getRoutes()
// => [
//   { method: 'GET', path: '/projects', handler: 'listProjects', name: 'projects.list' },
//   { method: 'POST', path: '/projects', handler: 'createProject', name: 'projects.create' },
// ]
```

### How to Improve

| Area | Current | Improvement |
|------|---------|-------------|
| Route listing | None | Add `honertia routes` CLI |
| Schema export | None | Add `honertia schema` CLI |
| Handler analysis | None | Add `honertia handler` CLI |
| Config validation | None | Add `honertia config` CLI |
| Programmatic API | None | Add `introspect` module |
| Route metadata | Minimal | Extend route builder to store metadata |

**Implementation priority**: Very High. This is a major agent workflow improvement.

---

## 8. Atomic, Reversible Operations

### Summary

Design mutations that are inspectable before running and reversible after.

### Description

Agents make mistakes. Reversible operations mean:
- Preview changes before applying
- Undo if something goes wrong
- Audit what was changed

This applies to:
- Database migrations
- Code generation
- Configuration changes

### Current State

Database mutations use Drizzle:
```typescript
// Current: Trusted mutation boundary, still no preview/rollback tooling
yield* dbMutation(db, async (tx) => {
  await tx.insert(projects).values(asTrusted({ name: 'New Project' }))
})

// Transactions for atomicity
yield* dbTransaction(db, async (tx) => {
  await tx.insert(projects).values(...)
  await tx.update(accounts).set(...)
})
```

No migration system or preview capabilities.

### Desired End State

Full preview and reversal system:

```typescript
// Migration definitions with up/down
import { defineMigration, sql } from 'honertia/db'

export const addEmailToProjects = defineMigration({
  version: '20250109_001',
  description: 'Add email column to projects table',

  up: sql`ALTER TABLE projects ADD COLUMN email TEXT`,
  down: sql`ALTER TABLE projects DROP COLUMN email`,

  // Optional: Data migration
  migrate: async (db) => {
    const projects = await db.query.projects.findMany()
    for (const project of projects) {
      await db.update(projects)
        .set({ email: `project-${project.id}@example.com` })
        .where(eq(projects.id, project.id))
    }
  },

  // Optional: Validation
  validate: async (db) => {
    const count = await db.select({ count: sql`count(*)` })
      .from(projects)
      .where(isNull(projects.email))
    return count[0].count === 0
  },
})

// CLI: Preview migrations
$ honertia migrate:preview
Migration: 20250109_001 - Add email column to projects table

Changes:
  + ALTER TABLE projects ADD COLUMN email TEXT

Affected tables:
  - projects (add column: email TEXT)

Rollback command:
  $ honertia migrate:rollback 20250109_001

Proceed? [y/N]

// CLI: Rollback
$ honertia migrate:rollback 20250109_001
Rolling back: 20250109_001 - Add email column to projects table
  - ALTER TABLE projects DROP COLUMN email
Done.

// CLI: Migration history
$ honertia migrate:status
┌─────────────────┬────────────────────────────────────────┬─────────────────────┐
│ Version         │ Description                            │ Applied             │
├─────────────────┼────────────────────────────────────────┼─────────────────────┤
│ 20250108_001    │ Create users table                     │ 2025-01-08 10:30    │
│ 20250108_002    │ Create projects table                  │ 2025-01-08 10:31    │
│ 20250109_001    │ Add email column to projects table     │ pending             │
└─────────────────┴────────────────────────────────────────┴─────────────────────┘
```

Code generation with preview:
```typescript
// CLI: Preview generated code
$ honertia generate:action CreateProject --preview
Would create: src/actions/projects/create.ts

```typescript
import { Effect, Schema as S } from 'effect'
import { action, authorize, validateRequest, redirect } from 'honertia/effect'

const CreateProjectSchema = S.Struct({
  // TODO: Add fields
})

export const createProject = action(
  Effect.gen(function* () {
    const auth = yield* authorize()
    const input = yield* validateRequest(CreateProjectSchema, {
      errorComponent: 'Projects/Create',
    })

    // TODO: Implement creation logic

    return yield* redirect('/projects')
  })
)
```

Proceed? [y/N]
```

### How to Improve

| Area | Current | Improvement |
|------|---------|-------------|
| Database migrations | None (use Drizzle) | Add `defineMigration()` wrapper |
| Migration preview | None | Add `honertia migrate:preview` |
| Migration rollback | None | Add `honertia migrate:rollback` |
| Code generation | None | Add `honertia generate:*` with `--preview` |
| Audit logging | None | Add migration history table |

**Implementation priority**: Medium. Migrations are important but Drizzle handles basics.

---

## 9. Test Generation Hooks

### Summary

Auto-generate test cases from route and schema definitions.

### Description

Agents can generate tests, but they need to know:
- What routes exist
- What inputs are valid/invalid
- What responses are expected
- What error cases exist

With schema-driven routes, most tests are predictable:
- 401 for unauthenticated requests to protected routes
- 404 for non-existent resources
- 422 for validation failures
- 200/201/204 for success cases

### Current State

Tests are written manually:
```typescript
// tests/actions/projects.test.ts
describe('listProjects', () => {
  test('returns user projects', async () => {
    const user = await createUser()
    const project = await createProject({ userId: user.id })

    const res = await app.request('/projects', {
      headers: { Cookie: await loginCookie(user) },
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.props.projects).toHaveLength(1)
  })
})
```

### Desired End State

Automatic test generation with hooks:

```typescript
// Route definition with test hooks
effectRoutes(app).get('/projects', listProjects, {
  name: 'projects.list',
  middleware: ['auth'],

  // Auto-generates tests for these cases
  tests: {
    auth: true,          // Generate 401 test
    notFound: false,     // No 404 test (list endpoint)
    validation: false,   // No validation (GET with no body)
    success: {
      setup: async (t) => {
        const user = await t.createUser()
        await t.createProject({ userId: user.id })
        return { user }
      },
      assert: async (t, res, { user }) => {
        t.expect(res.status).toBe(200)
        t.expect(res.props.projects).toHaveLength(1)
      },
    },
  },
})

// CLI: Generate tests from route definitions
$ honertia generate:tests
Generated tests:
  ✓ tests/routes/projects.test.ts (4 tests)
  ✓ tests/routes/users.test.ts (6 tests)

// Generated test file
// tests/routes/projects.test.ts (auto-generated)
import { describe, test, expect } from 'bun:test'
import { createTestContext } from 'honertia/test'

describe('GET /projects (projects.list)', () => {
  const t = createTestContext()

  test('requires authentication', async () => {
    const res = await t.request('GET', '/projects')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login')
  })

  test('returns user projects', async () => {
    const user = await t.createUser()
    await t.createProject({ userId: user.id })

    const res = await t.request('GET', '/projects', { user })
    expect(res.status).toBe(200)
    expect(res.props.projects).toHaveLength(1)
  })
})

describe('POST /projects (projects.create)', () => {
  const t = createTestContext()

  test('requires authentication', async () => {
    const res = await t.request('POST', '/projects', {
      body: { name: 'Test' },
    })
    expect(res.status).toBe(302)
  })

  test('validates required fields', async () => {
    const user = await t.createUser()
    const res = await t.request('POST', '/projects', {
      user,
      body: {},  // Missing required 'name'
    })
    expect(res.status).toBe(422)
    expect(res.props.errors.name).toBeDefined()
  })

  test('creates project with valid data', async () => {
    const user = await t.createUser()
    const res = await t.request('POST', '/projects', {
      user,
      body: { name: 'Test Project' },
    })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/projects')
  })
})
```

Schema-driven test data:
```typescript
// Generate valid/invalid test data from schema
const CreateProjectSchema = S.Struct({
  name: requiredString.pipe(S.minLength(3), S.maxLength(100)),
  description: nullableString,
})

// Auto-generated test cases
const testCases = generateTestCases(CreateProjectSchema)
// => {
//   valid: [
//     { name: 'Test', description: null },
//     { name: 'A'.repeat(100), description: 'Description' },
//   ],
//   invalid: [
//     { input: {}, errors: ['name is required'] },
//     { input: { name: 'ab' }, errors: ['name must be at least 3 characters'] },
//     { input: { name: 'a'.repeat(101) }, errors: ['name must be at most 100 characters'] },
//   ],
// }
```

### How to Improve

| Area | Current | Improvement |
|------|---------|-------------|
| Test generation | Manual | Add `honertia generate:tests` CLI |
| Route test hooks | None | Add `tests` option to route builder |
| Test context | Basic utils | Add `createTestContext()` helper |
| Schema test data | None | Add `generateTestCases()` from schema |
| Test factories | Manual | Generate from schema definitions |

**Implementation priority**: Very High. Major productivity improvement.

### Implemented: Colocated Test Generation

As of the latest update, Honertia now supports **colocated tests**—a pattern where action code and tests live in the same file. This dramatically improves LLM ergonomics by reducing:

1. **File operations**: One file to read/write instead of two
2. **Context pollution**: Everything needed to understand a route fits in one read
3. **Path mismatches**: No cross-referencing between `src/actions/` and `tests/actions/`
4. **Atomic changes**: Update handler logic → tests are right there to update too

#### Generated File Structure

When you run `honertia generate:action`, you get a single file containing everything:

```typescript
// src/actions/projects/create.ts
/**
 * CreateProject Action
 *
 * Route: POST /projects
 * Name: projects.create
 *
 * This file contains:
 * - Route configuration
 * - Request schema
 * - Handler logic
 * - Integration tests (run with: bun test src/actions/projects/create.ts)
 */

import { Effect, Schema as S } from 'effect'
import { action, authorize, redirect, validateRequest } from 'honertia/effect'

// ─────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────

export const CreateProjectSchema = S.Struct({
  name: S.String,
  description: S.String.pipe(S.NullOr),
})

// ─────────────────────────────────────────────────────────────
// Route Configuration
// ─────────────────────────────────────────────────────────────

export const route = {
  method: 'post' as const,
  path: '/projects',
  name: 'projects.create',
}

// ─────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────

export const createProject = action(
  Effect.gen(function* () {
    const auth = yield* authorize()
    const input = yield* validateRequest(CreateProjectSchema)

    // TODO: Implement createProject logic

    return yield* redirect('/projects')
  })
)

// ─────────────────────────────────────────────────────────────
// Integration Tests (self-executing in test mode)
// ─────────────────────────────────────────────────────────────

// Tests run automatically when file is executed with bun test
if (typeof Bun !== 'undefined' && Bun.env?.NODE_ENV === 'test') {
  const { describe, test, expect } = await import('bun:test')
  const { Hono } = await import('hono')
  const { effectRoutes, effectBridge, RouteRegistry } = await import('honertia/effect')
  const { honertia } = await import('honertia')

  const createTestApp = () => {
    const app = new Hono()
    const registry = new RouteRegistry()
    app.use('*', honertia({ version: '1.0.0', render: (page) => JSON.stringify(page) }))
    app.use('*', effectBridge())
    effectRoutes(app, { registry }).post(route.path, createProject, { name: route.name })
    return { app, registry }
  }

  describe(`Route: ${route.name} [${route.method.toUpperCase()} ${route.path}]`, () => {
    const { app } = createTestApp()

    test('redirects unauthenticated users to login', async () => {
      const res = await app.request('/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'test' }),
      })
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toContain('/login')
    })

    test('validates required fields', async () => {
      const res = await app.request('/projects', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Test-User': JSON.stringify({ id: 'test-user', role: 'user' }),
        },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(422)
    })

    test('processes request with valid data', async () => {
      const res = await app.request('/projects', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Test-User': JSON.stringify({ id: 'test-user', role: 'user' }),
        },
        body: JSON.stringify({ name: 'test value' }),
      })
      expect(res.status).toBe(201)
    })
  })
}
```

#### Why This Pattern Wins for LLMs

| Aspect | Separate Files | Colocated |
|--------|---------------|-----------|
| File operations | 2 reads, 2 writes | 1 read, 1 write |
| Path tracking | `src/actions/` + `tests/actions/` | Just `src/actions/` |
| Context | Split across files | All in one place |
| Test discovery | Find matching test file | Tests are right there |
| Atomic changes | Risk of drift | Always in sync |

#### CLI Commands

```bash
# Generate action with inline tests
honertia generate:action projects/create --method POST --path /projects

# Generate without tests
honertia generate:action projects/create --skip-tests

# Generate full CRUD (5 files, each with inline tests)
honertia generate:crud projects --schema "name:string:required"

# Run tests for a specific action
bun test src/actions/projects/create.ts

# Run all tests for a resource
bun test src/actions/projects/
```

---

## 10. Context-Efficient Documentation

### Summary

Documentation optimized for agent consumption—structured, searchable, example-heavy.

### Description

Agents read documentation differently than humans:
- **Humans**: Skim headings, read prose, build mental model
- **Agents**: Search for specific patterns, copy examples, apply directly

Documentation should:
- Include many small, complete examples
- Use consistent patterns that can be `Grep`ped
- Avoid prose that requires interpretation
- Include file paths for context

### Current State

README is comprehensive but prose-heavy:
```markdown
## Validation

Honertia uses Effect Schema with Laravel-inspired validators:

[Long explanation...]

```typescript
// Example code
```
```

### Desired End State

Structured, searchable documentation:

```markdown
## Validation Quick Reference

### Required String

```typescript
// File: src/schemas/user.ts
import { requiredString } from 'honertia/effect'

const UserSchema = S.Struct({
  name: requiredString,  // Trimmed, non-empty
})
```

**Pattern**: `requiredString`
**Transforms**: Trims whitespace, rejects empty
**Error**: "This field is required"
**See also**: `nullableString`, `required()`

---

### Email Validation

```typescript
// File: src/schemas/auth.ts
import { email } from 'honertia/effect'

const LoginSchema = S.Struct({
  email: email,  // Must be valid email format
})
```

**Pattern**: `email`
**Validates**: RFC 5322 email format
**Error**: "Invalid email address"
**See also**: `url`, `uuid`

---

### Custom Required Message

```typescript
// File: src/schemas/project.ts
import { required } from 'honertia/effect'

const ProjectSchema = S.Struct({
  name: required('Project name is required'),
})
```

**Pattern**: `required('message')`
**Transforms**: Trims whitespace
**Error**: Custom message provided
**See also**: `requiredString`
```

Inline structured comments in code:
```typescript
/**
 * @pattern validateRequest
 * @description Validates request body against schema
 * @example
 * const input = yield* validateRequest(
 *   S.Struct({ name: requiredString }),
 *   { errorComponent: 'Projects/Create' }
 * )
 * @param schema - Effect Schema to validate against
 * @param options.errorComponent - Component to re-render on error
 * @param options.messages - Override error messages
 * @param options.attributes - Human-readable field names
 * @returns Validated<T> - Branded type safe for database operations
 * @throws ValidationError - When validation fails
 * @see validate - Standalone validation
 * @see formatSchemaErrors - Error formatting
 */
export const validateRequest = <T>(
  schema: S.Schema<T>,
  options?: ValidateRequestOptions
): Effect.Effect<Validated<T>, ValidationError, RequestService> => { ... }
```

Generated pattern reference:
```typescript
// honertia generate:patterns > PATTERNS.md

# Honertia Pattern Reference

## Route Patterns

| Pattern | Example | Description |
|---------|---------|-------------|
| `effectRoutes(app).get(path, handler)` | `.get('/users', listUsers)` | GET route |
| `effectRoutes(app).post(path, handler)` | `.post('/users', createUser)` | POST route |
| `.provide(Layer)` | `.provide(RequireAuthLayer)` | Add middleware |
| `.prefix(path)` | `.prefix('/api/v1')` | Prefix all routes |
| `.group(fn)` | `.group((r) => { ... })` | Group routes |

## Schema Patterns

| Pattern | Example | Description |
|---------|---------|-------------|
| `S.Struct({ ... })` | `S.Struct({ name: S.String })` | Object schema |
| `requiredString` | `name: requiredString` | Required trimmed string |
| `nullableString` | `description: nullableString` | Nullable string |
| `email` | `email: email` | Email validation |
| `uuid` | `id: uuid` | UUID validation |

## Action Patterns

| Pattern | Example | Description |
|---------|---------|-------------|
| `yield* DatabaseService` | - | Get database |
| `yield* dbMutation(db, fn)` | - | Safe write boundary |
| `yield* authorize()` | - | Require auth |
| `yield* authorize(fn)` | `authorize(u => u.role === 'admin')` | Auth with check |
| `yield* validateRequest(schema)` | - | Validate body |
| `yield* render(component, props)` | `render('Users/Index', { users })` | Render page |
| `yield* redirect(path)` | `redirect('/users')` | Redirect |
```

### How to Improve

| Area | Current | Improvement |
|------|---------|-------------|
| README structure | Prose-heavy | Add quick reference sections |
| Code comments | Basic JSDoc | Add `@pattern`, `@example`, `@see` |
| Pattern reference | None | Generate `PATTERNS.md` |
| Searchable examples | Mixed in prose | Extract to dedicated sections |
| File path context | Sometimes | Always include file paths |

**Implementation priority**: Medium. Improves agent understanding.

---

## Implementation Roadmap

### The CLI is the Foundation

The `@honertia/cli` package is the centerpiece of agent-first development. All other features flow through it.

### Phase 1: Core CLI Infrastructure

**Goal**: Agents can generate features and query application structure.

```bash
# Milestone 1.1: Route Registry & Introspection
honertia routes                    # List all routes
honertia routes --json             # JSON for programmatic use
honertia routes:show <name>        # Route details

# Milestone 1.2: Action Generation with Tests
honertia generate:action <name>    # Action + integration tests
honertia generate:crud <resource>  # Full CRUD (5 actions + tests)

# Milestone 1.3: Test Infrastructure
honertia test                      # Run tests
honertia test --route <name>       # Run specific route tests
honertia test:generate             # Generate missing tests
```

**Implementation order**:
1. `RouteRegistry` class to store route metadata
2. `describeRoute()` test helper with real app testing
3. `createTestApp()` for test isolation
4. Templates for action + test generation
5. CLI commands with `--json` support

### Phase 2: Validation & Error Recovery

**Goal**: Agents can detect problems and auto-fix them.

```bash
# Milestone 2.1: Project Health Checks
honertia check                     # Full validation
honertia check:routes              # Validate all routes have handlers
honertia check:schemas             # Validate all schemas

# Milestone 2.2: Enhanced Errors
# All errors include machine-readable fix suggestions
{
  "code": "HON_CLI_001",
  "fix": {
    "type": "generate",
    "command": "honertia generate:action projects/update"
  }
}
```

**Implementation order**:
1. Route validation (orphan routes, missing handlers)
2. Schema validation (parse all schemas at startup)
3. Error catalog for CLI errors
4. Fix suggestion system

### Phase 3: Schema-Driven Generation

**Goal**: Agents can generate clients, docs, and factories from schemas.

```bash
# Milestone 3.1: OpenAPI & Client Types
honertia generate:openapi          # OpenAPI spec from routes + schemas
honertia generate:client           # TypeScript client from OpenAPI

# Milestone 3.2: Test Factories
honertia generate:factories        # Factories from Drizzle schema

# Milestone 3.3: Database
honertia db:status                 # Migration status
honertia db:migrate --preview      # Preview SQL
honertia db:generate <name>        # Generate migration from diff
```

**Implementation order**:
1. Schema extractor (parse Effect Schema to JSON Schema)
2. OpenAPI generator from route metadata
3. Client type generator
4. Factory generator from Drizzle schema
5. Migration wrapper with preview

### Phase 4: Advanced Features

**Goal**: Full development lifecycle through CLI.

```bash
# Milestone 4.1: Colocated Features
honertia generate:feature <name>   # Single-file route + handler + tests

# Milestone 4.2: Coverage & Analysis
honertia test:coverage             # Per-route coverage
honertia analyze                   # Code quality checks

# Milestone 4.3: Development Server
honertia dev                       # Dev server with HMR
honertia build                     # Production build
```

### Package Structure

```
packages/
├── honertia/                 # Core framework (existing)
│   ├── src/
│   │   ├── effect/
│   │   ├── test/             # NEW: Test utilities
│   │   │   ├── describe-route.ts
│   │   │   ├── test-app.ts
│   │   │   ├── factory.ts
│   │   │   └── assertions.ts
│   │   └── registry/         # NEW: Route registry
│   │       └── route-registry.ts
│   └── package.json
│
└── @honertia/cli/            # NEW: CLI package
    ├── src/
    │   ├── commands/
    │   ├── templates/
    │   ├── introspection/
    │   └── generators/
    └── package.json
```

### Priority Matrix

| Feature | Agent Impact | Effort | Priority |
|---------|--------------|--------|----------|
| `honertia routes` | High | Low | P0 |
| `honertia generate:action` | Very High | Medium | P0 |
| `describeRoute()` test helper | Very High | Medium | P0 |
| `honertia check` | High | Low | P1 |
| `honertia generate:crud` | High | Medium | P1 |
| Error fix suggestions | High | Medium | P1 |
| `honertia generate:openapi` | Medium | High | P2 |
| `honertia db:migrate` | Medium | High | P2 |
| `honertia generate:feature` | Medium | Medium | P3 |

---

## Success Metrics

How to measure if Honertia is agent-friendly:

1. **Context efficiency**: Average file reads per task
2. **Error recovery**: Time from error to fix
3. **Code generation**: Lines of code agent can scaffold
4. **Pattern consistency**: Variance in generated code style
5. **Self-sufficiency**: Tasks completed without documentation search

---

## Contributing

These features are designed for AI-assisted development. When contributing:

1. **Test with agents**: Verify features work well with Claude Code
2. **Prefer explicit**: When in doubt, be more explicit
3. **Include examples**: Every feature needs searchable examples
4. **Structured errors**: Every error should suggest a fix
5. **Pattern consistency**: Follow established patterns exactly

---

## Appendix: The Conversation That Shaped This Document

*This section documents how this roadmap was developed through a conversation between a human developer and Claude Code (Opus 4.5) on January 9, 2026. Preserving the reasoning helps future contributors understand not just what we decided, but why.*

### The Opening Question

The conversation began with a fundamental observation:

> "Honertia is being designed to be used by Claude Code specifically. Frameworks like Laravel were built for human programmers, but the Claude Code harness means that we could architect things in a different way for the benefit of agent loops. What kind of things could that be?"

This framing—**designing a framework for AI agents rather than humans**—set the direction for everything that followed.

### The Initial 10 Principles

Claude proposed 10 agent-friendly design principles based on how Claude Code's tools (`Read`, `Edit`, `Grep`, `Glob`, `Bash`) interact with codebases:

1. **Explicit Over Implicit** - Agents need traceability, not magic
2. **Colocated Metadata** - Keep related things together to reduce file searches
3. **Machine-Readable Error Messages** - Structured errors with fix suggestions
4. **Grep-Friendly Patterns** - Consistent, searchable code patterns
5. **Schema as Source of Truth** - One definition, types flow everywhere
6. **Minimal Indirection** - Flat code paths, no deep inheritance
7. **Built-in Introspection** - Let agents query the framework about itself
8. **Atomic, Reversible Operations** - Preview and rollback capabilities
9. **Test Generation Hooks** - Auto-generate tests from route definitions
10. **Context-Efficient Documentation** - Structured, searchable examples

The human's response: *"Built-in introspection and Test Generation hooks are such obvious wins, but so are all of these suggestions."*

### The CLI Insight

The conversation evolved when the human made a key observation:

> "Would an interesting angle therefore be a complete CLI library for interacting with Honertia? We don't just have to generate test hooks, we can generate actions complete with test hooks in one go. Tests that refer to specific routes in the code and literally test them as opposed to mock routes."

This shifted the vision from "add some CLI commands" to **"the CLI is the primary interface for agents."** Key realizations:

- **Real integration tests, not mocks**: Tests should hit actual routes through the real middleware stack
- **Generation + Testing unified**: `honertia generate:action` creates both the action AND its tests
- **JSON output everywhere**: Every command supports `--json` for programmatic consumption
- **Error recovery built-in**: Errors include fix commands that agents can execute

### The Effect-First Realization

The human then emphasized:

> "I think as much as possible, Effect and the Effect way of doing things should be a priority. It makes everything testable and explicit and handles errors and retries in a first-party standardized way. I also want to lean into types and inferring types as much as possible, ideally all from one schema/config."

This crystallized the architectural philosophy:

- **Effect isn't just for async**—it's the type system for the entire application
- **One schema, everything inferred**: Define `ProjectSchema` once, derive `CreateProjectSchema`, `UpdateProjectSchema`, TypeScript types, OpenAPI specs, test factories—all automatically
- **Services for testability**: Everything is a `Context.Tag`, swap layers for testing
- **Typed errors in signatures**: No `catch (e: unknown)`, errors are part of the type

### The Composable Primitives Principle

The final key insight from the human:

> "We also have a set of composable action primitives and ways-of-working like route model binding with `yield* bound('param')`, `yield* authorize()` etc. The more composable and reusable the building blocks are the less room there is for error."

This led to documenting the primitive pattern:

```typescript
// There is ONE way to get the authenticated user
const auth = yield* authorize()

// There is ONE way to validate input
const input = yield* validateRequest(schema)

// There is ONE way to get a bound model
const project = yield* bound('project')
```

The insight: **constraining the solution space is a feature, not a limitation.** When there's only one way to do something, agents (and humans) always know the right approach.

### Summary of Design Decisions

| Decision | Reasoning |
|----------|-----------|
| CLI as primary interface | Agents interact via `Bash` tool; CLI is their natural entry point |
| Real integration tests | Mocks drift from reality; test the actual routes |
| Effect-first architecture | Type inference, testability, explicit dependencies, typed errors |
| One schema, types everywhere | Reduce duplication, ensure consistency, enable generation |
| Composable primitives | Constrained solution space = less room for error |
| `--json` on all commands | Agents need structured output, not human-formatted text |
| Structured errors with fixes | Agents can parse errors and apply suggested fixes |

### What This Document Represents

This roadmap is not a traditional feature wishlist. It's a **design philosophy document** that answers: "What would a web framework look like if it were designed for AI agents from the ground up?"

The answer: explicit, composable, introspectable, schema-driven, and Effect-native.

---

*Document generated: January 9, 2026*
*Conversation between: Human developer and Claude Code (Opus 4.5)*
*Context: Defining the agent-first architecture for Honertia*

---

# The Next Phase: Effect 4, Drizzle 1.0, Workers Cache

*Added: July 6, 2026*

Honertia's next phase is built on three platform bets: Effect 4 (runtime and
bundle-size), Drizzle 1.0 (relations and a possible Effect-native driver), and
Cloudflare Workers Cache (responses served without running the Worker at
all). The first two are upgrade tracks below; Workers Cache landed as a
feature in 0.2.0 and has its own follow-up track.

## Workers Cache (shipped in 0.2.0; follow-ups tracked here)

0.2.0 ships the foundation: the `cache` route option (correct
`Cache-Control`/`Vary`/`Cache-Tag` with Inertia-aware guard rails),
binding-derived cache tags, the `purges` route option, and the typed
`ResponseCacheService` over `ctx.cache`.

**Follow-ups:**

- [x] ~~Verify the purge surface against the Workers runtime~~ Probed
      2026-07-07 with wrangler 4.107 (local **and** remote preview, compat
      date 2026-07-01, `"cache": { "enabled": true }`): `ctx.cache` is
      undefined and the `cloudflare:workers` module exports `cache` as an
      empty stub — the purge method has not shipped in dev/preview runtimes
      yet. Honertia's adapter now probes **both** documented surfaces
      (`ctx.cache`, then `import('cloudflare:workers').cache`) and degrades
      to an observable no-op (`isAvailable: false`). Cache headers/tags work
      regardless (pure HTTP, read server-side by Workers Cache).
- [ ] Re-probe purge availability on a **deployed** worker (and on newer
      wrangler releases) — flip the README status note when it lights up.
- [ ] Implicit purge convention: derive purges automatically for mutating
      routes that share a binding with a cached GET (today it's explicit
      `purges: true`). Adopt once real apps validate the tag scheme.
- [ ] Per-user caching recipe: document (or wrap) the gateway-entrypoint +
      `ctx.props` pattern for caching authenticated pages safely.
- [ ] Deploy-time `purge({ everything: true })` hook once a CLI deploy
      command exists (agent-first CLI section above).

# Platform Upgrade Plan: Effect 4 & Drizzle 1.0 → Honertia 2.0

Honertia's two foundational dependencies both have major versions in flight.
Neither is ready to adopt today, and neither blocks current work — every fix in
0.2.0 landed on Effect 3 + Drizzle 0.3x. But both are breaking for consumers
(Honertia declares `effect` as a peer dependency, so upgrading forces every app
to migrate with us), so they should ship together as **Honertia 2.0**, one
migration event instead of two.

## Effect 4 (currently beta; adopt at stable)

**Status (July 2026):** in beta; the Effect team recommends v3 for production.
Once stable, v4 becomes an LTS release and v3 goes into feature-freeze
(bug/security fixes only).

**Why it matters for Honertia:**

- **Bundle size.** The rewritten runtime shrinks a minimal
  Effect+Stream+Schema bundle from ~70 kB to ~20 kB — significant under
  Cloudflare Workers bundle limits, which is Honertia's home turf.
- **Unified versioning.** `effect`, `@effect/sql-*`, and platform packages
  share one version number, simplifying our peer-dependency story.
- **Schema rewrite.** v4 Schema is a substantial redesign with its own
  migration guide. Honertia surfaces Effect Schema directly in its public API
  (`validateRequest`, route `body`/`query` options, `parseOptions`), so this
  is where most of our migration work will be.

**Preconditions before starting:**

1. Effect 4 reaches stable (not beta/RC).
2. The official v3→v4 codemods and the Schema migration guide are published.
3. The v4 testing story (`@effect/vitest` equivalents) is settled for our
   bun test setup.

**Migration checklist (tracked here until it becomes issues):**

- [ ] Audit every public API that leaks an Effect type (`EffectHandler`,
      `BaseServices`, service tags, `ValidateOptions.parseOptions`,
      `S.Schema` route options) — these define the 2.0 breaking surface.
- [ ] Port validation: v4 Schema `ParseOptions` shape and `onExcessProperty`
      behavior must be re-verified; any app-side schema-level `parseOptions`
      annotation trick is v3-specific.
- [ ] Re-verify per-request `ManagedRuntime` construction cost against the v4
      runtime (it may get cheaper — measure, don't assume).
- [ ] Measure Worker bundle size before/after; publish the delta in the 2.0
      release notes.

## Drizzle 1.0 (currently beta/RC; adopt at stable)

**Why it matters for Honertia:**

- **Relations v2 (`defineRelations`).** The relations API changes shape again.
  As of 0.2.0, Honertia discovers foreign keys from **table metadata**
  (inline `.references()` FKs, identity-matched to JS property keys) first
  and `relations()` second — the first path is stable across 0.3x and 1.0,
  but the `relations()` fallback in `findRelation` will need a
  `defineRelations` branch when 1.0 lands.
- **Native Effect integration.** Drizzle now ships an Effect-native client —
  but **PostgreSQL-only** (`@effect/sql-pg`) as of mid-2026. Honertia is
  D1/SQLite-first, so this is not adoptable yet. When Effect drivers for
  D1/SQLite exist, `DatabaseService` could be backed by a drizzle-native
  Effect client, eliminating our `Effect.tryPromise` wrapping. Watch for it;
  don't build on it before it exists.

**Migration checklist:**

- [ ] Add a `defineRelations` discovery branch to `findRelation`, with the
      same JS-property-key contract and regression tests as the 0.2.0 paths.
- [ ] Re-run the binding-scoping suite against drizzle 1.0 stable
      (`tests/effect/binding-scoping.test.ts` is the gate).
- [ ] Extend the peer range (`>=0.30.0` → include 1.x) only after the above
      pass.
- [ ] Evaluate the Effect-native client for D1/SQLite if/when drivers ship.

## Sequencing

1. **Now (0.2.x):** framework hardening on Effect 3 + Drizzle 0.3x — done in
   0.2.0. Keep shipping features here; nothing below blocks 0.2.x work.
2. **When Drizzle 1.0 goes stable:** add `defineRelations` support and widen
   the peer range in a **0.x minor** — this is additive and shouldn't wait
   for 2.0.
3. **When Effect 4 goes stable:** branch `v2`, run the codemods, port the
   Schema surface, re-verify validation behavior, measure bundles.
4. **Honertia 2.0:** Effect 4 + Drizzle 1.x peers, a migration guide for apps
   (validation `parseOptions`, any Schema-facing changes), and bundle-size
   numbers in the release notes.

**Explicit non-goals until then:** adopting Effect 4 beta APIs, building on
`effect/unstable/*` modules, or coupling to the Postgres-only Effect client.
