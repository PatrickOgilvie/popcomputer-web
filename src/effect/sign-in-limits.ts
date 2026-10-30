/**
 * Limits on signing in, so guessing passwords is slow whichever addresses
 * the guesses come from.
 *
 * Two layers, cheapest first:
 *
 * - A Cloudflare Workers Rate Limiting binding counts every sign-in, sign-up
 *   and password call per client address, an IPv6 client's by its /64 network
 *   (`ipv6Prefix`), and every sign-in per account,
 *   over its short window (10 or 60 seconds), at Cloudflare's edge, with no
 *   database write.
 * - Better Auth's `rateLimit` table counts an account's sign-ins, each before
 *   its password is checked. Past `max`, the account cools down, for longer
 *   with each further sign-in, up to the window: a sign-in during a cooldown
 *   is refused before the password is checked. A cooldown, not a lock, so
 *   someone who knows an address can delay its owner, never shut them out.
 *
 * A successful sign-in deletes the account's row. `sweepSignInFailures`
 * deletes the rows that are spent, from a Cron Trigger.
 *
 * The account's row is a state machine, its states conditions on the row at
 * a moment, which `docs/state-machines.md` models:
 *
 * - spent: no row, or a window has passed since the end of its cooldown;
 * - counting: fewer than `max` sign-ins counted;
 * - cooling: `max` or more, within the cooldown the count earned;
 * - cooled: `max` or more, the cooldown over, the window not yet passed.
 *
 * A sign-in moves a spent row to a count of 1, and a counting or cooled one
 * to its count plus one, in one statement before its password is checked, so
 * sign-ins sent together are counted against each other; cooling refuses it.
 * A success deletes the row.
 */

import type { Column, SQL, Table } from 'drizzle-orm'
import { Clock, Context, Duration, Effect, Option } from 'effect'
import { AuthRateLimitError, HttpError } from './errors.js'
import { loadDrizzle } from './binding.js'
import { DatabaseService } from './services.js'

// Drizzle is an optional peer: it loads when an application limits sign-ins.
const drizzle = Effect.promise(loadDrizzle)

/** A Cloudflare Workers Rate Limiting binding, as `ratelimits` in `wrangler.jsonc` declares one. */
export interface RateLimiter {
  limit(options: { readonly key: string }): Promise<{ readonly success: boolean }>
}

/**
 * The names of the Rate Limiting bindings among `Bindings`, or any name for
 * bindings declared as no particular type. `setupWeb` reads them from its
 * Hono app's environment, not from the registration, which it makes.
 */
export type RateLimiterName<Bindings = never> = [Bindings] extends [never]
  ? string
  : object extends Bindings
    ? string
    : Extract<keyof { [Key in keyof Bindings as NonNullable<Bindings[Key]> extends RateLimiter ? Key : never]: unknown }, string>

/** Better Auth's `rateLimit` table, as its CLI and docs/auth-tables.md declare it: a unique `key`, a `count` and `lastRequest` in milliseconds. */
export type SignInCountsTable = Table & {
  readonly id: Column
  readonly key: Column
  readonly count: Column
  readonly lastRequest: Column
}

/** How an account's sign-ins slow the next ones. */
export interface SignInFailures {
  /** Sign-ins counted before the account cools down. A whole number, 1 or more. Default 10. */
  readonly max?: number
  /** How long the count lasts past the end of its cooldown. Default 15 minutes. */
  readonly window?: Duration.Input
  /** The first cooldown, doubled by each further sign-in, up to `window`. Default 1 minute. */
  readonly cooldown?: Duration.Input
}

/** `setupWeb`'s `auth.signInLimits`. */
export interface SignInLimitsConfig<Limiter extends string = string> {
  /**
   * The Rate Limiting binding that limits each client address's sign-in,
   * sign-up and password calls, and each account's sign-ins, over its period,
   * as `wrangler.jsonc` declares it:
   * `"ratelimits": [{ "name": "SIGN_IN_LIMITER", "namespace_id": "1001", "simple": { "limit": 5, "period": 60 } }]`.
   */
  readonly limiter: Limiter
  /** Better Auth's `rateLimit` table, where each account's failed sign-ins are counted. */
  readonly table: SignInCountsTable
  readonly failures?: SignInFailures
  /**
   * How many leading bits of an IPv6 address name the client its limit
   * counts: every address in that network counts as one, as its owner can
   * send from any of them. A whole number from 1 to 128. Default 64, the
   * network an ISP or a host gives one customer; 48 or 56 where a provider
   * gives a customer more, 128 for each address alone.
   */
  readonly ipv6Prefix?: number
}

