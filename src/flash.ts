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
 * session ends or another starts: that flag goes on through every answer
 * until a page the client shows takes it, and outlives the minute flash
 * data keeps. The cookie moves on the answer actually sent: a render the
 * action discarded shows nobody anything, so it takes nothing.
 */

import type { Context } from 'hono'
import { getCookie } from 'hono/cookie'
import { serialize } from 'hono/utils/cookie'
import { Data, Option, Result, Schema as S } from 'effect'
import { step, type Table } from './machine.js'
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

export interface MutableFlash {
  errors: Record<string, string | Readonly<Record<string, string>>>
  flash: Record<string, unknown>
  clearHistory: boolean
}

/** How a request ends, which is what moves the flash cookie. */
export type FlashAnswer =
  /** A page the client shows. `cleared` when it cleared Inertia's history. */
  | { readonly page: true; readonly cleared: boolean }
  /** Any other answer, a redirect among them. */
  | { readonly page: false; readonly status: number }

/** The request's flash data: what the previous request left and what this one sets. */
export interface FlashStore {
  /** Hand `value` to the next page under `key`. */
  set(key: string, value: PagePropValue): void
  /** Hand field errors to the next page, under `bag` when the form named one. */
  setErrors(errors: Readonly<Record<string, string>>, bag?: string): void
  /** Have the next page clear Inertia's history. */
  clearHistory(): void
  /** The data for a page this request renders, which it holds until the answer says the page was sent. */
  take(): FlashedPageData
  /** The Set-Cookie this answer carries, to carry data to the next request or clear it, if any. */
  cookie(answer: FlashAnswer): string | undefined
}

const COOKIE = 'popweb-flash'
/** `__Host-` cookies are HTTPS-only, host-only and Path=/, so subdomains cannot plant flash data. */
const SECURE_COOKIE = `__Host-${COOKIE}`
const MAX_AGE_SECONDS = 60
/** Browsers drop cookies over 4 KB; flash data past this budget is not carried. */
const MAX_COOKIE_BYTES = 3800
/** The form error a page shows in place of the field errors that did not fit. */
const ERRORS_LEFT_OUT = 'Some of the errors in this form could not be shown.'

const StoredFlash = S.Struct({
  errors: S.Record(S.String, S.Union([S.String, S.Record(S.String, S.String)])),
  flash: S.Record(S.String, S.Unknown),
  clearHistory: S.optional(S.Boolean),
  // When the data ends, beside a clear, which keeps the cookie past its Max-Age.
  until: S.optional(S.Number),
})

const decodeStored = S.decodeUnknownOption(S.fromJsonString(StoredFlash))

const empty = (): MutableFlash => ({ errors: {}, flash: {}, clearHistory: false })

const merged = (first: MutableFlash, second: MutableFlash): MutableFlash => ({
  errors: { ...first.errors, ...second.errors },
  flash: { ...first.flash, ...second.flash },
  clearHistory: first.clearHistory || second.clearHistory,
})

type FlashCookie = Data.TaggedEnum<{
  /** The browser holds no flash cookie. */
  Empty: {}
  /** It holds errors, flash values or the history's clear. */
  Holding: { readonly data: MutableFlash }
  /** It holds something this code cannot read. */
  Unreadable: {}
}>

/** How a request ended, with what it set that no page has shown. */
type FlashEvent = Data.TaggedEnum<{
  /** A page the client shows took what the cookie held. */
  Page: { readonly pending: MutableFlash; readonly cleared: boolean }
  Redirect: { readonly pending: MutableFlash }
  /** An answer that is no page and no redirect: JSON, a file, a 409, an empty 204. */
  Other: { readonly pending: MutableFlash }
  /** An Inertia prefetch, which the client keeps and shows only if the URL is visited. */
  Prefetch: { readonly pending: MutableFlash }
}>

/** What the answer does to the cookie. */
type CookieWrite = 'keep' | 'expire' | MutableFlash

const FlashCookie = Data.taggedEnum<FlashCookie>()
const FlashEvent = Data.taggedEnum<FlashEvent>()

