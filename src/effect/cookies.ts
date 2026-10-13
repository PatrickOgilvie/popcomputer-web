/**
 * Application cookies, each declared once with the schema of its value:
 * actions read, set and clear it through the declaration, and the response
 * carries what they set.
 *
 * @example
 * export const cartCookie = cookie('cart', S.String, { maxAge: '30 days', path: '/r' })
 *
 * const cartId = yield* cartCookie.read // Option<string>
 * yield* cartCookie.set(cart.id)
 * yield* cartCookie.clear
 */

import { Context, Duration, Effect, Option, Schema as S } from 'effect'

/** How a cookie is sent back: its lifetime and the paths it covers. */
export interface CookieOptions {
  /** How long the browser keeps it; without one, until the browser closes. */
  readonly maxAge?: Duration.Input
  /**
   * The paths it is sent to, by default `/`. A cached page whose path the
   * cookie covers is rendered afresh for every visitor carrying it, so scope a
   * cookie such as a cart to the paths that read it.
   */
  readonly path?: string
  /** Default `Lax`; `Strict` keeps it off every request another site starts. */
  readonly sameSite?: 'Lax' | 'Strict'
  /** Default `true`: browser scripts cannot read it. */
  readonly httpOnly?: boolean
}

/** A cookie written by `serializeCookie`: its name, value and attributes. */
export interface CookieWrite {
  readonly name: string
  readonly value: string
  readonly options: CookieOptions
}

/** The request's cookies: those it carries, and those its response sets. */
export interface CookieJar {
  /** The value the request carries under `name`, if any. */
  get(name: string): string | undefined
  /** Set `name` on the response; an empty value with a zero lifetime clears it. */
  set(write: CookieWrite): void
}

export class CookieService extends Context.Service<CookieService, CookieJar>()('@popcomputer/web/Cookies') {}

/** An application cookie: its value read, set and cleared through its schema. */
export interface Cookie<A> {
  readonly name: string
  /** The value the request carries, or none when it is absent or does not match the schema. */
  readonly read: Effect.Effect<Option.Option<A>, never, CookieService>
  /** Set the cookie on the response. */
  set(value: A): Effect.Effect<void, never, CookieService>
  /** Clear the cookie in the browser. */
  readonly clear: Effect.Effect<void, never, CookieService>
}

/**
 * Declare an application cookie: its name, the schema its value is checked
 * and encoded with, and how it is sent. The value travels as JSON, so the
 * browser holds what the schema encodes, and a value the request carries that
 * the schema rejects reads as none.
 */
export function cookie<A, I>(name: string, schema: S.Codec<A, I, never, never>, options: CookieOptions = {}): Cookie<A> {
  const codec = S.fromJsonString(S.toCodecJson(schema))
  const decode = S.decodeUnknownOption(codec)
  const encode = S.encodeSync(codec)

  return {
    name,
    read: Effect.map(CookieService, (jar) => {
      const raw = jar.get(name)

      return raw === undefined ? Option.none() : decode(raw)
    }),
    set: (value) => Effect.map(CookieService, (jar) => jar.set({ name, value: encode(value), options })),
    clear: Effect.map(CookieService, (jar) => jar.set({ name, value: '', options: { ...options, maxAge: 0 } })),
  }
}
