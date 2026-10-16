# Actions and routes

Each route's path is declared once, and every URL to it is built from that
declaration: the route registration, a server redirect and a client link. The
module holds only data, so server and React code both import it, and
`setupWeb`'s `paths` takes it, so `routes` registers only on declared paths,
and a path literal given to `redirect`, `back`, `href` or `intendedUrl` must
be one of them or an absolute URL: a misspelled path is a type error. A URL
computed at runtime, such as one `href` built, is a string and passes.

```ts
// src/paths.ts
export const paths = {
  login: '/login',
  logout: '/logout',
  authApi: '/api/auth/*',
  authCallback: '/api/auth/callback/{provider}',
  loginWithAcme: '/login/acme',
  dashboard: '/dashboard',
  billing: '/billing',
  pricing: '/pricing',
  explore: '/explore',
  projects: '/projects',
  project: '/projects/{project}',
  projectName: '/projects/{project}/name',
  projectBySlug: '/p/{project:slug}',
  organizationMembers: '/orgs/{organization:slug}/members',
  organizationMember: '/orgs/{organization:slug}/members/{member:userId}',
  task: '/projects/{project}/tasks/{task}',
  apiProjects: '/api/projects',
  apiProject: '/api/projects/{project}',
  apiDescription: '/api/openapi.json',
} as const
```

```ts
// src/actions/projects/show.ts
import { Effect } from 'effect'
import {
  action,
  authorize,
  bound,
  notFound,
  render,
} from '@popcomputer/web/effect'

export const showProject = action(
  Effect.gen(function* () {
    const auth = yield* authorize()
    const project = yield* bound('project')

    // Another member's project answers 404, so its existence stays private.
    if (project.userId !== auth.user.id) return yield* notFound('Project')

    return yield* render('Projects/Show', { project })
  })
)
```

```ts
// src/routes.ts
import { routes } from './app'
import { paths } from './paths'
import { showProject } from './actions/projects/show'

routes.get(paths.project, showProject, { name: 'projects.show' })
```

`redirect(paths.project, { project: project.id })` and, in React,
`href(paths.project, { project: project.id })` from `@popcomputer/web/paths` fill
the path's placeholders; the parameters are typed from them, so a renamed
placeholder is a type error at every URL built from it.

`routes` accepts an action only when the setup provides every service the
action uses and the action fails only with the package's errors. Otherwise the
registration is a type error that names the problem, for example
`missingServices: "@popcomputer/web/Database"` when no `database` is
configured, `unhandledErrors: "PaymentDeclined"` for a domain error the
action has not handled, or `missingRouteModels: "project"` for an action that
calls `bound('project')` on a path without `{project}`. `routes.provide(layer)`
adds services for the routes registered through it.

Routes that share a path prefix and a guard are grouped with
`routes.prefix(...)`. The prefix's placeholders bind models for every route
under it, so a guard layer provided on the group reads them with `bound()`,
and each route under it is registered with its whole declared path. A path
under a prefix that is not declared, or does not start with it, is a type
error. [Roles belong to memberships](guards.md#roles-belong-to-memberships-read-by-a-guard)
groups an organization's routes this way.

`action` does not hide another execution model. It preserves the Effect's
success, error, and requirement channels, while documenting that the program is
an HTTP action.

## Responses and failures

Choose the helper that matches the current action branch. These are alternative
endings, not statements to run in sequence:

| Intent | Action ending |
|---|---|
| Render a page | `return yield* render('Dashboard', { stats })` |
| Redirect | `return yield* redirect(paths.project, { project: project.id })` |
| Redirect to the page the request came from | `return yield* back(paths.project, { project: project.id })`, falling back to that path |
| Redirect from a helper or guard layer, ending the action | `yield* redirectNow(paths.dashboard)` |
| Return JSON declared by a schema, encoded as page props are | `return yield* json(ProjectList, { projects })` |
| Return JSON no client decodes, such as a webhook's acknowledgement | `return yield* json({ received: true })` |
| Return JSON when requested, otherwise render a page | `return yield* jsonOrRender('Projects/Index', { projects })` |
| Fail with `NotFoundError` | `return yield* notFound('Project', projectId)` |
| Fail with `ForbiddenError` | `return yield* forbidden('You cannot edit this project')` |
| Send a form back with field errors | `return yield* invalid({ name: 'That name is taken.' })` |
| Render a page that reports a failure, with its status | `return yield* render('Signing/LinkInvalid', {}, { status: 404 })` |
| Answer 500 for a failure the action cannot answer | `yield* crm.export(project.id).pipe(Effect.orDie)` |

Flash messages and a failed form's errors are in [Forms](forms.md#flash-messages-and-failed-forms);
cookies, files and headers in [Cookies, files and headers](responses.md);
JSON responses and the failures a client reads in [JSON clients](json.md).

## Failures an action cannot answer

Some failures have no answer the action can give: another system is down, a
storage write failed. They are defects. Pipe the call that fails through
`Effect.orDie`, and the request answers 500, with a generic message in
production and the failure's tag on the development error page, and the error
observer receives the failure itself, as `kind: 'defect'`:

```ts
class CrmUnavailable extends S.TaggedError<CrmUnavailable>()('CrmUnavailable', {}) {}

/** Another system the application hands its projects to. */
declare const crm: { readonly export: (projectId: string) => Effect.Effect<void, CrmUnavailable> }

const exportProject = action(Effect.gen(function* () {
  yield* authorize()
  const project = yield* bound('project')

  yield* crm.export(project.id).pipe(Effect.orDie)

  return yield* redirect(paths.project, { project: project.id })
}))
```

Never pipe `authorize()`, `bound()`, `validateRequest` or a database call
through `Effect.orDie`: their failures are answers, a redirect to sign in, a
404 or the form's errors, and the `no-catch-all-in-action` lint rule reports
it.

## Reporting failures

Typed failures, defects, Hono exceptions, and not-found responses share the
configured error boundary. Use `EffectErrorObserverService` as the integration
point for Sentry, PostHog, or another reporting system; observation does not
change the failure channel.
