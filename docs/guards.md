# Guards and roles

A guard decides whether the visitor may go on. `guard(...)` turns the Effect
that decides into a layer, provided to the routes it guards: it runs before
each action, may read the route's models with `bound()`, and turns the
visitor away by failing, as the action would have answered:

```ts
import { authorize, guard } from '@popcomputer/web/effect'

const RequireVerified = guard(authorize(({ user }) => user.emailVerified))

routes.provide(RequireVerified).get(paths.billing, showDashboard)
```

`guard` takes the Effect that decides; or a service and the Effect that
finds it, which the actions it guards then read; or a layer. Who may load a
record at all is its binding's to say, with `ownedBy`, `publicWhen` or
`public`, as [Route model binding](route-models.md#who-may-load-a-record)
shows: a guard decides it for a rule a column cannot state, such as
membership of an organization, whose binding says `guarded: true`. Such a
record loads only once a guard has read it and let the visitor in, and the
guard's read loads none of the records under it, such as the organization's
project, so a stranger the guard turns away gets its answer whether the
project exists or not. A layer that reads it for some other reason, such as
breadcrumbs, is no guard. A route whose records are asked for before a guard
has decided fails (`WEB_RTE_606_BINDING_ACCESS_INVALID`) before any lookup:
by a layer provided before the guard or built beside it, as `Layer.merge`
builds its layers, or by a guard that reads a record under the guarded one,
such as the project, before the organization's guard has decided. So
provide the guard on its own, before any other layer that reads a record.

The default page cache answers before any guard runs, so it caches no page
a guard decides for, nor one behind `routes.middleware(...)`. An access
check made any other way that reads something the page cache does not
track, as [Page caching](page-cache.md) lists, such as the time, needs
`cache: 'private'` on its routes.

An application that authenticates some other way, such as API keys, provides
its own user service through a layer that fails with `UnauthorizedError`:
`routes.provide(ApiKeyAuth)` runs it before the action, so every route
registered through it can read the service.

## A guard guards a group of routes

A rule every route in a group shares, such as "not once the project is
archived", is a guard provided to the group:

```ts
const OpenProject = guard(Effect.gen(function* () {
  const project = yield* bound('project')

  if (project.archivedAt !== null) return yield* forbidden('This project is archived.')
}))

routes.provide(OpenProject).put(paths.project, updateProject)
```

A guard that finds something the actions need, such as the visitor's
membership of an organization, provides it as a service, so every action in
the group, and a `shareProps` provided after it, reads it without querying
again:

```ts
class CurrentProject extends Context.Service<CurrentProject, {
  readonly project: typeof projects.$inferSelect
}>()('app/CurrentProject') {}

const OpenProject = guard(CurrentProject, Effect.gen(function* () {
  const project = yield* bound('project')

  if (project.archivedAt !== null) return yield* forbidden('This project is archived.')

  return CurrentProject.of({ project })
}))

routes.provide(OpenProject).get(paths.task, action(Effect.gen(function* () {
  const { project } = yield* CurrentProject

  return yield* render('Projects/Show', { project })
})))
```

## Roles belong to memberships, read by a guard

A role a user holds in one organization, such as admin, is not a field of the
user: the same user may be an admin of one organization and a member of
another, and a `role` column on the user table makes an admin anywhere an
admin everywhere. Keep the role on a membership row, one per user and
organization, and read it in a guard layer for the organization's routes.
The guard answers a visitor who is not a member with 404, so the
organization's existence stays private, and provides the membership as a
service, so actions and `shareProps` read it without querying again. The
organization's binding says so, `routeBinding(schema.organizations, { guarded: true })`,
and every route whose path names it is provided the guard. With Better
Auth's organization plugin, its `member` table is the membership row, read
the same way:

```ts
// src/memberships.ts
import { and, eq } from 'drizzle-orm'
import { Context, Effect } from 'effect'
import { authorize, bound, dbQuery, forbidden, guard, notFound } from '@popcomputer/web/effect'
import { memberships } from './schema'

export type Membership = typeof memberships.$inferSelect

export class CurrentMember extends Context.Service<CurrentMember, Membership>()('app/CurrentMember') {}

export const RequireMember = guard(CurrentMember, Effect.gen(function* () {
  const auth = yield* authorize()
  const organization = yield* bound('organization')
  const [membership] = yield* dbQuery((db) =>
    db.select().from(memberships).where(and(
      eq(memberships.organizationId, organization.id),
      eq(memberships.userId, auth.user.id)
    ))
  )

  if (membership === undefined) return yield* notFound('Organization')

  return CurrentMember.of(membership)
}))

// A member who can see the organization but lacks the role gets a 403.
export const requireRole = (...roles: ReadonlyArray<Membership['role']>) =>
  Effect.gen(function* () {
    const member = yield* CurrentMember

    if (!roles.includes(member.role)) return yield* forbidden('Your role in this organization does not allow that.')

    return member
  })
```

On Postgres through Hyperdrive, query caching is on by default: a read can be
answered from Hyperdrive's cache for up to a minute without asking the
database, so a membership just removed, or a role just lowered, still lets
its member through. Read memberships, roles and sessions through a Hyperdrive
configuration with caching disabled, as Cloudflare's
[query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/)
page recommends for them. D1 has no such cache.

A permission names what a route does rather than who may do it, so what
each role may do is one table, and a new role is one row:

```ts
// src/permissions.ts
import { Effect } from 'effect'
import { forbidden } from '@popcomputer/web/effect'
import { CurrentMember, type Membership } from './memberships'

export type Permission = 'members.invite' | 'members.role' | 'projects.delete'

const permissions: Readonly<Record<Membership['role'], ReadonlyArray<Permission>>> = {
  owner: ['members.invite', 'members.role', 'projects.delete'],
  admin: ['members.invite', 'members.role'],
  member: [],
}

export const can = (permission: Permission) =>
  Effect.gen(function* () {
    const member = yield* CurrentMember

    if (!permissions[member.role].includes(permission)) return yield* forbidden('Your role in this organization does not allow that.')

    return member
  })
```

An action states the role or permission it needs, `yield* can('members.role')`,
so the check travels with it wherever it is registered. The member it changes is a route model
too: `{member:userId}` binds the organization's membership of the user the
path names, so a member of another organization is a 404, and the write is
scoped by the bound row rather than by anything the request sends:

```ts
// src/actions/organizations/change-role.ts
import { and, eq, ne } from 'drizzle-orm'
import { Effect, Schema as S } from 'effect'
import { action, back, bound, dbMutation, flash, forbidden, validateRequest } from '@popcomputer/web/effect'
import { paths } from '../../paths'
import { can } from '../../permissions'
import { memberships } from '../../schema'

const ChangeRole = S.Struct({ role: S.Literals(['admin', 'member']) })

export const changeRole = action(Effect.gen(function* () {
  yield* can('members.role')
  const organization = yield* bound('organization')
  const member = yield* bound('member')
  const input = yield* validateRequest(ChangeRole)

  const [changed] = yield* dbMutation((db) =>
    db.update(memberships)
      .set({ role: input.role })
      .where(and(
        eq(memberships.organizationId, member.organizationId),
        eq(memberships.userId, member.userId),
        // An owner's role changes only by transferring ownership.
        ne(memberships.role, 'owner')
      ))
      .returning()
  )

  if (changed === undefined) return yield* forbidden("An owner's role changes only by transferring ownership.")

  yield* flash('success', 'Role changed.')

  return yield* back(paths.organizationMembers, { organization: organization.slug })
}))
```

The organization's routes share its path prefix and the guard, so they are
grouped under `routes.prefix(...)`. Each is registered with its whole
declared path, which must start with the prefix:

```ts
import { changeRole } from '../actions/organizations/change-role'
import { RequireMember } from '../memberships'

routes
  .prefix('/orgs/{organization:slug}')
  .provide(RequireMember)
  .put(paths.organizationMember, changeRole, { name: 'organizations.members.role' })
```

`changeRole` reads `CurrentMember` through `can`, which only `RequireMember`
provides, so registering it without the guard is a `missingServices` type
error, and the guard reads `bound('organization')`, so its routes need
`{organization}` in their path or prefix. A group whose every route needs
one permission is given it as a guard after the membership guard,
`.provide(RequireMember).provide(guard(can('projects.delete')))`, which turns
a member without it away with a 403 before any of its actions runs. A membership's role is an enum column, `text('role', { enum:
['owner', 'admin', 'member'] })`, so a misspelled role is a type error in
`requireRole`, in the table of permissions and in the update. A test seeds a membership for the user it
signs in with `signedIn`, and checks a stranger gets 404 and a member 403.
