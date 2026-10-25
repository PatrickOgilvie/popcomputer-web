# Pages and props

## Describe the pages

Each page component's props are an Effect Schema:

```ts
// src/pages.ts
import { Schema as S, Struct } from 'effect'
import { tableSchema } from '@popcomputer/web/schema'
import * as schema from './schema'

// Each page names the columns it shows; the table declares their types.
export const Project = tableSchema(schema.projects).mapFields(
  Struct.pick(['id', 'name', 'userId', 'createdAt'])
)

export const ProjectSummary = tableSchema(schema.projects).mapFields(Struct.pick(['id', 'name']))

export const Task = tableSchema(schema.tasks)

// A page that shows computed values beside columns adds them as fields.
export const ProjectCard = tableSchema(schema.projects).mapFields((fields) => ({
  ...Struct.pick(fields, ['id', 'name']),
  openTasks: S.Number,
}))

// The row a list page ends with, from which the next page continues.
export const ProjectCursor = S.Struct({ beforeAt: S.Date, beforeId: S.String })

export const pages = {
  'Projects/Index': S.Struct({ projects: S.Array(ProjectSummary), next: S.NullOr(ProjectCursor) }),
  'Projects/Show': S.Struct({ project: Project }),
  'Auth/Login': S.Struct({}),
  Dashboard: S.Struct({}),
}
```

`render('Projects/Show', props)` accepts only a registered page and props
matching its schema, and encodes the props as JSON through it, so `createdAt`
reaches the browser as an ISO string. A page answers 200, or the status its
third argument gives: `render('Projects/Missing', {}, { status: 404 })`. An
application without `pages` passes props of any declared shape, interfaces
included, whose values JSON carries.

Inertia keeps each page's props in the tab's history, and Back shows them
again without asking the server. A page rendered to a signed-in request is
encrypted there, and every page rendered to a visitor who is not signed in
clears the history, as does the first page after a session ends or another
starts, so the next person at the browser cannot page back through the
previous user's pages ([Signing in and out](sign-in.md)). Clearing also
empties Inertia's prefetch cache. `setupWeb`'s
`history: { encrypt: true }` encrypts every page and `false` none;
`render('Account/Codes', props, { encryptHistory: true, clearHistory: true })`
decides for one page. Inertia encrypts only over HTTPS or on localhost, and
elsewhere warns and keeps the page as it is.

The React component takes its props from the same schema:

```tsx
// src/pages/Projects/Show.tsx
import type { WebPage } from '@popcomputer/web/react'

const Show: WebPage<'Projects/Show'> = ({ project, auth, errors }) => (
  <main>
    <h1>{project.name}</h1>
    <p>Created {new Date(project.createdAt).toLocaleDateString()}</p>
    {auth.user && <p>Signed in as {auth.user.name}</p>}
    {errors.name && <p role="alert">{errors.name}</p>}
  </main>
)

export default Show
```

The client resolves each page by name. A map of every page to its component,
typed `{ readonly [Name in PageName]: WebPage<Name> }` (`PageName` from
`@popcomputer/web/effect`), makes a page without a component a type error. The
resolver checks a name with a guard, `(name): name is PageName => name in
components`, and falls back to the error page, which is not a registered page:
`createInertiaApp({ resolve: (name) => (isPage(name) ? components[name] :
ErrorPage) })`. A page component typed `WebPage<'Name'>` is a React function
component; type the error page `WebErrorPage` from `@popcomputer/web/react`.

A component a page renders takes its props from the same declaration:
`PagePropsFor<'Projects/Show'>['project']` from `@popcomputer/web/react` is the
`project` prop as the browser receives it.

A renamed prop, a missing page or a `Date` used as a `Date` in the browser is a
type error on the side that drifted.

A row joined from several tables spreads `columnsOf` for each table, which
takes the fields that table has: `{ ...columnsOf(stockLevels, StockLine),
...columnsOf(products, StockLine) }`. A field both tables have, such as `id`,
comes from the later one, so leave it out of the other table's:
`columnsOf(products, MovementRow.mapFields(Struct.omit(['id'])))`.

