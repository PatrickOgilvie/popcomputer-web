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

import { Clock, Context, Duration, Effect, Option, Schema as S } from 'effect'
import { BindingsService } from './services.js'
import type { BindingName } from './config.js'

/** How a cookie is sent back: its lifetime and the paths it covers. */
export interface CookieOptions {
  /** How long the browser keeps it; without one, until the browser closes. */
  readonly maxAge?: Duration.Input
  /**
   * The paths it is sent to, by default `/`. A cached page whose path the
   * cookie covers is rendered afresh for every visitor carrying it, so scope a
   * cookie such as a cart to the paths that read it. A `{param}` placeholder
   * is filled from the route that sets the cookie, as `/r/{restaurant}/`.
   */
  readonly path?: string
  /** Default `Lax`; `Strict` keeps it off every request another site starts. */
  readonly sameSite?: 'Lax' | 'Strict'
  /** Default `true`: browser scripts cannot read it. */
  readonly httpOnly?: boolean
  /**
   * Sign the value with the secret in this binding (HMAC-SHA256 over the
   * cookie's name and value, and its expiry when it has a `maxAge`), so a
   * value the browser changed or made up reads as none, and so does a copy
   * kept past its `maxAge`. An unsigned cookie holds what any visitor sends:
   * use it for a preference or a pointer the server checks, never for
   * authority.
   */
  readonly signed?: { readonly secret: BindingName }
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
  /**
   * Add a `Set-Cookie` header another library wrote, such as Better Auth's
   * session cookie, to whatever response the request ends with.
   */
  append(setCookie: string): void
}

export class CookieService extends Context.Service<CookieService, CookieJar>()('@popcomputer/web/Cookies') {}

/** An application cookie: its value read, set and cleared through its schema. */
export interface Cookie<A> {
  readonly name: string
  /**
   * The value the request carries, or none when it is absent, does not match
   * the schema, or, for a signed cookie, carries no valid signature.
   */
  readonly read: Effect.Effect<Option.Option<A>, never, CookieService | BindingsService>
  /**
   * A value as the browser holds it, decoded, or none when the schema rejects
   * it. A signed cookie's signature is not checked: `read` checks it.
   */
  parse(raw: string): Option.Option<A>
  /** Set the cookie on the response. */
  set(value: A): Effect.Effect<void, never, CookieService | BindingsService>
  /** Clear the cookie in the browser. */
  readonly clear: Effect.Effect<void, never, CookieService>
}

const encoder = new TextEncoder()

function base64Url(bytes: ArrayBuffer): string {
  let binary = ''

  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte)

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | undefined {
  try {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'))

    return Uint8Array.from(binary, (char) => char.charCodeAt(0))
  } catch {
    return undefined
  }
}

const hmacKey = (secret: string) =>
  crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])

/**
 * Declare an application cookie: its name, the schema its value is checked
 * and encoded with, and how it is sent. The value travels as JSON, so the
 * browser holds what the schema encodes, and a value the request carries that
 * the schema rejects reads as none.
 */
