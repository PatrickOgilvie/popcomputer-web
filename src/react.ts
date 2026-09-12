/** React types for @popcomputer/web applications. */

import type { PageProps } from './helpers.js'

type ReactRenderable = string | number | boolean | null | undefined | object

type ComponentType<P = Record<never, never>> = (props: P) => ReactRenderable

export type WebPage<TProps = Record<string, never>> = ComponentType<TProps & PageProps>

/** @deprecated Use {@link WebPage}. */
export type HonertiaPage<TProps = Record<string, never>> = WebPage<TProps>

export type PageResolver = (name: string) => 
  | Promise<{ default: ComponentType<unknown> }>
  | { default: ComponentType<unknown> }

export interface SharedProps {
  errors?: Record<string, string>
}

export type WithSharedProps<TProps = Record<string, never>> = TProps & SharedProps

export type { PageProps } from './helpers.js'
