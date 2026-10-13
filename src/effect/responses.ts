/**
 * Effect Response Helpers
 *
 * Utility functions for creating responses within Effect computations.
 */

import { Context, Effect, Layer, Option, Stream } from 'effect'
import { href, type PathArguments } from '../paths.js'
import {
  PageService,
  ResponseFactoryService,
  RequestService,
} from './services.js'
import { Redirect, NotFoundError, ForbiddenError, HttpError } from './errors.js'
import type { PagePropValue } from '../types.js'
import {
  encodeDeclaredField,
  encodePageProps,
  type FlashKey,
  type FlashValue,
  type PageName,
  type PagePropsArgument,
  type SharedKey,
  type SharedValue,
} from './pages.js'

/**
 * Redirect (303) to a route path, filling its placeholders: the path the
 * route is registered with, so the URL follows it.
 *
 * @example
 * return yield* redirect(paths.project, { project: project.id })
 * return yield* redirect(paths.projects, {}, { page: 2 })
 */
export function redirect<const Path extends string>(
  path: Path,
  ...args: PathArguments<Path>
): Effect.Effect<Redirect, never, never> {
  return Effect.succeed(new Redirect({ url: href(path, ...args), status: 303 }))
}

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
  return renderPage(component, args[0])
}

/** Render a page whose name and props `render`'s signature has checked. */
function renderPage(component: string, props: object | undefined): Effect.Effect<Response, never, PageService> {
  return Effect.gen(function* () {
    const page = yield* PageService
    const encoded = yield* encodePageProps(page.pages, component, props)
    const sharing = yield* Effect.serviceOption(PageSharing)

    if (Option.isSome(sharing)) {
      yield* sharing.value.share
    }

    return yield* Effect.promise(() => page.render(component, encoded))
  }).pipe(Effect.withSpan('Web.render', { attributes: { component } }))
}

/**
 * Hand a value to the page the user sees next, as Inertia's page `flash`.
 * After a redirect, that is the page the redirect renders.
 *
 * @example
 * yield* flash('success', 'Project created.')
 * return yield* redirect(paths.project, { project: project.id })
 */
export function flash<Key extends FlashKey>(key: Key, value: FlashValue<Key>): Effect.Effect<void, never, PageService> {
  return Effect.gen(function* () {
    const page = yield* PageService
    page.flash(key, yield* encodeDeclaredField(page.flashed, 'flash', key, value))
  })
}

/** A response's status and headers: a status alone, or both. */
export type ResponseOptions = number | { readonly status?: number; readonly headers?: HeadersInit }

/**
 * Return a JSON response.
 *
 * @example
 * return yield* json({ success: true })
 * return yield* json({ error: 'Not found' }, 404)
 * return yield* json(page, { headers: { 'Cache-Control': 'private, max-age=60' } })
 */
export const json = <T>(data: T, init: ResponseOptions = 200): Effect.Effect<Response, never, ResponseFactoryService> =>
  Effect.gen(function* () {
    const factory = yield* ResponseFactoryService

    return withHeaders(factory.json(data, statusOf(init)), init)
  })

/**
 * Return a text response.
 *
 * @example
 * return yield* text(feed, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } })
 */
export const text = (data: string, init: ResponseOptions = 200): Effect.Effect<Response, never, ResponseFactoryService> =>
  Effect.gen(function* () {
    const factory = yield* ResponseFactoryService

    return withHeaders(factory.text(data, statusOf(init)), init)
  })

/** How `file` answers: the body's media type, and a download name. */
export interface FileOptions {
  /** The body's media type, such as `text/csv; charset=utf-8`. */
  readonly contentType: string
  /** Offer the body as a download with this file name. Without it, browsers show the body inline. */
  readonly filename?: string
  readonly status?: number
  readonly headers?: HeadersInit
}

/** A file body: text, bytes, a web stream, or an Effect Stream of text or bytes. */
export type FileBody<E, R> =
  | string
  | Uint8Array<ArrayBuffer>
  | ReadableStream<Uint8Array>
  | Stream.Stream<string | Uint8Array<ArrayBuffer>, E, R>

