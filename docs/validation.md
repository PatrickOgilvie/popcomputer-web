# Validating input

```ts
import { Effect } from 'effect'
import {
  action,
  authorize,
  dbMutation,
  form,
  redirect,
} from '@popcomputer/web/effect'
import { CreateProject } from '../forms'
import { paths } from '../paths'
import { projects } from '../schema'

export const createProject = action(form(CreateProject), (input) =>
  Effect.gen(function* () {
    const auth = yield* authorize()

    const [project] = yield* dbMutation((db) =>
      db.insert(projects)
        .values({ ...input, id: crypto.randomUUID(), userId: auth.user.id })
        .returning()
    )

    return yield* redirect(paths.project, { project: project.id })
  })
)
```

An action declares its input as its first argument, `form(CreateProject)`,
and its handler receives it decoded. The input is read after the route's
layers, so a group's `RequireAuthLayer` or guard decides first, and before
the handler runs: a form that fails goes back to its page with the errors,
and the handler does not run. `form(CreateProject, { page: paths.projects })`
names that page for a request without a Referer, as
[Flash and failed forms](forms.md#flash-messages-and-failed-forms) shows. The
route table records the schema, so `routes.toJson()` lists the fields each
route accepts. The table reads both from the action `action` returns: an
action wrapped again, such as `.pipe(Effect.withSpan(...))`, loses them.

The form reads route params, query and body, and decodes them with every key
the schema does not declare removed. A body sent as JSON
is read as JSON whatever its media type, as `fetch` sends a string as
`text/plain`, and a form post's fields are nested. A key that two
sources provide with different values fails validation, so a body field cannot
replace a route parameter; pass `request: { order: ['body'] }` to read only the
body.

Dates and times have strict validators: `isoDate` accepts a calendar day
written `YYYY-MM-DD` and keeps it as that string, since a day has no time
zone, and `isoDateTime` accepts a moment with its zone,
`2030-05-01T09:00:00Z`, as a `Date`. Each refuses a day the calendar lacks,
and `isoDateTime` a time without a zone, which `coercedDate` would read in the
server's zone; [a form's date and time](#a-forms-date-and-time) shows a
form sending one with its zone. The form validators coerce, since a form
sends every value as a string: `coercedNumber` accepts `"12"`. A JSON
endpoint's contract, whose clients send JSON's own types, declares numbers
with Effect's schemas,
`S.Int.check(S.isGreaterThan(0))`, so a string is refused and the published
description says what the endpoint accepts.

A multipart form's files reach the schema as `File` values. Check them with
`upload({ types: ['image/png', 'image/jpeg'], maxBytes: 5_000_000 })`, or
`nullableUpload(...)` when the file is optional; a file input left empty is
no file. [Storing uploads](uploads.md) keeps one in an R2 bucket, and
[Serving an upload back](responses.md#serving-an-upload-back) says how `file()`
serves it.

A form reads at most 1 MiB of a body, or setupWeb's `bodyLimit`,
counting its declared `Content-Length` and the bytes as they arrive, and
refuses a larger one before parsing it: a JSON client gets a 413
(`WEB_VAL_007_BODY_TOO_LARGE`) and a page's form goes back with a `form`
error. The rest of a refused body is read and dropped before the answer, up
to 100 MiB, so a browser or a proxy still sending it reads the answer
instead of a closed connection; so is a body nothing reads, such as one posted
to a missing page, unless a response `file()` streams may read it. An action
whose form uploads files raises it past their `maxBytes`,
`form(ReceiptForm, { bodyLimit: 6_000_000 })`, as `ReceiptForm`
below needs. Headers and the
raw body, such as an `Idempotency-Key` or a webhook signature, are read from
`RequestService`'s `header()` and `raw()`.

`validateRequest(Schema, options)` reads the same input inside the handler,
for a read whose options or schema depend on what the action did first: a
`redirectTo` built from a record it loaded, or a second schema chosen by the
first answers, as the wizard and survey below show. `form`'s options are
`validateRequest`'s, but `redirectTo`, and `page`.

## A form's date and time

A `datetime-local` input holds a time with no zone, `2026-11-20T19:30`, which
`isoDateTime` refuses. Its zone is the visitor's, which only the browser
knows, so the form sends the moment it names: Inertia's `transform` turns the
input's value into one with its zone as the form posts, and a refusal still
comes back on `startsAt`. An edit form fills the input from the stored
moment, which a page's props hold as an ISO string, the other way:

```tsx
// src/components/ScheduleDinnerForm.tsx
import { useForm } from '@inertiajs/react'
import type { FormEvent } from 'react'
import type { FormInput } from '@popcomputer/web/react'
import type { ScheduleDinner } from '../forms'
import { paths } from '../paths'

// The input's time in the visitor's zone: `2026-11-20T19:30` in Paris is `2026-11-20T18:30:00.000Z`.
const moment = (local: string) => {
  const date = new Date(local)

  // A blank or invalid value goes as it is, for the server to refuse.
  return Number.isNaN(date.getTime()) ? local : date.toISOString()
}

// A stored moment as the input shows it, in the visitor's zone.
export const localInput = (iso: string) => {
  const date = new Date(iso)

  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

export function ScheduleDinnerForm() {
  const form = useForm<FormInput<typeof ScheduleDinner>>({ startsAt: '', seats: '' })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    form.transform((data) => ({ ...data, startsAt: moment(data.startsAt) }))
    form.post(paths.dinners)
  }

  return (
    <form onSubmit={submit}>
      <input type="datetime-local" value={form.data.startsAt} onChange={(event) => form.setData('startsAt', event.target.value)} />
      {form.errors.startsAt && <p role="alert">{form.errors.startsAt}</p>}
      <input type="number" min={1} value={form.data.seats} onChange={(event) => form.setData('seats', event.target.value)} />
      {form.errors.seats && <p role="alert">{form.errors.seats}</p>}
      <button type="submit" disabled={form.processing}>Schedule</button>
    </form>
  )
}
```

When the time belongs to a place rather than to whoever fills in the form,
such as a venue's dinner a host abroad schedules, send the place's zone with
it, and build the moment on the server from the time as the place's clock
reads it, `DateTime.makeZoned(local, { timeZone, adjustForTimeZone: true })`.

## User input in

A filter form sent with GET carries every field, empty or not, so read each
filter with `nullable(...)` or `nullableString`, which read an empty or absent
field as `null`; `S.optional(coercedNumber)` rejects `?minAmount=`. Limits
take the message the form shows, through Effect's checks. An upload names the
types it accepts: a family such as `image/*` leaves out SVG, which a browser
runs script in, and the type is the one the browser declares for the file:

```ts
import { Schema as S } from 'effect'
import { coercedNumber, nullable, nullableString, requiredString, upload } from '@popcomputer/web/schema'

const ClaimFilters = S.Struct({
  stage: nullable(S.Literals(['approver', 'finance'])),
  minAmount: nullable(coercedNumber),
  search: nullableString,
})

const ReceiptForm = S.Struct({
  description: requiredString.check(S.isMaxLength(200, { message: 'Keep it under 200 characters.' })),
  receipt: upload({ types: ['image/png', 'image/jpeg', 'application/pdf'], maxBytes: 5_000_000 }),
})
```

Read a link with `url`, or `nullableUrl` when it is optional. Each accepts
only `http:` and `https:` links and refuses every other scheme with "Use a
link that starts with https:// or http://.": a page shows a stored link in an
`href`, where a `javascript:` or `data:` link runs script on the
application's origin. The scheme is read as a browser reads it, so
`JavaScript:` or spaces before it make no difference. Keep an email address
with `email` and build its `mailto:` link in the page.

Cap an optional link's length on `url`, then make it optional with
`nullable`, which reads an empty field as `null` as `nullableUrl` does. The
cap counts the link once it is trimmed. `nullableUrl.check(...)` is a type
error, since its value may be `null`, which has no length:

```ts
import { Schema as S } from 'effect'
import { nullable, url } from '@popcomputer/web/schema'

const BookForm = S.Struct({
  link: nullable(url.check(S.isMaxLength(2000, { message: 'Keep the link under 2,000 characters.' }))),
})
```

A body field named like one of the route's placeholders, such as `claim` on
`PUT /claims/{claim}`, must carry the same value or the request fails
validation, whether or not the schema reads it; leave such fields out of the
form.

## Other patterns

- **Forms built per record**, such as a quiz's answers: build the schema from
  the record (`S.Struct({ answers: S.Tuple(questions.map(answerSchema)) })`)
  and annotate its type, since a tuple built from a runtime array infers as
  empty; errors arrive keyed by position, as `answers.3`. A schema built from
  the validators also serves as a page's props schema, so a filter form's
  query and the page that shows it share one.
- **Lists in forms**: decode a list with `S.Array(Item)`; a failing item's
  errors are keyed by its path, as `items.2.amount`. A failed validation lists
  at most 100 fields, then says on `form` that more were invalid. A request
  of more than 1000 values stops at its first invalid field and says so on
  `form`, since checking every one would hold an issue per item in memory;
  `parseOptions: { errors: 'all' }` asks for every one. Bound a
  list with `maxItems(Item, 50)`, which refuses a longer one with its own
  message before decoding any item. A JSON body, a form post
  and a multipart post (which Inertia sends for a form with a file) all
  decode the same: form fields named `items[2][amount]` or `items.2.amount`
  nest into the list, and every value of a `tags[]` field, in a form or a
  query string, is a list. A list's largest index may be at most 20 past the
  number of items sent, so renumber rows a form removes: `items[50][amount]`
  sent alone stays a key, and fails to decode as a list. Read them in React from
  the page's `errors` prop, ``errors[`items.${index}.amount`]``, which takes any
  path; Inertia's `useForm().errors` is keyed by the form's top-level fields
  only, so reading a nested path from it needs a cast. A wizard whose final
  submit carries every step's fields validates each step's part with
  `validateRequest(Step, { redirectTo: href(paths.applyStep, { step }) })`, so
  a failure goes back to that step with its errors.
- **Forms whose fields depend on earlier answers**, such as a survey's
  conditional questions: validate in two passes, `validateRequest(Envelope)`
  for what decides the rest, then `validateRequest(schemaFor(envelope))`; the
  body is read once and kept. Give an optional nested group `nullable(Group)`,
  which reads a group whose every field is blank as `null`, or
  `S.optionalKey(Group)`, not a decoding default: in effect 4.0.3 a struct
  with a decoding default reports its first missing field and drops its
  siblings' errors.
