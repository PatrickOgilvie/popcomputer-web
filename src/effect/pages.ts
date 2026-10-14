/**
 * The application's pages: each page component's props as an Effect Schema.
 *
 * Declared once in setupWeb's `pages`, and typed through the application's
 * registration, the registry types both sides of a page:
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
 * export const web = setupWeb(new Hono<Env>(), { ..., pages })
 * ```
 */

import { Effect, Predicate, Schema as S } from 'effect'
import type { PageProps, PagePropValue } from '../types.js'
import type { Registered } from './register.js'

/** A page's props schema: an Effect Schema of an object, needing no services. */
export type PageSchema = S.Codec<object, unknown, never, never>

/** Page component names and their props schemas, as setupWeb's `pages`. */
export type PageSchemas = Readonly<Record<string, PageSchema>>

type RegisteredPages = Registered<'pages', never>

type ConfiguredPages = RegisteredPages extends PageSchemas ? RegisteredPages : never

/** Whether the application registered its pages. */
export type PagesConfigured = [ConfiguredPages] extends [never] ? false : true

/** The page component names `render` accepts: every registered page, or any name. */
// Keys of the registered pages themselves: TypeScript can take `keyof` of the
// conditional ConfiguredPages through its constraint, Record<string, ...>,
// which would admit any string.
export type PageName = [ConfiguredPages] extends [never] ? string : Extract<keyof RegisteredPages, string>

/** The props an action passes to `render(component, props)`. */
export type PagePropsOf<Component extends string> = PagesConfigured extends true
  ? Component extends keyof ConfiguredPages
    ? S.Schema.Type<ConfiguredPages[Component]>
    : never
  : PageProps

/**
 * A prop value of a page without a registered schema: what JSON carries, in
 * arrays and objects of any declared shape, interfaces included, but no
 * functions.
 */
export type PagePropShape<Value> =
  Value extends string | number | boolean | null | undefined | Date ? Value
  : Value extends (...args: never) => unknown ? never
  : Value extends ReadonlyArray<infer Element> ? ReadonlyArray<PagePropShape<Element>>
  : Value extends object ? { readonly [Key in keyof Value]: PagePropShape<Value[Key]> }
  : never

/** The props of a page without a registered schema: an object whose values `PagePropShape` admits. */
export type PagePropsShape<Props> = { readonly [Key in keyof Props]: PagePropShape<Props[Key]> }

/**
 * `render`'s props argument: optional when the page needs none. Without
 * registered pages, `Props` is the props as given, checked by `PagePropsShape`.
 */
export type PagePropsArgument<Component extends string, Props = PageProps> = PagesConfigured extends true
  ? Record<never, never> extends PagePropsOf<Component>
    ? [props?: PagePropsOf<Component>]
    : [props: PagePropsOf<Component>]
  : [props?: Props]

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
    // SAFETY: without a registry, render's signature accepts only props PagePropsShape admits, the values JSON carries.
    return Effect.succeed(props as PageProps | undefined)
  }

  const schema = Object.hasOwn(pages, component) ? pages[component] : undefined

  if (schema === undefined) {
    return Effect.die(new Error(
      `Page '${component}' is not in setupWeb's pages. Add its props schema to the pages registry.`
    ))
  }

  // Props are encoded from their type, which is what the page's component
  // receives as JSON (Jsonify), so a schema built from validators, whose
  // encoded side is the request's raw input, serves as a page's props too.
  return S.encodeUnknownEffect(S.toCodecJson(S.toType(schema)))(props ?? {}).pipe(
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

/** Props shared with every page, as the application declares them in setupWeb's `shared`. */
type RegisteredShared = Registered<'shared', never>

/** The keys `share` accepts: the declared shared props, or any key before the application declares them. */
export type SharedKey = [RegisteredShared] extends [never] ? string : keyof RegisteredShared & string

/** The value `share(key, value)` takes for `key`. */
export type SharedValue<Key extends string> = [RegisteredShared] extends [never]
  ? PagePropValue
  : Key extends keyof RegisteredShared ? RegisteredShared[Key] : never

/** Flash data, as the application declares it in setupWeb's `flash`. */
type RegisteredFlash = Registered<'flash', never>

/** The keys `flash` accepts: the declared flash values, or any key before the application declares them. */
export type FlashKey = [RegisteredFlash] extends [never] ? string : keyof RegisteredFlash & string

/** The value `flash(key, value)` takes for `key`. */
export type FlashValue<Key extends string> = [RegisteredFlash] extends [never]
  ? PagePropValue
  : Key extends keyof RegisteredFlash ? RegisteredFlash[Key] : never

/** A struct of declared values, such as setupWeb's `shared` or `flash`. */
export type DeclaredFields = S.Struct<S.Struct.Fields>

/**
 * Encode one value as JSON through its field of a declared struct. Without a
 * struct the value passes through; a key the struct lacks, or a value its
 * field rejects, is a programming error the types normally prevent.
 */
export function encodeDeclaredField(
  declared: DeclaredFields | undefined,
  option: 'shared' | 'flash',
  key: string,
  value: unknown
): Effect.Effect<PagePropValue> {
  if (declared === undefined) {
    // SAFETY: without a declaration, share and flash accept only PagePropValue.
    return Effect.succeed(value as PagePropValue)
  }

  const field = Object.hasOwn(declared.fields, key) ? declared.fields[key] : undefined

  if (field === undefined) {
    return Effect.die(new Error(`'${key}' is not in setupWeb's ${option}. Declare it there.`))
  }

  // SAFETY: shared props and flash values are plain data, whose JSON encoding
  // needs no services.
  const codec = S.toCodecJson(S.toType(field)) as unknown as S.Codec<unknown, unknown, never, never>

  return S.encodeUnknownEffect(codec)(value).pipe(
    Effect.mapError((issue) => new Error(`The value for ${option} '${key}' does not match its schema: ${issue.message}`)),
    // SAFETY: a JSON codec's encoded value is JSON, which is a page prop value.
    Effect.map((encoded) => encoded as PagePropValue),
    Effect.orDie
  )
}
