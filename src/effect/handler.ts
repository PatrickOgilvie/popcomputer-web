/**
 * Effect Handler
 *
 * Wraps Effect computations into Hono handlers.
 */

import { Effect, Exit, Cause, ManagedRuntime } from 'effect'
import type { Context as HonoContext, MiddlewareHandler, Env } from 'hono'
import {
  getEffectBridgeConfig,
  getEffectRuntime,
  buildContextLayer,
} from './bridge.js'
import {
  ValidationError,
  UnauthorizedError,
  NotFoundError,
  HttpError,
  RouteConfigurationError,
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
  },
  prod: {
    json: new JsonErrorFormatter({
      pretty: false,
      includeSource: false,
      includeContext: false,
      includeFixes: true,
      safeMessages: true,
    }),
  },
}

/**
 * Get the appropriate JSON formatter for the environment.
 */
function getJsonFormatter(isDev: boolean): JsonErrorFormatter {
  return isDev ? memoizedFormatters.dev.json : memoizedFormatters.prod.json
}

/**
 * Convert an AppError to a throwable Error for Hono's onError handler.
 * Preserves error metadata like status codes and hints.
 */
function toThrowableError(error: AppError): Error {
  const err = new Error(error.message)
  err.name = error._tag

  // Preserve status for HttpError
  if (error instanceof HttpError) {
    ;(err as any).status = error.status
  }

  // Preserve hint for RouteConfigurationError
  if (error instanceof RouteConfigurationError && error.hint) {
    ;(err as any).hint = error.hint
  }

  // Preserve structured error for later formatting
  ;(err as any).structuredError = error

  return err
}

/**
 * Log a structured error to the console in terminal format.
 * Suppressed during tests (NODE_ENV=test or BUN_ENV=test).
 */
function logStructuredError(
  structured: HonertiaStructuredError,
  isDev: boolean
): void {
  if (!isDev) return
  // Suppress logging during tests
  if (typeof Bun !== 'undefined' && Bun.env?.NODE_ENV === 'test') return
  console.error(memoizedFormatters.dev.terminal.format(structured))
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
function isDevelopment<E extends Env>(c: HonoContext<E>): boolean {
  const env = c.env as Record<string, unknown> | undefined
  return (
    env?.ENVIRONMENT === 'development' ||
    env?.NODE_ENV === 'development'
  )
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

  // Exact tag id match ('honertia/Auth' must not also match 'honertia/AuthUser')
  const tagId = defect.message.slice(prefix.length).split(' ')[0]
  switch (tagId) {
    case 'honertia/Database':
      return HonertiaConfigurationError.databaseNotConfigured()
    case 'honertia/Auth':
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

  await activeRuntime.runPromise(observeEffectErrorEvent(event))
}

/**
 * Convert an Effect error to an HTTP response.
 *
 * Most errors are re-thrown so Hono's onError handler can render them
 * via Honertia's error component. Only errors that need special handling
 * (ValidationError for form re-rendering, UnauthorizedError for redirects)
 * return responses directly.
 */
export async function errorToResponse<E extends Env>(
  error: AppError,
  c: HonoContext<E>,
  runtime?: ManagedRuntime.ManagedRuntime<any, never>
): Promise<Response> {
  const context = captureErrorContext(c)
  const isDev = isDevelopment(c)
  const format = detectOutputFormat(
    createFormatDetectionContext(c),
    (c.env ?? {}) as Record<string, unknown>
  )

  // Convert to structured error
  const structured = toStructuredError(error, context)

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

  // Log in development
  logStructuredError(structured, isDev)

  // ValidationError: re-render form with errors or redirect back
  if (error instanceof ValidationError) {
    const isInertia = c.req.header('X-Inertia') === 'true'
    const prefersJson =
      c.req.header('Accept')?.includes('application/json') ||
      c.req.header('Content-Type')?.includes('application/json')

    // JSON response for API/AI requests
    if ((prefersJson && !isInertia) || format === 'json') {
      return c.json(getJsonFormatter(isDev).format(structured), 422)
    }

    // For Inertia requests with a component, render the component with errors
    const honertiaInstance = openHonertiaContext(c).honertia
    if (error.component && honertiaInstance) {
      honertiaInstance.setErrors(error.errors)
      return await honertiaInstance.render(error.component)
    }

    // Redirect back with errors
    const referer = c.req.header('Referer') || '/'
    honertiaInstance?.setErrors(error.errors)
    return c.redirect(referer, 303)
  }

  // UnauthorizedError: redirect to login
  if (error instanceof UnauthorizedError) {
    // JSON response for API/AI requests
    if (format === 'json') {
      return c.json(getJsonFormatter(isDev).format(structured), 401)
    }

    const isInertia = c.req.header('X-Inertia') === 'true'
    const redirectTo = error.redirectTo ?? '/login'
    return c.redirect(redirectTo, isInertia ? 303 : 302)
  }

  // NotFoundError: use Hono's notFound handler (renders via Honertia if configured)
  if (error instanceof NotFoundError) {
    // JSON response for API/AI requests
    if (format === 'json') {
      return c.json(getJsonFormatter(isDev).format(structured), 404)
    }

    return c.notFound() as Response
  }

  // ForbiddenError: return 403 JSON (useful for API routes)
  if ('_tag' in error && error._tag === 'ForbiddenError') {
    // Always JSON for forbidden - consistent API behavior
    return c.json(getJsonFormatter(isDev).format(structured), 403)
  }

  // HttpError: return custom status JSON (gives developers control over HTTP responses)
  if (error instanceof HttpError) {
    return c.json(getJsonFormatter(isDev).format(structured), error.status as any)
  }

  // All other errors (RouteConfigurationError, etc.): throw to Hono's onError handler
  const throwable = toThrowableError(error)
  // Attach structured error for Hono's onError to use
  ;(throwable as any).__honertiaStructured = structured
  throw throwable
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
        const exit = await tempRuntime.runPromiseExit(effect as Effect.Effect<Response | Redirect, AppError, any>)
        return await handleExit(exit, c, tempRuntime)
      } finally {
        await tempRuntime.dispose()
      }
    }

    const exit = await runtime.runPromiseExit(effect as Effect.Effect<Response | Redirect, AppError, any>)
    return await handleExit(exit, c, runtime)
  }
}

/**
 * Handle an Effect exit value.
 *
 * Failures are converted to responses via errorToResponse.
 * Defects (unexpected errors) are re-thrown for Hono's onError handler.
 */
async function handleExit<E extends Env>(
  exit: Exit.Exit<Response | Redirect, unknown>,
  c: HonoContext<E>,
  runtime?: ManagedRuntime.ManagedRuntime<any, never>
): Promise<Response> {
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
        throw wrapped
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
        throw err
      }

      const wrapped = new Error(String(err))
      ;(wrapped as any).__honertiaStructured = structured
      throw wrapped
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
  throw fallbackError
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
