/**
 * Effect Handler
 *
 * Wraps Effect computations into Hono handlers.
 */

import { Effect, Exit, Cause, ManagedRuntime, Runtime } from 'effect'
import type { Context as HonoContext, MiddlewareHandler, Env } from 'hono'
import {
  getEffectBridgeConfig,
  getEffectRuntime,
  buildContextLayer,
  disposeRequestRuntime,
} from './bridge.js'
import {
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  HttpError,
  AuthRateLimitError,
  HonertiaConfigurationError,
  Redirect,
  toStructuredError,
  type AppError,
} from './errors.js'
import { createStructuredError, ErrorCodes } from './error-catalog.js'
import { captureErrorContext } from './error-context.js'
import {
  detectOutputFormat,
  JsonErrorFormatter,
  InertiaErrorFormatter,
  TerminalErrorFormatter,
} from './error-formatter.js'
import type { HonertiaStructuredError } from './error-types.js'
import {
  observeEffectErrorEvent,
  type EffectErrorEvent,
} from './error-observer.js'
import { openHonertiaContext } from '../request-context.js'

/**
 * Memoized formatter instances to avoid recreation on every error.
 */
const memoizedFormatters = {
  dev: {
    json: new JsonErrorFormatter({
      pretty: true,
      includeSource: true,
      includeContext: true,
      includeFixes: true,
    }),
    terminal: new TerminalErrorFormatter({
      useColors: true,
      showSnippet: true,
      showFixes: true,
    }),
    inertia: new InertiaErrorFormatter({ isDev: true, includeFixes: true }),
  },
  prod: {
    json: new JsonErrorFormatter({
      pretty: false,
      includeSource: false,
      includeContext: false,
      includeFixes: true,
      safeMessages: true,
    }),
    inertia: new InertiaErrorFormatter({ isDev: false, includeFixes: false }),
  },
}

/**
 * Log a structured error to the console in terminal format.
 * Suppressed during tests (NODE_ENV=test or BUN_ENV=test).
 */
function logStructuredError(
  structured: HonertiaStructuredError,
  isDev: boolean
): void {
  // Suppress logging during tests
  if (typeof Bun !== 'undefined' && Bun.env?.NODE_ENV === 'test') return
  console.error(
    isDev
      ? memoizedFormatters.dev.terminal.format(structured)
      : memoizedFormatters.prod.json.formatString(structured)
  )
}

/**
 * Create a request context adapter for format detection.
 */
function createFormatDetectionContext<E extends Env>(c: HonoContext<E>) {
  return {
    header: (name: string) => c.req.header(name),
    method: c.req.method,
    url: c.req.url,
  }
}

/**
 * Determine if we're in development mode.
 *
 * Development must be explicitly signalled via ENVIRONMENT or NODE_ENV.
 * We deliberately do NOT treat the presence of Cloudflare's CF_PAGES_BRANCH
 * as development: that variable is set on every Pages deployment including
 * production, so keying off it would expose stack traces, source locations,
 * and raw error messages to clients on production Pages sites. Pages preview
 * environments that want verbose errors should set ENVIRONMENT=development.
 */
function isDevelopment<E extends Env>(
  c: HonoContext<E>,
  config: ErrorBoundaryConfig = {}
): boolean {
  const {
    showDevErrors = true,
    envKey = 'ENVIRONMENT',
    devValue = 'development',
  } = config
  const env = c.env as Record<string, unknown> | undefined
  return showDevErrors && (
    env?.[envKey] === devValue ||
    (envKey === 'ENVIRONMENT' && env?.NODE_ENV === devValue)
  )
}

/** Configuration shared by Effect and Hono error entrypoints. */
export interface ErrorBoundaryConfig {
  readonly component?: string
  readonly showDevErrors?: boolean
  readonly envKey?: string
  readonly devValue?: string
  readonly log?: boolean
}

/**
 * Render any request failure through Honertia's single error boundary.
 */
