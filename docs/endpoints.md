# JSON endpoints

A JSON API declares each endpoint once, as a contract: its method, its path
from `src/paths.ts`, the query, body and headers it reads, the body of a
success with its status, and the failures it declares, each with the status
it answers. Everything else derives from the contract, so nothing about an
endpoint is written twice: the action receives its input decoded and returns
the success value, the route takes its method and path from it, a client or a
test calls it with typed input and reads a typed result, and `openApi`
describes every endpoint for a published reference. The module imports only
`effect`, the validators and the paths, so a React bundle or a separate
client imports it without the server.

An application that is only an API leaves `version` and `render` out of
`setupWeb`: without a template it answers only JSON, every failure an unknown
path's included, whatever the client asks for, and rendering a page is a
configuration error.

```ts
// src/endpoints.ts
import { Schema as S } from 'effect'
import { endpoint } from '@popcomputer/web/endpoint'
import { alphaDash, coercedNumber, nullableString, requiredString } from '@popcomputer/web/schema'
import { paths } from './paths'

export const ApiProject = S.Struct({
  id: S.String,
  name: S.String,
  slug: S.String,
  createdAt: S.Date,
})

export class SlugTaken extends S.TaggedError<SlugTaken>()('SlugTaken', {
  slug: S.String,
  message: S.String,
}) {}

export const endpoints = {
  listProjects: endpoint.get(paths.apiProjects, {
    summary: 'List your projects, newest first.',
    auth: true,
    query: S.Struct({ limit: coercedNumber, q: nullableString }),
    success: S.Struct({ data: S.Array(ApiProject) }),
  }),
  createProject: endpoint.post(paths.apiProjects, {
    summary: 'Create a project.',
    auth: true,
    body: S.Struct({ name: requiredString, slug: alphaDash }),
    success: ApiProject,
    status: 201,
    errors: { 409: SlugTaken },
  }),
  showProject: endpoint.get(paths.apiProject, { auth: true, success: ApiProject }),
  deleteProject: endpoint.delete(paths.apiProject, { auth: true }),
}
```

`action(endpoint, handler)` implements one. The handler receives `params`
(the path's placeholders), the signed-in user as `auth` when the contract has
`auth: true`, and the `query`, `body` and `headers` the contract declares,
already decoded. A contract with `auth: true` is answered 401 for a client
that is not signed in, before its input is read, so the requirement is
declared once, where the API's description reads it too. Input that does not
decode is answered `422`, with each invalid field's message in `errors`,
before the handler runs. The handler returns
the success value, which the response encodes through the `success` schema,
so only the fields the schema declares leave the server, whatever the row
holds; an endpoint without `success` answers `204`. A failure the contract
declares is answered with its status in the error envelope, its `tag` the
failure's `_tag` and its fields in `body`. The package's own failures,
`notFound`, `forbidden`, `authorize()`'s 401 and the rest, are answered as
everywhere else, and every response of an endpoint is JSON, failures
included. `bound('project')` loads the model a placeholder in the contract's
path names, as in any action, and `responseHeader` adds a header such as a
created record's `Location`.

```ts
// src/actions/api/projects.ts
import { and, desc, eq, ilike } from 'drizzle-orm'
import { Effect } from 'effect'
import {
  action,
  bound,
  dbMutation,
  dbQuery,
  notFound,
  responseHeader,
} from '@popcomputer/web/effect'
import { href } from '@popcomputer/web/paths'
import { endpoints, SlugTaken } from '../../endpoints'
import { paths } from '../../paths'
import { projects } from '../../schema'

export const listProjects = action(endpoints.listProjects, ({ auth, query }) =>
  Effect.gen(function* () {
    const data = yield* dbQuery((db) =>
      db.select().from(projects)
        .where(and(eq(projects.userId, auth.user.id), query.q === null ? undefined : ilike(projects.name, `%${query.q}%`)))
        .orderBy(desc(projects.createdAt))
        .limit(Math.min(query.limit, 100))
    )

    return { data }
  })
)

export const createProject = action(endpoints.createProject, ({ auth, body }) =>
  Effect.gen(function* () {
    const [project] = yield* dbMutation((db) =>
      db.insert(projects)
        .values({ id: crypto.randomUUID(), name: body.name, slug: body.slug, userId: auth.user.id })
        .returning()
    ).pipe(
      Effect.catchTag('DatabaseConstraintViolation', (violation) =>
        Effect.fail(violation.constraint === 'unique'
          ? new SlugTaken({ slug: body.slug, message: `The slug ${body.slug} is taken.` })
          : violation)
      )
    )

    yield* responseHeader('Location', href(paths.apiProject, { project: project.id }))

    return project
  })
)

export const showProject = action(endpoints.showProject, ({ auth }) =>
  Effect.gen(function* () {
    const project = yield* bound('project')

    if (project.userId !== auth.user.id) return yield* notFound('Project')

    return project
  })
)

export const deleteProject = action(endpoints.deleteProject, ({ auth }) =>
  Effect.gen(function* () {
    const project = yield* bound('project')

    if (project.userId !== auth.user.id) return yield* notFound('Project')

    yield* dbMutation((db) => db.delete(projects).where(eq(projects.id, project.id)))
  })
)
```

`routes.endpoint(action)` registers it on the method and path its contract
declares, with the route options other registrations take. A failure the
contract does not declare is an `unhandledErrors` type error at the
registration, as for any action, so the contract lists every failure a client
can tell apart. Group endpoints with `.provide(...)`, or under a prefix their
declared paths start with, `routes.prefix('/api/orgs/{org}')`.

```ts
// src/api-routes.ts
import { openApi } from '@popcomputer/web/endpoint'
import { action, json } from '@popcomputer/web/effect'
import { routes } from './app'
import { createProject, deleteProject, listProjects, showProject } from './actions/api/projects'
import { endpoints } from './endpoints'
import { paths } from './paths'

routes
  .endpoint(listProjects)
  .endpoint(createProject, { name: 'api.projects.store' })
  .endpoint(showProject)
  .endpoint(deleteProject, { purges: true })

const description = openApi(endpoints, {
  title: 'Projects API',
  version: '1',
  security: { session: { type: 'apiKey', in: 'cookie', name: 'better-auth.session_token' } },
})

routes.get(paths.apiDescription, action(json(description)))
```

`openApi(endpoints, info)` is an OpenAPI 3.1 document: each endpoint named
by its key, with its path and query parameters, headers, body, success and
declared failures; the `422` of an endpoint that reads input, the `401` of
one with `auth: true`, and the `404` of one whose path names a record. Give
`security` the ways a client signs in, as OpenAPI security schemes, and each
endpoint with `auth: true` lists them, so a generated client knows to send
the session cookie or a bearer token. A validator that accepts form posts as
well as JSON, such as `coercedNumber`, is described as the JSON a client
sends, a number, with the limits its checks add, such as a `maxLength`. Serve
it from a route, as above, or write it to a file in a build step.
