/**
 * A route's records load in one round trip to D1, however deeply its path
 * nests them: each record's statement carries its parents' conditions, so
 * none waits for another's answer, and the statements go in one batch.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import type { D1Database } from '@cloudflare/workers-types'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/d1'
import { drizzle as pgDrizzle } from 'drizzle-orm/pglite'
import { integer as pgInteger, pgTable, text as pgText, type AnyPgColumn } from 'drizzle-orm/pg-core'
import { integer, sqliteTable, text, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import { Effect, Schema as S } from 'effect'
import { Hono } from 'hono'
import { join } from 'node:path'
import { setupWeb } from '../../src/setup.js'
import { routeBinding, bound } from '../../src/effect/binding.js'
import type { WebDeclaration } from '../../src/effect/register.js'
import { json } from '../../src/effect/responses.js'
import { testD1 } from '../../src/testing.js'

const orgs = sqliteTable('orgs', {
  id: integer('id').primaryKey(),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
})
const projects = sqliteTable('projects', {
  id: integer('id').primaryKey(),
  orgId: integer('org_id').notNull().references(() => orgs.id),
  name: text('name').notNull(),
  visibility: text('visibility').notNull(),
})
const tasks = sqliteTable('tasks', {
  id: integer('id').primaryKey(),
  projectId: integer('project_id').notNull().references(() => projects.id),
  title: text('title').notNull(),
  state: text('state').notNull(),
})
const folders = sqliteTable('folders', {
  id: integer('id').primaryKey(),
  parentId: integer('parent_id').references((): AnySQLiteColumn => folders.id),
  name: text('name').notNull(),
})
const schema = { orgs, projects, tasks, folders }

const bindings = {
  organization: routeBinding(orgs, { public: true }),
  project: routeBinding(projects, { publicWhen: { visibility: 'public' } }),
  task: routeBinding(tasks, { publicWhen: { state: 'open' } }),
  folder: routeBinding(folders, { public: true }),
  subfolder: routeBinding(folders, { public: true, scope: { folder: { foreignKey: 'parentId' } } }),
}

declare module '../../src/effect/register.js' {
  interface Register {
    web: WebDeclaration<{ bindings: { DB: D1Database }; routeBindings: typeof bindings }>
  }
}

const databases = testD1({ migrations: join(import.meta.dir, '..', 'fixtures', 'd1-binding-migrations') })

afterAll(() => databases.dispose())

/** A D1 database that counts its round trips: each statement run alone, and each batch. */
function countingD1(database: D1Database) {
  const unwrapped = new WeakMap<object, object>()
  let trips = 0

  const statement = (prepared: object): object => {
    const counted = new Proxy(prepared, {
      get(target, key) {
        const value: unknown = Reflect.get(target, key)

        if (typeof value !== 'function') return value
        if (key === 'bind') return (...values: unknown[]) => statement(Reflect.apply(value, target, values))
        if (key === 'all' || key === 'raw' || key === 'first' || key === 'run') {
          return (...args: unknown[]) => {
            trips += 1

            return Reflect.apply(value, target, args)
          }
        }

        return value.bind(target)
      },
    })

    unwrapped.set(counted, prepared)

    return counted
  }

  const counted = new Proxy(database, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key)

      if (typeof value !== 'function') return value
      if (key === 'prepare') return (query: string) => statement(Reflect.apply(value, target, [query]))
      if (key === 'batch') {
        return (statements: ReadonlyArray<object>) => {
          trips += 1

          return Reflect.apply(value, target, [statements.map((each) => unwrapped.get(each) ?? each)])
        }
      }

      return value.bind(target)
    },
  })

  return { database: counted, trips: () => trips }
}

const Names = S.Array(S.String)

const showProject = Effect.gen(function* () {
  const project = yield* bound('project')

  return yield* json(Names, [project.name])
})

const showTask = Effect.gen(function* () {
  const organization = yield* bound('organization')
  const project = yield* bound('project')
  const task = yield* bound('task')

  return yield* json(Names, [organization.name, project.name, task.title])
})

const showSubfolder = Effect.gen(function* () {
  const folder = yield* bound('folder')
  const subfolder = yield* bound('subfolder')

  return yield* json(Names, [folder.name, subfolder.name])
})

/** Two organizations, a private project, a closed task, and two folders each holding one. */
const rows = [
  "INSERT INTO orgs (id, slug, name) VALUES (1, 'acme', 'Acme'), (2, 'globex', 'Globex')",
  "INSERT INTO projects (id, org_id, name, visibility) VALUES (1, 1, 'Rockets', 'public'), (2, 2, 'Lasers', 'public'), (3, 1, 'Secret', 'private')",
  "INSERT INTO tasks (id, project_id, title, state) VALUES (1, 1, 'Fuel', 'open'), (2, 2, 'Focus', 'open'), (3, 1, 'Paint', 'closed')",
  "INSERT INTO folders (id, parent_id, name) VALUES (1, NULL, 'Home'), (2, 1, 'Photos'), (3, NULL, 'Work'), (4, 3, 'Notes')",
]

async function createApp() {
  // SAFETY: testD1 hands Miniflare's D1, which is Cloudflare's D1Database.
  const d1 = (await databases.fresh()) as unknown as D1Database

  await d1.batch(rows.map((sql) => d1.prepare(sql)))

  const counting = countingD1(d1)
  const app = new Hono<{ Bindings: { DB: D1Database } }>()
  const { routes } = setupWeb(app, {
    version: '1',
    render: (page) => JSON.stringify(page),
    schema,
    database: (c) => drizzle(c.env.DB, { schema }),
    bindings,
  })

  routes
    .get('/orgs/{organization:slug}/projects/{project}', showProject)
    .get('/orgs/{organization:slug}/projects/{project}/tasks/{task}', showTask)
    .get('/folders/{folder}/folders/{subfolder}', showSubfolder)

  const get = async (path: string) => {
    const before = counting.trips()
    const res = await app.request(path, { headers: { Accept: 'application/json' } }, { DB: counting.database })

    return { status: res.status, body: res.status === 200 ? await res.json() : undefined, trips: counting.trips() - before }
  }

  return { get }
}

