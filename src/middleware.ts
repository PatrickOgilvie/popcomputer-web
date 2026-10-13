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
import { openWebContext } from './request-context.js'
import { openFlash } from './flash.js'

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

    const getVersion = () => 
      config.version instanceof Function ? config.version() : config.version

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

        const page: PageObject = {
          component,
          props: pageProps,
          url: new URL(c.req.url).pathname + new URL(c.req.url).search,
          version,
          clearHistory: options.clearHistory,
          encryptHistory: options.encryptHistory,
          flash: flashed.flash,
        }

        if (isInertia) {
          return c.json(page, 200, {
            [HEADERS.INERTIA]: 'true',
            'Vary': HEADERS.INERTIA,
          })
        }

        const html = await config.render(page, c)

        return c.html(html, 200, {
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

    const committed = c.res ? flash.commit(c.res) : undefined

    if (committed !== undefined && committed !== c.res) {
      // Assigning c.res copies the previous response's Set-Cookie headers over
      // the new one's, which would drop the flash cookie; the committed
      // response already carries every cookie.
      // oxlint-disable-next-line no-param-reassign -- Hono middleware replaces c.res to apply the framework's response policy.
      c.res = undefined
      // oxlint-disable-next-line no-param-reassign -- Hono middleware replaces c.res to apply the framework's response policy.
      c.res = committed
    }

    // Return the response to ensure proper propagation in forwarding scenarios
    return c.res
  }
}

export { HEADERS }
