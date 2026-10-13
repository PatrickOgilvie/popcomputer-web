/**
 * React types for @popcomputer/web applications.
 *
 * Once the application declares its pages (setupWeb's `pages`) and registers
 * its setup, a page component names its page and receives the JSON form of
 * that page's props, with the shared props and field errors:
 *
 * @example
 * ```tsx
 * import type { WebPage } from '@popcomputer/web/react'
 *
 * const Show: WebPage<'Projects/Show'> = ({ project, errors }) => <h1>{project.name}</h1>
 * export default Show
 * ```
 */

import type { ReactNode } from 'react'
import type { ClientPageProps, Jsonify, PageName } from './effect/pages.js'
import type { DefaultPublicUser } from './effect/auth.js'
import type { Registered } from './effect/register.js'

/** A React function component, so a page renders as JSX and resolves in createInertiaApp. */
type ComponentType<P> = (props: P) => ReactNode

type RegisteredPublicUser = Registered<'publicUser', DefaultPublicUser>
type RegisteredShared = Registered<'shared', never>
type RegisteredFlash = Registered<'flash', never>

/**
 * Props every page receives from the application, derived from setupWeb:
 * `auth.user`, the signed-in user encoded through `auth.share` (or `null`),
 * and the `shared` props, each present when the request shared it.
 */
export type SharedProps = {
  readonly auth: { readonly user: Jsonify<RegisteredPublicUser> | null }
} & ([RegisteredShared] extends [never] ? Record<never, never> : Partial<Jsonify<RegisteredShared>>)

/**
 * A page's Inertia `flash` data, derived from setupWeb's `flash`: each value
 * is present when the previous request flashed it.
 */
export type FlashData = [RegisteredFlash] extends [never]
  ? Readonly<Record<string, unknown>>
  : Partial<Jsonify<RegisteredFlash>>

/**
 * Field errors by field, or, for a form that names an error bag, by bag and
 * field. Typed as Inertia types them, so both `errors.name` and
 * `errors.createProject.name` read as strings.
 */
export type PageFieldErrors = Readonly<Record<string, string>> &
  Readonly<Record<string, Readonly<Record<string, string>>>>

/** Props the framework gives every page: the field errors of a failed form. */
export interface FrameworkProps {
  readonly errors: PageFieldErrors
}

/** A page's props: the registered props of a page name, or the props given. */
export type PagePropsFor<Page extends string | object> =
  (Page extends string ? ClientPageProps<Page> : Page) & SharedProps & FrameworkProps

/** A page component, typed by its page name or by its own props. */
export type WebPage<Page extends PageName | object = Record<never, never>> = ComponentType<PagePropsFor<Page>>

/** The props the framework renders the error page (setupWeb's `errors.component`) with. */
export interface ErrorPageProps {
  readonly status: number
  readonly code: string
  readonly title: string
  readonly message: string
  /** The first fix, in development. */
  readonly hint?: string
  /** Ways to fix the error, in development. */
  readonly fixes?: ReadonlyArray<{ readonly description: string; readonly code?: string }>
}

export type PageResolver = (name: string) =>
  | Promise<{ default: ComponentType<never> }>
  | { default: ComponentType<never> }
