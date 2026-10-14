/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
import { describe, expect, test } from 'bun:test'
import { Clock, Context, DateTime, Effect, Layer, Schedule, Schema as S } from 'effect'
import { TestClock } from 'effect/testing'
import { Hono } from 'hono'
import { setupWeb } from '../src/setup.js'
import { action } from '../src/effect/action.js'
import { authorize, AuthUserService, DatabaseService } from '../src/effect/services.js'
import { flash, json, notFound, redirect, render } from '../src/effect/responses.js'
import { effectRoutes } from '../src/effect/routing.js'
import { applyMigrations, readMigrations, readPage, signedIn, testBrowser, testClock, testEnv } from '../src/testing.js'
import { HttpError } from '../src/effect/errors.js'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { eq } from 'drizzle-orm'
import { drizzle, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { bound } from '../src/effect/binding.js'
import { dbMutation } from '../src/effect/database.js'
import { nullableString, requiredString } from '../src/effect/schema.js'
import { validateRequest } from '../src/effect/validation.js'
import type { WebDeclaration } from '../src/effect/register.js'

// The README Quick start's application types: a SQLite projects table and the
// project route binding.
const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  userId: text('user_id').notNull(),
})
const projectsSchema = { projects }
const Project = S.Struct({ id: S.String, name: S.String, userId: S.String })
const routeBindings = { project: Project }
const UpdateProject = S.Struct({ name: requiredString, description: nullableString })

type ProjectsEnv = { Bindings: { readonly DATABASE_PATH: string } }

