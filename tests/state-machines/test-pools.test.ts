/* oxlint-disable effecttsgo/async-function -- Test entrypoints drive Miniflare's D1 and the file system, native Promise contracts. */
/**
 * Machines 50 to 53: testD1's pool, the directories it keeps databases in,
 * Miniflare's late-reply patch, and the ends of a test case. dispose() waits
 * for what the pool starts and stops, a memo that failed is not kept, a case
 * answers with its own outcome, and only Miniflare's read waits for a reply.
 */
import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MessageChannel } from 'node:worker_threads'
import { plainRead } from '../fixtures/miniflare/plain-read.js'
import { inTestCase, whenTestCaseEnds } from '../../src/test-case.js'
import { hostTag, POOL_DIRECTORY, removePoolDirectory, sweepAbandonedPools } from '../../src/test-pools.js'
import { testD1 } from '../../src/testing.js'

const fixtureMigrations = join(import.meta.dir, '..', 'fixtures', 'd1-migrations')

/** The D1 binding's parts these tests use. */
interface D1 {
  prepare(query: string): { all(): Promise<{ results: unknown[] }> }
}

const tables = async (database: unknown) =>
  (await (database as D1).prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name <> 'sqlite_sequence' ORDER BY name").all()).results

/** This process's pool directories in the temporary directory. */
const ownPools = async () => {
  const prefix = `${POOL_DIRECTORY}${process.pid}-`

  return (await readdir(tmpdir())).filter((name) => name.startsWith(prefix))
}

const wait = (millis: number) => new Promise((resolve) => setTimeout(resolve, millis))

describe('the ends of a test case', () => {
  test("M53.T11: an end that fails leaves the case's own answer, and is reported beside it", async () => {
    const reported = spyOn(console, 'error').mockImplementation(() => {})

    try {
      const answer = await inTestCase(() => {
        whenTestCaseEnds(() => Promise.reject(new Error('end failed')))

        return 'held'
      })

      expect(answer).toBe('held')
      expect(reported.mock.calls.flat().map(String).join()).toContain('end failed')
    } finally {
      reported.mockRestore()
    }
  })

  test("M53.T12: an end that fails leaves the case's own failure, not its own", async () => {
    const reported = spyOn(console, 'error').mockImplementation(() => {})

    try {
      const failed = inTestCase(() => {
        whenTestCaseEnds(() => Promise.reject(new Error('end failed')))

        throw new Error('the case own failure')
      })

      await expect(failed).rejects.toThrow('the case own failure')
    } finally {
      reported.mockRestore()
    }
  })

  test('M53.T14: what work the case started asks after it has ended is done at once', async () => {
    let done = 0

    await inTestCase(() => {
      setTimeout(() => whenTestCaseEnds(async () => {
        done += 1
      }), 5)
    })
    await wait(50)

    expect(done).toBe(1)
  })
})

describe("the pool's directories", () => {
  test('M50.T7: a removal something keeps writing to resolves only once the directory stays gone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'popweb-test-pools-'))
    const directory = join(root, 'pool')
    // oxlint-disable-next-line effecttsgo/global-date -- The writer runs for real time, as a workerd stopping does.
    const until = Date.now() + 300
    const writing = (async () => {
      // oxlint-disable-next-line effecttsgo/global-date -- As above.
      while (Date.now() < until) {
        await mkdir(directory, { recursive: true }).catch(() => undefined)
        await writeFile(join(directory, 'file'), 'x').catch(() => undefined)
      }
    })()

    await wait(20)
    await removePoolDirectory(directory)

    expect(existsSync(directory)).toBe(false)
    await writing
    await rm(root, { recursive: true, force: true })
  })

  test("M50.T11: a sweep leaves another host's young pool, whose process id means nothing here, and removes this host's abandoned one", async () => {
    const root = await mkdtemp(join(tmpdir(), 'popweb-test-pools-'))
    const elsewhere = `${POOL_DIRECTORY}999999-h00000000-abc`
    const here = `${POOL_DIRECTORY}999999-${await hostTag()}-def`

    await mkdir(join(root, elsewhere))
    await mkdir(join(root, here))
    await sweepAbandonedPools(root)

    expect((await readdir(root)).sort()).toEqual([elsewhere])
    await rm(root, { recursive: true, force: true })
  })
})

