# Forms

Each form's fields are a schema in a module the action and the page both
import. The action validates with it; the page imports it with `import type`,
so no server code reaches the bundle, and types its form with `FormInput`:

```ts
// src/forms.ts
import { Schema as S } from 'effect'
import { alphaDash, coercedDate, currentPassword, email, nullable, nullableString, requiredString } from '@popcomputer/web/schema'

export const CreateProject = S.Struct({
  name: requiredString,
  slug: alphaDash,
  description: nullableString,
})

export const RenameProject = S.Struct({ name: requiredString })

// The query the project list reads: a search, and where the page starts.
export const ProjectFilters = S.Struct({
  q: nullableString,
  beforeAt: nullable(coercedDate),
  beforeId: nullableString,
})

// A password signs in exactly as it was chosen: currentPassword never trims it.
export const SignIn = S.Struct({ email, password: currentPassword })
```

A form's fields derive from the schema its action validates them with:
`useForm<FormInput<typeof CreateProject>>({ ... })`, `FormInput` from
`@popcomputer/web/react`, so a renamed field is a type error in the form as
well as the action, and `const errors: FormErrors<typeof CreateProject> =
props.errors` types the errors the form reads by the same fields. Keep form
schemas in a module both sides import, `src/forms.ts`, and import them in
React with `import type`, so no server code reaches the browser.
The page below shows a form; [Pages and props](pages.md) shows the error page
and the client's page map.

A page reads its props, the shared props and `errors` from its declaration in
`src/pages.ts`, and its flash values from `usePage()`. A failed post comes
back to the page it was sent from, with the field errors in the form's
`errors`:

```tsx
// src/pages/Projects/Index.tsx
import { Link, useForm, usePage } from '@inertiajs/react'
import type { FormEvent } from 'react'
import { href } from '@popcomputer/web/paths'
import type { FormInput, WebPage } from '@popcomputer/web/react'
import { RenameProjectForm } from '../../components/RenameProjectForm'
import type { CreateProject } from '../../forms'
import { paths } from '../../paths'

const Index: WebPage<'Projects/Index'> = ({ projects, next }) => {
  const { flash } = usePage()
  const form = useForm<FormInput<typeof CreateProject>>({ name: '', slug: '', description: null })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    form.post(paths.projects, { onSuccess: () => form.reset() })
  }

  return (
    <main>
      {flash.success && <p role="status">{flash.success}</p>}

      <ul>
        {projects.map((project) => (
          <li key={project.id}>
            <Link href={href(paths.project, { project: project.id })}>{project.name}</Link>
            <RenameProjectForm project={project} />
          </li>
        ))}
      </ul>
      {next && <Link href={href(paths.projects, {}, next)}>Older projects</Link>}

      <form onSubmit={submit}>
        <label>
          Name
          <input value={form.data.name} onChange={(event) => form.setData('name', event.target.value)} />
        </label>
        {form.errors.name && <p role="alert">{form.errors.name}</p>}

        <label>
          Slug
          <input value={form.data.slug} onChange={(event) => form.setData('slug', event.target.value)} />
        </label>
        {form.errors.slug && <p role="alert">{form.errors.slug}</p>}

        <label>
          Description
          <textarea
            value={form.data.description ?? ''}
            onChange={(event) => form.setData('description', event.target.value === '' ? null : event.target.value)}
          />
        </label>

        <button type="submit" disabled={form.processing}>Create project</button>
      </form>
    </main>
  )
}

export default Index
```

## Flash messages and failed forms

`yield* flash('success', 'Project saved.')` before any of them hands a value to
the next page the user sees, as Inertia's page `flash` field: the page a
redirect renders, or the page the same request renders.