declare module '../src/effect/register.js' {
  interface Register {
    web: WebDeclaration<{
      database: BunSQLiteDatabase<typeof projectsSchema>
      routeBindings: typeof routeBindings
    }>
  }
}

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
    .get('/dashboard', action(render('Dashboard')))
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
    expect(res.headers.get('location')).toBe('/login?redirect=%2Fme')
  })

  test('pages share the signed-in user', async () => {
    const page = { headers: { 'X-Inertia': 'true', 'X-Inertia-Version': '1' } }
    const signedInRes = await createApp().request('/dashboard', page, testEnv(signedIn({ id: 'user-1' })))
    const signedOutRes = await createApp().request('/dashboard', page)

    expect(await signedInRes.json()).toMatchObject({ props: { auth: { user: { id: 'user-1' } } } })
    expect(await signedOutRes.json()).toMatchObject({ props: { auth: { user: null } } })
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

  test('takes bindings alone, without a layer', async () => {
    const res = await createApp().request('/region', {}, testEnv({ REGION: 'eu' }))

    expect(await res.json()).toEqual(await (await createApp().request('/region', {}, testEnv(Layer.empty, { REGION: 'eu' }))).json())
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
    const sqlite = new Database(':memory:')
    sqlite.run('CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, user_id TEXT NOT NULL)')
    const db = drizzle(sqlite, { schema: projectsSchema })
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
      schema: projectsSchema,
      bindings: routeBindings,
      errors: { component: 'Error' },
    })

    // README.md "Write actions and register routes".
    effectRoutes(app).get('/projects/{project}', action(Effect.gen(function* () {
      const auth = yield* authorize()
      const project = yield* bound('project')

      if (project.userId !== auth.user.id) return yield* notFound('Project')

      return yield* render('Projects/Show', { project })
    })))

    // AGENTS.md "A complete action".
    effectRoutes(app).put('/projects/{project}', action(Effect.gen(function* () {
      const auth = yield* authorize()
      const project = yield* bound('project')

      if (project.userId !== auth.user.id) return yield* notFound('Project')

      const input = yield* validateRequest(UpdateProject)

      yield* dbMutation((db) =>
        db.update(projects).set(input).where(eq(projects.id, project.id))
      )
      yield* flash('success', 'Project saved.')

      return yield* redirect(`/projects/${project.id}`)
    })))

    return { app, db, testBindings: { DATABASE_PATH: 'test.sqlite' } }
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

  test('a database a test provides serves route model binding', async () => {
    const { app, testBindings } = await createProjectsApp()
    const other = new Database(':memory:')
    other.run('CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, user_id TEXT NOT NULL)')
    const otherDb = drizzle(other, { schema: projectsSchema })
    otherDb.insert(projects).values({ id: 'project-1', name: 'Gemini', userId: 'user-1' }).run()

    const res = await app.request(
      '/projects/project-1',
      { headers: { 'X-Inertia': 'true' } },
      testEnv(Layer.merge(signedIn({ id: 'user-1' }), Layer.succeed(DatabaseService, otherDb)), testBindings)
    )

    expect(await res.json()).toMatchObject({ props: { project: { name: 'Gemini' } } })
  })

  test("a test's database replaces the database factory's for binding and writes", async () => {
    const { app, db, testBindings } = await createProjectsApp()
    const migrations = await mkdtemp(join(tmpdir(), 'popweb-migrations-'))
    await writeFile(join(migrations, '0000_projects.sql'), [
      'CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, user_id TEXT NOT NULL);',
      "INSERT INTO projects (id, name, user_id) VALUES ('project-1', 'Gemini', 'user-1');",
    ].join('\n--> statement-breakpoint\n'))

    const sqlite = new Database(':memory:')
    expect(await readMigrations(migrations)).toHaveLength(2)
    await applyMigrations(migrations, async (statement) => sqlite.run(statement))
    const testDb = drizzle(sqlite, { schema: projectsSchema })
    const env = () => testEnv(signedIn({ id: 'user-1' }), testBindings, { database: testDb })

    const show = await app.request('/projects/project-1', { headers: { 'X-Inertia': 'true' } }, env())
    await app.request('/projects/project-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Gemini II', description: null }),
    }, env())

    expect(await show.json()).toMatchObject({ props: { project: { name: 'Gemini' } } })
    expect(testDb.select({ name: projects.name }).from(projects).all()).toEqual([{ name: 'Gemini II' }])
    expect(db.select({ name: projects.name }).from(projects).all()).toEqual([{ name: 'Apollo' }])
  })

  test("answers 404 for another member's project", async () => {
    const { app, testBindings } = await createProjectsApp()
    const res = await app.request(
      '/projects/project-1',
      {},
      testEnv(signedIn({ id: 'user-2' }), testBindings)
    )

    expect(res.status).toBe(404)
  })

  const update = (body: unknown, userId: string) =>
    createProjectsApp().then(async ({ app, db, testBindings }) => ({
      db,
      res: await app.request(
        '/projects/project-1',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        testEnv(signedIn({ id: userId }), testBindings)
      ),
    }))

  test('the AGENTS.md update action saves and redirects to the project', async () => {
    const { db, res } = await update({ name: 'Renamed', description: null }, 'user-1')

    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/projects/project-1')
    expect(res.headers.getSetCookie().some((cookie) => cookie.startsWith('popweb-flash='))).toBe(true)
    expect(db.select().from(projects).all()).toEqual([
      { id: 'project-1', name: 'Renamed', description: null, userId: 'user-1' },
    ])
  })

  test("the AGENTS.md update action answers 404 for another member's project", async () => {
    const { res } = await update({ name: 'Renamed' }, 'user-2')

    expect(res.status).toBe(404)
  })

  test('the AGENTS.md update action rejects an empty name', async () => {
    const { res } = await update({ name: '  ' }, 'user-1')

    expect(res.status).toBe(422)
  })
})

describe('testClock', () => {
  function clockApp() {
    const app = new Hono()
    const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) })

    routes.get('/now', action(Effect.gen(function* () {
      const now = yield* DateTime.now

      return yield* json({ now: DateTime.formatIso(now), millis: yield* Clock.currentTimeMillis })
    })))

    return app
  }

  test('every request reads the time the test sets', async () => {
    const time = await testClock(new Date('2026-03-01T09:00:00Z'))
    const app = clockApp()
    const env = testEnv(time.layer)

    expect(await (await app.request('/now', {}, env)).json()).toEqual({
      now: '2026-03-01T09:00:00.000Z',
      millis: Date.parse('2026-03-01T09:00:00Z'),
    })

    await time.advance('8 days')
    expect((await (await app.request('/now', {}, env)).json()).now).toBe('2026-03-09T09:00:00.000Z')
    expect(time.now()).toEqual(new Date('2026-03-09T09:00:00Z'))

    await time.set(Date.parse('2027-01-01T00:00:00Z'))
    expect((await (await app.request('/now', {}, env)).json()).now).toBe('2027-01-01T00:00:00.000Z')
  })

  test('combines with a signed-in user', async () => {
    const time = await testClock()
    const app = new Hono()
    const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) })

    routes.get('/me', action(Effect.gen(function* () {
      const auth = yield* authorize()

      return yield* json({ id: auth.user.id, at: yield* Clock.currentTimeMillis })
    })))

    const res = await app.request('/me', {}, testEnv(Layer.merge(signedIn({ id: 'user-1' }), time.layer)))

    expect(await res.json()).toEqual({ id: 'user-1', at: Date.UTC(2026, 0, 1) })
  })
})

