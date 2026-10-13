/**
 * Effect Config for the Worker's vars and secrets, named as the application
 * declares its bindings.
 */

import { Config, type Duration, type Redacted } from 'effect'
import type { Registered } from './register.js'

type DeclaredBindings = Registered<'bindings', never>

/**
 * The name of a var or secret: a binding the application declares as a
 * string, or any name before it declares its bindings.
 */
export type BindingName = [DeclaredBindings] extends [never] ? string : StringBindingName<DeclaredBindings>

/** The names of the string-valued bindings among `Bindings`. */
type StringBindingName<Bindings> = {
  [Key in keyof Bindings]-?: NonNullable<Bindings[Key]> extends string ? Key : never
}[keyof Bindings] & string

/** Effect Config constructors whose names are the application's bindings. */
export interface BindingConfig {
  readonly string: (name: BindingName) => Config.Config<string>
  readonly number: (name: BindingName) => Config.Config<number>
  readonly int: (name: BindingName) => Config.Config<number>
  readonly boolean: (name: BindingName) => Config.Config<boolean>
  readonly duration: (name: BindingName) => Config.Config<Duration.Duration>
  readonly redacted: (name: BindingName) => Config.Config<Redacted.Redacted<string>>
  readonly url: (name: BindingName) => Config.Config<URL>
  readonly date: (name: BindingName) => Config.Config<Date>
}

/**
 * Effect `Config` for the Worker's vars and secrets, each name checked
 * against the bindings the Hono app's type declares: a misspelled name is a
 * type error, not a default silently taken. The values are Effect Config's,
 * read from the request's bindings in actions and services alike.
 *
 * @example
 * const ttl = yield* config.duration('HOLD_TTL').pipe(Config.withDefault(Duration.minutes(10)))
 * const secret = yield* config.redacted('WEBHOOK_SECRET')
 */
export const config: BindingConfig = {
  string: (name) => Config.String(name),
  number: (name) => Config.Number(name),
  int: (name) => Config.Int(name),
  boolean: (name) => Config.Boolean(name),
  duration: (name) => Config.Duration(name),
  redacted: (name) => Config.Redacted(name),
  url: (name) => Config.URL(name),
  date: (name) => Config.Date(name),
}
