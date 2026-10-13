/**
 * Table Schema Tests
 *
 * A Drizzle table's row as an Effect Schema, so page props and the signed-in
 * user can take their fields from the table that declares them.
 */

import { describe, expect, test } from 'bun:test'
import { Redacted, Schema as S, Struct } from 'effect'
import { boolean, integer, pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { columnsOf, tableSchema } from '../../src/effect/table-schema.js'
import { Database } from 'bun:sqlite'
import { count, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { sqliteTable, text as sqliteText } from 'drizzle-orm/sqlite-core'
import { betterAuthSession } from '../../src/effect/auth.js'

const level = pgEnum('level', ['beginner', 'advanced'])

const courses = pgTable('courses', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  level: level('level').notNull(),
  seats: integer('seats'),
  published: boolean('published').notNull(),
  publishedAt: timestamp('published_at'),
})

const course = {
  id: 'c1',
  title: 'Effect',
  level: 'beginner',
  seats: null,
  published: true,
  publishedAt: new Date('2026-01-01T00:00:00Z'),
}

describe('tableSchema', () => {
  test('checks each column against its type, nullability and enum values', () => {
    const decode = S.decodeUnknownExit(tableSchema(courses))

    expect(decode(course)._tag).toBe('Success')
    expect(decode({ ...course, level: 'expert' })._tag).toBe('Failure')
    expect(decode({ ...course, seats: '3' })._tag).toBe('Failure')
    expect(decode({ ...course, title: null })._tag).toBe('Failure')
  })

  test('picks the columns a page shows, and encodes them as JSON', () => {
    const Listing = tableSchema(courses).mapFields(Struct.pick(['id', 'title', 'publishedAt']))

    expect(S.encodeSync(S.toCodecJson(Listing))(course)).toEqual({
      id: 'c1',
      title: 'Effect',
      publishedAt: '2026-01-01T00:00:00.000Z',
    })
  })
})

describe('betterAuthSession', () => {
  const users = pgTable('user', {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    role: text('role', { enum: ['author', 'reader'] }).notNull(),
  })

  test('decodes Better Auth\'s session with the user as the table declares it', () => {
    const session = S.decodeUnknownSync(betterAuthSession(tableSchema(users)))({
      user: { id: 'u1', email: 'ada@example.com', role: 'author' },
      session: {
        id: 's1',
        userId: 'u1',
        expiresAt: new Date('2027-01-01T00:00:00Z'),
        token: 'secret',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      },
    })

    expect(session.user.role).toBe('author')
    expect(Redacted.value(session.session.token)).toBe('secret')
  })
})

describe('columnsOf', () => {
  test('selects the columns a page schema names, beside computed values', () => {
    const projects = sqliteTable('projects', {
      id: sqliteText('id').primaryKey(),
      name: sqliteText('name').notNull(),
      secret: sqliteText('secret').notNull(),
    })
    const tasks = sqliteTable('tasks', { id: sqliteText('id').primaryKey(), projectId: sqliteText('project_id').notNull() })
    const sqlite = new Database(':memory:')
    sqlite.run('CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, secret TEXT NOT NULL)')
    sqlite.run('CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL)')
    const db = drizzle(sqlite)
    db.insert(projects).values({ id: 'p1', name: 'Apollo', secret: 's' }).run()
    db.insert(tasks).values([{ id: 't1', projectId: 'p1' }, { id: 't2', projectId: 'p1' }]).run()

    const ProjectCard = tableSchema(projects).mapFields((fields) => ({
      ...Struct.pick(fields, ['id', 'name']),
      openTasks: S.Number,
    }))

    const rows = db
      .select({ ...columnsOf(projects, ProjectCard), openTasks: count(tasks.id) })
      .from(projects)
      .leftJoin(tasks, eq(tasks.projectId, projects.id))
      .groupBy(projects.id)
      .all()

    expect(rows).toEqual([{ id: 'p1', name: 'Apollo', openTasks: 2 }])
    expect(S.decodeUnknownSync(ProjectCard)(rows[0])).toEqual({ id: 'p1', name: 'Apollo', openTasks: 2 })
  })
})
