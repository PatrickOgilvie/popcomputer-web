/**
 * The application's settings every request reads, resolved once, with their
 * defaults: the error page, where sign-in and home are, how much of a body
 * the framework reads, the session cookie's name, and the schema and
 * bindings route models load through.
 *
 * setupWeb builds one and hands each request the same value. A stack composed
 * by hand has none: there, `setupOf` builds one from what its middleware
 * registered on the request, as `loadUser({ sessionCookie })` and
 * `effectBridge({ schema, bindings })` do.
 */

import { Context as EffectContext } from 'effect'
import type { Context, Env } from 'hono'
import type { RouteBindingsConfig } from './effect/binding.js'
import { DEFAULT_BODY_LIMIT } from './effect/body-limit.js'
import type { ErrorBoundaryConfig } from './effect/handler.js'
import { openWebContext } from './request-context.js'
import { sessionCookies, type SessionCookies } from './session-cookies.js'

/** One application's settings, with their defaults. */
export interface WebSetup {
  /** The error page's component, and when it shows development's details. */
  readonly errors: ErrorBoundaryConfig
  /** Where a signed-out visitor goes when a route needs a user. */
  readonly signInPath: string
  /** Where a signed-in visitor goes from a page for guests. */
  readonly homePath: string
  /** The most bytes the framework reads of a request body. */
  readonly bodyLimit: number
  /** The names the application gives its session cookie, `auth.sessionCookie`. */
  readonly sessionCookieNames: readonly string[]
  /** Which cookies hold a session: Better Auth's, and those names. */
  readonly sessionCookies: SessionCookies
  /** The Drizzle schema route models load from. */
  readonly schema: object | undefined
  /** The route-model bindings. */
  readonly bindings: RouteBindingsConfig | undefined
}

/** What a WebSetup is built from: setupWeb's configuration, each part optional. */
export interface WebSetupOptions {
  readonly errors?: ErrorBoundaryConfig
  readonly signInPath?: string
  readonly homePath?: string
  readonly bodyLimit?: number
  readonly sessionCookie?: string | readonly string[]
  readonly schema?: object
  readonly bindings?: RouteBindingsConfig
}

/** The settings these options give, each default filled in. */
export function webSetup(options: WebSetupOptions = {}): WebSetup {
  const names = options.sessionCookie === undefined ? [] : [options.sessionCookie].flat()

  return {
    errors: options.errors ?? {},
    signInPath: options.signInPath ?? '/login',
    homePath: options.homePath ?? '/',
    bodyLimit: options.bodyLimit ?? DEFAULT_BODY_LIMIT,
    sessionCookieNames: names,
    sessionCookies: sessionCookies(names),
    schema: options.schema,
    bindings: options.bindings,
  }
}

/**
 * The request's settings: setupWeb's, or for a stack composed by hand, the
 * defaults with what its middleware registered on the request.
 */
export function setupOf<E extends Env>(c: Context<E>): WebSetup {
  const context = openWebContext(c)

  return context.setup ?? webSetup({
    errors: context.errorBoundary,
    signInPath: context.signInPath,
    homePath: context.homePath,
    bodyLimit: context.bodyLimit,
    sessionCookie: context.sessionCookies,
    schema: context.schema,
    bindings: context.bindings,
  })
}

/**
 * Hand the request setupWeb's settings. The fields they replaced on the
 * request context still hold them, for code that read them there.
 */
export function useSetup<E extends Env>(c: Context<E>, setup: WebSetup): void {
  const context = openWebContext(c)

  context.setup = setup
  context.errorBoundary = setup.errors
  context.signInPath = setup.signInPath
  context.homePath = setup.homePath
  context.bodyLimit = setup.bodyLimit
}

/** The request's settings in an action or a layer, such as sign-out's session cookie names. */
export class WebSetupService extends EffectContext.Service<WebSetupService, WebSetup>()('@popcomputer/web/WebSetup') {}
