/**
 * The application's registration: one declaration every derived type reads.
 *
 * `setupWeb`'s result carries the types its configuration declares: the
 * Worker's bindings, the database and Better Auth clients, the signed-in
 * user, route model bindings, pages, shared props and flash data. Registering
 * it once makes every API that depends on them typed by them: `DatabaseService`,
 * `authorize`, `bound`, `render`, `WebPage`, `share`, `flash` and `testEnv`.
 *
 * @example
 * ```ts
 * export const web = setupWeb(new Hono<Env>(), { ... })
 *
 * declare module '@popcomputer/web' {
 *   interface Register {
 *     web: typeof web
 *   }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Register {}

/** What an application's setup declares. Each is `never` when it declares none. */
export interface WebTypes {
  /** The Worker's bindings: `Env['Bindings']` of the Hono app. */
  readonly bindings?: unknown
  /** The client setupWeb's `database` factory returns. */
  readonly database?: unknown
  /** The Drizzle schema route model binding reads. */
  readonly schema?: unknown
  /** The Better Auth client setupWeb's `auth.client` returns. */
  readonly auth?: unknown
  /** The signed-in user `auth.session` decodes. */
  readonly user?: unknown
  /** The public user `auth.share` encodes as the `auth.user` page prop. */
  readonly publicUser?: unknown
  /** The parsers of route model bindings (`bindings`). */
  readonly routeBindings?: unknown
  /** Each page's props schema (`pages`). */
  readonly pages?: unknown
  /** The props shared with every page (`shared`). */
  readonly shared?: unknown
  /** The values `flash` hands to the next page (`flash`). */
  readonly flash?: unknown
}

/**
 * Carries an application's types. `setupWeb`'s result is one; a test or a
 * hand-composed application can register one directly:
 * `interface Register { web: WebDeclaration<{ database: TestDatabase }> }`.
 */
export interface WebDeclaration<Types extends WebTypes> {
  /** Types only: never set at runtime. */
  readonly '~types'?: Types
}

type RegisteredTypes = Register extends { readonly web: WebDeclaration<infer Types> } ? Types : WebTypes

/** The type registered under `Key`, or `Fallback` when the application declares none. */
export type Registered<Key extends keyof WebTypes, Fallback> = RegisteredTypes extends {
  readonly [K in Key]: infer Declared
}
  ? [Declared] extends [never]
    ? Fallback
    : unknown extends Declared
      ? Fallback
      : Declared
  : Fallback
