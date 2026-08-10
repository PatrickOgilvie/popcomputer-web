/** Public protocol and rendering types. */

import type { Context } from 'hono'

export interface PageObject<TProps = Record<string, unknown>> {
  component: string
  props: TProps & { errors?: Record<string, string> }
  url: string
  version: string
  clearHistory?: boolean
  encryptHistory?: boolean
}

export interface WebConfig {
  version: string | (() => string)
  render: (page: PageObject, ctx?: Context) => string | Promise<string>
}

export interface RenderOptions {
  clearHistory?: boolean
  encryptHistory?: boolean
}

export interface WebInstance {
  render<T extends Record<string, unknown>>(
    component: string,
    props?: T,
    options?: RenderOptions
  ): Response | Promise<Response>
  
  share(key: string, value: unknown | (() => unknown | Promise<unknown>)): void
  getShared(): Record<string, unknown>
  setErrors(errors: Record<string, string>): void
}

/** @deprecated Use {@link WebConfig}. */
export type HonertiaConfig = WebConfig

/** @deprecated Use {@link WebInstance}. */
export type HonertiaInstance = WebInstance

export const HEADERS = {
  HONERTIA: 'X-Inertia',
  VERSION: 'X-Inertia-Version',
  PARTIAL_COMPONENT: 'X-Inertia-Partial-Component',
  PARTIAL_DATA: 'X-Inertia-Partial-Data',
  PARTIAL_EXCEPT: 'X-Inertia-Partial-Except',
  LOCATION: 'X-Inertia-Location',
} as const