/** The limits a request applies: the binding it reads and the policy, resolved. */
export interface ActiveSignInLimits {
  readonly limiter: RateLimiter | undefined
  readonly limiterName: string
  readonly table: SignInCountsTable
  readonly max: number
  readonly windowMillis: number
  readonly cooldownMillis: number
  readonly ipv6Prefix: number
}

export class SignInLimits extends Context.Service<SignInLimits, ActiveSignInLimits>()('@popcomputer/web/SignInLimits') {}

const millisOf = (input: Duration.Input): number => {
  try {
    return Duration.toMillis(Duration.fromInputUnsafe(input))
  } catch {
    return Number.NaN
  }
}

/** The policy `failures` sets, with its defaults. */
function failuresPolicy(failures: SignInFailures | undefined) {
  return {
    max: failures?.max ?? 10,
    windowMillis: millisOf(failures?.window ?? '15 minutes'),
    cooldownMillis: millisOf(failures?.cooldown ?? '1 minute'),
  }
}

/**
 * Refuse `auth.signInLimits.failures` that would never cool an account down:
 * a `max` that is not a whole number of at least 1, or a `window` or
 * `cooldown` that is not a positive whole number of milliseconds, such as
 * `Number()` of a variable that is not set. setupWeb calls it.
 */
export function assertSignInLimitsConfig(config: SignInLimitsConfig): void {
  const { max, windowMillis, cooldownMillis } = failuresPolicy(config.failures)
  const invalid = [
    ...(Number.isSafeInteger(max) && max >= 1 ? [] : [`max ${String(max)}`]),
    ...(Number.isSafeInteger(windowMillis) && windowMillis > 0 ? [] : [`window ${String(config.failures?.window)}`]),
    ...(Number.isSafeInteger(cooldownMillis) && cooldownMillis > 0 ? [] : [`cooldown ${String(config.failures?.cooldown)}`]),
  ]

  if (invalid.length > 0) {
    throw new Error(
      `Invalid setupWeb configuration: auth.signInLimits.failures has ${invalid.join(', ')}, with which no account would ever cool down. ` +
        "Give max as a whole number of 1 or more, and window and cooldown as positive durations, such as '15 minutes' and '1 minute'."
    )
  }

  const prefix = config.ipv6Prefix ?? DEFAULT_IPV6_PREFIX

  if (!(Number.isSafeInteger(prefix) && prefix >= 1 && prefix <= 128)) {
    throw new Error(
      `Invalid setupWeb configuration: auth.signInLimits.ipv6Prefix is ${String(config.ipv6Prefix)}, which names no IPv6 network. ` +
        'Give a whole number of bits from 1 to 128, such as 64, or leave it out.'
    )
  }
}

/** The limits `setupWeb`'s configuration gives a request, reading its bindings. */
export function activeSignInLimits(config: SignInLimitsConfig, bindings: object): ActiveSignInLimits {
  const limiter: unknown = Reflect.get(bindings, config.limiter)

  return {
    limiter: limiter instanceof Object && Reflect.get(limiter, 'limit') instanceof Function
      // SAFETY: the binding has a limit method, which the Rate Limiting API's is.
      ? limiter as RateLimiter
      : undefined,
    limiterName: config.limiter,
    table: config.table,
    ...failuresPolicy(config.failures),
    ipv6Prefix: config.ipv6Prefix ?? DEFAULT_IPV6_PREFIX,
  }
}

/**
 * Better Auth's paths a client address is limited on: signing in and up, and
 * every password and verification call, except a sign-in through an identity
 * provider. `/verify-password` and `/delete-user` check the signed-in
 * account's password, as `/change-password` does: a stolen session must not
 * guess it unlimited. The seam suite fails on an endpoint of Better Auth's
 * that takes a password and is missing here.
 */
