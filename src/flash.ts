/**
 * Flash data: values one request hands to the page the user sees next.
 *
 * A form that fails validation redirects back, and its field errors reach the
 * page the redirect renders; an action's `flash(key, value)` reaches that
 * page's Inertia `flash` field. Both travel in a short-lived cookie that the
 * next page to render reads and clears, so they show once, without
 * server-side sessions; a request that only redirects passes them on. Data
 * set during a request that renders a page goes into that page directly.
 * The same cookie tells the next page to clear Inertia's history once the
 * session ends.
 */

import type { Context } from 'hono'
import { getCookie } from 'hono/cookie'
import { serialize } from 'hono/utils/cookie'
import { Option, Schema as S } from 'effect'
import type { PagePropValue } from './types.js'

/** Field errors, or field errors under the error bags of named forms. */
export type FlashErrors = Readonly<Record<string, string | Readonly<Record<string, string>>>>

/** What a page receives from flash. */
export interface FlashedPageData {
  readonly errors: FlashErrors
  /** Inertia's page `flash` field. Values reach the client as JSON. */
  readonly flash: Readonly<Record<string, unknown>>
  /** Whether the page clears Inertia's history: the session ended since the last page. */
  readonly clearHistory: boolean
}

interface MutableFlash {
  errors: Record<string, string | Readonly<Record<string, string>>>
  flash: Record<string, unknown>
  clearHistory: boolean
}

/** The request's flash data: what the previous request left and what this one sets. */
export interface FlashStore {
  /** Hand `value` to the next page under `key`. */
  set(key: string, value: PagePropValue): void
  /** Hand field errors to the next page, under `bag` when the form named one. */
  setErrors(errors: Readonly<Record<string, string>>, bag?: string): void
  /** Have the next page clear Inertia's history. */
  clearHistory(): void
  /** The data for the page this request renders. */
  take(): FlashedPageData
  /** Whether committing a response of this status writes the flash cookie, to carry data or clear it. */
  setsCookie(status: number): boolean
  /** The response with the cookie that carries data to the next request, or clears it. */
  commit(response: Response): Response
}

const COOKIE = 'popweb-flash'
/** `__Host-` cookies are HTTPS-only, host-only and Path=/, so subdomains cannot plant flash data. */
const SECURE_COOKIE = `__Host-${COOKIE}`
const MAX_AGE_SECONDS = 60
/** Browsers drop cookies over 4 KB; flash data past this budget is not carried. */
const MAX_COOKIE_BYTES = 3800

const StoredFlash = S.Struct({
  errors: S.Record(S.String, S.Union([S.String, S.Record(S.String, S.String)])),
  flash: S.Record(S.String, S.Unknown),
  clearHistory: S.optional(S.Boolean),
})

const decodeStored = S.decodeUnknownOption(S.fromJsonString(StoredFlash))

const empty = (): MutableFlash => ({ errors: {}, flash: {}, clearHistory: false })

/** Open the flash store for a request. */
export function openFlash(c: Context): FlashStore {
  const secure = new URL(c.req.url).protocol === 'https:'
  const name = secure ? SECURE_COOKIE : COOKIE
  const raw = getCookie(c, name)
  // An Inertia prefetch is not a visit: it leaves flash data for the visit.
  const prefetch = c.req.header('Purpose') === 'prefetch'

  const incoming = Option.map(
    raw === undefined ? Option.none() : decodeStored(fromBase64Url(raw)),
    (decoded): MutableFlash => ({ errors: decoded.errors, flash: decoded.flash, clearHistory: decoded.clearHistory === true })
  )
  const pending = empty()
  let delivered = false
  const clears = raw !== undefined && !prefetch

  // A request that only redirects, such as a guard sending the visitor on,
  // renders no page: what it received goes on with the redirect, so a failed
  // form's errors reach the page it lands on.
  const outgoing = (status: number): MutableFlash => {
    const redirects = status >= 300 && status < 400
    const carried = redirects && !delivered && !prefetch ? Option.getOrElse(incoming, empty) : empty()

    return {
      errors: { ...carried.errors, ...pending.errors },
      flash: { ...carried.flash, ...pending.flash },
      clearHistory: carried.clearHistory || pending.clearHistory,
    }
  }

  return {
    set(key, value) {
      pending.flash[key] = value
    },

    setErrors(errors, bag) {
      if (bag === undefined) {
        Object.assign(pending.errors, errors)
      } else {
        pending.errors[bag] = { ...errors }
      }
    },

    clearHistory() {
      pending.clearHistory = true
    },

    take() {
      const previous = Option.getOrElse(incoming, empty)
      const data = {
        errors: delivered || prefetch ? { ...pending.errors } : { ...previous.errors, ...pending.errors },
        flash: delivered || prefetch ? { ...pending.flash } : { ...previous.flash, ...pending.flash },
        clearHistory: delivered || prefetch ? pending.clearHistory : previous.clearHistory || pending.clearHistory,
      }

      delivered = !prefetch
      Object.assign(pending, empty())

      return data
    },

    setsCookie(status) {
      return clears || hasData(outgoing(status))
    },

    commit(response) {
      const next = outgoing(response.status)
      const carries = hasData(next)

      if (!carries && !clears) return response

      const cookie = carries
        ? serialize(name, toBase64Url(stored(withinBudget(next))), {
            path: '/',
            httpOnly: true,
            secure,
            sameSite: 'Lax',
            maxAge: MAX_AGE_SECONDS,
          })
        : serialize(name, '', { path: '/', httpOnly: true, secure, sameSite: 'Lax', maxAge: 0 })

      const headers = new Headers(response.headers)
      headers.append('Set-Cookie', cookie)

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      })
    },
  }
}

function hasData(data: MutableFlash): boolean {
  return Object.keys(data.errors).length > 0 || Object.keys(data.flash).length > 0 || data.clearHistory
}

/** The cookie's JSON, which names `clearHistory` only when it is set. */
function stored(data: MutableFlash): string {
  return JSON.stringify(data.clearHistory ? data : { errors: data.errors, flash: data.flash })
}

/**
 * Keep field errors before flash values when the data outgrows a cookie,
 * and clearing the history before either.
 */
function withinBudget(data: MutableFlash): MutableFlash {
  const fits = (candidate: MutableFlash) =>
    toBase64Url(stored(candidate)).length <= MAX_COOKIE_BYTES

  if (fits(data)) return data

  const errorsOnly = { errors: data.errors, flash: {}, clearHistory: data.clearHistory }

  return fits(errorsOnly) ? errorsOnly : { ...empty(), clearHistory: data.clearHistory }
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''

  for (const byte of bytes) binary += String.fromCharCode(byte)

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(encoded: string): string {
  try {
    const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'))

    return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))
  } catch {
    return ''
  }
}