export function cookie<A, I>(name: string, schema: S.Codec<A, I, never, never>, options: CookieOptions = {}): Cookie<A> {
  const json = S.toCodecJson(schema)
  const decodeJson = S.decodeUnknownOption(S.fromJsonString(json))
  const decodeValue = S.decodeUnknownOption(json)
  const encode = S.encodeEffect(json)

  // A value whose JSON form is a string, such as an id, is stored as it is,
  // so a cookie an application wrote by hand reads the same; one stored as a
  // JSON string reads too. A string that starts with a quote is stored as
  // JSON, so it does not read as a JSON string of something else.
  const parse = (raw: string): Option.Option<A> =>
    raw.startsWith('"')
      ? Option.orElse(decodeJson(raw), () => decodeValue(raw))
      : Option.orElse(decodeValue(raw), () => decodeJson(raw))

  const signing = options.signed
  // How long a signed value stays valid, when the cookie has a lifetime: the
  // browser drops the cookie then, and a copy kept past it must not read.
  const signedLifetime = signing === undefined || options.maxAge === undefined
    ? undefined
    : Math.floor(Duration.toSeconds(Duration.fromInputUnsafe(options.maxAge)))

  // A signed value is `value.signature`, or `value.expiry.signature` when it
  // expires, the expiry in seconds since the epoch. The two sign different
  // text, `name=value` and `name=value;expires=expiry`: a cookie value holds
  // no `;`, so neither signature passes for the other, and a value signed
  // before expiries were signed still reads.
  const unsigned = (raw: string): string => {
    if (signing === undefined) return raw

    const value = raw.slice(0, Math.max(0, raw.lastIndexOf('.')))
    const dated = signedLifetime === undefined ? null : /^(.*)\.\d+$/s.exec(value)

    return dated?.[1] ?? value
  }
  const signedText = (value: string, expiry: string | undefined) =>
    expiry === undefined ? `${name}=${value}` : `${name}=${value};expires=${expiry}`

  const secret: Effect.Effect<string, never, BindingsService> = Effect.flatMap(BindingsService, (bindings) => {
    const binding = signing?.secret ?? ''
    const value: unknown = Reflect.get(bindings, binding)

    return typeof value === 'string' && value !== ''
      ? Effect.succeed(value)
      : Effect.die(new Error(`Cookie '${name}' is signed with the secret in ${binding}, which this request's bindings lack.`))
  })

  const signatureOf = (text: string) =>
    Effect.flatMap(secret, (key) =>
      Effect.promise(async () => base64Url(await crypto.subtle.sign('HMAC', await hmacKey(key), encoder.encode(text))))
    )

  const verified = (raw: string): Effect.Effect<Option.Option<string>, never, BindingsService> => {
    if (signing === undefined) return Effect.succeedSome(raw)

    const dot = raw.lastIndexOf('.')
    const signature = dot < 0 ? undefined : fromBase64Url(raw.slice(dot + 1))

    if (signature === undefined) return Effect.succeedNone

    const signedPart = raw.slice(0, dot)
    const dated = /^(.*)\.(\d+)$/s.exec(signedPart)

    return Effect.gen(function* () {
      const key = yield* secret
      const verify = (text: string) =>
        Effect.promise(async () => crypto.subtle.verify('HMAC', await hmacKey(key), signature, encoder.encode(text)))

      // A value signed with its expiry reads until then, whatever the
      // declaration now says; one signed without reads as it always has.
      if (dated !== null && (yield* verify(signedText(dated[1] ?? '', dated[2])))) {
        const now = yield* Clock.currentTimeMillis

        return Number(dated[2]) * 1000 > now ? Option.some(dated[1] ?? '') : Option.none()
      }

      return (yield* verify(signedText(signedPart, undefined))) ? Option.some(signedPart) : Option.none()
    })
  }

  const withSignature = (stored: string): Effect.Effect<string, never, BindingsService> =>
    Effect.gen(function* () {
      if (signedLifetime === undefined) return `${stored}.${yield* signatureOf(signedText(stored, undefined))}`

      const expiry = String(Math.floor((yield* Clock.currentTimeMillis) / 1000) + signedLifetime)

      return `${stored}.${expiry}.${yield* signatureOf(signedText(stored, expiry))}`
    })

  return {
    name,
    parse: (raw) => parse(unsigned(raw)),
    read: Effect.flatMap(CookieService, (jar) => {
      const raw = jar.get(name)

      return raw === undefined ? Effect.succeedNone : Effect.map(verified(raw), Option.flatMap(parse))
    }),
    set: (value) => Effect.flatMap(CookieService, (jar) =>
      encode(value).pipe(
        Effect.mapError((issue) => new Error(`The value for cookie '${name}' does not match its schema: ${issue.message}`)),
        Effect.orDie,
        Effect.map((encoded) => (typeof encoded === 'string' && !encoded.startsWith('"') ? encoded : JSON.stringify(encoded))),
        Effect.flatMap((stored) => (signing === undefined ? Effect.succeed(stored) : withSignature(stored))),
        Effect.map((stored) => jar.set({ name, value: stored, options }))
      )
    ),
    clear: Effect.map(CookieService, (jar) => jar.set({ name, value: '', options: { ...options, maxAge: 0 } })),
  }
}