const ADDRESS_LIMITED = [
  '/sign-in', '/sign-up', '/change-password', '/change-email', '/reset-password', '/request-password-reset',
  '/forget-password', '/send-verification-email', '/verify-email', '/email-otp', '/two-factor', '/magic-link', '/phone-number',
  '/verify-password', '/delete-user',
]

/**
 * Sign-ins that send the visitor to an identity provider, which checks the
 * person and sends no email from here: an office signing in together through
 * one address is not guessing anything.
 */
const PROVIDER_SIGN_INS = ['/sign-in/social', '/sign-in/oauth2', '/sign-in/sso']

const under = (path: string, prefix: string): boolean => path === prefix || path.startsWith(`${prefix}/`)

/** Whether Better Auth's endpoint at `path` is one whose calls are limited. */
export const isLimitedPath = (path: string): boolean =>
  !PROVIDER_SIGN_INS.some((prefix) => under(path, prefix)) && ADDRESS_LIMITED.some((prefix) => under(path, prefix))

/**
 * Better Auth's endpoints that sign an account in with a password, and the
 * body field each finds the account by: a field another endpoint reads, such
 * as an email sent to the username sign-in, names nothing it checks.
 */
const ACCOUNT_FIELDS = {
  '/sign-in/email': 'email',
  '/sign-in/username': 'username',
  '/sign-in/phone-number': 'phoneNumber',
} as const

type PasswordSignInPath = keyof typeof ACCOUNT_FIELDS

/** Whether the endpoint at `path` signs an account in with a password, whose failures are counted. */
export const isPasswordSignIn = (path: string): path is PasswordSignInPath => Object.hasOwn(ACCOUNT_FIELDS, path)

/** What a sign-in attempt is limited by: the client's address, and the account it names. */
export interface SignInAttempt {
  readonly path: string
  readonly address: string
  readonly account: string | undefined
}

/** The network an IPv6 client counts as, unless `ipv6Prefix` says otherwise: what an ISP or a host gives one customer. */
const DEFAULT_IPV6_PREFIX = 64

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

/**
 * An IPv6 address's eight 16-bit groups, or undefined for text that is not
 * one. A zone, `%eth0`, names the interface, not the address, and an IPv4
 * address in the last 32 bits, `::ffff:203.0.113.7`, is two groups.
 */
function ipv6Groups(address: string): ReadonlyArray<number> | undefined {
  const [text = ''] = address.split('%', 1)
  const lastColon = text.lastIndexOf(':')

  if (lastColon === -1) return undefined

  const last = text.slice(lastColon + 1)
  const dotted = last.includes('.') ? last : undefined

  if (dotted !== undefined && !IPV4.test(dotted)) return undefined

  const octets = dotted?.split('.').map(Number) ?? []
  const hex = dotted === undefined
    ? text
    : `${text.slice(0, lastColon + 1)}${(((octets[0] ?? 0) << 8) | (octets[1] ?? 0)).toString(16)}:${(((octets[2] ?? 0) << 8) | (octets[3] ?? 0)).toString(16)}`
  const halves = hex.split('::')

  if (halves.length > 2) return undefined

  const groupsOf = (half: string | undefined) => (half === undefined || half === '' ? [] : half.split(':'))
  const left = groupsOf(halves[0])
  const right = groupsOf(halves[1])
  const elided = halves.length === 2 ? 8 - left.length - right.length : 0

  if (halves.length === 2 ? elided < 1 : left.length !== 8) return undefined

  const groups = [...left, ...Array.from({ length: elided }, () => '0'), ...right]

  return groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group)) ? groups.map((group) => Number.parseInt(group, 16)) : undefined
}

/**
 * The client an address counts as for its limit. An IPv6 address counts as
 * its network, its first `ipv6Prefix` bits, written in full: its owner can
 * send from any address in it, so each must not start a fresh count. One
 * that carries an IPv4 address, `::ffff:203.0.113.7`, counts as that IPv4
 * address. An IPv4 address, and text that is no address, such as
 * `'unknown'`, count as they are.
 */
