/**
 * Effect Handler
 *
 * Wraps Effect computations into Hono handlers.
 */

import { sameOriginReferer } from './referer.js'
import { webUrl } from '../locations.js'
import { Option, Effect, Exit, Cause, ManagedRuntime, Predicate, Result } from 'effect'
import type { Context as HonoContext, Env } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { readTestLayer } from './test-env.js'
import { declaresEnvironment, isDevelopment } from '../development.js'
import { setupOf } from '../web-setup.js'
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
  answersErrorAsJson,
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
 * Whether the error page shows development's details: in development, as
 * isDevelopment decides, unless `showDevErrors` is false.
 */
function showsDevelopmentErrors<E extends Env>(
  c: HonoContext<E>,
  config: ErrorBoundaryConfig = {}
): boolean {
  if (config.showDevErrors === false) return false

  // A test request (testEnv) that declares no environment shows development
  // errors, so a failing test explains itself.
  if (!declaresEnvironment(c, config)) return readTestLayer(c.env) !== undefined

  return isDevelopment(c, config)
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
 * How the boundary answers each of the framework's failures, beyond the
 * error page or JSON envelope its structured error gives: every failure an
 * action may fail with names one, so a new one does not compile until
 * someone decides how it is answered.
 */
type Answer =
  /** Better Auth's own redirect, as it answered. */
  | 'auth-redirect'
  /** Back to the form, its errors flashed; a JSON client gets them. */
  | 'form'
  /** To sign in, or home; a JSON client gets 401 and the scheme it must use. */
  | 'sign-in'
  /** The error page, with when to try again. */
  | 'retry-after'
  /** Its own body, when it carries one. */
  | 'its-body'
  /** Not a failure: a redirect, which the route answers before the boundary. */
  | 'redirect'
  /** The error page, or the JSON envelope. */
  | 'error-page'

const ANSWERS = {
  AuthRedirect: 'auth-redirect',
  ValidationError: 'form',
  UnauthorizedError: 'sign-in',
  AuthRateLimitError: 'retry-after',
  HttpError: 'its-body',
  Redirect: 'redirect',
  NotFoundError: 'error-page',
  ForbiddenError: 'error-page',
  DatabaseError: 'error-page',
  DatabaseConstraintViolation: 'error-page',
  SessionLookupUnavailable: 'error-page',
  InvalidAuthSession: 'error-page',
  RouteConfigurationError: 'error-page',
  ConfigurationError: 'error-page',
  CacheError: 'error-page',
  ResponseCachePurgeError: 'error-page',
  ConfigError: 'error-page',
} satisfies { readonly [Tag in AppError['_tag']]: Answer }

/** How the boundary answers a failure: by its tag, or the error page for anything else thrown. */
function answerOf(error: unknown): Answer {
  if (!Predicate.hasProperty(error, '_tag') || !Predicate.isString(error._tag) || !Object.hasOwn(ANSWERS, error._tag)) return 'error-page'

  // SAFETY: Object.hasOwn checked the tag is one of ANSWERS' keys.
  return ANSWERS[error._tag as AppError['_tag']]
}

/**
 * Render any request failure through the single error boundary.
 */
// oxlint-disable-next-line effecttsgo/async-function -- This Hono boundary awaits ManagedRuntime exits and converts typed failures, defects, and redirects into HTTP responses.
export async function renderErrorResponse<E extends Env>(
  cause: unknown,
  c: HonoContext<E>,
  config: ErrorBoundaryConfig = {},
  known?: StructuredError
): Promise<Response> {
  const error = cause
  const answer = answerOf(error)

  if (answer === 'auth-redirect' && error instanceof AuthRedirect) {
    return new Response(null, {
      status: error.status,
      headers: error.headers,
    })
  }

  const context = captureErrorContext(c)
  const isDev = showsDevelopmentErrors(c, config)

  const format = openWebContext(c).jsonApi === true || answersErrorAsJson(createFormatDetectionContext(c)) ? 'json' : 'page'

  const structured = known ?? toStructuredError(error, context)

  const formatter = isDev ? memoizedFormatters.dev : memoizedFormatters.prod

  const finalize = (response: Response): Response =>
    appendVerifiedErrorHeaders(response, error)

  // Expected failures (validation, not found, forbidden) are answers, not
  // server errors; only a 5xx is logged.
  if ((config.log ?? true) && structured.httpStatus >= 500) {
    logStructuredError(structured, isDev)
  }

  if (answer === 'form' && error instanceof ValidationError) {
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

  if (answer === 'sign-in' && error instanceof UnauthorizedError) {
    if (format === 'json') {
      // A JSON client is told the scheme it must use: the one the failure
      // names, or Bearer for a request that sent a bearer token.
      const challenge = error.challenge ?? (/^Bearer\b/i.test(c.req.header('Authorization') ?? '') ? 'Bearer' : undefined)

      if (challenge !== undefined) c.header('WWW-Authenticate', challenge)

      return finalize(c.json(formatter.json.format(structured), 401))
    }

    return finalize(c.redirect(
      error.redirectTo ?? (error.home === true ? setupOf(c).homePath : signInUrl(c)),
      c.req.header('X-Inertia') === 'true' ? 303 : 302
    ))
  }

  if (answer === 'retry-after' && error instanceof AuthRateLimitError && error.retryAfterSeconds !== undefined) {
    c.header('Retry-After', String(error.retryAfterSeconds))
  }

  const status = structured.httpStatus

  // An HttpError with a body owns its response format; every other failure
  // renders the error page for page and HTML requests.
  if (format === 'json' || (answer === 'its-body' && error instanceof HttpError && error.body !== undefined)) {
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
  const { signInPath } = setupOf(c)
  // A visit returns to its page after signing in. A form post cannot be
  // replayed, so it returns to the page the form was on.
  const url = new URL(c.req.url)
  const intended = c.req.method.toUpperCase() === 'GET'
    ? `${url.pathname}${url.search}`
    : sameOriginReferer(c.req.header('Referer'), c.req.url) ?? openWebContext(c).formPage

  return intended === undefined ? signInPath : `${signInPath}?redirect=${encodeURIComponent(intended)}`
}

/**
 * The same-origin page the request came from, else the page its route's form
 * is on (its `form` option, or its own path when that path has a page), else
 * the home page.
 */
function previousUrl<E extends Env>(c: HonoContext<E>): string {
  return sameOriginReferer(c.req.header('Referer'), c.req.url) ?? openWebContext(c).formPage ?? '/'
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
  const responseCookies = response.headers.getSetCookie()

  for (const cookie of responseCookies) {
    headers.append('set-cookie', cookie)
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
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
async function observeEffectError(
  event: EffectErrorEvent,
  runtime: ManagedRuntime.ManagedRuntime<never, unknown>
): Promise<void> {
  // An unavailable route Layer is represented in the returned Exit in v4.
  // Observation must never replace the original request failure.
  await runtime.runPromiseExit(observeEffectErrorEvent(event))
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
  runtime: ManagedRuntime.ManagedRuntime<never, unknown>
): Promise<Response> {
  if (error instanceof AuthRedirect) {
    return renderErrorResponse(error, c, setupOf(c).errors)
  }

  // redirectNow: leaving the action for another page is not an error.
  if (error instanceof Redirect) {
    return handleRedirect(error, c, runtime)
  }

  const structured = toStructuredError(error, captureErrorContext(c))

  await observeEffectError(
    {
      source: 'framework',
      handling: 'unhandled',
      kind: 'failure',
      error,
      structured,
    },
    runtime
  )

  return renderErrorResponse(error, c, setupOf(c).errors)
}

/**
 * Handle a Redirect value (which is not an error). A redirect leads to a path
 * or an `http:` or `https:` URL: one to any other scheme, such as a
 * `javascript:` URL built from a visitor's input, is a defect, since an
 * Inertia visit assigns its location to `window.location.href`.
 */
// oxlint-disable-next-line effecttsgo/async-function -- This Hono boundary answers a refused redirect through handleExit's defect path.
async function handleRedirect<E extends Env>(
  redirect: Redirect,
  c: HonoContext<E>,
  runtime: ManagedRuntime.ManagedRuntime<never, unknown>
): Promise<Response> {
  if (webUrl(redirect.url, c.req.url) === undefined) {
    return handleExit(Exit.die(new Error(`A redirect leads to a path or an http: or https: URL, not ${schemeOf(redirect.url)}.`)), c, runtime)
  }

  return c.redirect(redirect.url, redirect.status)
}

/** A refused redirect's scheme, for its defect's message without the URL a visitor may have written. */
function schemeOf(url: string): string {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url.replace(/[\t\n\r]/g, '').trim())?.[1]

  return scheme === undefined || /^https?$/i.test(scheme) ? 'an unreadable URL' : `a ${scheme.toLowerCase()}: URL`
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
  runtime: ManagedRuntime.ManagedRuntime<never, unknown>
): Promise<Response> {
  const boundaryConfig = setupOf(c).errors

  if (Exit.isSuccess(exit)) {
    const value = exit.value

    if (isRedirect(value)) {
      return handleRedirect(value, c, runtime)
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
          {
            source: 'framework',
            handling: 'unhandled',
            kind: 'defect',
            error: err,
            structured,
          },
          runtime
        )
        return renderErrorResponse(new Error(err instanceof Error ? err.message : structured.message), c, boundaryConfig, structured)
      }

      // Otherwise create a generic defect error
      const structured = createStructuredError(
        ErrorCodes.INT_801_EFFECT_DEFECT,
        { reason: describeDefect(err) },
        context
      )

      await observeEffectError(
        {
          source: 'framework',
          handling: 'unhandled',
          kind: 'defect',
          error: err,
          structured,
        },
        runtime
      )

      return renderErrorResponse(err instanceof Error ? err : new Error(String(err)), c, boundaryConfig, structured)
    }
  }

  // Fallback: throw generic error with structured info
  const structured = createStructuredError(
    ErrorCodes.INT_800_UNEXPECTED,
    { reason: 'Unknown effect failure' },
    context
  )

  await observeEffectError(
    {
      source: 'framework',
      handling: 'unhandled',
      kind: 'defect',
      error: new Error('Unknown effect failure'),
      structured,
    },
    runtime
  )
  return renderErrorResponse(new Error('Unknown effect failure'), c, boundaryConfig, structured)
}

/**
 * A defect as a developer reads it on the development error page: a tagged
 * failure an action turned into a defect with `Effect.orDie` by its tag, then
 * its message, if any. Production shows none of it.
 */
function describeDefect(error: unknown): string {
  const tag: unknown = error instanceof Object ? Reflect.get(error, '_tag') : undefined
  const message = error instanceof Error ? error.message : ''

  if (typeof tag === 'string') return message === '' ? tag : `${tag}: ${message}`

  return error instanceof Error ? message || error.name : String(error)
}