describe('a route that nests its records', () => {
  test('loads two of them in one round trip', async () => {
    const { get } = await createApp()

    expect(await get('/orgs/acme/projects/1')).toEqual({ status: 200, body: ['Rockets'], trips: 1 })
  })

  test('loads three of them in one round trip', async () => {
    const { get } = await createApp()

    expect(await get('/orgs/acme/projects/1/tasks/1')).toEqual({ status: 200, body: ['Acme', 'Rockets', 'Fuel'], trips: 1 })
  })

  test('still answers 404 for a record under another parent, or one its access rule keeps private', async () => {
    const { get } = await createApp()

    // Lasers is Globex's, task 2 is Lasers', project 3 is private, task 3 is closed.
    for (const path of [
      '/orgs/acme/projects/2',
      '/orgs/acme/projects/3',
      '/orgs/nobody/projects/1',
      '/orgs/acme/projects/1/tasks/2',
      '/orgs/globex/projects/1/tasks/1',
      '/orgs/acme/projects/1/tasks/3',
    ]) {
      expect(`${path} ${(await get(path)).status}`).toBe(`${path} 404`)
    }
  })

  test('scopes a record to a parent in its own table', async () => {
    const { get } = await createApp()

    expect(await get('/folders/1/folders/2')).toEqual({ status: 200, body: ['Home', 'Photos'], trips: 1 })
    expect((await get('/folders/1/folders/4')).status).toBe(404)
    expect((await get('/folders/3/folders/2')).status).toBe(404)
    expect((await get('/folders/2/folders/1')).status).toBe(404)
  })
})

describe('on Postgres, which has no batch', () => {
  const pgOrgs = pgTable('orgs', { id: pgInteger('id').primaryKey(), slug: pgText('slug').notNull(), name: pgText('name').notNull() })
  const pgProjects = pgTable('projects', {
    id: pgInteger('id').primaryKey(),
    orgId: pgInteger('org_id').notNull().references(() => pgOrgs.id),
    name: pgText('name').notNull(),
    visibility: pgText('visibility').notNull(),
  })
  const pgTasks = pgTable('tasks', {
    id: pgInteger('id').primaryKey(),
    projectId: pgInteger('project_id').notNull().references(() => pgProjects.id),
    title: pgText('title').notNull(),
    state: pgText('state').notNull(),
  })
  const pgFolders = pgTable('folders', {
    id: pgInteger('id').primaryKey(),
    parentId: pgInteger('parent_id').references((): AnyPgColumn => pgFolders.id),
    name: pgText('name').notNull(),
  })
  const pgSchema = { orgs: pgOrgs, projects: pgProjects, tasks: pgTasks, folders: pgFolders }

  async function createPostgresApp() {
    const client = new PGlite()

    await client.exec(`
      CREATE TABLE orgs (id integer PRIMARY KEY, slug text NOT NULL, name text NOT NULL);
      CREATE TABLE projects (id integer PRIMARY KEY, org_id integer NOT NULL REFERENCES orgs(id), name text NOT NULL, visibility text NOT NULL);
      CREATE TABLE tasks (id integer PRIMARY KEY, project_id integer NOT NULL REFERENCES projects(id), title text NOT NULL, state text NOT NULL);
      CREATE TABLE folders (id integer PRIMARY KEY, parent_id integer REFERENCES folders(id), name text NOT NULL);
      ${rows.join(';\n')};
    `)

    const db = pgDrizzle(client, { schema: pgSchema })
    const app = new Hono()
    const { routes } = setupWeb(app, {
      version: '1',
      render: (page) => JSON.stringify(page),
      schema: pgSchema,
      database: () => db,
      bindings: {
        organization: routeBinding(pgOrgs, { public: true }),
        project: routeBinding(pgProjects, { publicWhen: { visibility: 'public' } }),
        task: routeBinding(pgTasks, { publicWhen: { state: 'open' } }),
        folder: routeBinding(pgFolders, { public: true }),
        subfolder: routeBinding(pgFolders, { public: true, scope: { folder: { foreignKey: 'parentId' } } }),
      },
    })

    routes
      .get('/orgs/{organization:slug}/projects/{project}', showProject)
      .get('/orgs/{organization:slug}/projects/{project}/tasks/{task}', showTask)
      .get('/folders/{folder}/folders/{subfolder}', showSubfolder)

    return async (path: string) => {
      const res = await app.request(path, { headers: { Accept: 'application/json' } })

      return { status: res.status, body: res.status === 200 ? await res.json() : undefined }
    }
  }

  test('loads nested records, each under its own parent and access rule', async () => {
    const get = await createPostgresApp()

    expect(await get('/orgs/acme/projects/1/tasks/1')).toEqual({ status: 200, body: ['Acme', 'Rockets', 'Fuel'] })
    expect(await get('/folders/1/folders/2')).toEqual({ status: 200, body: ['Home', 'Photos'] })

    for (const path of [
      '/orgs/acme/projects/2',
      '/orgs/acme/projects/3',
      '/orgs/acme/projects/1/tasks/2',
      '/orgs/globex/projects/1/tasks/1',
      '/orgs/acme/projects/1/tasks/3',
      '/folders/3/folders/2',
      '/folders/2/folders/1',
    ]) {
      expect(`${path} ${(await get(path)).status}`).toBe(`${path} 404`)
    }
  })
})
