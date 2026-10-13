/**
 * Effect Response Helpers
 *
 * Utility functions for creating responses within Effect computations.
 */

import { wantsJson } from './negotiation.js'
import { Cause, Context, Effect, Layer, Option, Schema as S, Stream } from 'effect'
import { observeOrLog } from './error-observer.js'
import { href, type PathArguments, type PathTarget } from '../paths.js'
import {
  PageService,
  ResponseFactoryService,
  RequestService,
} from './services.js'
import { Redirect, NotFoundError, ForbiddenError, HttpError, ValidationError } from './errors.js'
import { sameOriginReferer } from './referer.js'
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
  path: Path & PathTarget<Path>,
  ...args: PathArguments<Path>
): Effect.Effect<Redirect, never, never> {
  return Effect.succeed(new Redirect({ url: fillPath(path, args), status: 303 }))
}

/**
 * The URL to a path its caller's signature already checked: `href` with the
 * path and arguments widened, so it does not check them again.
 */
function fillPath(path: string, args: readonly unknown[]): string {
  // SAFETY: the caller's PathTarget and PathArguments checked these values.
  return href(path, ...(args as PathArguments<string>))
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
 * Return a JSON response. Given a schema first, the value is checked against
 * it and encoded through its JSON form, as a page's props are, so the
 * response's shape is declared once: the action, a client and a test
 * (`readJson(res, Schema)`) use the same schema.
 *
 * @example
 * return yield* json({ success: true })
 * return yield* json({ error: 'Not found' }, 404)
 * return yield* json(FlagsResponse, { flags, evaluatedAt: new Date() })
 */
export function json<A, I>(
  schema: S.Codec<A, I, never, never>,
  data: NoInfer<A>,
  init?: ResponseOptions
): Effect.Effect<Response, never, ResponseFactoryService>
export function json<T>(data: T, init?: ResponseOptions): Effect.Effect<Response, never, ResponseFactoryService>
export function json(
  first: unknown,
  second?: unknown,
  third?: ResponseOptions
): Effect.Effect<Response, never, ResponseFactoryService> {
  const declared = S.isSchema(first)
  // SAFETY: the overloads put the options second when no schema comes first.
  const init: ResponseOptions = (declared ? third : (second as ResponseOptions | undefined)) ?? 200

  return Effect.gen(function* () {
    const factory = yield* ResponseFactoryService
    const data = declared
      // SAFETY: the schema overload takes only schemas without services.
      ? yield* S.encodeUnknownEffect(S.toCodecJson(first as S.Codec<unknown, unknown, never, never>))(second).pipe(
          Effect.mapError((issue) => new Error(`The JSON response does not match its schema: ${issue.message}`)),
          Effect.orDie
        )
      : first

    return withHeaders(factory.json(data, statusOf(init)), init)
  })
}

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
 * Redirect (303) from anywhere in an action, such as a helper or a guard
 * layer, by failing with the redirect: the rest of the action does not run,
 * and the boundary answers with the redirect. The helper's type says it may
 * leave. Values flashed before it reach the next page.
 *
 * @example
 * const sellerStore = Effect.gen(function* () {
 *   const auth = yield* authorize()
 *
 *   return auth.user.storeId ?? (yield* redirectNow(paths.newStore))
 * })
 */
export function redirectNow<const Path extends string>(
  path: Path & PathTarget<Path>,
  ...args: PathArguments<Path>
): Effect.Effect<never, Redirect, never> {
  return Effect.fail(new Redirect({ url: fillPath(path, args), status: 303 }))
}

/**
 * Fail the form with field errors, as `validateRequest` does: the form goes
 * back to its page, which receives them as `errors`, and a JSON client gets a
 * 422. Shows a domain error beside the field it concerns.
 *
 * @example
 * yield* placeOffer(input).pipe(
 *   Effect.catchTag('OfferTooLow', (error) => invalid({ amount: error.message }))
 * )
 */
export const invalid = (errors: Readonly<Record<string, string>>): Effect.Effect<never, ValidationError, never> =>
  Effect.fail(new ValidationError({ errors }))

/**
 * Redirect (303) back to the page the request came from, as a failed form
 * does, or to `fallback` when it came from another site or none.
 *
 * @example
 * Effect.catchTag('ListingNotOpen', (error) =>
 *   Effect.andThen(flash('error', error.message), back(paths.search))
 * )
 */
export function back<const Path extends string = '/'>(
  fallback?: Path & PathTarget<Path>,
  ...args: PathArguments<Path>
): Effect.Effect<Redirect, never, RequestService> {
  return Effect.gen(function* () {
    const request = yield* RequestService
    const previous = sameOriginReferer(request.header('Referer'), request.url)

    return new Redirect({ url: previous ?? fillPath(fallback ?? '/', args), status: 303 })
  })
}

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
 * Whether the request comes from a client that reads JSON rather than pages:
 * it asks for or sends JSON, or it asks for no HTML while sending an `Accept`
 * header (`fetch`'s `*\/*`) or an `Authorization` header. Inertia visits and
 * browsers, which ask for HTML, read pages.
 */
export const prefersJson: Effect.Effect<boolean, never, RequestService> =
  Effect.gen(function* () {
    const request = yield* RequestService

    return wantsJson((name) => request.header(name))
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
 * order. A failure, such as the database being unavailable, is reported to
 * `EffectErrorObserverService` and the page renders without the props it
 * computes: shared props are optional on the page, so it shows its defaults.
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
        Effect.catchCause((cause) =>
          observeOrLog(
            {
              source: 'user',
              handling: 'handled',
              kind: Cause.hasFails(cause) ? 'failure' : 'defect',
              error: Cause.squash(cause),
              metadata: { operation: 'shareProps' },
            },
            'Shared props failed; the page renders without them'
          )
        ),
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
