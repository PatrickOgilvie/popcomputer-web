# Guards and roles

A guard can be any layer that fails. Turn an authorization rule into one for a
group of routes with `Layer.effectDiscard`:

```ts
import { Layer } from 'effect'
import { authorize } from '@popcomputer/web/effect'

const RequireVerified = Layer.effectDiscard(authorize(({ user }) => user.emailVerified))

routes.provide(RequireVerified).get(paths.billing, showDashboard)
```

An application that authenticates some other way, such as API keys, provides
its own user service through a layer that fails with `UnauthorizedError`:
`routes.provide(ApiKeyAuth)` runs it before the action, so every route
registered through it can read the service.

## A layer guards a group of routes

A rule every route in a group shares, such as "only the project's owner", is a
layer that fails, provided to the routes it guards. It runs before each
action, may read the route's models with `bound()`, and answers the way the
action would have. A record the visitor may not see answers 404, so its
existence stays private:

```ts
const OwnProject = Layer.effectDiscard(Effect.gen(function* () {
  const auth = yield* authorize()
  const project = yield* bound('project')

  if (project.userId !== auth.user.id) return yield* notFound('Project')
}))

routes.provide(OwnProject).get(paths.project, showProject)
```

A guard that finds something the actions need, such as the visitor's
membership of an organization, provides it as a service instead of discarding
it, so every action in the group, and a `shareProps` provided after it, reads
it without querying again:

```ts
class CurrentProject extends Context.Service<CurrentProject, {
  readonly project: typeof projects.$inferSelect
}>()('app/CurrentProject') {}

const OwnedProject = Layer.effect(CurrentProject, Effect.gen(function* () {
  const auth = yield* authorize()
  const project = yield* bound('project')

  if (project.userId !== auth.user.id) return yield* notFound('Project')

  return CurrentProject.of({ project })
}))

routes.provide(OwnedProject).get(paths.task, action(Effect.gen(function* () {
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
service, so actions and `shareProps` read it without querying again. With
Better Auth's organization plugin, its `member` table is the membership row,
read the same way:

```ts
// src/memberships.ts
import { and, eq } from 'drizzle-orm'
import { Context, Effect, Layer } from 'effect'
import { authorize, bound, dbQuery, forbidden, notFound } from '@popcomputer/web/effect'
import { memberships } from './schema'

type Membership = typeof memberships.$inferSelect

export class CurrentMember extends Context.Service<CurrentMember, Membership>()('app/CurrentMember') {}

export const RequireMember = Layer.effect(CurrentMember, Effect.gen(function* () {
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

An action states the role it needs. The member it changes is a route model
too: `{member:userId}` binds the organization's membership of the user the
path names, so a member of another organization is a 404, and the write is
scoped by the bound row rather than by anything the request sends:

```ts
// src/actions/organizations/change-role.ts
import { and, eq, ne } from 'drizzle-orm'
import { Effect, Schema as S } from 'effect'
import { action, back, bound, dbMutation, flash, forbidden, validateRequest } from '@popcomputer/web/effect'
import { requireRole } from '../../memberships'
import { paths } from '../../paths'
import { memberships } from '../../schema'

const ChangeRole = S.Struct({ role: S.Literals(['admin', 'member']) })

export const changeRole = action(Effect.gen(function* () {
  yield* requireRole('owner', 'admin')
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

`changeRole` reads `CurrentMember`, which only `RequireMember` provides, so
registering it without the guard is a `missingServices` type error, and the
guard reads `bound('organization')`, so its routes need `{organization}` in
their path or prefix. A membership's role is an enum column, `text('role', { enum:
['owner', 'admin', 'member'] })`, so a misspelled role is a type error in
`requireRole` and in the update. A test seeds a membership for the user it
signs in with `signedIn`, and checks a stranger gets 404 and a member 403.
