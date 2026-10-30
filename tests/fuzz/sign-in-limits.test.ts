/**
 * An account's sign-in count, as sequences of guesses sent together, the
 * owner's sign-ins and time passing, through each of Better Auth's password
 * doors and the spellings each folds together. The rules
 * src/effect/sign-in-limits.ts states, and docs/state-machines/
 * SignInLimits.tla checks, predict each step; whatever the order:
 *
 * - a sign-in while its account cools down is refused with a 429 before its
 *   password is checked, and every other one is counted before it is;
 * - guesses sent together reach the password check no more often than the
 *   count lets them in, so no more than `max` before a cooldown;
 * - each door's row holds the count and the time the rules give: the count
 *   lasts a window past the end of its cooldown, never spent toward it, and
 *   only the owner's sign-in clears it.
 *
 * Each door counts apart (docs/auth.md), so the model keeps a count for each.
 */
import { describe } from 'bun:test'
import { Database } from 'bun:sqlite'
import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { phoneNumber, username } from 'better-auth/plugins'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { Arbitrary } from 'effect'
import { Hono } from 'hono'
import { betterAuthHandler } from '../../src/auth.js'
import { setupWeb } from '../../src/setup.js'
import { testBrowser, testClock, testEnv, testRateLimiter } from '../../src/testing.js'
import { pick, property, show, weighted } from './property'

const MAX = 2
const COOLDOWN = 60_000
const WINDOW = 15 * 60_000
const START = Date.UTC(2026, 0, 1)
const PASSWORD = 'correct horse'

const rateLimit = sqliteTable('rate_limit', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull(),
  lastRequest: integer('last_request').notNull(),
})

/** Each password door, the body field it finds the account by, and spellings of Ada's that it folds together. */
const DOORS = {
  email: { path: '/api/auth/sign-in/email', field: 'email', spellings: ['ada@example.com', 'ADA@example.com', 'Ada@Example.Com', ' ada@example.com '] },
  username: { path: '/api/auth/sign-in/username', field: 'username', spellings: ['ada', 'ADA', 'Ada', 'aDa'] },
  phone: { path: '/api/auth/sign-in/phone-number', field: 'phoneNumber', spellings: ['+15550000001', ' +15550000001', '+15550000001 ', '+15550000001'] },
} as const

type Door = keyof typeof DOORS

/** The account a spelling names at its door, as the endpoint looks it up: the username plugin's default lowercases. */
const accountOf = (door: Door, spelling: string): string => (door === 'username' ? spelling.toLowerCase() : spelling.trim().toLowerCase())

const step = Arbitrary.all({
  act: weighted(['guess', 3], ['owner', 1], ['wait', 2]),
  door: pick(['email', 'username', 'phone']),
  spelling: pick([0, 1, 2, 3]),
  together: pick([1, 2, 3, 4]),
  // Around the first cooldown, its doublings and the window, each boundary exactly too.
  wait: pick([1_000, 59_000, 60_000, 61_000, 120_000, 240_000, WINDOW, WINDOW + 60_000, 2 * WINDOW + 1_000]),
})

type Step = typeof step extends Arbitrary.Arbitrary<infer A> ? A : never

interface Row {
  readonly count: number
  readonly lastRequest: number
}

/** The rules, as src/effect/sign-in-limits.ts states them. */
const cooldownAfter = (count: number): number => (count < MAX ? 0 : Math.min(WINDOW, COOLDOWN * 2 ** (count - MAX)))
const cooling = (row: Row, now: number): boolean => row.count >= MAX && row.lastRequest + cooldownAfter(row.count) > now
const spent = (row: Row, now: number): boolean => row.lastRequest + cooldownAfter(row.count) + WINDOW <= now

/** A sign-in at `now`, by the rules: refused while its account cools down, else counted. Whether it was counted. */
function counts(rows: Map<string, Row>, account: string, now: number): boolean {
  const row = rows.get(account)

  if (row !== undefined && cooling(row, now)) return false

  rows.set(account, { count: row === undefined || spent(row, now) ? 1 : row.count + 1, lastRequest: now })
  return true
}

