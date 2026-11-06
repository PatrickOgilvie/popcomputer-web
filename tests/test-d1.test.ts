/* oxlint-disable effecttsgo/async-function -- Test entrypoints drive Miniflare's D1, a native Promise contract. */
/**
 * testD1 hands each test its own migrated D1 database, on Miniflare's real D1,
 * starting another Miniflare when one's databases run out, and stops them all
 * on dispose.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { MessageChannel, Worker } from 'node:worker_threads'
import { readReply } from './fixtures/miniflare/read-reply.js'
import { Arbitrary, Schema as S } from 'effect'
import { fuzz } from '../src/fuzz.js'
import { isRunning, sweepAbandonedPools } from '../src/test-pools.js'
import { testD1, testEnv } from '../src/testing.js'
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

const everyCase = Arbitrary.schema(S.Literal(1))

/** A worker thread that replies a moment after it is asked. */
const lateReply = `
const { workerData } = require('worker_threads')

setTimeout(() => workerData.port.postMessage('late'), 50)
`

/**
 * A run in a process of its own that makes `cases` cases of `fuzz`, each with
 * a database, and prints how many `workerd` processes it held at its most.
 */
const fuzzRun = (cases: number) => `
import { spawnSync } from 'node:child_process'
import { Arbitrary, Schema as S } from 'effect'
import { fuzz } from ${JSON.stringify(join(import.meta.dir, '..', 'src', 'fuzz.ts'))}
import { testD1 } from ${JSON.stringify(join(import.meta.dir, '..', 'src', 'testing.ts'))}

const pool = testD1({ migrations: ${JSON.stringify(migrations)}, perMiniflare: 2 })
const running = () => spawnSync('pgrep', ['-P', String(process.pid), 'workerd']).stdout.toString().split('\\n').filter(Boolean).length
let peak = 0

await fuzz(Arbitrary.schema(S.Literal(1)), async () => {
  const database = await pool.fresh()

  await database.prepare('INSERT INTO notes (body) VALUES (?)').bind('note').run()
  peak = Math.max(peak, running())
}, { runs: ${cases} })

console.log(peak)
await pool.dispose()
process.exit(0)
`

/** What a run left when killed: it prints its process id and pool's folder, then waits to be killed. */
const killedRun = `
import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { testD1 } from ${JSON.stringify(join(import.meta.dir, '..', 'src', 'testing.ts'))}

const before = new Set(readdirSync(tmpdir()))
const pool = testD1({ migrations: ${JSON.stringify(migrations)}, perMiniflare: 2 })
const database = await pool.fresh()

await database.prepare('INSERT INTO notes (body) VALUES (?)').bind('note').run()
console.log(JSON.stringify(readdirSync(tmpdir()).filter((name) => !before.has(name) && name.startsWith('popweb-test-d1-'))))
await new Promise(() => undefined)
`

/** A later run: it starts a pool, which sweeps, and waits there until `folder` has gone, or gives up. */
const laterRun = (folder: string) => `
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testD1 } from ${JSON.stringify(join(import.meta.dir, '..', 'src', 'testing.ts'))}

const pool = testD1({ migrations: ${JSON.stringify(migrations)}, perMiniflare: 2 })
await pool.fresh()

for (let waited = 0; waited < 100 && existsSync(join(tmpdir(), ${JSON.stringify(folder)})); waited += 1) await Bun.sleep(100)

console.log(existsSync(join(tmpdir(), ${JSON.stringify(folder)})))
await pool.dispose()
process.exit(0)
`

/** The first line of a process's output, read as it arrives, leaving it running. */
async function firstLineOf(output: ReadableStream<Uint8Array>): Promise<string> {
  const reader = output.getReader()
  const decoder = new TextDecoder()
  let text = ''

  while (!text.includes('\n')) {
    const { done, value } = await reader.read()

    if (done) break

    text += decoder.decode(value)
  }

  return text.split('\n')[0] ?? ''
}

const canListFiles = Bun.which('lsof') !== null

/** The `workerd` processes that hold a file in `folder`. */
function workerdsHolding(folder: string): string[] {
  const holding = new Set<string>()
  let pid = ''

  for (const line of Bun.spawnSync(['lsof', '-c', 'workerd', '-Fpn']).stdout.toString().split('\n')) {
    if (line.startsWith('p')) pid = line.slice(1)
    else if (line.startsWith('n') && line.includes(folder)) holding.add(pid)
  }

  return [...holding]
}

describe('isRunning', () => {
  test('a running process is, a finished one is not, and one that refuses the signal is', async () => {
    const finished = Bun.spawn(['true'])

    await finished.exited

    expect(isRunning(process.pid)).toBe(true)
    expect(isRunning(finished.pid)).toBe(false)
    // launchd or init: another user's process refuses the signal, and is running.
    expect(isRunning(1)).toBe(true)
  })
})

