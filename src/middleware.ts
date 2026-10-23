/** Inertia protocol middleware. */

import type { Context, MiddlewareHandler } from 'hono'
import { Option, Schema as S } from 'effect'
import type {
  LazyPageProp,
  PageProps,
  WebConfig,
  WebInstance,
  PageObject,
  RenderOptions,
} from './types.js'
import { HEADERS } from './types.js'
import { openWebContext, type WebRequestContext } from './request-context.js'
import { openFlash } from './flash.js'
import { applyDefaultCacheControl } from './page-cache.js'
import { ConfigurationError } from './effect/errors.js'
import { webUrl } from './locations.js'

declare module 'hono' {
  interface ContextVariableMap {
    /** Page rendering API for plain Hono handlers. */
    web: WebInstance
  }
}

interface ValidationErrorBag {
  [field: string]: string | Readonly<Record<string, string>>
}

// oxlint-disable-next-line effecttsgo/async-function -- Hono middleware and renderer contracts use native next()/Response promises; typed Effect work stays inside that request boundary.
async function resolveValue<T>(value: T | (() => T | Promise<T>)): Promise<T> {
  if (value instanceof Function) {
    return value()
  }

  return value
}

/**
 * Build a predicate deciding whether a prop key survives a partial reload.
 *
 * Mirrors Inertia's `only`/`except` semantics: `errors` is always retained so
 * validation feedback is never dropped from a partial response.
 */
function createPartialPredicate(
  include?: string,
  exclude?: string
): (key: string) => boolean {
  const includeKeys = include
    ? include.split(',').map((k) => k.trim())
    : undefined

  const excludeKeys = exclude
    ? exclude.split(',').map((k) => k.trim())
    : undefined

  return (key: string): boolean => {
    if (key === 'errors') return true

    if (includeKeys && !includeKeys.includes(key)) return false

    if (excludeKeys && excludeKeys.includes(key)) return false

    return true
  }
}

function filterPartialProps(
  props: PageProps,
  keep: (key: string) => boolean
): PageProps {
  return Object.fromEntries(
    Object.entries(props).filter(([key]) => keep(key))
  )
}

