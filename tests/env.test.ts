/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
/**
 * Env Declaration Tests
 *
 * An application declares its vars and secrets once. The declaration types
 * the bindings, `checkEnv` lists what is missing or invalid without a value,
 * and `setupWeb` checks each isolate's bindings before serving it.
 */

import { describe, expect, spyOn, test } from 'bun:test'
import { Effect, Schema as S } from 'effect'
import { Hono } from 'hono'
import { setupWeb } from '../src/setup.js'
import { action } from '../src/effect/action.js'
import { json } from '../src/effect/responses.js'
import { checkEnv, defineEnv, describeEnvProblem, EnvInvalid, randomSecret, secret, variable, type EnvBindings } from '../src/env.js'
import { testBatch, testEnv } from '../src/testing.js'

const env = defineEnv({
  AUTH_SECRET: secret(S.String.check(S.isMinLength(32)), { generate: randomSecret }),
  MAIL_KEY: secret(S.String.check(S.isStartingWith('re_'))),
  SENTRY_DSN: secret(S.String, { optional: true }),
  ENVIRONMENT: variable(S.Literals(['development', 'production', 'test'])),
  TIME_ZONE: variable(S.String, { optional: true }),
})

type Bindings = EnvBindings<typeof env>

const valid = {
  AUTH_SECRET: 'a-secret-of-thirty-two-characters-or-more',
  MAIL_KEY: 're_0123456789',
  ENVIRONMENT: 'test',
} satisfies Bindings

describe('the declaration', () => {
  test('types the bindings as the Worker receives them', () => {
    const bindings: Bindings = { ...valid, TIME_ZONE: 'Europe/London' }
    const environment: 'development' | 'production' | 'test' = bindings.ENVIRONMENT
    const timeZone: string | undefined = bindings.TIME_ZONE

    // @ts-expect-error a required secret is required
    const withoutKey: Bindings = { AUTH_SECRET: valid.AUTH_SECRET, ENVIRONMENT: 'test' }
    // @ts-expect-error a var's schema types its value
    const staging: Bindings = { ...valid, ENVIRONMENT: 'staging' }
    // @ts-expect-error the Worker receives every var and secret as a string
    secret(S.Number)

    expect([environment, timeZone, withoutKey, staging]).toHaveLength(4)
  })

  test('marks each entry a secret or a var, required or optional', () => {
    expect(env.entries.AUTH_SECRET).toMatchObject({ kind: 'secret', optional: false })
    expect(env.entries.AUTH_SECRET.generate).toBe(randomSecret)
    expect(env.entries.MAIL_KEY.generate).toBeUndefined()
    expect(env.entries.SENTRY_DSN).toMatchObject({ kind: 'secret', optional: true })
    expect(env.entries.ENVIRONMENT).toMatchObject({ kind: 'variable', optional: false })

    const required: false = env.entries.MAIL_KEY.optional
    const optional: true = env.entries.TIME_ZONE.optional

    expect([required, optional]).toEqual([false, true])
  })

  test('generates 32 random bytes in base64', () => {
    const one = randomSecret()

    expect(atob(one)).toHaveLength(32)
    expect(randomSecret()).not.toBe(one)
  })
})

describe('checkEnv', () => {
  test('finds nothing wrong with values the declaration accepts', () => {
    expect(checkEnv(env, valid)).toEqual([])
    expect(checkEnv(env, { ...valid, SENTRY_DSN: 'https://sentry.example', TIME_ZONE: 'UTC', OTHER: 1 })).toEqual([])
  })

  test('lists each missing var and secret the Worker needs, and no optional one', () => {
    expect(checkEnv(env, {})).toEqual([
      { name: 'AUTH_SECRET', kind: 'secret', problem: 'missing' },
      { name: 'MAIL_KEY', kind: 'secret', problem: 'missing' },
      { name: 'ENVIRONMENT', kind: 'variable', problem: 'missing' },
    ])
  })

  test('reads an empty secret as missing', () => {
    expect(checkEnv(env, { ...valid, MAIL_KEY: '' })).toEqual([{ name: 'MAIL_KEY', kind: 'secret', problem: 'missing' }])
    expect(checkEnv(env, { ...valid, SENTRY_DSN: '' })).toEqual([])
  })

  test('says what an invalid value should be, never the value', () => {
    const problems = checkEnv(env, { ...valid, AUTH_SECRET: 'too-short-to-sign-with', ENVIRONMENT: 'staging' })

    expect(problems).toEqual([
      { name: 'AUTH_SECRET', kind: 'secret', problem: 'invalid', expected: 'Expected a value with a length of at least 32' },
      { name: 'ENVIRONMENT', kind: 'variable', problem: 'invalid', expected: 'Expected "development" | "production" | "test"' },
    ])
    expect(JSON.stringify(problems)).not.toContain('too-short-to-sign-with')
    expect(JSON.stringify(problems)).not.toContain('staging')
  })

  test("hides a value a schema's own message repeats", () => {
    const leaky = defineEnv({
      API_KEY: secret(S.String.check(S.makeFilter((key) => key.startsWith('sk_') || `${key} is not a key`))),
    })

    const [problem] = checkEnv(leaky, { API_KEY: 'pk_live_0123456789' })

    expect(problem?.expected).toBe('[redacted] is not a key')
  })

  test("ends a schema's own sentence once", () => {
    const keyed = defineEnv({ API_KEY: secret(S.String.check(S.isStartingWith('sk_', { message: 'Use a secret key.' }))) })
    const [problem] = checkEnv(keyed, { API_KEY: 'pk_0123' })

    expect(problem && describeEnvProblem(problem)).toBe('The secret API_KEY is invalid: Use a secret key.')
  })

  test('describes each problem in a sentence', () => {
    const [missing, invalid] = checkEnv(env, { ...valid, MAIL_KEY: undefined, ENVIRONMENT: 'staging' })

    expect(missing && describeEnvProblem(missing)).toBe('The secret MAIL_KEY is missing.')
    expect(invalid && describeEnvProblem(invalid)).toBe(
      'The variable ENVIRONMENT is invalid: Expected "development" | "production" | "test".'
    )
  })
})

