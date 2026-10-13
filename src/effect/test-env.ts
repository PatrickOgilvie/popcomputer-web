import type { Layer } from 'effect'

/**
 * Test state attached to request env objects by `testEnv`
 * (@popcomputer/web/testing). Keyed by the env object Hono passes through as
 * `c.env`, so only an env built by `testEnv` carries it: no Workers binding or
 * configuration value can add services or replace the database.
 */
const testLayers = new WeakMap<object, Layer.Layer<never>>()
const testDatabases = new WeakMap<object, object>()

/** Attach `layer` to `env` for effectBridge to merge into the request runtime. */
export function attachTestLayer(env: object, layer: Layer.Layer<never>): void {
  testLayers.set(env, layer)
}

/** The test layer attached to this request env, if any. */
export function readTestLayer(env: unknown): Layer.Layer<never> | undefined {
  return env instanceof Object ? testLayers.get(env) : undefined
}

/** Attach the database a test request uses in place of setupWeb's `database` factory. */
export function attachTestDatabase(env: object, database: object): void {
  testDatabases.set(env, database)
}

/** The database a test attached to this request env, if any. */
export function readTestDatabase(env: unknown): object | undefined {
  return env instanceof Object ? testDatabases.get(env) : undefined
}

/** Carry a test env's attachments to a copy of it. */
export function copyTestState(from: unknown, to: object): void {
  const layer = readTestLayer(from)
  const database = readTestDatabase(from)

  if (layer !== undefined) attachTestLayer(to, layer)
  if (database !== undefined) attachTestDatabase(to, database)
}