export function addressRange(address: string, ipv6Prefix: number): string {
  const text = address.trim().toLowerCase()
  const groups = ipv6Groups(text)

  if (groups === undefined) return text

  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = groups

  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) return `${g >> 8}.${g & 0xff}.${h >> 8}.${h & 0xff}`

  const network = groups.map((group, index) => {
    const kept = Math.min(16, Math.max(0, ipv6Prefix - index * 16))

    return kept === 0 ? 0 : group & ((0xffff << (16 - kept)) & 0xffff)
  })

  return `${network.map((group) => group.toString(16)).join(':')}/${ipv6Prefix}`
}

/**
 * The client's address, as Cloudflare reports it. `X-Forwarded-For` is the
 * client's to write, so a request without Cloudflare's header shares one
 * address rather than naming its own.
 */
export function clientAddress(headers: Headers): string {
  return headers.get('cf-connecting-ip') ?? 'unknown'
}

/**
 * The account a password sign-in at `path` names: the field its endpoint
 * finds the account by, as the endpoint normalizes it. An email or a phone
 * number is trimmed and lowercased, as Better Auth lowercases an email; a
 * username is normalized by the username plugin's own normalizer, so every
 * spelling an application's `usernameNormalization` folds together counts
 * against one account. `betterAuth` is the registered Better Auth's options.
 * Undefined for any other endpoint, and for a body whose field is missing,
 * blank or not text.
 */
export function accountOf(path: string, body: unknown, betterAuth?: unknown): string | undefined {
  if (!isPasswordSignIn(path) || !(body instanceof Object)) return undefined

  const named: unknown = Reflect.get(body, ACCOUNT_FIELDS[path])

  if (typeof named !== 'string' || named.trim() === '') return undefined

  return path === '/sign-in/username' ? usernameOf(named, betterAuth) : named.trim().toLowerCase()
}

const property = (value: unknown, key: string): unknown => value instanceof Object ? Reflect.get(value, key) : undefined

/**
 * A username as the username plugin's `/sign-in/username` looks it up: by
 * the normalizer its username field transforms input with (the plugin's
 * `usernameNormalization`, or lowercasing), applied once more first when its
 * `validationOrder.username` is `'pre-normalization'`. Undefined when the
 * normalizer throws or returns no text, so the sign-in is refused before a
 * password is checked; lowercased without the plugin, whose endpoint is then
 * missing.
 */
function usernameOf(name: string, betterAuth: unknown): string | undefined {
  const plugins: unknown = property(betterAuth, 'plugins')
  const plugin: unknown = Array.isArray(plugins) ? plugins.find((each: unknown) => property(each, 'id') === 'username') : undefined
  const transform = property(property(property(property(property(plugin, 'schema'), 'user'), 'fields'), 'username'), 'transform')
  const normalizer: unknown = property(transform, 'input')

  if (!(normalizer instanceof Function)) return name.toLowerCase()

  const twice = property(property(property(plugin, 'options'), 'validationOrder'), 'username') === 'pre-normalization'

  try {
    const once: unknown = Reflect.apply(normalizer, transform, [name])
    const normalized: unknown = twice && typeof once === 'string' ? Reflect.apply(normalizer, transform, [once]) : once

    return typeof normalized === 'string' ? normalized : undefined
  } catch {
    return undefined
  }
}

/**
 * What a call to Better Auth's endpoint at `path` is limited by, given the
 * account `accountOf` read from its body. A password sign-in that names no
 * account is refused with a 400, before Better Auth checks its password, so
 * no guess goes uncounted.
 */
export function signInAttempt(path: string, headers: Headers, account: string | undefined): Effect.Effect<SignInAttempt, HttpError> {
  return isPasswordSignIn(path) && account === undefined
    ? Effect.fail(new HttpError({ status: 400, message: `This sign-in names no account: send its ${ACCOUNT_FIELDS[path]} as text.` }))
    : Effect.succeed({ path, address: clientAddress(headers), account })
}

