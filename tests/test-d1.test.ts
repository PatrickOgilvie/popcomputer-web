/* oxlint-disable effecttsgo/async-function -- Test entrypoints drive Miniflare's D1, a native Promise contract. */
/**
 * testD1 hands each test its own migrated D1 database, on Miniflare's real D1,
 * starting another Miniflare when one's databases run out, and stops them all
 * on dispose.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { testD1 } from '../src/testing.js'
import type { WebDeclaration } from '../src/effect/register.js'

const migrations = join(import.meta.dir, 'fixtures', 'd1-migrations')
// Two databases a Miniflare, so a third starts another.
const databases = testD1({ migrations, perMiniflare: 2 })

afterAll(() => databases.dispose())

/** The D1 binding as the application declares it, which `fresh()` hands out typed. */
interface D1 {
  prepare(query: string): { bind(...values: unknown[]): { run(): Promise<unknown> }; all(): Promise<{ results: unknown[] }> }
  batch(statements: ReadonlyArray<unknown>): Promise<unknown>
  exec(query: string): Promise<unknown>
}

declare module '../src/effect/register.js' {
  interface Register {
    web: WebDeclaration<{ bindings: { DB: D1 } }>
  }
}

const notes = async (database: D1) => (await database.prepare('SELECT body FROM notes ORDER BY body').all()).results

const write = (database: D1, body: string) => database.prepare('INSERT INTO notes (body) VALUES (?)').bind(body).run()

describe('testD1', () => {
  test("each database is migrated, empty, and apart from every other, across Miniflares", async () => {
    const [first, second, third] = await Promise.all([databases.fresh(), databases.fresh(), databases.fresh()])

    await write(first, 'first')
    await write(third, 'third')

    expect(await notes(first)).toEqual([{ body: 'first' }])
    expect(await notes(second)).toEqual([])
    expect(await notes(third)).toEqual([{ body: 'third' }])
  })

  test("a database has the migrations' constraints", async () => {
    const database = await databases.fresh()
    await write(database, 'once')

    await expect(write(database, 'once')).rejects.toThrow(/UNIQUE/)
  })

  test('dispose stops the databases, and the next one starts a new Miniflare', async () => {
    const pool = testD1({ migrations, perMiniflare: 2 })
    const stopped = await pool.fresh()

    await pool.dispose()

    await expect(notes(stopped)).rejects.toThrow()

    const after = await pool.fresh()
    await write(after, 'after')
    expect(await notes(after)).toEqual([{ body: 'after' }])
    await pool.dispose()
  })
})
