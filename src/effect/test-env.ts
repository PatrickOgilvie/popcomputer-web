import type { Layer } from 'effect'

/**
 * Test layers attached to request env objects by `testEnv`
 * (@popcomputer/web/testing). Keyed by the env object Hono passes through as
 * `c.env`, so only an env built by `testEnv` carries a layer: no Workers
 * binding or configuration value can add services to a request.
 */
const testLayers = new WeakMap<object, Layer.Layer<never>>()

/** Attach `layer` to `env` for effectBridge to merge into the request runtime. */
export function attachTestLayer(env: object, layer: Layer.Layer<never>): void {
  testLayers.set(env, layer)
}

/** The test layer attached to this request env, if any. */
export function readTestLayer(env: unknown): Layer.Layer<never> | undefined {
  return env instanceof Object ? testLayers.get(env) : undefined
}