describe("setupWeb's env", () => {
  function createApp() {
    const app = new Hono<{ Bindings: Bindings }>()
    const databases = { made: 0 }
    const { routes } = setupWeb(app, {
      version: '1',
      render: (page) => JSON.stringify(page),
      env,
      database: () => {
        databases.made += 1

        return {}
      },
    })

    routes.get('/', action(json({ ok: true })))

    return { app, routes, databases }
  }

  const api = { headers: { Accept: 'application/json' } }

  test('serves bindings the declaration accepts', async () => {
    const { app } = createApp()
    const res = await app.request('/', api, testEnv(valid))

    expect(res.status).toBe(200)
  })

  test('fails a request whose bindings it refuses, naming each var and secret before making a database', async () => {
    const { app, databases } = createApp()
    const res = await app.request('/', api, testEnv({ ...valid, MAIL_KEY: undefined, ENVIRONMENT: 'development' }))

    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({
      code: 'WEB_CFG_306_ENV_INVALID',
      message: expect.stringContaining('The secret MAIL_KEY is missing.'),
    })
    expect(databases.made).toBe(0)
  })

  test('logs the problems once for each isolate, since a production page names none', async () => {
    const { app } = createApp()
    const logged = spyOn(console, 'log').mockImplementation(() => {})

    try {
      // A development server gives each request bindings of its own.
      await app.request('/', api, testEnv({ ...valid, MAIL_KEY: undefined, ENVIRONMENT: 'production' }))
      await app.request('/', api, testEnv({ ...valid, MAIL_KEY: undefined, ENVIRONMENT: 'production' }))

      const lines = logged.mock.calls.map((call) => call.map(String).join(' '))

      expect(lines.filter((line) => line.includes('The secret MAIL_KEY is missing.'))).toHaveLength(1)
    } finally {
      logged.mockRestore()
    }
  })

  test('names nothing outside development, and never a value', async () => {
    const { app } = createApp()
    const production = await app.request('/', api, testEnv({ ...valid, AUTH_SECRET: 'short-secret-value', ENVIRONMENT: 'production' }))
    const development = await app.request('/', api, testEnv({ ...valid, AUTH_SECRET: 'short-secret-value', ENVIRONMENT: 'development' }))

    expect(production.status).toBe(500)
    expect(await production.text()).not.toContain('AUTH_SECRET')
    expect(await development.text()).not.toContain('short-secret-value')
  })

  test('rejects a Cron run or routes.run with EnvInvalid', async () => {
    const { routes } = createApp()
    const bindings = testEnv({ ...valid, MAIL_KEY: undefined })

    const scheduled = routes.scheduled(() => Effect.void)({ cron: '0 3 * * *', scheduledTime: 0 }, bindings)

    await expect(scheduled).rejects.toBeInstanceOf(EnvInvalid)
    await expect(routes.run(Effect.succeed(1), bindings)).rejects.toMatchObject({
      _tag: 'EnvInvalid',
      problems: [{ name: 'MAIL_KEY', kind: 'secret', problem: 'missing' }],
    })
  })

  test("leaves a queue's messages to retry", async () => {
    const { routes } = createApp()
    const batch = testBatch([{ orderId: 'order-1' }])

    await routes.queue(S.Struct({ orderId: S.String }), () => Effect.void)(batch, testEnv({ ...valid, MAIL_KEY: undefined }))

    expect(batch.retried()).toEqual([{ orderId: 'order-1' }])
  })
})
