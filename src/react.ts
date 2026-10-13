/**
 * React types for @popcomputer/web applications.
 *
 * Once the application registers its pages (setupWeb's `pages`, mirrored by
 * augmenting `WebPagesType`), a page component names its page and receives
 * the JSON form of that page's props:
 *
 * @example
 * ```tsx
 * import type { WebPage } from '@popcomputer/web/react'
 *
 * const Show: WebPage<'Projects/Show'> = ({ project, errors }) => <h1>{project.name}</h1>
 * export default Show
 * ```
 */

import type { ClientPageProps, PageName } from './effect/pages.js'

type ReactRenderable = string | number | boolean | null | undefined | object

type ComponentType<P> = (props: P) => ReactRenderable

/**
 * Props the application shares with every page, such as the signed-in user.
 * Augment it to type them:
 *
 * @example
 * ```ts
 * declare module '@popcomputer/web/react' {
 *   interface SharedProps {
 *     auth: { user: { id: string; name: string | null } | null }
 *   }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SharedProps {}

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