/** The cookie that leaves this data: none once nothing is left. */
const leaving = (data: MutableFlash): readonly [FlashCookie, CookieWrite] =>
  hasData(data) ? [FlashCookie.Holding({ data }), data] : [FlashCookie.Empty(), 'expire']

/** Only what this request set changes the cookie. */
const addingOnly = (state: FlashCookie, held: MutableFlash, pending: MutableFlash): readonly [FlashCookie, CookieWrite] =>
  hasData(pending) ? leaving(merged(held, pending)) : [state, 'keep']

/**
 * What each answer does to the cookie. A page takes what it showed, and takes
 * the history's clear only if it cleared. A redirect carries everything on,
 * so a failed form's errors reach the page it lands on. Anything else leaves
 * the cookie as it is, unless the request added to it.
 */
export const flashCookieTable: Table<FlashCookie, FlashEvent, CookieWrite> = {
  Empty: {
    Page: { to: ['Empty', 'Holding'], run: (state, { pending }) => addingOnly(state, empty(), pending) },
    Redirect: { to: ['Empty', 'Holding'], run: (state, { pending }) => addingOnly(state, empty(), pending) },
    Other: { to: ['Empty', 'Holding'], run: (state, { pending }) => addingOnly(state, empty(), pending) },
    Prefetch: { to: ['Empty', 'Holding'], run: (state, { pending }) => addingOnly(state, empty(), pending) },
  },
  Holding: {
    Page: { to: ['Empty', 'Holding'], run: (state, { pending, cleared }) => leaving(merged({ ...empty(), clearHistory: state.data.clearHistory && !cleared }, pending)) },
    Redirect: { to: ['Empty', 'Holding'], run: (state, { pending }) => leaving(merged(state.data, pending)) },
    Other: { to: ['Holding'], run: (state, { pending }) => addingOnly(state, state.data, pending) },
    Prefetch: { to: ['Holding'], run: (state, { pending }) => addingOnly(state, state.data, pending) },
  },
  Unreadable: {
    Page: { to: ['Empty', 'Holding'], run: (_, { pending }) => leaving(pending) },
    Redirect: { to: ['Empty', 'Holding'], run: (_, { pending }) => leaving(pending) },
    Other: { to: ['Empty', 'Holding'], run: (_, { pending }) => leaving(pending) },
    Prefetch: { to: ['Unreadable', 'Holding'], run: (state, { pending }) => addingOnly(state, empty(), pending) },
  },
}

/** The cookie's data as it reads now: flash data past its minute has ended. */
const dataAt = (decoded: S.Schema.Type<typeof StoredFlash>, now: number): MutableFlash =>
  decoded.until !== undefined && decoded.until <= now
    ? { ...empty(), clearHistory: decoded.clearHistory === true }
    : { errors: decoded.errors, flash: decoded.flash, clearHistory: decoded.clearHistory === true }

/** What `pending` holds that `shown` did not show. */
const unshown = (pending: MutableFlash, shown: FlashedPageData): MutableFlash => ({
  errors: Object.fromEntries(Object.entries(pending.errors).filter(([key, value]) => shown.errors[key] !== value)),
  flash: Object.fromEntries(Object.entries(pending.flash).filter(([key, value]) => shown.flash[key] !== value)),
  clearHistory: pending.clearHistory && !shown.clearHistory,
})

