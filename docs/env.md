# Vars and secrets

An application declares its Worker's vars and secrets once, in
`src/env.ts`: each one's schema, whether it is a secret, whether the Worker
needs it, and how to make a value when nobody has to choose one. The
declaration types the bindings, each isolate checks its bindings against it
before serving, and scripts check it locally and before a deploy.

## Declaring them

The Quick start's `src/env.ts`, with a queue's binding beside the others:

```ts
import { Schema as S } from 'effect'
import { defineEnv, randomSecret, secret, variable, type EnvBindings } from '@popcomputer/web/env'

/** The Worker's vars and secrets, each declared once. */
export const env = defineEnv({
  DATABASE_URL: secret(),
  // Signs sessions: generated the first time, and replacing it signs everyone out.
  BETTER_AUTH_SECRET: secret(S.String.check(S.isMinLength(32)), { generate: randomSecret }),
  PAYMENT_WEBHOOK_SECRET: secret(S.String.check(S.isStartingWith('whsec_'))),
  // The origin Better Auth's emailed links name, never the host a request reached.
  APP_URL: variable(S.String),
  TIME_ZONE: variable(S.String, { optional: true }),
})

export type Bindings = EnvBindings<typeof env> & {
  KV: KVNamespace
  SIGN_IN_LIMITER: RateLimit
  // A Queues producer, as wrangler.jsonc's queues.producers binds it.
  REMINDERS: Queue
}

export type Env = { Bindings: Bindings }
```

- `secret(schema, options)` declares a secret: set on Cloudflare with
  `wrangler secret put NAME`, and in `.dev.vars` for the development server,
  never in `wrangler.jsonc`, where it would be committed. `secret()` alone
  is any non-empty string.
- `variable(schema, options)` declares a plain var, set in `wrangler.jsonc`'s
  `vars`. `variable()` alone is any string.
- `{ optional: true }` lets the Worker run without it. Every other var and
  secret is required.
- `{ generate }` makes a value for a secret nobody has to choose, such as a
  signing key: `randomSecret` makes 32 random bytes in base64. A script can
  then write one locally and upload one before the first deploy, as the
  demo's do. A secret without it must be set by hand, such as an API key
  another service issued.

The Worker receives every var and secret as a string, so each schema decodes
from one: `S.Literals(['development', 'production'])`, a string with checks,
or `S.FiniteFromString` for a number. A schema that does not, such as
`S.Number`, is a type error. `EnvBindings<typeof env>` is each value as the
Worker receives it, optional ones optional; the bindings that are not vars
or secrets, such as D1, KV or a rate limiter, stay in the type beside it, as
`wrangler.jsonc` declares them.

## Checked when an isolate starts

Pass the declaration to `setupWeb` as `env`, beside the rest of the
configuration, as the Quick start's
[`src/app.ts`](setup.md#3-configure-the-application-once-and-register-it)
does: `setupWeb(new Hono<Env>(), { ..., env })`.

Each isolate checks its bindings on its first request, Cron run or queue
batch, before the database or the auth client is made; a development server,
which gives each request bindings of its own, has each request's checked. A
var or secret that is missing, or that its schema refuses, fails every
request with `EnvInvalid`, which names each one and never a value:

```text
The Worker's vars and secrets do not match the env declaration:
- The secret PAYMENT_WEBHOOK_SECRET is missing.
- The secret BETTER_AUTH_SECRET is invalid: Expected a value with a length of at least 32.
```

The isolate logs each failure once, through Effect's logger, so the
Worker's logs name each problem in production too. The request answers 500
with the error page, code `WEB_CFG_306_ENV_INVALID`: as for any server
error, the page names the problems in development, and elsewhere says only
that the server failed. `routes.scheduled` and `routes.run` reject with
`EnvInvalid`, so the platform records the failed run, and `routes.queue`
leaves each message to retry. An empty secret counts as missing.

A test's bindings go through the same check, so `testEnv` takes every
required var and secret; a test of the failure leaves one out.

## Checking them before a deploy

`checkEnv(env, values)` checks any set of values against the declaration
and lists each problem, without its value, for a script that runs outside
the Worker. `@popcomputer/web/env` imports only `effect`, so a script reads
the same `src/env.ts` the Worker does:

```ts
// scripts/check-env.ts
import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { checkEnv, describeEnvProblem } from '@popcomputer/web/env'
import { env } from '../src/env'

const problems = checkEnv(env, parseEnv(readFileSync('.dev.vars', 'utf8')))

for (const problem of problems) console.error(describeEnvProblem(problem))
process.exitCode = problems.length === 0 ? 0 : 1
```

The development server reads `wrangler.jsonc`'s `vars` too, with `.dev.vars`
over them, so a script checking what it will see passes both.

Each problem is `{ name, kind, problem, expected }`: `kind` is `'secret'` or
`'variable'`, `problem` is `'missing'` or `'invalid'`, and `expected` says
what the schema wants. `env.entries` lists each var and secret with its
`kind`, `optional`, `generate` and `schema`, for a script that sets them.

The demo's scripts use both, as
[its README](https://github.com/PatrickOgilvie/popcomputer-web-demo#vars-and-secrets)
shows:

- `bun run env:check` checks `.dev.vars` and the vars.
- `bun run env:check --remote` checks every required secret is on Cloudflare.
- `bun run secret NAME` checks a value before uploading it.
- `bun run deploy` refuses to deploy while a secret it cannot generate is
  missing, and uploads one it can.

## Reading them

Read a var or a secret in an action, a service or a job through the
declaration, `yield* env.config.NAME`, as its own schema decodes it:
`variable(S.FiniteFromString)` reads as a number and
`S.Literals(['development', 'production'])` as that union, a secret reads as
`Redacted`, and an optional one as an `Option`. Each is an Effect `Config`
over the request's or the job's bindings, so `Config.withDefault` and the
rest of Effect's `Config` apply, and a name the declaration does not hold is
a type error:

```ts
// src/settings.ts
import { Effect, Option, Redacted } from 'effect'
import { env } from './env'

export const paymentSettings = Effect.gen(function* () {
  const secret = yield* env.config.PAYMENT_WEBHOOK_SECRET
  const timeZone = Option.getOrElse(yield* env.config.TIME_ZONE, () => 'UTC')

  return { signing: Redacted.value(secret).length, timeZone }
})
```

A value its schema refuses fails the read with a configuration error, as
`setupWeb`'s check would have at startup; a secret's never shows its value.
An empty value reads as missing, as Effect reads one, though the startup
check accepts an empty var. In `setupWeb`'s factories, read `c.env`, as the
Quick start's `auth.client` reads `c.env.BETTER_AUTH_SECRET`.
`config.string('NAME')` and `config.redacted('KEY')` from
`@popcomputer/web/effect` read a binding the declaration does not hold, as a
string.