describe('testClock settle', () => {
  test('moves the clock until a request that waits on it finishes', async () => {
    const time = await testClock(new Date('2026-01-01T00:00:00Z'))
    const app = new Hono()
    const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) })
    let attempts = 0

    const attemptedAt: number[] = []

    // Fails four times, then succeeds, waiting 1s, 2s, 4s and 8s between attempts.
    const deliver = Effect.gen(function* () {
      attemptedAt.push(yield* Clock.currentTimeMillis)

      return attemptedAt.length < 5 ? yield* Effect.fail('unavailable' as const) : attemptedAt.length
    }).pipe(Effect.retry(Schedule.exponential('1 second')), Effect.orDie)

    routes.post('/deliver', action(Effect.gen(function* () {
      return yield* json({ delivered: yield* deliver })
    })))

    const res = await time.settle(app.request('/deliver', { method: 'POST' }, testEnv(time.layer)))

    expect(await res.json()).toEqual({ delivered: 5 })
    expect(attemptedAt.map((at, i) => i === 0 ? 0 : (at - attemptedAt[i - 1]!) / 1000)).toEqual([0, 1, 2, 4, 8])
  })

  test('rejects when the request does not answer within the turns', async () => {
    const time = await testClock(new Date('2026-01-01T00:00:00Z'))
    const app = new Hono()
    const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) })

    routes.get('/stuck', action(Effect.never.pipe(Effect.flatMap(() => json({ ok: true })))))

    await expect(time.settle(app.request('/stuck', {}, testEnv(time.layer)), 3))
      .rejects.toThrow('did not settle within 3 turns')
  })
})

describe('readPage', () => {
  test('explains an asset version conflict rather than asking for X-Inertia', async () => {
    const app = new Hono()
    const { routes } = setupWeb(app, { version: '2', render: (page) => JSON.stringify(page) })
    routes.get('/dashboard', action(render('Dashboard')))

    const res = await app.request('/dashboard', { headers: { 'X-Inertia': 'true', 'X-Inertia-Version': '1' } })

    expect(res.status).toBe(409)
    await expect(readPage(res, 'Dashboard')).rejects.toThrow("X-Inertia-Version is not the app's version")
  })

  test('says why the response rendered the error page instead', async () => {
    const app = new Hono()
    const { routes } = setupWeb(app, {
      version: '1',
      render: (page) => JSON.stringify(page),
      errors: { component: 'Error' },
    })

    routes.get('/projects/1', action(Effect.fail(new HttpError({ status: 409, message: 'The project is archived.' }))))

    const res = await app.request('/projects/1', { headers: { 'X-Inertia': 'true', 'X-Inertia-Version': '1' } }, testEnv(Layer.empty))

    await expect(readPage(res, 'Projects/Show')).rejects.toThrow(
      "Expected the 'Projects/Show' page, but the response rendered 'Error' (409): The project is archived."
    )
  })
})

describe('testBrowser', () => {
  test('drops a cookie as a browser does, whether its Max-Age is 0 or its Expires has passed', async () => {
    const app = new Hono()
      .get('/set', (c) => c.body(null, 204, { 'Set-Cookie': 'session=abc; Path=/' }))
      .get('/expire', (c) => c.body(null, 204, { 'Set-Cookie': 'session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT' }))
      .get('/zero', (c) => c.body(null, 204, { 'Set-Cookie': 'session=; Path=/; Max-Age=0' }))
      .get('/later', (c) => c.body(null, 204, { 'Set-Cookie': 'session=kept; Path=/; Expires=Fri, 01 Jan 2100 00:00:00 GMT' }))
    const browser = testBrowser(app)

    await browser.request('/set')
    await browser.request('/expire')
    expect(browser.cookies.has('session')).toBe(false)

    await browser.request('/set')
    await browser.request('/zero')
    expect(browser.cookies.has('session')).toBe(false)

    await browser.request('/later')
    expect(browser.cookies.get('session')).toBe('kept')
  })
})

