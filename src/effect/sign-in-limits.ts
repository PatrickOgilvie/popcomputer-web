/**
 * Limits on signing in, so guessing passwords is slow whichever addresses
 * the guesses come from.
 *
 * Two layers, cheapest first:
 *
 * - A Cloudflare Workers Rate Limiting binding counts every sign-in, sign-up
 *   and password call per client address, and every sign-in per account,
 *   over its short window (10 or 60 seconds), at Cloudflare's edge, with no
 *   database write.
 * - Better Auth's `rateLimit` table counts an account's failed sign-ins over
 *   a long window. Past `max`, the account cools down, for longer with each
 *   further failure, up to the window: a sign-in during a cooldown is refused
 *   before the password is checked. A cooldown, not a lock, so someone who
 *   knows an address can delay its owner, never shut them out.
 *
 * Only a failure writes a row, and a successful sign-in deletes the account's
 * row if it has one. `sweepSignInFailures` deletes the rows whose window has
 * passed, from a Cron Trigger.
 */

import type { Column, Table } from 'drizzle-orm'
import { Clock, Context, Duration, Effect, Option } from 'effect'
import { AuthRateLimitError } from './errors.js'
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

/** How an account's failed sign-ins slow the next ones. */
export interface SignInFailures {
  /** Failed sign-ins within `window` before the account cools down. Default 10. */
  readonly max?: number
  /** How long a failure counts. Default 15 minutes. */
  readonly window?: Duration.Input
  /** The first cooldown, doubled by each further failure, up to `window`. Default 1 minute. */
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
}

/** The limits a request applies: the binding it reads and the policy, resolved. */
export interface ActiveSignInLimits {
  readonly limiter: RateLimiter | undefined
  readonly limiterName: string
  readonly table: SignInCountsTable
  readonly max: number
  readonly windowMillis: number
  readonly cooldownMillis: number
}

export class SignInLimits extends Context.Service<SignInLimits, ActiveSignInLimits>()('@popcomputer/web/SignInLimits') {}

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
    max: config.failures?.max ?? 10,
    windowMillis: Duration.toMillis(Duration.fromInputUnsafe(config.failures?.window ?? '15 minutes')),
    cooldownMillis: Duration.toMillis(Duration.fromInputUnsafe(config.failures?.cooldown ?? '1 minute')),
  }
}

/** Better Auth's paths a client address is limited on: signing in and up, and every password and verification call, except a sign-in through an identity provider. */
const ADDRESS_LIMITED = [
  '/sign-in', '/sign-up', '/change-password', '/change-email', '/reset-password', '/request-password-reset',
  '/forget-password', '/send-verification-email', '/verify-email', '/email-otp', '/two-factor', '/magic-link', '/phone-number',
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

/** Whether the endpoint at `path` signs an account in with a password, whose failures are counted. */
export const isPasswordSignIn = (path: string): boolean => path === '/sign-in/email' || path === '/sign-in/username'

/** What a sign-in attempt is limited by: the client's address, and the account it names. */
export interface SignInAttempt {
  readonly path: string
  readonly address: string
  readonly account: string | undefined
}

/**
 * The client's address, as Cloudflare reports it. `X-Forwarded-For` is the
 * client's to write, so a request without Cloudflare's header shares one
 * address rather than naming its own.
 */
export function clientAddress(headers: Headers): string {
  return headers.get('cf-connecting-ip') ?? 'unknown'
}

/** The account a sign-in names, from its body: the email, or a username, lowercased. */
export function accountOf(body: unknown): string | undefined {
  if (!(body instanceof Object)) return undefined

  const named: unknown = Reflect.get(body, 'email') ?? Reflect.get(body, 'username')

  return typeof named === 'string' && named.trim() !== '' ? named.trim().toLowerCase() : undefined
}

/** A key for the account that stores no address: its SHA-256. */
const accountKey = (account: string): Effect.Effect<string> =>
  Effect.promise(async () => {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(account)))

    return `sign-in:${[...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
  })

/** The cooldown after `count` failures: none below `max`, then doubling from `cooldownMillis`, up to the window. */
const cooldownAfter = (limits: ActiveSignInLimits, count: number): number =>
  count < limits.max ? 0 : Math.min(limits.windowMillis, limits.cooldownMillis * 2 ** (count - limits.max))

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
      onConflictDoUpdate(config: { target: Column; set: object }): { returning(fields: object): PromiseLike<ReadonlyArray<{ count: number }>> }
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
 * Run a call to Better Auth within the sign-in limits: the address, and for a
 * password sign-in the account, are counted on the Rate Limiting binding,
 * and a sign-in during the account's cooldown is refused before the call; a
 * failed sign-in (401) is counted, and a successful one clears the count.
 * Without `auth.signInLimits`, the call runs as it is.
 */
export function withinSignInLimits<E, R>(
  attempt: SignInAttempt,
  call: Effect.Effect<Response, E, R>
): Effect.Effect<Response, E | AuthRateLimitError, R> {
  return Effect.gen(function* () {
    const configured = yield* Effect.serviceOption(SignInLimits)

    if (Option.isNone(configured) || !isLimitedPath(attempt.path)) return yield* call

    const limits = configured.value

    yield* limit(limits, `address:${attempt.address}`)

    if (attempt.account === undefined || !isPasswordSignIn(attempt.path)) return yield* call

    const key = yield* accountKey(attempt.account)

    yield* limit(limits, key)

    const db = yield* counts
    const { eq, sql } = yield* drizzle
    const table = limits.table
    const now = yield* Clock.currentTimeMillis
    const [row] = yield* Effect.promise(() => db.select({ count: table.count, lastRequest: table.lastRequest }).from(table).where(eq(table.key, key)).limit(1))
    const current = row !== undefined && row.lastRequest > now - limits.windowMillis ? row : undefined

    if (current !== undefined) {
      const until = current.lastRequest + cooldownAfter(limits, current.count)

      if (until > now) return yield* Effect.fail(refused(until - now))
    }

    const response = yield* call

    if (response.status === 401) {
      // One write, counting afresh once the window has passed.
      yield* Effect.promise(() =>
        db.insert(table)
          .values({ id: crypto.randomUUID(), key, count: 1, lastRequest: now })
          .onConflictDoUpdate({
            target: table.key,
            set: {
              count: sql`case when ${table.lastRequest} <= ${now - limits.windowMillis} then 1 else ${table.count} + 1 end`,
              lastRequest: now,
            },
          })
          .returning({ count: table.count })
      )
    } else if (response.ok && row !== undefined) {
      yield* Effect.promise(() => db.delete(table).where(eq(table.key, key)))
    }

    return response
  })
}

/**
 * Delete the counts of failed sign-ins whose window has passed. Run it from a
 * Cron Trigger, so made-up addresses do not keep rows:
 * `scheduled: routes.scheduled(() => sweepSignInFailures)`.
 */
export const sweepSignInFailures: Effect.Effect<void> = Effect.gen(function* () {
  const configured = yield* Effect.serviceOption(SignInLimits)

  if (Option.isNone(configured)) {
    return yield* Effect.die(new Error("sweepSignInFailures sweeps the counts of setupWeb's auth.signInLimits, which is not configured."))
  }

  const limits = configured.value
  const db = yield* counts
  const { and, like, lt } = yield* drizzle
  const now = yield* Clock.currentTimeMillis
  const table = limits.table

  yield* Effect.promise(() =>
    db.delete(table).where(and(like(table.key, 'sign-in:%'), lt(table.lastRequest, now - limits.windowMillis)))
  )
})