describe('testD1', () => {
  const pools: Array<ReturnType<typeof testD1>> = []
  const pool = (migrations = fixtureMigrations, perMiniflare = 2) => {
    const made = testD1({ migrations, perMiniflare })

    pools.push(made)

    return made
  }

  afterAll(() => Promise.all(pools.map((made) => made.dispose())))

  test("M51.T8: only Miniflare's own read waits for a reply: a caller under a folder named miniflare is told at once", async () => {
    await pool().fresh()

    const { port1 } = new MessageChannel()
    // oxlint-disable-next-line effecttsgo/global-date -- How long the read blocked is real time.
    const started = Date.now()

    expect(plainRead(port1)).toBeUndefined()
    // oxlint-disable-next-line effecttsgo/global-date -- As above.
    expect(Date.now() - started).toBeLessThan(1000)
    port1.close()
  }, 60_000)

  test('M52.T15: a migrations folder that appears is read by the next fresh() after dispose()', async () => {
    const root = await mkdtemp(join(tmpdir(), 'popweb-test-pools-'))
    const migrations = join(root, 'drizzle')
    const d1 = pool(migrations)

    await expect(d1.fresh()).rejects.toThrow()
    await cp(fixtureMigrations, migrations, { recursive: true })
    await d1.dispose()

    expect(await tables(await d1.fresh())).toEqual([{ name: 'notes' }])
    await d1.dispose()
    await rm(root, { recursive: true, force: true })
  }, 60_000)

  test('M52.T16: a migration added after dispose() is applied by the next fresh()', async () => {
    const root = await mkdtemp(join(tmpdir(), 'popweb-test-pools-'))
    const migrations = join(root, 'drizzle')
    const d1 = pool(migrations)

    await cp(fixtureMigrations, migrations, { recursive: true })
    await d1.fresh()
    await d1.dispose()
    await writeFile(join(migrations, '9999_later.sql'), 'CREATE TABLE later (id INTEGER PRIMARY KEY);')

    expect(await tables(await d1.fresh())).toEqual([{ name: 'later' }, { name: 'notes' }])
    await d1.dispose()
    await rm(root, { recursive: true, force: true })
  }, 60_000)

  test('a migrations folder with no migrations gives an empty database', async () => {
    const root = await mkdtemp(join(tmpdir(), 'popweb-test-pools-'))
    const d1 = pool(root)

    expect(await tables(await d1.fresh())).toEqual([])
    await d1.dispose()
    await rm(root, { recursive: true, force: true })
  }, 60_000)

  test('M52.T21: a fresh() under way when dispose() is called is stopped by it', async () => {
    const d1 = pool()
    const opening = d1.fresh()

    await d1.dispose()

    await expect(tables(await opening)).rejects.toThrow()
  }, 60_000)

  test('M52.T22, T23: dispose() resolves with the pool directory gone, a fresh() under way and a second dispose() included', async () => {
    const before = new Set(await ownPools())
    const d1 = pool()

    await d1.fresh()
    await d1.dispose()

    const opening = d1.fresh()

    await Promise.resolve()
    await Promise.resolve()
    await d1.dispose()
    await opening
    await d1.fresh()

    const first = d1.dispose()

    await d1.dispose()

    expect((await ownPools()).filter((name) => !before.has(name))).toEqual([])
    await first
  }, 60_000)

  test('M52.T32: a database a case asked for without waiting is finished when the case ends, so its Miniflare stops', async () => {
    const d1 = pool(fixtureMigrations, 2)
    let second: unknown

    await inTestCase(() => {
      void d1.fresh()
    })
    await inTestCase(async () => {
      second = await d1.fresh()
    })

    for (let tries = 0; tries < 50 && await tables(second).then(() => true, () => false); tries += 1) await wait(100)

    await expect(tables(second)).rejects.toThrow()
  }, 60_000)
})