export function web(config: WebConfig): MiddlewareHandler {
  // oxlint-disable-next-line effecttsgo/async-function -- Hono middleware and renderer contracts use native next()/Response promises; typed Effect work stays inside that request boundary.
  return async (c: Context, next) => {
    const sharedProps: Record<string, LazyPageProp> = {}
    const errors: ValidationErrorBag = {}
    const flash = openFlash(c)
    // Whether a page this request rendered cleared the client's history.
    let historyCleared = false

    const getVersion = () =>
      config.version instanceof Function ? config.version() : config.version ?? ''

    // An application without a template answers only JSON, failures included.
    if (config.render === undefined) openWebContext(c).jsonApi = true

    const isInertia = c.req.header(HEADERS.INERTIA) === 'true'
    const clientVersion = c.req.header(HEADERS.VERSION)
    const version = getVersion()

    // Version mismatch - force full reload
    if (isInertia && clientVersion && clientVersion !== version && c.req.method === 'GET') {
      return c.body(null, {
        status: 409,
        headers: { [HEADERS.LOCATION]: c.req.url },
      })
    }

    const instance = {
      share(key: string, value: LazyPageProp) {
        sharedProps[key] = value
      },

      getShared() {
        return { ...sharedProps }
      },

      setErrors(newErrors: Record<string, string>) {
        Object.assign(errors, newErrors)
      },

      // oxlint-disable-next-line effecttsgo/async-function -- Hono middleware and renderer contracts use native next()/Response promises; typed Effect work stays inside that request boundary.
      async render<T extends PageProps>(
        component: string,
        props?: T,
        options: RenderOptions = {}
      ): Promise<Response> {
        const explicitProps: PageProps = props ?? {}
        // Determine whether this is an active partial reload for this component.
        // When it is, we can skip evaluating lazy shared props that the client
        // filtered out — that's the whole point of a partial reload.
        let partialKeep: ((key: string) => boolean) | undefined

        if (isInertia) {
          const partialComponent = c.req.header(HEADERS.PARTIAL_COMPONENT)
          const partialData = c.req.header(HEADERS.PARTIAL_DATA)
          const partialExcept = c.req.header(HEADERS.PARTIAL_EXCEPT)

          if (partialComponent === component && (partialData || partialExcept)) {
            partialKeep = createPartialPredicate(partialData, partialExcept)
          }
        }

        // Resolve lazy shared props. Skip any shared prop that is overridden by
        // an explicitly passed prop (the passed value wins) or that a partial
        // reload would discard — avoiding wasted work for deferred/lazy props.
        const resolvedShared = new Map<string, PageProps[string]>()

        for (const [key, value] of Object.entries(sharedProps)) {
          if (key in explicitProps) continue

          if (partialKeep && !partialKeep(key)) continue
          resolvedShared.set(key, await resolveValue(value))
        }

        const mergedProps = new Map<string, PageProps[string]>(resolvedShared)

        for (const [key, value] of Object.entries(explicitProps)) {
          mergedProps.set(key, value)
        }

        // Field errors: flashed by a failed form submission, then set by this request.
        const flashed = flash.take()
        const pageErrors = { ...flashed.errors, ...errors }

        if (Object.keys(pageErrors).length > 0) {
          const decodedErrors = S.decodeUnknownOption(
            S.Record(S.String, S.String)
          )(mergedProps.get('errors'))

          const mergedErrors = Option.isSome(decodedErrors)
            ? { ...decodedErrors.value }
            : {}

          Object.assign(mergedErrors, pageErrors)
          mergedProps.set('errors', mergedErrors)
        }

        if (!mergedProps.has('errors')) {
          mergedProps.set('errors', {})
        }

        // Apply the partial filter to the full merged object so explicitly
        // passed props also honor `only`/`except`.
        const pageProps = partialKeep
          ? filterPartialProps(Object.fromEntries(mergedProps), partialKeep)
          : Object.fromEntries(mergedProps)

        const context = openWebContext(c)
        const encrypt = config.history?.encrypt ?? 'signed-in'
        // A session the lookup found ended, or one ended since the last page,
        // leaves history its pages wrote that this visitor must not see.
        const sessionEnded = flashed.clearHistory || endsSession(context.sessionLookupCookies ?? [], context.sessionCookies ?? [])
        const page: PageObject = {
          component,
          props: pageProps,
          url: new URL(c.req.url).pathname + new URL(c.req.url).search,
          version,
          clearHistory: options.clearHistory ?? (sessionEnded || undefined),
          encryptHistory: options.encryptHistory ??
            ((encrypt === 'signed-in' ? context.authUser !== undefined : encrypt) || undefined),
          flash: flashed.flash,
        }

        historyCleared ||= page.clearHistory === true

        const status = options.status ?? 200

        if (isInertia) {
          return c.json(page, status, {
            [HEADERS.INERTIA]: 'true',
            'Vary': HEADERS.INERTIA,
          })
        }

        if (config.render === undefined) {
          throw new ConfigurationError({
            message: `render('${page.component}') answers a page, but setupWeb has no render, so this application answers only JSON.`,
            hint: "Give setupWeb a render template to answer pages, or answer this route with json(...) or an endpoint's contract.",
          })
        }

        const html = await config.render(page, c)

        return c.html(html, status, {
          'Vary': HEADERS.INERTIA,
        })
      },
    } satisfies WebInstance

    const requestContext = openWebContext(c)
    requestContext.web = instance
    requestContext.flash = flash
    c.set('web', instance)
    await next()

    // Convert 302 to 303 for non-GET requests
    // Guard against c.res being undefined (no handler matched)
    if (
      isInertia &&
      c.res &&
      c.res.status === 302 &&
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method)
    ) {
      const location = c.res.headers.get('Location')

      if (location) {
        // oxlint-disable-next-line no-param-reassign -- Hono middleware replaces c.res to apply the framework's response policy.
        c.res = new Response(null, {
          status: 303,
          headers: { 'Location': location, 'Vary': HEADERS.INERTIA },
        })
      }
    }

    // An Inertia visit follows a redirect inside its request, which cannot
    // reach another site, such as an OAuth provider or a payment page:
    // Inertia asks for those with 409 and X-Inertia-Location, and loads the
    // site as a full page. The redirect's cookies, such as an OAuth state,
    // stay on the response.
    const elsewhere = isInertia && c.res ? otherSiteLocation(c.res, c.req.url) : undefined

    if (elsewhere !== undefined && c.res) {
      const headers = new Headers({ [HEADERS.LOCATION]: elsewhere, Vary: HEADERS.INERTIA })
      for (const cookie of c.res.headers.getSetCookie()) headers.append('Set-Cookie', cookie)

      // oxlint-disable-next-line no-param-reassign -- Hono middleware replaces c.res to apply the framework's response policy.
      c.res = undefined
      // oxlint-disable-next-line no-param-reassign -- Hono middleware replaces c.res to apply the framework's response policy.
      c.res = new Response(null, { status: 409, headers })
    }

    const context = openWebContext(c)

    // A response that ends the session, as signing out does, has the next
    // page clear the history the signed-in pages wrote.
    if (c.res && !historyCleared && endsSession(answeredCookies(c.res, context), context.sessionCookies ?? [])) {
      flash.clearHistory()
    }

    const committed = c.res
      ? withResponseHeaders(
          withSessionLookupCookies(withResponseCookies(flash.commit(c.res), context.responseCookies), context.sessionLookupCookies),
          context.responseHeaders
        )
      : undefined

    if (committed !== undefined && committed !== c.res) {
      // Assigning c.res copies the previous response's Set-Cookie headers over
      // the new one's, which would drop the flash cookie; the committed
      // response already carries every cookie.
      // oxlint-disable-next-line no-param-reassign -- Hono middleware replaces c.res to apply the framework's response policy.
      c.res = undefined
      // oxlint-disable-next-line no-param-reassign -- Hono middleware replaces c.res to apply the framework's response policy.
      c.res = committed
    }

    // Without privateByDefault around it, as an application composed by hand
    // may be, web() says itself who may keep what it answers.
    if (c.res && context.cacheControlByDefault !== true) applyDefaultCacheControl(c)

    // Return the response to ensure proper propagation in forwarding scenarios
    return c.res
  }
}

