/** Inertia protocol middleware. */

import type { Context, MiddlewareHandler } from 'hono'
import type { WebConfig, WebInstance, PageObject, RenderOptions } from './types.js'
import { HEADERS } from './types.js'
import { openHonertiaContext } from './request-context.js'

declare module 'hono' {
  interface ContextVariableMap {
    /** Page rendering API for plain Hono handlers. */
    web: WebInstance
    /** @deprecated Use `c.var.web`. */
    honertia: WebInstance
  }
}

async function resolveValue<T>(value: T | (() => T | Promise<T>)): Promise<T> {
  if (typeof value === 'function') {
    return await (value as () => T | Promise<T>)()
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
  props: Record<string, unknown>,
  keep: (key: string) => boolean
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(props).filter(([key]) => keep(key))
  )
}

export function web(config: WebConfig): MiddlewareHandler {
  return async (c: Context, next) => {
    const sharedProps: Record<string, unknown | (() => unknown | Promise<unknown>)> = {}
    let errors: Record<string, string> = {}

    const getVersion = () => 
      typeof config.version === 'function' ? config.version() : config.version

    const isHonertia = c.req.header(HEADERS.HONERTIA) === 'true'
    const clientVersion = c.req.header(HEADERS.VERSION)
    const version = getVersion()

    // Version mismatch - force full reload
    if (isHonertia && clientVersion && clientVersion !== version && c.req.method === 'GET') {
      return c.body(null, {
        status: 409,
        headers: { [HEADERS.LOCATION]: c.req.url },
      })
    }

    const instance: WebInstance = {
      share(key: string, value: unknown | (() => unknown | Promise<unknown>)) {
        sharedProps[key] = value
      },

      getShared() {
        return { ...sharedProps }
      },

      setErrors(newErrors: Record<string, string>) {
        errors = { ...errors, ...newErrors }
      },

      async render<T extends Record<string, unknown>>(
        component: string,
        props: T = {} as T,
        options: RenderOptions = {}
      ): Promise<Response> {
        // Determine whether this is an active partial reload for this component.
        // When it is, we can skip evaluating lazy shared props that the client
        // filtered out — that's the whole point of a partial reload.
        let partialKeep: ((key: string) => boolean) | undefined
        if (isHonertia) {
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
        const resolvedShared: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(sharedProps)) {
          if (key in props) continue
          if (partialKeep && !partialKeep(key)) continue
          resolvedShared[key] = await resolveValue(value)
        }

        let mergedProps: Record<string, unknown> = {
          ...resolvedShared,
          ...props,
        }

        // Add errors
        if (Object.keys(errors).length > 0) {
          mergedProps.errors = {
            ...(mergedProps.errors as Record<string, string> || {}),
            ...errors
          }
        }
        if (!mergedProps.errors) {
          mergedProps.errors = {}
        }

        // Apply the partial filter to the full merged object so explicitly
        // passed props also honor `only`/`except`.
        if (partialKeep) {
          mergedProps = filterPartialProps(mergedProps, partialKeep)
        }

        const page: PageObject = {
          component,
          props: mergedProps as Record<string, unknown> & { errors?: Record<string, string> },
          url: new URL(c.req.url).pathname + new URL(c.req.url).search,
          version,
          ...(options.clearHistory !== undefined && { clearHistory: options.clearHistory }),
          ...(options.encryptHistory !== undefined && { encryptHistory: options.encryptHistory }),
        }

        if (isHonertia) {
          return c.json(page, 200, {
            [HEADERS.HONERTIA]: 'true',
            'Vary': HEADERS.HONERTIA,
          })
        }

        const html = await config.render(page, c)
        return c.html(html, 200, {
          'Vary': HEADERS.HONERTIA,
        })
      },
    }

    const requestContext = openHonertiaContext(c)
    requestContext.web = instance
    requestContext.honertia = instance
    c.set('web', instance)
    c.set('honertia', instance)
    await next()

    // Convert 302 to 303 for non-GET requests
    // Guard against c.res being undefined (no handler matched)
    if (
      isHonertia &&
      c.res &&
      c.res.status === 302 &&
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method)
    ) {
      const location = c.res.headers.get('Location')
      if (location) {
        c.res = new Response(null, {
          status: 303,
          headers: { 'Location': location, 'Vary': HEADERS.HONERTIA },
        })
      }
    }

    // Return the response to ensure proper propagation in forwarding scenarios
    return c.res
  }
}

/** @deprecated Use {@link web}. */
export const honertia: typeof web = web

export { HEADERS }
