/** Public protocol and rendering types. */

import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

export type PagePropValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | Date
  | readonly PagePropValue[]
  | PageProps

export interface PageProps {
  [key: string]: PagePropValue
}

export type LazyPageProp = PagePropValue | (() => PagePropValue | Promise<PagePropValue>)

export type SharedPageProps = Record<string, LazyPageProp>

/** Field errors, or field errors under the error bags of named forms. */
export type PageErrors = Readonly<Record<string, string | Readonly<Record<string, string>>>>

export interface PageObject<TProps extends object = PageProps> {
  component: string
  props: TProps & { errors?: PageErrors }
  url: string
  version: string
  /** The client forgets the key that encrypted its history, so earlier pages cannot be shown again. */
  clearHistory?: boolean
  /** The client encrypts this page in the browser's history. */
  encryptHistory?: boolean
  /** Inertia 3's flash data: values the previous request handed to this page. */
  flash?: Readonly<Record<string, unknown>>
}

export interface WebConfig {
  /**
   * The asset version: a client holding another version reloads the page in
   * full. Without one, pages carry none.
   */
  version?: string | (() => string)
  /**
   * The HTML document a first visit receives, holding the page object.
   * Without one, the application answers only JSON, as an API does: every
   * failure, an unknown path's included, is the JSON error envelope, and
   * rendering a page is a configuration error.
   */
  render?: (page: PageObject, ctx?: Context) => string | Promise<string>
  /**
   * How pages keep their props in the browser's history. Pages rendered to a
   * signed-in request are encrypted there unless this says otherwise, and the
   * first page after the session ends or another starts clears it, as does
   * every page rendered to a visitor who is not signed in, so Back after
   * sign-out cannot show the previous user's pages. A tab whose next page
   * goes to another signed-in user is cleared only when that page is the
   * first since the switch: one shown first in another tab took the clear.
   */
  history?: HistoryConfig
}

/** How pages keep their props in the browser's history: setupWeb's and web()'s `history`. */
export interface HistoryConfig {
  /**
   * Which pages Inertia encrypts in the browser's history, with a key the
   * tab forgets when the session ends: `'signed-in'`, the default, for pages
   * rendered to a signed-in request; `true` for every page; `false` for
   * none. `render(..., { encryptHistory })` decides for one page.
   */
  readonly encrypt?: boolean | 'signed-in'
}

export interface RenderOptions {
  clearHistory?: boolean
  encryptHistory?: boolean
  /**
   * That the page goes to a signed-in visitor, whoever signed them in:
   * `render` says so when the action's AuthUserService gives a user, from
   * the session lookup, a layer the route provides or web.services. A page
   * also goes to one when the session lookup found one. A signed-in page is
   * encrypted in history under the default `history.encrypt`, and answered
   * no-store.
   */
  signedIn?: boolean
  /**
   * The response's status, 200 unless given: 404 for a page that says what
   * is missing, as a visit and as the Inertia page object alike.
   */
  status?: ContentfulStatusCode
}

export interface WebInstance {
  render<T extends PageProps>(
    component: string,
    props?: T,
    options?: RenderOptions
  ): Response | Promise<Response>
  
  share(key: string, value: LazyPageProp): void
  getShared(): SharedPageProps
  setErrors(errors: Record<string, string>): void
}



export const HEADERS = {
  INERTIA: 'X-Inertia',
  VERSION: 'X-Inertia-Version',
  PARTIAL_COMPONENT: 'X-Inertia-Partial-Component',
  PARTIAL_DATA: 'X-Inertia-Partial-Data',
  PARTIAL_EXCEPT: 'X-Inertia-Partial-Except',
  LOCATION: 'X-Inertia-Location',
} as const