export async function renderErrorResponse<E extends Env>(
  error: unknown,
  c: HonoContext<E>,
  config: ErrorBoundaryConfig = {}
): Promise<Response> {
  const context = captureErrorContext(c)
  const isDev = isDevelopment(c, config)
  const format = detectOutputFormat(
    createFormatDetectionContext(c),
    (c.env ?? {}) as Record<string, unknown>
  )
  const structured = error instanceof Error
    ? getStructuredFromThrown(error) ?? toStructuredError(error, context)
    : toStructuredError(error, context)
  const formatter = isDev ? memoizedFormatters.dev : memoizedFormatters.prod

  if (config.log ?? true) {
    logStructuredError(structured, isDev)
  }

  if (error instanceof ValidationError) {
    const isInertia = c.req.header('X-Inertia') === 'true'
    const prefersJson =
      c.req.header('Accept')?.includes('application/json') ||
      c.req.header('Content-Type')?.includes('application/json')
    if ((prefersJson && !isInertia) || format === 'json') {
      return c.json(formatter.json.format(structured), 422)
    }

    const requestContext = openHonertiaContext(c)
    const page = requestContext.web ?? requestContext.honertia
    if (error.component && page) {
      page.setErrors(error.errors)
      return await page.render(error.component)
    }

    page?.setErrors(error.errors)
    return c.redirect(c.req.header('Referer') || '/', 303)
  }

  if (error instanceof UnauthorizedError) {
    if (format === 'json') {
      return c.json(formatter.json.format(structured), 401)
    }
    return c.redirect(
      error.redirectTo ?? '/login',
      c.req.header('X-Inertia') === 'true' ? 303 : 302
    )
  }

  if (error instanceof AuthRateLimitError && error.retryAfterSeconds !== undefined) {
    c.header('Retry-After', String(error.retryAfterSeconds))
  }

  const status = structured.httpStatus
  if (
    format === 'json' ||
    error instanceof ForbiddenError ||
    error instanceof HttpError ||
    error instanceof AuthRateLimitError
  ) {
    return c.json(formatter.json.format(structured), status as any)
  }

  const requestContext = openHonertiaContext(c)
  const page = requestContext.web ?? requestContext.honertia
  if (page) {
    const response = await page.render(
      config.component ?? 'Error',
      formatter.inertia.format(structured) as Record<string, unknown>
    )
    if (response.status === status) return response
    return new Response(response.body, {
      status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }

  return c.json(formatter.json.format(structured), status as any)
}

/**
 * Classify Effect's missing-service defect for a known Honertia tag into the
 * structured configuration error. Unconfigured services are not provided to
 * the layer, so the first `yield*` of their tag dies here with
 * "Service not found: <tagId> (...)". Returns null for any other defect.
 */
function classifyMissingService(defect: unknown): HonertiaConfigurationError | null {
  if (!(defect instanceof Error)) return null
  const prefix = 'Service not found: '
  if (!defect.message.startsWith(prefix)) return null

  // Exact tag id match ('@popcomputer/web/Auth' must not also match '@popcomputer/web/AuthUser')
  const tagId = defect.message.slice(prefix.length).split(' ')[0]
  switch (tagId) {
    case '@popcomputer/web/Database':
      return HonertiaConfigurationError.databaseNotConfigured()
    case '@popcomputer/web/Auth':
      return HonertiaConfigurationError.authNotConfigured()
    default:
      return null
  }
}

/**
 * Observe an Effect error without changing request behavior.
 */
async function observeEffectError<E extends Env>(
  c: HonoContext<E>,
  event: EffectErrorEvent,
  runtime?: ManagedRuntime.ManagedRuntime<any, never>
): Promise<void> {
  const activeRuntime = runtime ?? getEffectRuntime(c)
  if (!activeRuntime) return

  try {
    await activeRuntime.runPromise(observeEffectErrorEvent(event))
  } catch (error) {
    // A route Layer can itself be the source of the failure. In that case its
    // runtime cannot also host the observer; preserve the original typed error
    // response instead of replacing it with the runtime's FiberFailure.
    if (!Runtime.isFiberFailure(error)) throw error
  }
}

/**
 * Convert an Effect error to an HTTP response.
 *
 * The typed failure is observed once, then rendered through the same boundary
 * used by Hono errors and not-found responses.
 */
export async function errorToResponse<E extends Env>(
  error: AppError,
  c: HonoContext<E>,
  runtime?: ManagedRuntime.ManagedRuntime<any, never>
): Promise<Response> {
  const structured = toStructuredError(error, captureErrorContext(c))

  await observeEffectError(
    c,
    {
      source: 'framework',
      handling: 'unhandled',
      kind: 'failure',
      error,
      structured,
    },
    runtime
  )

  return renderErrorResponse(error, c, openHonertiaContext(c).errorBoundary)
}

/**
 * Handle a Redirect value (which is not an error).
 */
function handleRedirect<E extends Env>(redirect: Redirect, c: HonoContext<E>): Response {
  return c.redirect(redirect.url, redirect.status)
}

/**
 * Check if a value is a Redirect.
 */
function isRedirect(value: unknown): value is Redirect {
  return value instanceof Redirect
}

/**
 * Wrap an Effect into a Hono handler.
 */
export function effectHandler<E extends Env, R, Err extends AppError>(
  effect: Effect.Effect<Response | Redirect, Err, R>
): MiddlewareHandler<E> {
  return async (c) => {
    const runtime = getEffectRuntime(c)

    if (!runtime) {
      // No runtime set up, create one for this request
      const layer = buildContextLayer(c, getEffectBridgeConfig(c))
      const tempRuntime = ManagedRuntime.make(layer)

      try {
        return await runEffectWithRuntime(effect, c, tempRuntime)
      } finally {
        await disposeRequestRuntime(c, tempRuntime)
      }
    }

    return await runEffectWithRuntime(effect, c, runtime)
  }
}

/** Run one handler Effect with a caller-owned managed runtime. */
export async function runEffectWithRuntime<
  E extends Env,
  R,
  Err,
>(
  effect: Effect.Effect<Response | Redirect, Err, R>,
  c: HonoContext<E>,
  runtime: ManagedRuntime.ManagedRuntime<R, never>
): Promise<Response> {
  let exit: Exit.Exit<Response | Redirect, unknown>

  try {
    exit = await runtime.runPromiseExit(effect)
  } catch (error) {
    // ManagedRuntime initializes its Layer before it can fork the requested
    // Effect. A typed Layer failure is therefore surfaced as FiberFailure
    // rather than returned by runPromiseExit; restore it to the normal exit
    // path so route-layer errors retain Honertia's typed handling.
    if (!Runtime.isFiberFailure(error)) throw error
    exit = Exit.failCause(error[Runtime.FiberFailureCauseId])
  }

  return handleExit(exit, c, runtime)
}

/**
 * Handle an Effect exit value.
 *
 * Failures are converted to responses via errorToResponse.
 * Defects (unexpected errors) are observed and rendered by the same boundary.
 */
async function handleExit<E extends Env>(
  exit: Exit.Exit<Response | Redirect, unknown>,
  c: HonoContext<E>,
  runtime?: ManagedRuntime.ManagedRuntime<any, never>
): Promise<Response> {
  const boundaryConfig = openHonertiaContext(c).errorBoundary

  if (Exit.isSuccess(exit)) {
    const value = exit.value
    if (isRedirect(value)) {
      return handleRedirect(value, c)
    }
    return value
  }

  // Handle typed failures
  const cause = exit.cause

  if (Cause.isFailure(cause)) {
    const error = Cause.failureOption(cause)
    if (error._tag === 'Some') {
      return await errorToResponse(error.value as AppError, c, runtime)
    }
  }

  // Handle defects (unexpected errors) - attach structured error for Hono's onError
  const context = captureErrorContext(c)

  if (Cause.isDie(cause)) {
    const defect = Cause.dieOption(cause)
    if (defect._tag === 'Some') {
      // A missing Honertia service is a configuration defect; translate it to
      // the structured configuration error before the generic defect paths.
      const err = classifyMissingService(defect.value) ?? defect.value

      // If the defect is already a structured error (like HonertiaConfigurationError),
      // convert it using its own toStructured method.
      // This branch always throws after observing, so the generic defect path below
      // only runs for defects that do not implement toStructured.
      if (err && typeof err === 'object' && 'toStructured' in err && typeof (err as any).toStructured === 'function') {
        const structured = (err as any).toStructured(context)
        await observeEffectError(
          c,
          {
            source: 'framework',
            handling: 'unhandled',
            kind: 'defect',
            error: err,
            structured,
          },
          runtime
        )
        const wrapped = new Error((err as any).message ?? String(err))
        ;(wrapped as any).__honertiaStructured = structured
        ;(wrapped as any).hint = (err as any).hint
        return renderErrorResponse(wrapped, c, boundaryConfig)
      }

      // Otherwise create a generic defect error
      const structured = createStructuredError(
        ErrorCodes.INT_801_EFFECT_DEFECT,
        { reason: err instanceof Error ? err.message : String(err) },
        context
      )

      await observeEffectError(
        c,
        {
          source: 'framework',
          handling: 'unhandled',
          kind: 'defect',
          error: err,
          structured,
        },
        runtime
      )

      if (err instanceof Error) {
        ;(err as any).__honertiaStructured = structured
        return renderErrorResponse(err, c, boundaryConfig)
      }

      const wrapped = new Error(String(err))
      ;(wrapped as any).__honertiaStructured = structured
      return renderErrorResponse(wrapped, c, boundaryConfig)
    }
  }

  // Fallback: throw generic error with structured info
  const structured = createStructuredError(
    ErrorCodes.INT_800_UNEXPECTED,
    { reason: 'Unknown effect failure' },
    context
  )
  await observeEffectError(
    c,
    {
      source: 'framework',
      handling: 'unhandled',
      kind: 'defect',
      error: new Error('Unknown effect failure'),
      structured,
    },
    runtime
  )
  const fallbackError = new Error('Unknown effect failure')
  ;(fallbackError as any).__honertiaStructured = structured
  return renderErrorResponse(fallbackError, c, boundaryConfig)
}

/**
 * Create a handler from a function that returns an Effect.
 */
export function effect<E extends Env, R, Err extends AppError>(
  fn: () => Effect.Effect<Response | Redirect, Err, R>
): MiddlewareHandler<E> {
  return effectHandler(Effect.suspend(fn))
}

/**
 * Create a handler from an Effect directly.
 */
export const handle = effectHandler

/**
 * Get structured error from a thrown error (if available).
 * Used by Hono's onError handler.
 */
export function getStructuredFromThrown(error: Error): HonertiaStructuredError | undefined {
  return (error as any).__honertiaStructured
}
