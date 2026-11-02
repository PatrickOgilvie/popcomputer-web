# Storing uploads

An uploaded file lives in a Cloudflare R2 bucket, under a key the server
makes; the database keeps the key, or the key is made from the record's id.
The bucket is a binding, so an application service built for each request
wraps it, and actions store and read files through the service. A test gives
the service a bucket in memory.

## The bucket, its binding and its service

Declare the bucket in `wrangler.jsonc`. `wrangler dev` and Vite's dev server
keep a local one in `.wrangler/state`; the deployed Worker needs it made once,
`wrangler r2 bucket create uploads`, a remote change for the owner to make:

```jsonc
"r2_buckets": [{ "binding": "UPLOADS", "bucket_name": "uploads" }]
```

Type it beside the other bindings in `src/env.ts`, as the
[Quick start](setup.md)'s `Bindings` does: `UPLOADS: R2Bucket`, the type
`@cloudflare/workers-types` gives. Then a service wraps it:

```ts
// src/uploads.ts
import { Context, Effect, Layer, Option } from 'effect'

/** A stored file, as `file()` serves it back. */
export interface StoredFile {
  readonly body: ReadableStream<Uint8Array>
  readonly contentType: string
}

export class Uploads extends Context.Service<Uploads, {
  readonly put: (key: string, file: File) => Effect.Effect<void>
  readonly get: (key: string) => Effect.Effect<Option.Option<StoredFile>>
}>()('app/Uploads') {}

// R2 failing is another system down: Effect.promise makes it a defect, a 500.
export const uploadsFor = (bucket: R2Bucket) => Layer.succeed(Uploads, Uploads.of({
  put: (key, file) =>
    Effect.asVoid(Effect.promise(() => bucket.put(key, file, { httpMetadata: { contentType: file.type } }))),
  get: (key) =>
    Effect.map(Effect.promise(() => bucket.get(key)), (stored) =>
      Option.map(Option.fromNullOr(stored), (object) => ({
        body: object.body,
        contentType: object.httpMetadata?.contentType ?? 'application/octet-stream',
      }))
    ),
}))
```

A binding holds the request's I/O, so give the service in `web.services`'s
`request`, beside the others, and register the routes on the `routes` it
returns:

```ts
// In src/app.ts, after the Register declaration:
export const { app, routes } = web.services({
  app: ClockLive,
  request: (c) => Layer.merge(auditLogFor(c.env.KV), uploadsFor(c.env.UPLOADS)),
})

// In src/routes.ts:
routes.post(paths.projectCover, uploadCover, { name: 'projects.cover.update' })
routes.get(paths.projectCover, showCover, { name: 'projects.cover' })
```

## Storing a file and serving it back

`upload()` checks the file's type and size; the key is the server's, here
the project's id, never the file's name. The bound project decides who may
store its cover and who may see it, as for any record:

```ts
// src/actions/projects/cover.ts
import { Effect, Option, Schema as S } from 'effect'
import { action, bound, file, flash, notFound, redirect, validateRequest } from '@popcomputer/web/effect'
import { upload } from '@popcomputer/web/schema'
import { paths } from '../../paths'
import { Uploads } from '../../uploads'

const CoverForm = S.Struct({
  cover: upload({ types: ['image/png', 'image/jpeg', 'image/webp'], maxBytes: 5_000_000 }),
})

const coverKey = (projectId: string) => `projects/${projectId}/cover`

export const uploadCover = action(Effect.gen(function* () {
  // Its owner's only: the binding is ownedBy 'userId'.
  const project = yield* bound('project')
  // oxlint-disable-next-line popcomputer-web/explain-security-loosening -- a cover is up to 5 MB, and only the project's owner reaches this read.
  const input = yield* validateRequest(CoverForm, { bodyLimit: 6_000_000 })
  const uploads = yield* Uploads

  yield* uploads.put(coverKey(project.id), input.cover)
  yield* flash('success', 'Cover saved.')

  return yield* redirect(paths.project, { project: project.id })
}))

export const showCover = action(Effect.gen(function* () {
  const project = yield* bound('project')
  const uploads = yield* Uploads
  const cover = yield* uploads.get(coverKey(project.id))

  if (Option.isNone(cover)) return yield* notFound('Cover')

  return yield* file(cover.value.body, { contentType: cover.value.contentType })
}))
```

A page shows it with `<img src={href(paths.projectCover, { project: project.id })} />`.
`file()` streams the object's `body` as it is, and takes the `ArrayBuffer`
its `arrayBuffer()` reads too; [Serving an upload back](responses.md#serving-an-upload-back)
says which types it serves inline. A record with several files, such as a
journal entry's photos, keeps each one's key on a row of its own, made with
`crypto.randomUUID()`, and its type beside it. A body holds 1 MiB unless the
action raises `bodyLimit` past the file's limit, a change the lint rule
`explain-security-loosening` asks a reason for and `AGENTS.md` asks the owner
to sign off.

## Testing with a bucket in memory

A test gives `Uploads` a `Map` in `testEnv`'s layer, which replaces the
service `web.services` gives. One layer shared by several requests keeps what
they stored:

```ts
// src/cover.test.ts
import { describe, expect, test } from 'bun:test'
import { Effect, Layer, Option } from 'effect'
import { signedIn, testEnv } from '@popcomputer/web/testing'
import app from './app'
import './routes'
import { testBindings } from './test-bindings'
import { Uploads } from './uploads'

const memoryUploads = () => {
  const stored = new Map<string, File>()

  return Layer.succeed(Uploads, Uploads.of({
    put: (key, file) => Effect.sync(() => { stored.set(key, file) }),
    get: (key) => Effect.sync(() =>
      Option.map(Option.fromUndefinedOr(stored.get(key)), (file) => ({ body: file.stream(), contentType: file.type }))
    ),
  }))
}

describe('a project cover', () => {
  test('is stored, then served to its owner only', async () => {
    const uploads = memoryUploads()
    const owner = testEnv(Layer.merge(signedIn({ id: 'user-1' }), uploads), testBindings)
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const body = new FormData()
    body.set('cover', new File([png], 'cover.png', { type: 'image/png' }))

    const saved = await app.request('/projects/project-1/cover', { method: 'POST', body }, owner)
    const served = await app.request('/projects/project-1/cover', {}, owner)
    const stranger = await app.request(
      '/projects/project-1/cover',
      {},
      testEnv(Layer.merge(signedIn({ id: 'user-2' }), uploads), testBindings)
    )

    expect(saved.status).toBe(303)
    expect(served.headers.get('Content-Type')).toBe('image/png')
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(png)
    expect(stranger.status).toBe(404)
  })
})
```

To run the real `uploadsFor` against R2's own behaviour, Miniflare's
`getR2Bucket` gives a bucket, as [A database for tests](test-database.md)
says; its type differs slightly from `R2Bucket`, so type the service's
parameter by the methods it calls.
