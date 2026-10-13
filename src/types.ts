/** Public protocol and rendering types. */

import type { Context } from 'hono'

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
  clearHistory?: boolean
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
}

export interface RenderOptions {
  clearHistory?: boolean
  encryptHistory?: boolean
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
