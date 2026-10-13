/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
/**
 * Upload Tests
 *
 * A multipart form's files reach the action through validateRequest and the
 * upload validators; a failed upload goes back to the form like any field.
 */

import { describe, expect, test } from 'bun:test'
import { Effect, Schema as S } from 'effect'
import { Hono } from 'hono'
import { setupWeb } from '../src/setup.js'
import { action } from '../src/effect/action.js'
import { json } from '../src/effect/responses.js'
import { requiredString, upload } from '../src/effect/schema.js'
import { validateRequest } from '../src/effect/validation.js'

const PostForm = S.Struct({ title: requiredString, cover: upload({ types: ['image/*'], maxBytes: 1024 }) })

function createApp() {
  const app = new Hono()
  const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) })

  routes.post('/posts', action(Effect.gen(function* () {
    const input = yield* validateRequest(PostForm)

    return yield* json({ title: input.title, cover: input.cover.name, bytes: input.cover.size })
  })))

  return app
}

const form = (cover: File) => {
  const body = new FormData()
  body.set('title', 'Launch')
  body.set('cover', cover)

  return body
}

describe('uploads', () => {
  test('a multipart file reaches the action', async () => {
    const res = await createApp().request('/posts', {
      method: 'POST',
      body: form(new File([new Uint8Array(10)], 'cover.png', { type: 'image/png' })),
    })

    expect(await res.json()).toEqual({ title: 'Launch', cover: 'cover.png', bytes: 10 })
  })

  test('a file input left empty goes back to the form with the error on its field', async () => {
    const res = await createApp().request('/posts', {
      method: 'POST',
      headers: { Referer: 'http://localhost/posts/new' },
      body: form(new File([], '')),
    })

    expect(res.status).toBe(303)
    expect(res.headers.get('Location')).toBe('/posts/new')
  })
})
