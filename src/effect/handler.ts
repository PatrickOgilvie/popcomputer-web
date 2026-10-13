/**
 * Effect Handler
 *
 * Wraps Effect computations into Hono handlers.
 */

import { sameOriginReferer } from './referer.js'
import { Option, Effect, Exit, Cause, ManagedRuntime, Result } from 'effect'
import type { Context as HonoContext, MiddlewareHandler, Env } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import {
  getEffectBridgeConfig,
  getEffectRuntime,
  buildContextLayer,
  disposeRequestRuntime,
} from './bridge.js'
import { readTestLayer } from './test-env.js'
import {
  ValidationError,
  UnauthorizedError,
  HttpError,
  AuthRateLimitError,
  AuthRedirect,
  ConfigurationError,
  Redirect,
  isStructuredError,
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
import type { StructuredError } from './error-types.js'
import {
  observeEffectErrorEvent,
  type EffectErrorEvent,
} from './error-observer.js'
import { openWebContext } from '../request-context.js'

const structuredErrorsByCause = new WeakMap<Error, StructuredError>()

/**
 * Memoized formatter instances to avoid recreation on every error.
 */
const memoizedFormatters = {
  dev: {
    json: new JsonErrorFormatter({
      pretty: true,
      includeContext: true,
      includeFixes: true,
    }),
    terminal: new TerminalErrorFormatter({
      useColors: true,
      showFixes: true,
    }),
    inertia: new InertiaErrorFormatter({ isDev: true, includeFixes: true }),
  },
  // Production responses carry no fixes: they describe the application's setup.
  prod: {
    json: new JsonErrorFormatter({
      pretty: false,
      includeContext: false,
      includeFixes: false,
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
  structured: StructuredError,
  isDev: boolean
): void {
  // Suppress logging during tests
  if ('Bun' in globalThis && globalThis.Bun.env?.NODE_ENV === 'test') return
  // oxlint-disable-next-line effecttsgo/global-console -- The outer HTTP error renderer writes preformatted terminal or JSON diagnostics to stderr; preserve that output format.
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

  const env = c.env ?? {}
  const configuredEnvironment = Object.getOwnPropertyDescriptor(env, envKey)?.value
  const nodeEnvironment = Object.getOwnPropertyDescriptor(env, 'NODE_ENV')?.value

  // A test request (testEnv) that declares no environment shows development
  // errors, so a failing test explains itself.
  if (configuredEnvironment === undefined && nodeEnvironment === undefined) {
    return showDevErrors && readTestLayer(env) !== undefined
  }

  return showDevErrors && (
    configuredEnvironment === devValue ||
    (envKey === 'ENVIRONMENT' && nodeEnvironment === devValue)
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
 * Render any request failure through the single error boundary.
 */
// oxlint-disable-next-line effecttsgo/async-function -- This Hono boundary awaits ManagedRuntime exits and converts typed failures, defects, and redirects into HTTP responses.
export async function renderErrorResponse<E extends Env>(
  cause: unknown,
  c: HonoContext<E>,
  config: ErrorBoundaryConfig = {}
): Promise<Response> {
  const error = cause

  if (error instanceof AuthRedirect) {
    return new Response(null, {
      status: error.status,
      headers: error.headers,
    })
  }

  const context = captureErrorContext(c)
  const isDev = isDevelopment(c, config)

  const format = openWebContext(c).jsonApi === true
    ? 'json'
    : detectOutputFormat(createFormatDetectionContext(c), c.env)

  const structured = error instanceof Error
    ? getStructuredFromThrown(error) ?? toStructuredError(error, context)
    : toStructuredError(error, context)

  const formatter = isDev ? memoizedFormatters.dev : memoizedFormatters.prod

  const finalize = (response: Response): Response =>
    appendVerifiedErrorHeaders(response, error)

  // Expected failures (validation, not found, forbidden) are answers, not
  // server errors; only a 5xx is logged.
  if ((config.log ?? true) && structured.httpStatus >= 500) {
    logStructuredError(structured, isDev)
  }

  if (error instanceof ValidationError) {
    if (format === 'json') {
      // SAFETY: a validation failure's status is 400 or 422, both contentful.
      return finalize(c.json(formatter.json.format(structured), structured.httpStatus as ContentfulStatusCode))
    }

    // A form submission goes back to the form, whose page shows the errors.
    // Invalid query parameters on a page visit render the error page.
    if (!['GET', 'HEAD'].includes(c.req.method.toUpperCase())) {
      openWebContext(c).flash?.setErrors(error.errors, c.req.header('X-Inertia-Error-Bag') || undefined)

      return finalize(c.redirect(error.redirectTo ?? previousUrl(c), 303))
    }

    // The error page this visit renders shows which parameters were invalid.
    openWebContext(c).web?.setErrors(error.errors)
  }

  if (error instanceof UnauthorizedError) {
    if (format === 'json') {
      // A JSON client is told the scheme it must use: the one the failure
      // names, or Bearer for a request that sent a bearer token.
      const challenge = error.challenge ?? (/^Bearer\b/i.test(c.req.header('Authorization') ?? '') ? 'Bearer' : undefined)

      if (challenge !== undefined) c.header('WWW-Authenticate', challenge)

      return finalize(c.json(formatter.json.format(structured), 401))
    }

    return finalize(c.redirect(
      error.redirectTo ?? (error.home === true ? openWebContext(c).homePath ?? '/' : signInUrl(c)),
      c.req.header('X-Inertia') === 'true' ? 303 : 302
    ))
  }

  if (error instanceof AuthRateLimitError && error.retryAfterSeconds !== undefined) {
    c.header('Retry-After', String(error.retryAfterSeconds))
  }

  const status = structured.httpStatus

  // An HttpError with a body owns its response format; every other failure
  // renders the error page for page and HTML requests.
  if (format === 'json' || (error instanceof HttpError && error.body !== undefined)) {
    // SAFETY: The Hono adapter has already constrained this value at the request boundary; this assertion bridges an overload its generic context cannot retain.
    return finalize(c.json(formatter.json.format(structured), status as ContentfulStatusCode))
  }

  const requestContext = openWebContext(c)
  const page = requestContext.web

  if (page) {
    const response = await page.render(
      config.component ?? 'Error',
      formatter.inertia.format(structured)
    )

    if (response.status === status) return finalize(response)

    return finalize(new Response(response.body, {
      status,
      statusText: response.statusText,
      headers: response.headers,
    }))
  }

  // SAFETY: The Hono adapter has already constrained this value at the request boundary; this assertion bridges an overload its generic context cannot retain.
  return finalize(c.json(formatter.json.format(structured), status as ContentfulStatusCode))
}

/**
 * The sign-in page, carrying the page a visit was on its way to as
 * `redirect`, for `intendedUrl` to return to after signing in.
 */
function signInUrl<E extends Env>(c: HonoContext<E>): string {
  const signInPath = openWebContext(c).signInPath ?? '/login'
  // A visit returns to its page after signing in. A form post cannot be
  // replayed, so it returns to the page the form was on.
  const url = new URL(c.req.url)
  const intended = c.req.method.toUpperCase() === 'GET'
    ? `${url.pathname}${url.search}`
    : sameOriginReferer(c.req.header('Referer'), c.req.url)

  return intended === undefined ? signInPath : `${signInPath}?redirect=${encodeURIComponent(intended)}`
}

/** The same-origin page the request came from, or the home page. */
function previousUrl<E extends Env>(c: HonoContext<E>): string {
  return sameOriginReferer(c.req.header('Referer'), c.req.url) ?? '/'
}

function appendVerifiedErrorHeaders(
  response: Response,
  cause: unknown
): Response {
  const error = cause

  if (
    !(error instanceof ValidationError) &&
    !(error instanceof AuthRateLimitError) &&
    !(error instanceof HttpError)
  ) {
    return response
  }

  if (!error.headers) return response

  const headers = new Headers(error.headers)
  response.headers.forEach((value, name) => {
    if (name.toLowerCase() !== 'set-cookie') headers.set(name, value)
  })
  const responseCookies = readResponseSetCookies(response.headers)

  for (const cookie of responseCookies) {
    headers.append('set-cookie', cookie)
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function readResponseSetCookies(headers: Headers): readonly string[] {
  // SAFETY: Bun's Headers implements the standard getSetCookie extension; the optional contract also supports runtimes without it.
  const headersWithCookies = headers as Headers & {
    getSetCookie?: () => string[]
  }

  if (headersWithCookies.getSetCookie instanceof Function) {
    return headersWithCookies.getSetCookie()
  }

  const combined = headers.get('set-cookie')

  return combined ? [combined] : []
}

/**
 * Classify Effect's missing-service defect for a known framework service tag into the
 * structured configuration error. Unconfigured services are not provided to
 * the layer, so the first `yield*` of their tag dies here with
 * "Service not found: <tagId> (...)". Returns null for any other defect.
 */
function classifyMissingService(cause: unknown): ConfigurationError | null {
  const defect = cause

  if (!(defect instanceof Error)) return null
  const prefix = 'Service not found: '

  if (!defect.message.startsWith(prefix)) return null

  // Exact tag id match ('@popcomputer/web/Auth' must not also match '@popcomputer/web/AuthUser')
  const tagId = defect.message.slice(prefix.length).split(' ')[0]

  switch (tagId) {
    case '@popcomputer/web/Database':
      return ConfigurationError.databaseNotConfigured()
    case '@popcomputer/web/Auth':
      return ConfigurationError.authNotConfigured()
    default:
      return null
  }
}

/**
 * Observe an Effect error without changing request behavior.
 */
// oxlint-disable-next-line effecttsgo/async-function -- This Hono boundary awaits ManagedRuntime exits and converts typed failures, defects, and redirects into HTTP responses.
async function observeEffectError<E extends Env>(
  c: HonoContext<E>,
  event: EffectErrorEvent,
  runtime?: ManagedRuntime.ManagedRuntime<never, unknown>
): Promise<void> {
  const activeRuntime = runtime ?? getEffectRuntime(c)

  if (!activeRuntime) return

  // An unavailable route Layer is represented in the returned Exit in v4.
  // Observation must never replace the original request failure.
  await activeRuntime.runPromiseExit(observeEffectErrorEvent(event))
}

/**
 * Convert an Effect error to an HTTP response.
 *
 * The typed failure is observed once, then rendered through the same boundary
 * used by Hono errors and not-found responses.
 */
// oxlint-disable-next-line effecttsgo/async-function -- This Hono boundary awaits ManagedRuntime exits and converts typed failures, defects, and redirects into HTTP responses.
export async function errorToResponse<E extends Env>(
  error: AppError,
  c: HonoContext<E>,
  runtime?: ManagedRuntime.ManagedRuntime<never, unknown>
): Promise<Response> {
  if (error instanceof AuthRedirect) {
    return renderErrorResponse(error, c, openWebContext(c).errorBoundary)
  }

  // redirectNow: leaving the action for another page is not an error.
  if (error instanceof Redirect) {
    return handleRedirect(error, c)
  }

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

  return renderErrorResponse(error, c, openWebContext(c).errorBoundary)
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
function isRedirect<Value>(value: Value): value is Value & Redirect {
  return value instanceof Redirect
}

/** Run one handler Effect with a caller-owned managed runtime. */
// oxlint-disable-next-line effecttsgo/async-function -- This Hono boundary awaits ManagedRuntime exits and converts typed failures, defects, and redirects into HTTP responses.
export async function runEffectWithRuntime<
  E extends Env,
  R,
  Err,
  RuntimeError,
>(
  effect: Effect.Effect<Response | Redirect, Err, R>,
  c: HonoContext<E>,
  runtime: ManagedRuntime.ManagedRuntime<R, RuntimeError>
): Promise<Response> {
  // ManagedRuntime includes both Layer acquisition failures and handler
  // failures in the Exit returned by its v4 runner.
  const exit: Exit.Exit<Response | Redirect, unknown> =
    await runtime.runPromiseExit(effect)

  return handleExit(exit, c, runtime)
}

/**
 * Handle an Effect exit value.
 *
 * Failures are converted to responses via errorToResponse.
 * Defects (unexpected errors) are observed and rendered by the same boundary.
 */
// oxlint-disable-next-line effecttsgo/async-function -- This Hono boundary awaits ManagedRuntime exits and converts typed failures, defects, and redirects into HTTP responses.
async function handleExit<E extends Env>(
  exit: Exit.Exit<Response | Redirect, unknown>,
  c: HonoContext<E>,
  runtime?: ManagedRuntime.ManagedRuntime<never, unknown>
): Promise<Response> {
  const boundaryConfig = openWebContext(c).errorBoundary

  if (Exit.isSuccess(exit)) {
    const value = exit.value

    if (isRedirect(value)) {
      return handleRedirect(value, c)
    }

    return value
  }

  // Handle typed failures
  const cause = exit.cause

  if (Cause.hasFails(cause)) {
    const error = Cause.findErrorOption(cause)

    if (Option.isSome(error)) {
      // SAFETY: The Hono adapter has already constrained this value at the request boundary; this assertion bridges an overload its generic context cannot retain.
      return errorToResponse(error.value as AppError, c, runtime)
    }
  }

  // Handle defects (unexpected errors) - attach structured error for Hono's onError
  const context = captureErrorContext(c)

  if (Cause.hasDies(cause)) {
    const defect = Cause.findDefect(cause)

    if (Result.isSuccess(defect)) {
      // A missing framework service is a configuration defect; translate it to
      // the structured configuration error before the generic defect paths.
      const err = classifyMissingService(defect.success) ?? defect.success

      // If the defect is already a structured error (like ConfigurationError),
      // convert it using its own toStructured method.
      // This branch always throws after observing, so the generic defect path below
      // only runs for defects that do not implement toStructured.
      if (isStructuredError(err)) {
        const structured = err.toStructured(context)
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
        const wrapped = new Error(err instanceof Error ? err.message : structured.message)
        structuredErrorsByCause.set(wrapped, structured)

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
        structuredErrorsByCause.set(err, structured)

        return renderErrorResponse(err, c, boundaryConfig)
      }

      const wrapped = new Error(String(err))
      structuredErrorsByCause.set(wrapped, structured)

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
  structuredErrorsByCause.set(fallbackError, structured)

  return renderErrorResponse(fallbackError, c, boundaryConfig)
}

/**
 * Get structured error from a thrown error (if available).
 * Used by Hono's onError handler.
 */
export function getStructuredFromThrown(error: Error): StructuredError | undefined {
  return structuredErrorsByCause.get(error)
}