export { HEADERS }

/** The response with the application cookies an action set. */
function withResponseCookies(response: Response, cookies: readonly string[] | undefined): Response {
  if (cookies === undefined || cookies.length === 0) return response

  const headers = new Headers(response.headers)

  for (const cookie of cookies) headers.append('Set-Cookie', cookie)

  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

/**
 * The response with the cookies the session lookup set, but for those the
 * response sets itself: a sign-in's new session outlives the old session's
 * renewal, or the expiry of one revoked elsewhere, which a browser applies
 * after it when written later.
 */
function withSessionLookupCookies(response: Response, cookies: readonly string[] | undefined): Response {
  if (cookies === undefined || cookies.length === 0) return response

  const set = new Set(response.headers.getSetCookie().map(cookieName))
  const kept = cookies.filter((cookie) => !set.has(cookieName(cookie)))

  return withResponseCookies(response, kept)
}

/** A Set-Cookie header's cookie name. */
function cookieName(setCookie: string): string {
  return setCookie.slice(0, setCookie.indexOf('=')).trim()
}

/**
 * The cookies the response sets once web() writes those the request queued,
 * in the order a browser applies them: its own, the application's, the
 * session lookup's it does not set itself, and those added with responseHeader.
 */
function answeredCookies(response: Response, context: WebRequestContext): string[] {
  const own = [...response.headers.getSetCookie(), ...(context.responseCookies ?? [])]
  const set = new Set(own.map(cookieName))

  return [
    ...own,
    ...(context.sessionLookupCookies ?? []).filter((cookie) => !set.has(cookieName(cookie))),
    ...(context.responseHeaders ?? []).filter(([name]) => name.toLowerCase() === 'set-cookie').map(([, value]) => value),
  ]
}

/**
 * Whether these Set-Cookie headers, applied in order, leave the session token
 * cookie expired: Better Auth's, under any prefix, or the one setupWeb's
 * `auth.sessionCookie` names.
 */
function endsSession(setCookies: readonly string[], sessionCookies: readonly string[]): boolean {
  const expired = new Map<string, boolean>()

  for (const setCookie of setCookies) {
    const name = cookieName(setCookie).replace(/^__(?:Secure|Host)-/, '')

    if (name.endsWith('.session_token') || sessionCookies.includes(name)) {
      const [pair = '', ...attributes] = setCookie.split(';')

      expired.set(name, pair.slice(pair.indexOf('=') + 1).trim() === '' ||
        attributes.some((attribute) => /^\s*max-age\s*=\s*(?:0|-\d+)\s*$/i.test(attribute)))
    }
  }

  return [...expired.values()].includes(true)
}

/** The response with the headers an action or layer added with responseHeader. */
function withResponseHeaders(response: Response, added: ReadonlyArray<readonly [string, string]> | undefined): Response {
  if (added === undefined || added.length === 0) return response

  const headers = new Headers(response.headers)

  for (const [name, value] of added) headers.append(name, value)

  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

/**
 * The redirect's location when it leads to another site than the request's,
 * which an Inertia visit cannot follow. Only a web page qualifies: Inertia
 * assigns the location to `window.location.href`, which would run a
 * `javascript:` URL on the application's page, though no browser follows one
 * from a redirect.
 */
function otherSiteLocation(response: Response, requestUrl: string): string | undefined {
  const location = response.status >= 300 && response.status < 400 ? response.headers.get('Location') : null

  if (location === null) return undefined

  const target = webUrl(location, requestUrl)

  return target !== undefined && target.origin !== webUrl(requestUrl)?.origin ? target.href : undefined
}
