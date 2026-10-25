# Route model binding

Name each model's Drizzle table once, in `setupWeb`'s `bindings`, with who may
load its record, then use Laravel-style route placeholders:

```ts
import * as schema from '../schema'

const bindings = {
  project: routeBinding(schema.projects, { ownedBy: 'userId' }),
  task: routeBinding(schema.tasks, { scope: { project: { foreignKey: 'projectId' } } }),
}

routes
  .get(paths.project, showProject)
  .get(paths.projectBySlug, showProjectBySlug)
  .get(paths.task, showTask)
```

Inside `showTask`, both models from the nested route are available by name:

```ts
const project = yield* bound('project')
const task = yield* bound('task')
```

## Who may load a record

Laravel's route model binding finds a record and leaves who may see it to a
policy each action has to remember to call. Here the binding says it, once,
beside its table, and the lookup's query enforces it, so no action has to
remember the check:

| Option | Who loads the record | Anyone else |
| --- | --- | --- |
| `ownedBy: 'userId'` | The signed-in user whose id the column holds, a column that references the users table's `id` | The 404 a missing record gets. A signed-out visitor is asked to sign in, before the database is asked |
| `publicWhen: { isPublic: true }` | Anyone, when its columns hold these values, each typed by its column, as `{ visibility: 'public' }` | 404, its owner included |
| `public: true` | Anyone, signed in or not | Nobody else |
| `guarded: true` | Anyone the route's guard lets through, as a membership guard lets in an organization's members. The record loads only once a `guard(...)` the route is provided has read it and let the visitor in: asked for first by an action, another layer or a guard that reads a record under it, it fails | The guard's answer: 404 for a stranger, as [Guards and roles](guards.md#roles-belong-to-memberships-read-by-a-guard) shows |

A record that lives inside another, such as a book in a list, says `scope`
instead: `book: routeBinding(schema.books, { scope: { list: { foreignKey: 'listId' } } })`
loads a book only under its list, so the list's option decides. Registering
a route that names `{book}` without `{list}` fails, and so does a child that
says `public: true` under a parent that says who may load it, since it would
load for anyone on a path without the parent.

A binding gives one option: two fail when `setupWeb` is called
(`WEB_RTE_606_BINDING_ACCESS_INVALID`), as do a column the table lacks and
a `publicWhen` value that is undefined, such as an absent setting, which a
SQLite boolean column would read as false. The `require-binding-access`
[lint rule](lint-rules.md) reports a binding that gives none, which loads
any record its path names, for anyone.

The signed-in user is the session's, or the one a layer the route provides
gives, as an API key's does. An `ownedBy` column declares that it holds a
user's id,
`userId: text('user_id').notNull().references(() => user.id)`, naming the
table `betterAuthSession` was given, or else Better Auth's `user`. One that
references another table, or no table, fails when `setupWeb` is called
(`WEB_RTE_607_BINDING_OWNER_NOT_USER`): compared with the signed-in user's
id, it would match no record.

A record an organization owns loads under the organization, as
`/orgs/{organization:slug}/projects/{project}`: the organization's binding is
`guarded: true`, with the membership guard that decides provided to its
routes, and the project is scoped to it,
`scope: { organization: { foreignKey: 'organizationId' } }`. A member loads
the organization's projects, anyone else gets the guard's 404, and another
organization's project under this one's path is a 404 too. A record that
belongs to a user through a parent, such as a book in a list, loads under
the parent the same way, the list `ownedBy: 'userId'`, unless it holds a
`userId` of its own.

One table can be bound twice, for two kinds of page. A project's own pages
bind `{project}` for its owner, and the page anyone may see binds
`{showcase}` from the same table, under a path of its own, such as
`/showcase/{showcase}`:

```ts
import * as schema from '../schema'

const bindings = {
  project: routeBinding(schema.projects, { ownedBy: 'userId' }),
  showcase: routeBinding(schema.projects, { publicWhen: { isPublic: true } }),
}
```

## What a model is

`bound('task')` is the table's row, checked against the table's columns as it
loads: their types, nullability and enum values. A parameter name need not
match its table: `bindings: { author: schema.users }` loads `{author}` from
`users`. A JSON column, or a text column narrowed with `$type<Role>()`, is
typed but not checked by its column: name an Effect Schema for the binding,
such as `tableSchema(schema.contacts, { custom: CustomValues })`, whose
overrides check those columns and derive the rest; the binding loads from the
table the schema was built from.

## When a model loads

