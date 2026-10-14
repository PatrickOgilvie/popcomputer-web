/**
 * rowOf: an insert-select's fields from the table, for writes on D1 that
 * depend on a condition.
 */

import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { and, eq, sql } from 'drizzle-orm'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { rowOf } from '../src/drizzle.js'

const jobs = sqliteTable('jobs', {
  id: text('id').primaryKey(),
  status: text('status', { enum: ['draft', 'open', 'closed'] }).notNull(),
})

const candidates = sqliteTable('candidates', {
  id: text('id').primaryKey(),
  jobId: text('job_id').notNull(),
  email: text('email').notNull(),
  stage: text('stage').notNull().default('applied'),
  appliedAt: integer('applied_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date(Date.UTC(2026, 0, 2))),
  rating: integer('rating'),
  extra: text('extra', { mode: 'json' }).$type<{ source: string }>(),
})

function openDatabase() {
  const sqlite = new Database(':memory:')
  sqlite.run("CREATE TABLE jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL)")
  sqlite.run(`CREATE TABLE candidates (
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL, email TEXT NOT NULL, stage TEXT NOT NULL,
    applied_at INTEGER NOT NULL, rating INTEGER, extra TEXT
  )`)
  sqlite.run("INSERT INTO jobs VALUES ('open-job', 'open'), ('closed-job', 'closed')")

  return drizzle(sqlite)
}

const applyTo = (db: ReturnType<typeof openDatabase>, jobId: string, id: string) =>
  db.insert(candidates).select(
    db.select(rowOf(candidates, { id, jobId, email: 'ada@example.com', extra: { source: 'careers' } }))
      .from(jobs)
      .where(and(eq(jobs.id, jobId), eq(jobs.status, 'open')))
  ).returning({ id: candidates.id }).all()

describe('rowOf', () => {
  test('writes the row, with defaults for the columns left out, only while the condition holds', () => {
    const db = openDatabase()

    expect(applyTo(db, 'open-job', 'c1')).toEqual([{ id: 'c1' }])
    expect(applyTo(db, 'closed-job', 'c2')).toEqual([])
    expect(db.select().from(candidates).all()).toEqual([{
      id: 'c1',
      jobId: 'open-job',
      email: 'ada@example.com',
      stage: 'applied',
      appliedAt: new Date(Date.UTC(2026, 0, 2)),
      rating: null,
      extra: { source: 'careers' },
    }])
  })

  test('takes a value the database computes as SQL', () => {
    const db = openDatabase()

    db.insert(candidates).select(
      db.select(rowOf(candidates, { id: 'c1', jobId: 'open-job', email: 'a@example.com', rating: sql`(select count(*) + 4 from ${jobs})` }))
        .from(jobs)
        .where(eq(jobs.id, 'open-job'))
    ).run()

    expect(db.select({ rating: candidates.rating }).from(candidates).all()).toEqual([{ rating: 6 }])
  })

  test('takes a column of the table the insert selects from', () => {
    const db = openDatabase()

    db.insert(candidates).select(
      db.select(rowOf(candidates, { id: 'c1', jobId: jobs.id, email: 'a@example.com' })).from(jobs).where(eq(jobs.id, 'open-job'))
    ).run()

    expect(db.select({ jobId: candidates.jobId }).from(candidates).all()).toEqual([{ jobId: 'open-job' }])
  })
})

// Checked by `bun run test:types`, never run: rowOf names only the table's columns.
export function rowOfNamesOnlyColumns() {
  // @ts-expect-error jobID is not a column of candidates
  rowOf(candidates, { id: 'c1', jobID: 'open-job', email: 'a@example.com' })
  // @ts-expect-error email is required
  rowOf(candidates, { id: 'c1', jobId: 'open-job' })
}
