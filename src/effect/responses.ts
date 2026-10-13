/**
 * Effect Response Helpers
 *
 * Utility functions for creating responses within Effect computations.
 */

import { Effect } from 'effect'
import {
  PageService,
  ResponseFactoryService,
  RequestService,
} from './services.js'
import { Redirect, NotFoundError, ForbiddenError, HttpError } from './errors.js'
import type { PagePropValue } from '../types.js'
import { encodePageProps, type PageName, type PagePropsArgument } from './pages.js'

/**
 * Create a redirect response.
 *
 * @example
 * return yield* redirect('/projects')
 * return yield* redirect('/login', 302)
 */
export const redirect = (url: string, status: 302 | 303 = 303): Effect.Effect<Redirect, never, never> =>
  Effect.succeed(new Redirect({ url, status }))

/**
 * Render a page component.
 *
 * Once the application registers its pages (setupWeb's `pages`), the
 * component must be a registered page and `props` must match its schema,
 * which encodes them as JSON for the client.
 *
 * @example
 * return yield* render('Projects/Show', { project, canEdit })
 */
export function render<Component extends PageName>(
  component: Component,
  ...args: PagePropsArgument<Component>
): Effect.Effect<Response, never, PageService> {
  return Effect.gen(function* () {
    const page = yield* PageService
    const props = yield* encodePageProps(page.pages, component, args[0])

    return yield* Effect.promise(() => page.render(component, props))
  }).pipe(Effect.withSpan('Web.render', { attributes: { component } }))
}

/**
 * Hand a value to the page the user sees next, as Inertia's page `flash`.
 * After a redirect, that is the page the redirect renders.
 *
 * @example
 * yield* flash('success', 'Project created.')
 * return yield* redirect(`/projects/${project.id}`)
 */
export const flash = (key: string, value: PagePropValue): Effect.Effect<void, never, PageService> =>
  Effect.gen(function* () {
    const page = yield* PageService
    page.flash(key, value)
  })

/**
 * Return a JSON response.
 *
 * @example
 * return yield* json({ success: true })
 * return yield* json({ error: 'Not found' }, 404)
 */
export const json = <T>(data: T, status = 200): Effect.Effect<Response, never, ResponseFactoryService> =>
  Effect.gen(function* () {
    const factory = yield* ResponseFactoryService

    return factory.json(data, status)
  })

/**
 * Return a text response.
 */
export const text = (data: string, status = 200): Effect.Effect<Response, never, ResponseFactoryService> =>
  Effect.gen(function* () {
    const factory = yield* ResponseFactoryService

    return factory.text(data, status)
  })

/**
 * Fail with a not found error.
 *
 * @example
 * if (!project) return yield* notFound('Project')
 */
export const notFound = (resource: string, id?: string | number): Effect.Effect<never, NotFoundError, never> =>
  Effect.fail(new NotFoundError({ resource, id }))

/**
 * Fail with a forbidden error.
 *
 * @example
 * if (!canEdit) return yield* forbidden('You cannot edit this resource')
 */
export const forbidden = (message = 'Forbidden'): Effect.Effect<never, ForbiddenError, never> =>
  Effect.fail(new ForbiddenError({ message }))

/**
 * Fail with a custom HTTP error.
 */
export const httpError = (
  status: number,
  message: string,
  body?: PagePropValue
): Effect.Effect<never, HttpError, never> =>
  Effect.fail(new HttpError({ status, message, body }))

/**
 * Check if the request prefers JSON response.
 */
export const prefersJson: Effect.Effect<boolean, never, RequestService> =
  Effect.gen(function* () {
    const request = yield* RequestService
    const isInertia = request.header('X-Inertia') === 'true'

    if (isInertia) return false

    const accept = request.header('Accept') ?? ''

    if (accept.includes('application/json')) return true

    const contentType = request.header('Content-Type') ?? ''

    return contentType.includes('application/json')
  })

/**
 * Answer a JSON client with the page's props as JSON, and a page visit with
 * the rendered page. Both are encoded through the page's schema, and the
 * response varies on `Accept`, so a cache keeps the two apart.
 *
 * @example
 * return yield* jsonOrRender('Pages/Index', { pages, total })
 */
export function jsonOrRender<Component extends PageName>(
  component: Component,
  ...args: PagePropsArgument<Component>
): Effect.Effect<Response, never, RequestService | PageService | ResponseFactoryService> {
  return Effect.gen(function* () {
    const wantsJson = yield* prefersJson

    if (!wantsJson) {
      return varyOnAccept(yield* render(component, ...args))
    }

    const page = yield* PageService
    const props = yield* encodePageProps(page.pages, component, args[0])

    return varyOnAccept(yield* json(props ?? {}))
  })
}

function varyOnAccept(response: Response): Response {
  const headers = new Headers(response.headers)
  const vary = headers.get('Vary')

  headers.set('Vary', vary ? `${vary}, Accept` : 'Accept')

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/**
 * Share data with all page responses.
 */
export const share = (key: string, value: PagePropValue): Effect.Effect<void, never, PageService> =>
  Effect.gen(function* () {
    const page = yield* PageService
    page.share(key, value)
  })