/**
 * Return a file: an export, a feed or stored media. A Stream body is sent as
 * it is produced; a failure after the response has started ends the body.
 *
 * @example
 * return yield* file(Stream.fromIterable(rows).pipe(Stream.map(toCsvLine)), {
 *   contentType: 'text/csv; charset=utf-8',
 *   filename: 'claims.csv',
 * })
 */
export function file<E = never, R = never>(
  body: FileBody<E, R>,
  options: FileOptions
): Effect.Effect<Response, never, R> {
  return Effect.gen(function* () {
    const headers = new Headers(options.headers)
    headers.set('Content-Type', options.contentType)

    if (options.filename !== undefined) {
      headers.set('Content-Disposition', contentDisposition(options.filename))
    }

    const content = Stream.isStream(body)
      ? yield* Stream.toReadableStreamEffect(body.pipe(Stream.map(toBytes)))
      : body

    return new Response(content, { status: options.status ?? 200, headers })
  })
}

const encoder = new TextEncoder()

function toBytes(chunk: string | Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  return typeof chunk === 'string' ? encoder.encode(chunk) : chunk
}

/** An attachment header naming the file, safe for any characters in the name. */
function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, '_')

  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

function statusOf(init: ResponseOptions): number {
  return typeof init === 'number' ? init : init.status ?? 200
}

function withHeaders(response: Response, init: ResponseOptions): Response {
  if (typeof init === 'number' || init.headers === undefined) return response

  const headers = new Headers(response.headers)
  new Headers(init.headers).forEach((value, name) => headers.set(name, value))

  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

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
      return varyOnAccept(yield* renderPage(component, args[0]))
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
 * Share a value with every page this request renders, under a key setupWeb's
 * `shared` declares; the value is encoded through its field.
 *
 * @example
 * yield* share('unreadCount', unread)
 */
export function share<Key extends SharedKey>(key: Key, value: SharedValue<Key>): Effect.Effect<void, never, PageService> {
  return Effect.gen(function* () {
    const page = yield* PageService
    page.share(key, yield* encodeDeclaredField(page.shared, 'shared', key, value))
  })
}

/** Shared props as `shareProps` computes them: any of setupWeb's `shared`. */
export type SharedPropsInput = { readonly [Key in SharedKey]?: SharedValue<Key> }

/** The shared props a request's pages compute when they render. Provided by `shareProps`. */
export class PageSharing extends Context.Service<
  PageSharing,
  { readonly share: Effect.Effect<void> }
>()('@popcomputer/web/PageSharing') {}

/**
 * Compute props every page shares, such as a header's unread count, when a
 * page renders: redirects and JSON responses never run it. Provide it on the
 * routes whose pages show them; each `shareProps` a route is given runs, in
 * order. A failure fails the page as a defect.
 *
 * @example
 * export const routes = web.routes.provide(shareProps(Effect.gen(function* () {
 *   const viewer = yield* currentUser
 *
 *   return viewer ? { unreadOffers: yield* countUnreadOffers(viewer.user.id) } : {}
 * })))
 */
export function shareProps<E, R>(
  compute: Effect.Effect<SharedPropsInput, E, R>
): Layer.Layer<PageSharing, never, R | PageService> {
  return Layer.effect(
    PageSharing,
    Effect.gen(function* () {
      const context = yield* Effect.context<R | PageService>()
      const earlier = yield* Effect.serviceOption(PageSharing)
      const own = compute.pipe(
        Effect.flatMap((values) =>
          Effect.gen(function* () {
            const page = yield* PageService

            for (const [key, value] of Object.entries(values)) {
              if (value !== undefined) {
                page.share(key, yield* encodeDeclaredField(page.shared, 'shared', key, value))
              }
            }
          })
        ),
        Effect.orDie,
        Effect.provideContext(context)
      )

      return PageSharing.of({
        share: Option.match(earlier, {
          onNone: () => own,
          onSome: (previous) => Effect.andThen(previous.share, own),
        }),
      })
    })
  )
}
