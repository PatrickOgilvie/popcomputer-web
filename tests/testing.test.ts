/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
import { describe, expect, test } from 'bun:test'
import { Context, Effect, Layer } from 'effect'
import { TestClock } from 'effect/testing'
import { Hono } from 'hono'
import { setupWeb } from '../src/setup.js'
import { action } from '../src/effect/action.js'
import { authorize, AuthUserService } from '../src/effect/services.js'
import { json } from '../src/effect/responses.js'
import { effectRoutes } from '../src/effect/routing.js'
import { signedIn, testEnv } from '../src/testing.js'

class Greeter extends Context.Service<Greeter, { readonly greet: (name: string) => string }>()(
  'tests/Greeter'
) {}

type Env = { Bindings: { readonly REGION: string } }

const createApp = () => {
  const app = new Hono<Env>()
  setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) })

  // Greeter comes from the request runtime (here, testEnv), not from a route layer.
  effectRoutes<Env, Greeter>(app)
    .get('/me', action(Effect.gen(function* () {
      const auth = yield* authorize()

      return yield* json({ id: auth.user.id, email: auth.user.email })
    })))
    .get('/greeting', action(Effect.gen(function* () {
      const greeter = yield* Greeter

      return yield* json({ message: greeter.greet('Ada') })
    })))

  app.get('/region', (c) => c.json({ region: c.env.REGION }))

  return app
}

describe('testEnv', () => {
  test('signedIn layers sign the request in through the real route', async () => {
    const res = await createApp().request('/me', {}, testEnv(signedIn({ id: 'user-1' })))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: 'user-1', email: 'test@example.com' })
  })

  test('requests without a signed-in layer stay signed out', async () => {
    const res = await createApp().request('/me')

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login')
  })

  test('supplies application services', async () => {
    const greeter = Layer.succeed(Greeter, Greeter.of({ greet: (name) => `Hello, ${name}` }))
    const res = await createApp().request('/greeting', {}, testEnv(greeter))

    expect(await res.json()).toEqual({ message: 'Hello, Ada' })
  })

  test('keeps the bindings it is given', async () => {
    const res = await createApp().request('/region', {}, testEnv(Layer.empty, { REGION: 'eu' }))

    expect(await res.json()).toEqual({ region: 'eu' })
  })

  test('ignores a layer under a string key, which deploy configuration could set', async () => {
    const env = { REGION: 'eu', __testLayer: signedIn({ id: 'user-1' }) }
    const res = await createApp().request('/me', {}, env)

    expect(res.status).toBe(302)
  })
})

describe('signedIn', () => {
  test('sessions expire an hour after the provided Effect clock', async () => {
    await Effect.runPromise(Effect.gen(function* () {
      yield* TestClock.adjust('10 seconds')

      const auth = yield* AuthUserService.pipe(Effect.provide(signedIn({ id: 'clock-user' })))

      expect(auth.user.id).toBe('clock-user')
      expect(auth.session.userId).toBe('clock-user')
      expect(auth.session.expiresAt.getTime()).toBe(3_610_000)
    }).pipe(Effect.provide(TestClock.layer())))
  })

  test('keeps the user fields it is given', async () => {
    const auth = await Effect.runPromise(AuthUserService.pipe(
      Effect.provide(signedIn({ id: 'user-2', email: 'ada@example.com', name: 'Ada' }))
    ))

    expect(auth.user).toMatchObject({ id: 'user-2', email: 'ada@example.com', name: 'Ada' })
  })
})

describe('the README route test', () => {
  // Mirrors README.md "Testing": the Quick start app, its project route with
  // route model binding, and a migrated SQLite database owned by the test.
  const createProjectsApp = async () => {
    const { Database } = await import('bun:sqlite')
    const { drizzle } = await import('drizzle-orm/bun-sqlite')
    const { sqliteTable, text } = await import('drizzle-orm/sqlite-core')
    const { Schema: S } = await import('effect')
    const { bound } = await import('../src/effect/binding.js')
    const { render } = await import('../src/effect/responses.js')

    const projects = sqliteTable('projects', {
      id: text('id').primaryKey(),
      name: text('name').notNull(),
      userId: text('user_id').notNull(),
    })
    const schema = { projects }
    const Project = S.Struct({ id: S.String, name: S.String, userId: S.String })

    type ProjectsEnv = { Bindings: { readonly DATABASE_PATH: string } }
    const sqlite = new Database(':memory:')
    sqlite.run('CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, user_id TEXT NOT NULL)')
    const db = drizzle(sqlite, { schema })
    db.insert(projects).values({ id: 'project-1', name: 'Apollo', userId: 'user-1' }).run()

    const openDatabase = (path: string) => {
      if (path !== 'test.sqlite') throw new Error(`No test database at ${path}`)

      return db
    }

    const app = new Hono<ProjectsEnv>()
    setupWeb(app, {
      version: '1',
      render: (page) => JSON.stringify(page),
      database: (c) => openDatabase(c.env.DATABASE_PATH),
      schema,
      bindings: { project: Project },
      errors: { component: 'Error' },
    })

    effectRoutes(app).get('/projects/{project}', action(Effect.gen(function* () {
      const project = yield* bound('project')
      // This test does not augment WebRouteBindingsType, so `project` is untyped here.
      yield* authorize((auth) => auth.user.id === Reflect.get(project, 'userId'))

      return yield* render('Projects/Show', { project })
    })))

    return { app, testBindings: { DATABASE_PATH: 'test.sqlite' } }
  }

  test('shows a project to its owner', async () => {
    const { app, testBindings } = await createProjectsApp()
    const res = await app.request(
      '/projects/project-1',
      { headers: { 'X-Inertia': 'true' } },
      testEnv(signedIn({ id: 'user-1' }), testBindings)
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      component: 'Projects/Show',
      props: { project: { id: 'project-1' } },
    })
  })

  test('forbids other users', async () => {
    const { app, testBindings } = await createProjectsApp()
    const res = await app.request(
      '/projects/project-1',
      {},
      testEnv(signedIn({ id: 'user-2' }), testBindings)
    )

    expect(res.status).toBe(403)
  })
})