/** The row's key: the account's SHA-256, as the code stores it. */
async function keyOf(account: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(account)))

  return `sign-in:${[...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

async function createApp() {
  // A cheap hash, and a count of each password Better Auth checks.
  const checked = { passwords: 0 }
  const auth = betterAuth({
    database: memoryAdapter({ user: [], session: [], account: [], verification: [], rateLimit: [] }),
    baseURL: 'http://localhost',
    secret: 'sign-in-limits-fuzz-secret-with-enough-entropy-0123',
    emailAndPassword: {
      enabled: true,
      password: {
        hash: async (password) => `plain:${password}`,
        verify: async ({ hash, password }) => {
          checked.passwords++
          return hash === `plain:${password}`
        },
      },
    },
    rateLimit: { enabled: false },
    logger: { disabled: true },
    plugins: [username(), phoneNumber({ sendOTP: async () => {} })],
  })
  const { user } = await auth.api.signUpEmail({ body: { name: 'Ada', email: 'ada@example.com', password: PASSWORD, username: 'ada' } })
  await (await auth.$context).internalAdapter.updateUser(user.id, { phoneNumber: '+15550000001', phoneNumberVerified: true })

  const sqlite = new Database(':memory:')
  sqlite.run('CREATE TABLE rate_limit (id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, count INTEGER NOT NULL, last_request INTEGER NOT NULL)')
  const db = drizzle(sqlite, { schema: { rateLimit } })

  const app = new Hono()
  const { routes } = setupWeb(app, {
    version: '1',
    render: (page) => JSON.stringify(page),
    database: () => db,
    auth: {
      client: () => auth,
      signInLimits: { limiter: 'SIGN_IN_LIMITER', table: rateLimit, failures: { max: MAX, window: WINDOW, cooldown: COOLDOWN } },
    },
  })

  routes.all('/api/auth/*', betterAuthHandler({ settable: [] }))

  const time = await testClock(START)
  const env = testEnv(time.layer, { SIGN_IN_LIMITER: testRateLimiter({ limit: 1_000_000 }) })
  const rows = () => db.select().from(rateLimit).all()

  return { app, env, time, rows, checked }
}

async function runSteps(steps: readonly Step[]): Promise<string | undefined> {
  const { app, env, time, rows, checked } = await createApp()
  const model = new Map<string, Row>()
  let now = START
  let guesses = 0

  // Each sign-in from a client address of its own, as a botnet sends them.
  const send = (door: Door, spelling: string, password: string) =>
    testBrowser(app, env).request(DOORS[door].path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [DOORS[door].field]: spelling, password }),
    })

  for (const [index, sent] of steps.entries()) {
    const at = `step ${index + 1}, ${show(sent)}`

    if (sent.act === 'wait') {
      await time.advance(sent.wait)
      now += sent.wait
      continue
    }

    const spelling = DOORS[sent.door].spellings[sent.spelling]
    const account = accountOf(sent.door, spelling)
    const before = checked.passwords
    const passwords = sent.act === 'owner' ? [PASSWORD] : Array.from({ length: sent.together }, () => `guess-${++guesses}`)
    const answers = await Promise.all(passwords.map((password) => send(sent.door, spelling, password)))
    const counted = passwords.filter(() => counts(model, account, now)).length
    const refusals = answers.filter((answer) => answer.status === 429).length
    const checks = checked.passwords - before

    if (refusals !== passwords.length - counted) return `${at}: ${refusals} of ${passwords.length} were refused, not ${passwords.length - counted}`
    if (checks > counted) return `${at}: ${checks} passwords were checked, though the count let ${counted} in`
    if (answers.some((answer) => answer.status >= 500)) return `${at}: answered ${show(answers.map((answer) => answer.status))}`

    // A success clears the count; a refused or failed one leaves it as the rules counted it.
    if (answers.some((answer) => answer.ok)) model.delete(account)

    // Each row by its key's first digits, its count and the time of its last sign-in.
    const described = (key: string, row: Row) => `${key.slice(8, 16)}: ${row.count} at ${(row.lastRequest - START) / 1000}s`
    const stored = rows().map((row) => described(row.key, row)).sort()
    const expected = (await Promise.all([...model].map(async ([name, row]) => described(await keyOf(name), row)))).sort()

    if (show(stored) !== show(expected)) return `${at}: the rows are ${show(stored)}, not ${show(expected)}`
  }

  return undefined
}

describe("an account's sign-in count", () => {
  property(
    'lets in no guess the rules refuse, before its password is checked, at each door and spelling',
    Arbitrary.array(step, { maxLength: 12 }),
    async (steps) => {
      const refusal = await runSteps(steps)

      return refusal === undefined ? undefined : `${refusal}, after ${show(steps)}`
    },
    { runs: 100 }
  )
})
