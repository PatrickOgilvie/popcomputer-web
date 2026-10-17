# The database

The database operations read the request's client from `DatabaseService` and
give their callback the application's Drizzle client with its own types:

| Operation | Use |
| --- | --- |
| `dbQuery((db) => ...)` | Reads. |
| `dbMutation((db) => ...)` | One write, or writes that need not be atomic. |
| `dbTransaction(effect)` | An Effect whose database operations must succeed together, on a driver with asynchronous transactions (Postgres, MySQL, libsql). |
| `dbBatch((db) => [...])` | Writes that must succeed together on Cloudflare D1, libsql or Neon HTTP: every statement applies, or none. |

Inside `dbTransaction`, `DatabaseService` is the transaction, so every
`dbQuery` and `dbMutation` the Effect runs takes part, including those of the
services it calls. Domain logic between the writes stays ordinary Effect code:
the transaction commits when the Effect succeeds, and rolls back when it fails
with the Effect's own typed error.

```ts
// src/actions/projects/destroy.ts
import { eq } from 'drizzle-orm'
import { Effect } from 'effect'
import { action, bound, dbMutation, dbTransaction, flash, redirect } from '@popcomputer/web/effect'
import { paths } from '../../paths'
import { projects, tasks } from '../../schema'

export const destroyProject = action(
  Effect.gen(function* () {
    // Its owner's only: the binding is ownedBy 'userId'.
    const project = yield* bound('project')

    yield* dbTransaction(Effect.gen(function* () {
      yield* dbMutation((db) => db.delete(tasks).where(eq(tasks.projectId, project.id)))
      yield* dbMutation((db) => db.delete(projects).where(eq(projects.id, project.id)))
    }))
    yield* flash('success', 'Project deleted.')

    return yield* redirect(paths.projects)
  })
)
```

`dbTransaction` is a type error on Cloudflare D1, which rejects interactive
transactions, and on synchronous drivers such as `bun:sqlite`, which commit
before an awaited write runs. On D1, use `dbBatch`. A batch cannot decide
from a read, so a rule such as "at most 100 open tasks" belongs in the write
itself (`INSERT ... SELECT ... WHERE (SELECT count(*) ...) < 100`, then check
the number of rows changed); a count followed by an insert lets concurrent
requests pass the limit together.

A write that breaks a constraint fails with `DatabaseConstraintViolation`,
which names the constraint kind (`unique`, `foreign-key`, `not-null`, `check`)
and, when the driver reports them, its `columns`. Any other failure is a
`DatabaseError`. `uniqueFieldErrors` turns a unique violation into field errors
the form shows:

```ts
yield* dbMutation((db) => db.insert(projects).values(newProject)).pipe(
  uniqueFieldErrors({ slug: 'A project with this slug already exists.' })
)
```

## Migrations

The package does not run migrations. drizzle-kit generates them from
`src/schema.ts`, and the demo's README shows the commands that generate and
apply them, in [Changing the database](https://github.com/PatrickOgilvie/popcomputer-web-demo#changing-the-database).
[A database for tests](test-database.md) applies the same migrations to a
test's database.

## Lists page through with a cursor

A list that grows pages through it by the last row shown, not by an offset: a
row added or removed between two requests shifts every offset, and the
database counts and skips every row before one. Order by a column that orders
the rows and a unique one that breaks ties, read one row more than the page
holds to learn whether another page follows, and render the cursor of the
last row shown as the page's `next`. The query decodes through
`validateRequest`, so a malformed cursor is a 422 rather than a database
error, and an empty search box is `null`:

```ts
// src/actions/projects/list.ts
import { and, desc, eq, ilike, lt, or } from 'drizzle-orm'
import { Effect } from 'effect'
import { action, authorize, dbQuery, render, validateRequest } from '@popcomputer/web/effect'
import { ProjectFilters } from '../../forms'
import { projects } from '../../schema'

const PAGE_SIZE = 25

export const listProjects = action(Effect.gen(function* () {
  const auth = yield* authorize()
  const filters = yield* validateRequest(ProjectFilters)
  const after = filters.beforeAt !== null && filters.beforeId !== null
    ? { at: filters.beforeAt, id: filters.beforeId }
    : null

  const rows = yield* dbQuery((db) =>
    db.select({ id: projects.id, name: projects.name, createdAt: projects.createdAt })
      .from(projects)
      .where(and(
        eq(projects.userId, auth.user.id),
        filters.q === null ? undefined : ilike(projects.name, `%${filters.q}%`),
        after === null ? undefined : or(
          lt(projects.createdAt, after.at),
          and(eq(projects.createdAt, after.at), lt(projects.id, after.id))
        )
      ))
      .orderBy(desc(projects.createdAt), desc(projects.id))
      .limit(PAGE_SIZE + 1)
  )

  const shown = rows.slice(0, PAGE_SIZE)
  const last = shown.at(-1)

  return yield* render('Projects/Index', {
    projects: shown,
    next: rows.length > PAGE_SIZE && last !== undefined ? { beforeAt: last.createdAt, beforeId: last.id } : null,
  })
}))
```

The page links to the next one with `href(paths.projects, {}, next)`, as
[Forms](forms.md) shows; a search carries on through the
pages when the link adds it, `{ ...next, q }`. The page's schema drops
`createdAt` from each row it shows, since `ProjectSummary` does not name it.
An index on the order's columns, `(user_id, created_at, id)`, lets each page
start where the last one ended.

On Postgres, declare a cursor's timestamp as
`timestamp('created_at', { precision: 3, withTimezone: true })`. The cursor
travels as a JavaScript `Date`, which holds milliseconds, while a plain
`timestamp` holds microseconds, so a row created within the same millisecond
as the last one shown, but before it, falls between the pages and is never
listed. A `timestamp` without a time zone also reads in the process's zone:
Workers run in UTC, but a test on a machine in another zone shifts every
cursor by its offset.
