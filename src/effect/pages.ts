/**
 * The application's pages: each page component's props as an Effect Schema.
 *
 * Registered once in setupWeb's `pages` and mirrored by augmenting
 * `WebPagesType`, the registry types both sides of a page:
 *
 * - `render('Projects/Show', props)` accepts only registered page names and
 *   checks `props` against the page's schema, then encodes them as JSON
 *   through it, so a `Date` reaches the client as an ISO string.
 * - `WebPage<'Projects/Show'>` from `@popcomputer/web/react` types the React
 *   component with the JSON form of the same props.
 *
 * @example
 * ```ts
 * export const pages = {
 *   'Projects/Show': S.Struct({ project: Project, canEdit: S.Boolean }),
 * }
 *
 * declare module '@popcomputer/web/effect' {
 *   interface WebPagesType {
 *     type: typeof pages
 *   }
 * }
 * ```
 */

import { Effect, Predicate, Schema as S } from 'effect'
import type { PageProps } from '../types.js'

/** A page's props schema: an Effect Schema of an object, needing no services. */
export type PageSchema = S.Codec<object, unknown, never, never>

/** Page component names and their props schemas, as setupWeb's `pages`. */
export type PageSchemas = Readonly<Record<string, PageSchema>>

/**
 * Augmentable registry used by `render`, `jsonOrRender` and `WebPage`.
 *
 * Set `type` to the same object passed as setupWeb's `pages`.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface WebPagesType {}

type ConfiguredPages = WebPagesType extends { type: infer Pages extends PageSchemas } ? Pages : never

/** Whether the application registered its pages. */
export type PagesConfigured = [ConfiguredPages] extends [never] ? false : true

/**
 * setupWeb's `pages` option: required, and the registry `WebPagesType`
 * names, once the application augments it.
 */
export type PagesOption = PagesConfigured extends true
  ? { readonly pages: ConfiguredPages }
  : { readonly pages?: PageSchemas }

/** The page component names `render` accepts: every registered page, or any name. */
export type PageName = PagesConfigured extends true ? keyof ConfiguredPages & string : string

/** The props an action passes to `render(component, props)`. */
export type PagePropsOf<Component extends string> = PagesConfigured extends true
  ? Component extends keyof ConfiguredPages
    ? S.Schema.Type<ConfiguredPages[Component]>
    : never
  : PageProps

/** `render`'s props argument: optional when the page needs none. */
export type PagePropsArgument<Component extends string> = PagesConfigured extends true
  ? Record<never, never> extends PagePropsOf<Component>
    ? [props?: PagePropsOf<Component>]
    : [props: PagePropsOf<Component>]
  : [props?: PageProps]

/**
 * A value as the client receives it after JSON encoding: dates and bigints
 * become strings, and arrays and objects carry their elements' JSON forms.
 */
export type Jsonify<T> =
  T extends Date | bigint ? string
  : T extends string | number | boolean | null | undefined ? T
  : T extends ReadonlyArray<infer Element> ? ReadonlyArray<Jsonify<Element>>
  : T extends object ? { [K in keyof T]: Jsonify<T[K]> }
  : never

/** The props a page component receives: the JSON form of its schema's type. */
export type ClientPageProps<Component extends string> = Jsonify<PagePropsOf<Component>>

/**
 * Encode a page's props through its schema as JSON.
 *
 * Without a registry the props pass through. A page missing from the
 * registry, or props its schema rejects, is a programming error the types
 * normally prevent, so it is a defect naming the page.
 */
export function encodePageProps(
  pages: PageSchemas | undefined,
  component: string,
  props: object | undefined
): Effect.Effect<PageProps | undefined> {
  if (pages === undefined) {
    // SAFETY: without a registry, render's signature accepts only PageProps.
    return Effect.succeed(props as PageProps | undefined)
  }

  const schema = Object.hasOwn(pages, component) ? pages[component] : undefined

  if (schema === undefined) {
    return Effect.die(new Error(
      `Page '${component}' is not in setupWeb's pages. Add its props schema to the pages registry.`
    ))
  }

  return S.encodeUnknownEffect(S.toCodecJson(schema))(props ?? {}).pipe(
    Effect.mapError((issue) => new Error(`The props for page '${component}' do not match its schema: ${issue.message}`)),
    Effect.flatMap((encoded) =>
      Predicate.isObject(encoded) && !Array.isArray(encoded)
        // SAFETY: a JSON object is a PageProps record of JSON page prop values.
        ? Effect.succeed(encoded as PageProps)
        : Effect.fail(new Error(`The schema for page '${component}' must describe an object of props.`))
    ),
    Effect.orDie
  )
}