/** Open the flash store for a request. `pages` says whether the application has any page to show. */
export function openFlash(c: Context, options: { readonly pages?: boolean } = {}): FlashStore {
  const secure = new URL(c.req.url).protocol === 'https:'
  const name = secure ? SECURE_COOKIE : COOKIE
  const raw = getCookie(c, name)
  // An Inertia prefetch is not a visit: it leaves flash data for the visit.
  const prefetch = c.req.header('Purpose') === 'prefetch'

  const decoded = raw === undefined ? Option.none() : decodeStored(fromBase64Url(raw))
  const cookie: FlashCookie = raw === undefined
    ? FlashCookie.Empty()
    // oxlint-disable-next-line effecttsgo/global-date -- A cookie's lifetime runs on the browser's clock, as session-cookies.ts reads it.
    : Option.match(decoded, { onNone: () => FlashCookie.Unreadable(), onSome: (value) => FlashCookie.Holding({ data: dataAt(value, Date.now()) }) })
  const held = cookie._tag === 'Holding' ? cookie.data : empty()
  const pending = empty()
  let shown: FlashedPageData | undefined

  const serialized = (next: MutableFlash): string => {
    const fitting = withinBudget(next)

    return hasData(fitting)
      // The history's clear waits for the page that applies it, however
      // long: until the browser closes, as the tab's key does. Data beside it
      // still ends in a minute, by the time the cookie holds.
      ? serialize(name, toBase64Url(stored(fitting, hasFields(fitting) ? serializedUntil() : undefined)), {
          path: '/',
          httpOnly: true,
          secure,
          sameSite: 'Lax',
          ...(fitting.clearHistory ? {} : { maxAge: MAX_AGE_SECONDS }),
        })
      : serialize(name, '', { path: '/', httpOnly: true, secure, sameSite: 'Lax', maxAge: 0 })
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
      if (options.pages !== false) pending.clearHistory = true
    },

    take() {
      shown = prefetch ? { ...pending } : merged(held, pending)

      return shown
    },

    cookie(answer) {
      const left = shown === undefined || !answer.page ? pending : unshown(pending, shown)
      const event = prefetch
        ? FlashEvent.Prefetch({ pending: left })
        : answer.page
          ? FlashEvent.Page({ pending: left, cleared: answer.cleared })
          : answer.status >= 300 && answer.status < 400
            ? FlashEvent.Redirect({ pending: left })
            : FlashEvent.Other({ pending: left })

      return Result.match(step(flashCookieTable, cookie, event), {
        // SAFETY of the table: no cell refuses.
        onFailure: (refused) => {
          throw refused
        },
        onSuccess: ([, write]) => write === 'keep'
          ? undefined
          : serialized(write === 'expire' ? empty() : write),
      })
    },
  }
}

/** When flash data written now ends. */
const serializedUntil = (): number =>
  // oxlint-disable-next-line effecttsgo/global-date -- A cookie's lifetime runs on the browser's clock, as session-cookies.ts reads it.
  Date.now() + MAX_AGE_SECONDS * 1000

const hasFields = (data: MutableFlash): boolean =>
  Object.keys(data.errors).length > 0 || Object.keys(data.flash).length > 0

function hasData(data: MutableFlash): boolean {
  return hasFields(data) || data.clearHistory
}

/** The cookie's JSON, which names `clearHistory` and `until` only when they are set. */
function stored(data: MutableFlash, until?: number): string {
  return JSON.stringify({
    errors: data.errors,
    flash: data.flash,
    ...(data.clearHistory ? { clearHistory: true } : {}),
    ...(until === undefined ? {} : { until }),
  })
}

/**
 * Keep field errors before flash values when the data outgrows a cookie of
 * `maxBytes`, clearing the history before either. Field errors that do not all
 * fit go in order, as many as do, with a form error saying the rest did not.
 */
export function withinBudget(data: MutableFlash, maxBytes = MAX_COOKIE_BYTES): MutableFlash {
  const fits = (candidate: MutableFlash) =>
    toBase64Url(stored(candidate)).length <= maxBytes

  if (fits(data)) return data

  const errorsOnly = { errors: data.errors, flash: {}, clearHistory: data.clearHistory }

  if (fits(errorsOnly)) return errorsOnly

  const entries = Object.entries(data.errors)
  const withFirst = (count: number): MutableFlash => ({
    errors: { ...Object.fromEntries(entries.slice(0, count)), form: ERRORS_LEFT_OUT },
    flash: {},
    clearHistory: data.clearHistory,
  })
  let kept = 0
  let tooMany = entries.length

  while (tooMany - kept > 1) {
    const middle = Math.floor((kept + tooMany) / 2)

    if (fits(withFirst(middle))) kept = middle
    else tooMany = middle
  }

  return fits(withFirst(kept)) ? withFirst(kept) : { ...empty(), clearHistory: data.clearHistory }
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