describe('sweepAbandonedPools', () => {
  test("removes a pool whose process is gone and an older version's old one, and nothing else", async () => {
    const root = await mkdtemp(join(tmpdir(), 'sweep-'))
    const finished = Bun.spawn(['true'])

    await finished.exited

    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    const gone = [`popweb-test-d1-${finished.pid}-abcdef`, 'popweb-test-d1-abcdef']
    // A running process's pool however old, an older version's still in use, and whatever else lives here.
    const stays = [`popweb-test-d1-${process.pid}-abcdef`, 'popweb-test-d1-ghijkl', 'someone-elses-cache']

    try {
      for (const name of [...gone, ...stays]) await mkdir(join(root, name))
      for (const name of [gone[0], gone[1], stays[0], stays[2]]) if (name !== undefined) await utimes(join(root, name), twoDaysAgo, twoDaysAgo)

      await sweepAbandonedPools(root)

      expect((await readdir(root)).sort()).toEqual([...stays].sort())
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('testD1', () => {
  test("each database is migrated, empty, and apart from every other, across Miniflares", async () => {
    const [first, second, third] = await Promise.all([databases.fresh(), databases.fresh(), databases.fresh()])

    await write(first, 'first')
    await write(third, 'third')

    expect(await notes(first)).toEqual([{ body: 'first' }])
    expect(await notes(second)).toEqual([])
    expect(await notes(third)).toEqual([{ body: 'third' }])
  })

  test('a test reads the database through the env testEnv returns, which has every binding passed to it', async () => {
    const env = testEnv({ DB: await databases.fresh() })

    // Not env.DB?.: a binding passed to testEnv keeps its declared type.
    await write(env.DB, 'read back')

    expect(await notes(env.DB)).toEqual([{ body: 'read back' }])
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

  test("a reply that lands after Miniflare's read wakes is waited for, and anyone else is told there is none", async () => {
    await databases.fresh()

    const threads: { receiveMessageOnPort(port: unknown): unknown } = createRequire(import.meta.url)('node:worker_threads')
    const { port1, port2 } = new MessageChannel()
    const worker = new Worker(lateReply, { eval: true, workerData: { port: port2 }, transferList: [port2] })

    try {
      // Nothing has landed yet, and whoever asks is told so at once.
      expect(threads.receiveMessageOnPort(port1)).toBeUndefined()
      expect(readReply(port1)).toBe('late')
    } finally {
      await worker.terminate()
    }
  })

  test('a fuzz case\'s databases are finished when it ends, so a run stops each Miniflare they fill', async () => {
    const pool = testD1({ migrations, perMiniflare: 2 })
    const taken: D1[] = []

    await fuzz(everyCase, async () => {
      taken.push(await pool.fresh())

      return undefined
    }, { runs: 5 })

    const [first, second, third, fourth, fifth] = taken

    if (first === undefined || second === undefined || third === undefined || fourth === undefined || fifth === undefined) throw new Error('Five cases take five databases.')

    await expect(notes(first)).rejects.toThrow()
    await expect(notes(second)).rejects.toThrow()
    await expect(notes(third)).rejects.toThrow()
    await expect(notes(fourth)).rejects.toThrow()

    // The fifth's Miniflare still has a database to hand out, so it stays.
    await write(fifth, 'still here')
    expect(await notes(fifth)).toEqual([{ body: 'still here' }])

    await pool.dispose()
  })

  test('a database made outside a case stays, whatever the cases around it finish', async () => {
    const pool = testD1({ migrations, perMiniflare: 2 })
    const held = await pool.fresh()

    await write(held, 'held')
    await fuzz(everyCase, async () => {
      await pool.fresh()

      return undefined
    }, { runs: 6 })

    expect(await notes(held)).toEqual([{ body: 'held' }])

    await pool.dispose()
  })

  test('dispose in the middle of a run starts the next database afresh', async () => {
    const pool = testD1({ migrations, perMiniflare: 2 })

    await fuzz(everyCase, async () => {
      await pool.dispose()
      await write(await pool.fresh(), 'after')

      return undefined
    }, { runs: 5 })

    await pool.dispose()
  })

  test('a run of many cases never holds more than the Miniflare it is filling', async () => {
    const run = Bun.spawn(['bun', '-e', fuzzRun(12)], { stdout: 'pipe', stderr: 'inherit' })
    const output = await new Response(run.stdout).text()

    expect(await run.exited).toBe(0)
    expect(Number(output.trim())).toBe(1)
  }, 30_000)

  test('a later run removes what a killed run left: its folder and its workerd', async () => {
    const killed = Bun.spawn(['bun', '-e', killedRun], { stdout: 'pipe', stderr: 'inherit' })
    const folders: unknown = JSON.parse(await firstLineOf(killed.stdout))
    const folder = Array.isArray(folders) ? String(folders[0]) : ''

    killed.kill('SIGKILL')
    await killed.exited

    expect(folder).toMatch(new RegExp(`^popweb-test-d1-${killed.pid}-`))
    expect(existsSync(join(tmpdir(), folder))).toBe(true)
    if (canListFiles) expect(workerdsHolding(folder)).not.toEqual([])

    const later = Bun.spawn(['bun', '-e', laterRun(folder)], { stdout: 'pipe', stderr: 'inherit' })
    const output = await new Response(later.stdout).text()

    expect(await later.exited).toBe(0)
    expect(output.trim()).toBe('false')
    if (canListFiles) expect(workerdsHolding(folder)).toEqual([])
  }, 30_000)

  test('a later run leaves the folders of a run still going', async () => {
    const running = testD1({ migrations, perMiniflare: 2 })
    const before = new Set(await readdir(tmpdir()))
    const database = await running.fresh()
    const [folder] = (await readdir(tmpdir())).filter((name) => !before.has(name) && name.startsWith(`popweb-test-d1-${process.pid}-`))

    expect(folder).toBeDefined()

    const later = Bun.spawn(['bun', '-e', laterRun('none')], { stdout: 'ignore', stderr: 'inherit' })

    expect(await later.exited).toBe(0)

    await write(database, 'still here')
    expect(await notes(database)).toEqual([{ body: 'still here' }])

    await running.dispose()
  }, 30_000)
})
