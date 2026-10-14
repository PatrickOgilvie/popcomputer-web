/* oxlint-disable effecttsgo/async-function -- Test entrypoints drive Miniflare's D1, a native Promise contract. */
/**
 * testD1 hands each test its own migrated D1 database, on Miniflare's real D1,
 * starting another Miniflare when one's databases run out, and stops them all
 * on dispose.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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

/**
 * A test run in a process of its own: it writes to databases from a pool,
 * prints the pool's directory, disposes it and exits at once, as `bun test`
 * exits once the last `afterAll` resolves.
 */
const exitingRun = `
import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { testD1 } from ${JSON.stringify(join(import.meta.dir, '..', 'src', 'testing.ts'))}

const before = new Set(readdirSync(tmpdir()))
const pool = testD1({ migrations: ${JSON.stringify(migrations)}, perMiniflare: 4 })

for (let index = 0; index < 8; index += 1) {
  await (await pool.fresh()).prepare('INSERT INTO notes (body) VALUES (?)').bind('note ' + index).run()
}

console.log(JSON.stringify(readdirSync(tmpdir()).filter((name) => !before.has(name) && name.startsWith('popweb-test-d1-'))))
await pool.dispose()
process.exit(0)
`

/** Whether a SQLite file holds these tests' `notes` table: a database a test here migrated. */
function holdsNotes(file: string): boolean {
  try {
    const database = new Database(file, { readonly: true })

    try {
      return database.query("SELECT 1 FROM sqlite_master WHERE name = 'notes'").get() !== null
    } finally {
      database.close()
    }
  } catch {
    return false
  }
}

/**
 * The directories in the system's temporary directory, made since `before`,
 * that still hold a database these tests migrated. Other processes' Miniflares
 * may come and go there meanwhile; only these tests' databases count.
 */
async function leftDatabases(before: ReadonlySet<string>): Promise<string[]> {
  const made = (await readdir(tmpdir())).filter((name) => !before.has(name) && /^(miniflare|popweb-test-d1)-/.test(name))
  const left: string[] = []

  for (const name of made) {
    const files = await readdir(join(tmpdir(), name), { recursive: true }).catch(() => [])

    if (files.some((file) => file.endsWith('.sqlite') && holdsNotes(join(tmpdir(), name, file)))) left.push(name)
  }

  return left
}

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

  test("a run that exits as soon as dispose resolves, as bun test does, leaves none of the databases' files", async () => {
    const before = new Set(await readdir(tmpdir()))
    const run = Bun.spawn(['bun', '-e', exitingRun], { stdout: 'pipe', stderr: 'pipe' })
    const output = await new Response(run.stdout).text()

    expect(await run.exited).toBe(0)
    expect(await leftDatabases(before)).toEqual([])

    const pools: unknown = JSON.parse(output)
    expect(pools).toEqual([expect.stringMatching(/^popweb-test-d1-/)])
    expect(Array.isArray(pools) && pools.some((name) => existsSync(join(tmpdir(), String(name))))).toBe(false)
  })
})