A query reads exactly the columns a page shows with `columnsOf`, which takes
them from the page's schema, beside any values it computes:

```ts
import { count, eq } from 'drizzle-orm'
import { columnsOf } from '@popcomputer/web/schema'
import { ProjectCard } from '../pages'
import { tasks } from '../schema'

const projectCards = dbQuery((db) =>
  db.select({ ...columnsOf(projects, ProjectCard), openTasks: count(tasks.id) })
    .from(projects)
    .leftJoin(tasks, eq(tasks.projectId, projects.id))
    .groupBy(projects.id)
)
```

## Props every page shows

Props every page shows, such as a header's unread count, are declared in
`setupWeb`'s `shared` and computed by `shareProps`, provided on the routes
whose pages show them. It runs when a page renders, never for a redirect or a
JSON response, and returns any of the declared props; an action can also set
one with `share(key, value)`. When it fails, such as when the database is
unavailable, the failure is reported to `EffectErrorObserverService` and the
page renders without those props, which pages treat as optional.

```ts
const sharedRoutes = routes.provide(shareProps(Effect.gen(function* () {
  const viewer = yield* currentUser

  return viewer ? { unreadCount: yield* Effect.succeed(3) } : {}
})))
```

Shared props, such as the unread count `shareProps` computes, arrive on every
page beside its own props. A route that does not provide them leaves them
out, so a page reads them as optional:

```tsx
// src/pages/Dashboard.tsx
import type { WebPage } from '@popcomputer/web/react'

const Dashboard: WebPage<'Dashboard'> = ({ auth, unreadCount }) => (
  <main>
    <h1>{auth.user ? `Welcome back, ${auth.user.name}` : 'Welcome'}</h1>
    {unreadCount !== undefined && <p>{unreadCount} unread</p>}
  </main>
)

export default Dashboard
```

## The error page

The error page is setupWeb's `errors.component`. The boundary renders it for
every failure a page visit ends with, a 404, a 403 or a 500, with the
failure's status, title and message; in development it adds a hint:

```tsx
// src/pages/Error.tsx
import type { WebErrorPage } from '@popcomputer/web/react'
import { paths } from '../paths'

const ErrorPage: WebErrorPage = ({ status, title, message, hint, auth }) => (
  <main>
    <h1>{status}: {title}</h1>
    <p>{message}</p>
    {hint && <pre>{hint}</pre>}
    <a href={auth.user ? paths.dashboard : paths.login}>{auth.user ? 'Back to your dashboard' : 'Sign in'}</a>
  </main>
)

export default ErrorPage
```

The error page is rendered by the boundary, after the action, so it receives
`auth.user` and flash values but not the props `shareProps` computes; give
its layout defaults for them. A value a guard layer `share()`s before the
action does reach it, so a banner every page must show, such as "viewing as
Ada", is shared there.

## The page map

The client maps every registered page to its component. The map's type makes
a page without a component a type error, and the error page, which is not a
registered page, answers any other name:

```tsx
// src/main.tsx
import { createInertiaApp } from '@inertiajs/react'
import type { PageName } from '@popcomputer/web/effect'
import type { WebPage } from '@popcomputer/web/react'
import Login from './pages/Auth/Login'
import Dashboard from './pages/Dashboard'
import ErrorPage from './pages/Error'
import ProjectsIndex from './pages/Projects/Index'
import ProjectsShow from './pages/Projects/Show'

const components: { readonly [Name in PageName]: WebPage<Name> } = {
  'Projects/Index': ProjectsIndex,
  'Projects/Show': ProjectsShow,
  'Auth/Login': Login,
  Dashboard,
}

const isPage = (name: string): name is PageName => name in components

void createInertiaApp({
  resolve: (name) => (isPage(name) ? components[name] : ErrorPage),
})
```

`createTemplate`'s `scripts` loads this module, built by Vite or another
bundler; `createVersion(manifest)` changes with every build, so a visitor on
an old build reloads into the new one.

## Other patterns

- **Counts in the header**, such as unread messages: declare them in
  `shared` and compute them with `shareProps`, which runs only when a page
  renders.
