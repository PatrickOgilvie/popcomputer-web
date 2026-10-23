# Application services

Services an action needs beyond the framework's are Effect layers, given
with `web.services(...)` once `web` is registered. It returns the routes,
which accept actions that use them.

```ts
// src/services.ts
import { Config, Context, DateTime, Effect, Layer } from 'effect'
import { config } from '@popcomputer/web/effect'

export class Clock extends Context.Service<Clock, {
  readonly today: Effect.Effect<string>
  readonly timeZone: string
}>()('app/Clock') {}

// config reads the Worker's bindings, named as src/env.ts declares them:
// here the TIME_ZONE var.
export const ClockLive = Layer.effect(Clock, Effect.gen(function* () {
  const timeZone = yield* config.string('TIME_ZONE').pipe(Config.withDefault('UTC'))
  // An unknown zone is a deployment mistake: the layer fails to build, naming it.
  const zone = yield* DateTime.zoneMakeNamedEffect(timeZone).pipe(Effect.orDie)

  return Clock.of({
    // DateTime.now reads Effect's Clock, so testClock moves today as well.
    today: Effect.map(DateTime.now, (now) => DateTime.formatIsoDate(DateTime.setZone(now, zone))),
    timeZone,
  })
}))

export class AuditLog extends Context.Service<AuditLog, {
  readonly record: (event: string) => Effect.Effect<void>
}>()('app/AuditLog') {}

export const auditLogFor = (kv: KVNamespace) => Layer.succeed(AuditLog, AuditLog.of({
  record: (event) => Effect.promise(() => kv.put(`audit:${event}`, event)),
}))
```

In `src/app.ts`, after the `Register` declaration, the routes come from
`web.services(...)` in place of `export const { app, routes } = web`:

```ts
export const { app, routes } = web.services({
  app: ClockLive,
  request: (c) => auditLogFor(c.env.KV),
})
```

The `app` layer is built once, on the first request an isolate serves, and
shared by every later request: configuration, clients that open no connection
until used, in-memory caches. `config` from `@popcomputer/web/effect` is
Effect `Config` named by the bindings `src/env.ts` declares, so a misspelled
name is a type error: it reads the Worker's bindings in both kinds of service
and in actions, and `config.redacted('PAYMENT_WEBHOOK_SECRET')` reads a
secret. A missing binding fails the request with a configuration error that
names it in development. The `request` layer is built for each request from
its context and bindings, when the request runs an action: a plain Hono
route never calls `request(c)`. Anything holding a request's I/O, such as a D1, KV or
Hyperdrive binding, belongs in `request`: Workers forbid using it from
another request. A request service built from a request header, `c.req.raw`
or `c.req.url`, such as a tenant named by `X-Tenant`, makes every page that
runs it render per request, as reading a header does in an action, since no
cache key holds them. A request service replaces an application service with the
same tag. For services only some routes need, use `routes.provide(layer)`.

A layer's type is inferred, even when it reads the database, `config` or
`bound`: `web.services` comes after the registration, so the types those read
do not depend on the layer. A service that queries the database keeps
`DatabaseService` in its methods' requirements rather than providing it
itself, so a method called inside `dbTransaction` takes part in the
transaction:

```ts
import { eq } from 'drizzle-orm'

type Project = typeof projects.$inferSelect

export class Projects extends Context.Service<Projects, {
  readonly ownedBy: (
    userId: string
  ) => Effect.Effect<ReadonlyArray<Project>, DatabaseError, DatabaseService>
}>()('app/Projects') {}

export const ProjectsLive = Layer.succeed(Projects, Projects.of({
  ownedBy: (userId) =>
    dbQuery((db) => db.select().from(projects).where(eq(projects.userId, userId))),
}))
```

## Rules live in services; actions decide what a failure means

Put a business rule in an Effect service whose methods fail with
`Schema.TaggedError` errors, and let the action turn each failure into a
response with `Effect.catchTags`: `invalid(...)` for an error that belongs
beside a form field, `notFound(...)` or `forbidden(...)` for access, and
`flash(...)` then `back(...)` for a refusal the visitor should read. A failure
the action leaves unhandled is a type error at its registration, naming it in
`unhandledErrors`.

The transaction can live in the service, as below, or in the action that
calls several services' methods inside one `dbTransaction`; either way, a
typed failure after a write, such as a rule a later step checks, rolls that
write back.

A limit checked by counting and then inserting lets two concurrent requests
both pass the count. Inside `dbTransaction`, lock the row the limit belongs to
first (`for('update')` on Postgres), so the second request counts after the
first one writes.

```ts
import { count, eq } from 'drizzle-orm'
import type { DatabaseWriteError } from '@popcomputer/web/effect'
import { requiredString } from '@popcomputer/web/schema'
import { tasks } from '../schema'

export class TaskLimitReached extends S.TaggedError<TaskLimitReached>()('TaskLimitReached', {
  limit: S.Number,
}) {}

export class Tasks extends Context.Service<Tasks, {
  readonly add: (
    projectId: string,
    title: string
  ) => Effect.Effect<void, TaskLimitReached | DatabaseWriteError, DatabaseService>
}>()('app/Tasks') {}

export const TasksLive: Layer.Layer<Tasks> = Layer.succeed(Tasks, Tasks.of({
  add: (projectId, title) =>
    dbTransaction(Effect.gen(function* () {
      yield* dbQuery((db) => db.select().from(projects).where(eq(projects.id, projectId)).for('update'))
      const [row] = yield* dbQuery((db) =>
        db.select({ tasks: count() }).from(tasks).where(eq(tasks.projectId, projectId))
      )

      if ((row?.tasks ?? 0) >= 100) return yield* new TaskLimitReached({ limit: 100 })

      yield* dbMutation((db) => db.insert(tasks).values({ id: crypto.randomUUID(), projectId, title }))
    })),
}))

export const addTask = action(Effect.gen(function* () {
  // Its owner's only: the binding is ownedBy 'userId'.
  const project = yield* bound('project')
  const input = yield* validateRequest(S.Struct({ title: requiredString }))
  const service = yield* Tasks

  return yield* service.add(project.id, input.title).pipe(
    Effect.andThen(redirect(paths.project, { project: project.id })),
    Effect.catchTags({
      TaskLimitReached: (error) => invalid({ title: `A project holds at most ${error.limit} tasks.` }),
    })
  )
}))
```

## Other patterns

- **State machines**: model a record's states as a `Schema.TaggedUnion`
  (build a state with `.cases.Draft.make(...)`) and its transitions as one
  function returning an Effect that fails with a typed error for an illegal
  one; the action maps those errors, all of them with one handler when they
  answer alike (`Effect.catchTag(['ClaimLocked', 'AlreadyPaid'], refuse)`),
  and a page schema built from the union lets React switch over the states
  exhaustively.
- **Services that join transactions**: keep `DatabaseService` in a service
  method's requirements (`Effect.Effect<A, E, DatabaseService>`) instead of
  providing it inside the service, so a method called in `dbTransaction`
  takes part in it.