/** A key for the account that stores no address: its SHA-256. */
const accountKey = (account: string): Effect.Effect<string> =>
  Effect.promise(async () => {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(account)))

    return `sign-in:${[...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
  })

/** The cooldown after `count` sign-ins: none below `max`, then doubling from `cooldownMillis`, up to the window. */
const cooldownAfter = (limits: ActiveSignInLimits, count: number): number =>
  count < limits.max ? 0 : Math.min(limits.windowMillis, limits.cooldownMillis * 2 ** (count - limits.max))

/**
 * The row's states as SQL, each the same rule as `cooldownAfter`: the
 * cooldown its count earned, whether it is cooling at `now`, and whether it
 * is spent. The policy's numbers, which setupWeb checked are whole, are
 * written into the statement, so every dialect reads them as integers.
 */
function rowStates(limits: ActiveSignInLimits, table: SignInCountsTable, now: number, sql: typeof import('drizzle-orm').sql) {
  const literal = (value: number) => sql.raw(String(value))
  const doublings: SQL[] = []

  for (let extra = 0, millis = limits.cooldownMillis; millis < limits.windowMillis; extra++, millis *= 2) {
    doublings.push(sql`when ${table.count} = ${literal(limits.max + extra)} then ${literal(millis)}`)
  }

  const cooldown = sql`(case when ${table.count} < ${literal(limits.max)} then 0 ${sql.join(doublings, sql` `)} else ${literal(limits.windowMillis)} end)`

  return {
    cooling: sql`${table.count} >= ${literal(limits.max)} and ${table.lastRequest} + ${cooldown} > ${now}`,
    spent: sql`${table.lastRequest} + ${cooldown} + ${literal(limits.windowMillis)} <= ${now}`,
  }
}

const refused = (retryAfterMillis: number) =>
  new AuthRateLimitError({ retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMillis / 1000)), cause: undefined })

/** Count one call on the Rate Limiting binding; a refusal fails with AuthRateLimitError. */
const limit = (limits: ActiveSignInLimits, key: string): Effect.Effect<void, AuthRateLimitError> => {
  const limiter = limits.limiter

  if (limiter === undefined) {
    return Effect.die(new Error(
      `auth.signInLimits names the Rate Limiting binding ${limits.limiterName}, which this request's bindings lack. ` +
        'Declare it under "ratelimits" in wrangler.jsonc, and in a test give it testRateLimiter().'
    ))
  }

  return Effect.promise(() => limiter.limit({ key })).pipe(
    Effect.flatMap((outcome) => outcome.success ? Effect.void : Effect.fail(refused(60_000)))
  )
}

/** A Drizzle client's query builder, as the counts are read and written through it whatever the dialect. */
interface CountsClient {
  select(fields: object): { from(table: Table): { where(condition: unknown): { limit(count: number): PromiseLike<ReadonlyArray<{ count: number; lastRequest: number }>> } } }
  insert(table: Table): {
    values(row: object): {
      onConflictDoUpdate(config: { target: Column; set: object; setWhere: SQL }): { returning(fields: object): PromiseLike<ReadonlyArray<{ count: number }>> }
    }
  }
  delete(table: Table): { where(condition: unknown): PromiseLike<unknown> }
}

const counts = Effect.flatMap(Effect.serviceOption(DatabaseService), (db) =>
  Option.isNone(db)
    ? Effect.die(new Error('auth.signInLimits counts failed sign-ins in Better Auth\'s rateLimit table, but setupWeb has no database.'))
    // SAFETY: the database is the application's Drizzle client, and the
    // table one of its tables; the counts use the builder calls every SQL
    // dialect Drizzle supports for D1 and Postgres shares.
    : Effect.succeed(db.value as unknown as CountsClient)
)

/**
 * Whether the registered Better Auth keeps its own request counts through
 * its database adapter, `rateLimit: { storage: 'database' }`. Each rollover
 * of one of its windows then deletes every row of its rateLimit model older
 * than its longest window, a minute by default, the account failure counts
 * kept here among them. Which table that model is the adapter decides, so a
 * `modelName` of its own is no proof the counts are spared.
 */
function prunesCounts(betterAuth: unknown): boolean {
  const rateLimit = property(betterAuth, 'rateLimit')

  if (property(rateLimit, 'enabled') === false || property(rateLimit, 'customStorage') !== undefined) return false

  // Better Auth's default: its secondary storage when it has one, else memory.
  const storage = property(rateLimit, 'storage') ?? (property(betterAuth, 'secondaryStorage') === undefined ? 'memory' : 'secondary-storage')

  return storage !== 'memory' && storage !== 'secondary-storage'
}

/**
 * The configuration error for `auth.signInLimits` beside a Better Auth whose
 * rate-limit storage would delete the counts, or none. `betterAuth` is the
 * registered Better Auth's options. setupWeb checks it as it builds Better
 * Auth for each request, so a misconfigured application fails on its first
 * request of any kind, as a misconfigured env does, not only on a sign-in.
 */