A form submission that fails validation, whether in `validateRequest` or as a
`ValidationError` the action fails with, redirects back (303) to the page it
came from: the path of its same-origin `Referer`. A request without one, as a
test's that posts without visiting the form first, goes to the page its route
names with `form`, its placeholders filled from the route's own,
`routes.post(paths.bookSlot, bookSlot, { form: paths.slots })`; a route whose
path also has a page, such as `POST /slots` beside `GET /slots`, goes back to
that page without naming it; and any other goes to `/`. A
`ValidationError` with `redirectTo` goes to that page instead, such as a
wizard's earlier step. That page renders with all of its own props and the
field errors as `errors`; a form that names an Inertia error bag gets them
under its name.

Errors and flash values travel in a short-lived `HttpOnly` cookie that the
next page to render reads and clears. A request that only redirects, such as
a home page sending visitors to their dashboard, passes them on, so a failed
form whose `Referer` was missing still shows its errors where it lands. The
cookie is readable, not encrypted: never flash a secret, such as a new API key
shown once; render the page with it from the action instead.

A JSON client gets a 422 instead of the redirect. Invalid query parameters on
a page visit render the error page with 422, with the invalid fields as
`errors`; `readErrorPage(res)` from `@popcomputer/web/testing` reads it in a
test.

## Several forms on one page keep their errors apart

A failed form goes back to its page with the field errors in `errors`, keyed
by field. When the page holds several forms with a field of the same name,
such as the project list's create form and the rename form on each row, every
form would show the one that failed. An Inertia error bag keeps them apart:
the form names a bag when it submits, the request carries it as
`X-Inertia-Error-Bag`, and the errors come back under that name, which only
that form reads. The action needs nothing of its own; `validateRequest` and
`invalid` put the errors in the bag the request names:

```ts
// src/actions/projects/rename.ts
import { eq } from 'drizzle-orm'
import { Effect } from 'effect'
import { action, authorize, back, bound, dbMutation, flash, notFound, validateRequest } from '@popcomputer/web/effect'
import { RenameProject } from '../../forms'
import { paths } from '../../paths'
import { projects } from '../../schema'

export const renameProject = action(Effect.gen(function* () {
  const auth = yield* authorize()
  const project = yield* bound('project')

  if (project.userId !== auth.user.id) return yield* notFound('Project')

  const input = yield* validateRequest(RenameProject)

  yield* dbMutation((db) => db.update(projects).set({ name: input.name }).where(eq(projects.id, project.id)))
  yield* flash('success', 'Project renamed.')

  return yield* back(paths.projects)
}))
```

```ts
import { renameProject } from '../actions/projects/rename'

routes.put(paths.projectName, renameProject, { name: 'projects.rename', purges: true })
```

Each row's form names its own bag, so a rename that fails shows its error on
its own row, and the create form, which names none, shows only its own:

```tsx
// src/components/RenameProjectForm.tsx
import { useForm } from '@inertiajs/react'
import type { FormEvent } from 'react'
import { href } from '@popcomputer/web/paths'
import type { FormInput, PagePropsFor } from '@popcomputer/web/react'
import type { RenameProject } from '../forms'
import { paths } from '../paths'

type Project = PagePropsFor<'Projects/Index'>['projects'][number]

export function RenameProjectForm({ project }: { readonly project: Project }) {
  const form = useForm<FormInput<typeof RenameProject>>({ name: project.name })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    form.put(href(paths.projectName, { project: project.id }), { errorBag: `rename-${project.id}` })
  }

  return (
    <form onSubmit={submit}>
      <input
        aria-label={`New name for ${project.name}`}
        value={form.data.name}
        onChange={(event) => form.setData('name', event.target.value)}
      />
      {form.errors.name && <p role="alert">{form.errors.name}</p>}
      <button type="submit" disabled={form.processing}>Rename</button>
    </form>
  )
}
```

The page's `errors` prop holds the bag as well, `errors['rename-project-1']`,
for a component that reads errors without `useForm`; a test reads it there
with `readPage`. Name one bag per form that can fail beside another, such as
approve and reject on each row of an inbox.