A route loads its models the first time the action calls `bound()`, so a
guard or `authorize()` that runs first decides before any database lookup,
and a signed-out visitor cannot tell an existing record from a missing one.
A missing row fails `bound()` with `NotFoundError`, which renders a 404. The
route's models load together, so a missing one is a 404 whichever the action
asks for. A guard's read loads only the record it reads and those before it
in the path, and the rest load on the first read after the guards, so a
visitor a guard turns away learns nothing of the records under the one it
decides for, even when it answers 403 or redirects. A guard that reads a
record under a `guarded` one fails until that one's guard has decided.

`{post}` looks the record up by the table's `id` column, or, for a table
without one, its primary key. `{post:slug}` names the column by its property
key in the table (`certificateToken`, not the SQL `certificate_token`), and a
column the table lacks fails when the route is registered.

To lock a bound record inside `dbTransaction`, read it again by its id with
`.for('update')`, as [Rules live in services](services.md#rules-live-in-services-actions-decide-what-a-failure-means)
shows; the bound row was read before the transaction began.

## Nested models are scoped to their parent

A nested binding is scoped to the binding before it. Drizzle's metadata
finds the relationship when the child's column references the parent's
(`.references(() => projects.id)`) or a relation declares it, so `{task}`
under `{project}` loads only the project's tasks: another project's task
under this one's path is a 404. Name the relationship with `scope`, which
also says the binding loads only under its parent, so the parent's option
decides who may load it. `scope` can name an earlier binding than the one
before it, such as a project's flag under one of the project's environments,
`/projects/{project}/environments/{environment}/flags/{flag:key}`. `setupWeb`
checks each scope's binding and columns when it is called:

```ts
import * as schema from '../schema'

const routeBindings = {
  task: routeBinding(schema.tasks, {
    scope: {
      project: { foreignKey: 'projectId' },
    },
  }),
}
```

This fails closed when a child lookup cannot be safely scoped to its parent.

A membership is a route model like any other: with
`member: routeBinding(schema.memberships, { scope: { organization: { foreignKey: 'organizationId' } } })`
among the bindings, `/orgs/{organization:slug}/members/{member:userId}` loads
the organization's membership of the user the path names, by its `userId`
column, and another organization's member is a 404. Bind every record a path
names this way, rather than reading its id as a plain parameter and querying
for it.

## A lookup names one record

A lookup column must name one record within the route's scope: a slug unique
only within an organization belongs under it, as
`/orgs/{organization:slug}/events/{event:slug}`. When the column matches more
than one row, `bound()` fails (`WEB_RTE_605_BINDING_AMBIGUOUS`) instead of
picking one. An `ownedBy` binding's lookup is scoped by its owner, so a
slug unique to each user names one record. Any other tenant the route takes
from the signed-in user rather than its path, such as a member's company,
does not scope a lookup: put the tenant in the path
(`/c/{company:slug}/shops/{shop:code}`), which also keeps links to another
tenant's records from loading, or make the column unique across tenants.

## Plain parameters

A placeholder without a binding is a plain parameter: the action reads it
with `validateRequest`, beside the route's models. In
`/teams/{team}/invites/{token}`, `bound('team')` loads the team and `token`
arrives with the request's input, to be looked up like any other input,
scoped by the team. A page that answers when a record is missing, such as an
article that falls back to another locale, takes that parameter as a plain
parameter too, queries with it scoped by its bound parent, and tags its
cached response with what it read using `tagCache`.

## Reading a model outside the action

`bound('project')` needs a route whose path, or prefix, has `{project}`: the
types track it as the Effect requirement `RouteModel<'project'>`, which only
such a route provides. An action, or a guard layer, that reads a model its
route does not bind fails to type-check where the route is registered, with
`missingRouteModels: "project"`. A helper that reads a model states the
requirement in its type, `BoundRequirements<'project'>`, so every action that
uses it carries it:

```ts
import type { BoundModelError, BoundRequirements } from '@popcomputer/web/effect'

type Project = typeof projects.$inferSelect

// The route's project, or a 403 once it is archived.
export const openProject: Effect.Effect<Project, BoundModelError | ForbiddenError, BoundRequirements<'project'>> =
  Effect.gen(function* () {
    const project = yield* bound('project')

    if (project.archivedAt !== null) return yield* forbidden('This project is archived.')

    return project
  })
```

An action calls it, `const project = yield* openProject`, and only a route
with `{project}` accepts that action.

A test that runs such a helper outside a route provides
`BoundModels.fromModels({ project })`, which binds the models it holds.

Route model binding is currently Drizzle-specific even though the basic
`DatabaseService` can hold any application database client.
