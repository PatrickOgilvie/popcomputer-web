/**
 * Whether the application runs in development, decided once for every place
 * that asks: the error page's details, the page cache, which keeps nothing in
 * development, and the warnings a route gives its developer.
 */

import type { Context, Env } from 'hono'

/** The binding that says the application runs in development, and the value that says so: setupWeb's `errors.envKey` and `errors.devValue`. */
export interface DevelopmentSignal {
  readonly envKey?: string
  readonly devValue?: string
}

/**
 * Whether the Worker's bindings say it runs in development: `envKey`
 * (`ENVIRONMENT` unless set) holds `devValue` (`development` unless set), or,
 * for the default key, `NODE_ENV` does. Development is only ever said, never
 * inferred: Cloudflare sets `CF_PAGES_BRANCH` on every Pages deployment,
 * production included, so reading it would show production's visitors stack
 * traces. A Pages preview that wants development sets `ENVIRONMENT`.
 */
export function isDevelopment<E extends Env>(c: Context<E>, signal: DevelopmentSignal = {}): boolean {
  const { envKey = 'ENVIRONMENT', devValue = 'development' } = signal
  const env: object = c.env ?? {}

  return Object.getOwnPropertyDescriptor(env, envKey)?.value === devValue ||
    (envKey === 'ENVIRONMENT' && Object.getOwnPropertyDescriptor(env, 'NODE_ENV')?.value === devValue)
}

/** Whether the bindings say which environment this is at all, by `envKey` or `NODE_ENV`. */
export function declaresEnvironment<E extends Env>(c: Context<E>, signal: DevelopmentSignal = {}): boolean {
  const env: object = c.env ?? {}

  return Object.getOwnPropertyDescriptor(env, signal.envKey ?? 'ENVIRONMENT')?.value !== undefined ||
    Object.getOwnPropertyDescriptor(env, 'NODE_ENV')?.value !== undefined
}
