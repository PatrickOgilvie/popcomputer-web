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
import type { PageProps, PagePropValue } from '../types.js'

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
 * @example
 * return yield* render('Dashboard/Index', { projects })
 */
export const render = <T extends PageProps>(
  component: string,
  props?: T
): Effect.Effect<Response, never, PageService> =>
  Effect.gen(function* () {
    const page = yield* PageService

    return yield* Effect.promise(() => page.render(component, props))
  })

/**
 * Render a page component with validation errors pre-set.
 *
 * @example
 * return yield* renderWithErrors('Auth/Login', { email: 'Invalid' })
 */
export const renderWithErrors = <T extends PageProps>(
  component: string,
  errors: Record<string, string>,
  props?: T
): Effect.Effect<Response, never, PageService> =>
  Effect.gen(function* () {
    const page = yield* PageService
    page.setErrors(errors)

    return yield* Effect.promise(() => page.render(component, props))
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
 * Return JSON if the client prefers it, otherwise render a page component.
 */
export const jsonOrRender = <T extends PageProps>(
  component: string,
  data: T
): Effect.Effect<Response, never, RequestService | PageService | ResponseFactoryService> =>
  Effect.gen(function* () {
    const wantsJson = yield* prefersJson

    if (wantsJson) {
      return yield* json(data)
    }

    return yield* render(component, data)
  })

/**
 * Share data with all page responses.
 */
export const share = (key: string, value: PagePropValue): Effect.Effect<void, never, PageService> =>
  Effect.gen(function* () {
    const page = yield* PageService
    page.share(key, value)
  })