export function signInLimitsStorageError(betterAuth: unknown): Error | undefined {
  if (!prunesCounts(betterAuth)) return undefined

  return new Error(
    "auth.signInLimits counts each account's failed sign-ins in a rateLimit table, and Better Auth's rateLimit " +
      "storage 'database' deletes that table's rows by age, the counts among them. Keep Better Auth's limits in " +
      "memory, betterAuth({ rateLimit: { enabled: true, storage: 'memory' } }), or in its secondary storage."
  )
}

/**
 * Run a call to Better Auth within the sign-in limits: the address, and for a
 * password sign-in the account, are counted on the Rate Limiting binding; a
 * password sign-in is counted against its account before the call, unless
 * the account cools down, which refuses it, and a successful one clears the
 * count. Without `auth.signInLimits`, the call runs as it is. `betterAuth` is
 * the registered Better Auth's options: with limits whose storage would
 * delete the counts, every call fails, naming the fix.
 */
export function withinSignInLimits<E, R>(
  attempt: SignInAttempt,
  call: Effect.Effect<Response, E, R>,
  betterAuth: unknown
): Effect.Effect<Response, E | AuthRateLimitError, R> {
  return Effect.gen(function* () {
    const configured = yield* Effect.serviceOption(SignInLimits)

    if (Option.isNone(configured)) return yield* call

    // setupWeb refuses this before any route runs; this guards a call made
    // with the limits but outside setupWeb's own request setup.
    const storageError = signInLimitsStorageError(betterAuth)

    if (storageError !== undefined) return yield* Effect.die(storageError)

    if (!isLimitedPath(attempt.path)) return yield* call

    const limits = configured.value

    yield* limit(limits, `address:${addressRange(attempt.address, limits.ipv6Prefix)}`)

    if (attempt.account === undefined || !isPasswordSignIn(attempt.path)) return yield* call

    const key = yield* accountKey(attempt.account)

    yield* limit(limits, key)

    const db = yield* counts
    const { eq, sql } = yield* drizzle
    const table = limits.table
    const now = yield* Clock.currentTimeMillis
    const { cooling, spent } = rowStates(limits, table, now, sql)

    // One statement counts the sign-in, afresh once the row is spent, unless
    // the account is cooling down, when it writes nothing and returns no row.
    const counted = yield* Effect.promise(() =>
      db.insert(table)
        .values({ id: crypto.randomUUID(), key, count: 1, lastRequest: now })
        .onConflictDoUpdate({
          target: table.key,
          set: { count: sql`case when ${spent} then 1 else ${table.count} + 1 end`, lastRequest: now },
          setWhere: sql`not (${cooling})`,
        })
        .returning({ count: table.count })
    )

    if (counted.length === 0) {
      const [row] = yield* Effect.promise(() => db.select({ count: table.count, lastRequest: table.lastRequest }).from(table).where(eq(table.key, key)).limit(1))

      return yield* Effect.fail(refused(row === undefined ? 0 : row.lastRequest + cooldownAfter(limits, row.count) - now))
    }

    const response = yield* call

    if (response.ok) yield* Effect.promise(() => db.delete(table).where(eq(table.key, key)))

    return response
  })
}

/**
 * Delete the counts that are spent: a window has passed since the end of
 * their cooldown. Run it from a Cron Trigger, so made-up addresses do not
 * keep rows: `scheduled: routes.scheduled(() => sweepSignInFailures)`.
 */
export const sweepSignInFailures: Effect.Effect<void> = Effect.gen(function* () {
  const configured = yield* Effect.serviceOption(SignInLimits)

  if (Option.isNone(configured)) {
    return yield* Effect.die(new Error("sweepSignInFailures sweeps the counts of setupWeb's auth.signInLimits, which is not configured."))
  }

  const limits = configured.value
  const db = yield* counts
  const { and, like, sql } = yield* drizzle
  const now = yield* Clock.currentTimeMillis
  const table = limits.table

  yield* Effect.promise(() => db.delete(table).where(and(like(table.key, 'sign-in:%'), rowStates(limits, table, now, sql).spent)))
})
