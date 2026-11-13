/**
 * Flash data: values one request hands to the page its redirect leads to.
 *
 * A form that fails validation redirects back, and its field errors reach the
 * page the redirect renders; an action's `flash(key, value)` reaches that
 * page's Inertia `flash` field. Both travel in a short-lived cookie that names
 * the page they are for, its path and query: that page reads and clears
 * them, so they show once, without server-side sessions, and a page another
 * tab renders meanwhile leaves them. A redirect from that page passes them on
 * to where it leads. Data a redirect to another site, or an answer that is no
 * redirect, leaves goes to whichever page renders next, as all data did
 * before it named a page. Data set during a request that renders a page goes
 * into that page directly.
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
  /** The address, path and query, of the page the errors and flash values are for; none for whichever page renders next. */
  for?: string
}

/** How a request ends, which is what moves the flash cookie. */
export type FlashAnswer =
  /** A page the client shows. `cleared` when it cleared Inertia's history. */
  | { readonly page: true; readonly cleared: boolean }
  /** Any other answer, a redirect among them, with the Location it leads to. */
  | { readonly page: false; readonly status: number; readonly location?: string | undefined }

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
  // The address of the page the data is for.
  for: S.optional(S.String),
})

const decodeStored = S.decodeUnknownOption(S.fromJsonString(StoredFlash))

const empty = (): MutableFlash => ({ errors: {}, flash: {}, clearHistory: false })

/** `data` for the page at `address`, or for whichever page renders next. */
const addressed = (data: MutableFlash, address: string | undefined): MutableFlash => {
  const { for: _previous, ...rest } = data

  return address === undefined || !hasFields(data) ? rest : { ...rest, for: address }
}

/**
 * Both sides' data, for the page one side names when only it holds fields or
 * both name the same, and for whichever page renders next when they differ.
 */
const merged = (first: MutableFlash, second: MutableFlash): MutableFlash =>
  addressed({
    errors: { ...first.errors, ...second.errors },
    flash: { ...first.flash, ...second.flash },
    clearHistory: first.clearHistory || second.clearHistory,
  }, !hasFields(second) ? first.for : !hasFields(first) ? second.for : first.for === second.for ? first.for : undefined)

/** Whether a page at `here` shows `data`'s fields: data for it, or for whichever page renders next. */
const isFor = (data: MutableFlash, here: string): boolean => data.for === undefined || data.for === here

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
  /** A page the client shows, at `here`, took what the cookie held for it. */
  Page: { readonly pending: MutableFlash; readonly cleared: boolean; readonly here: string }
  /** A redirect from `here` to `to`, an address on this site, or none for another site. */
  Redirect: { readonly pending: MutableFlash; readonly here: string; readonly to: string | undefined }
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
 * What each answer does to the cookie. A page takes what it showed: the
 * fields held for it, and the history's clear only if it cleared. A page at
 * another address leaves the fields for theirs. A redirect carries everything
 * on: what this request set, for the page it leads to, and, from the page the
 * cookie's fields are for, those fields too, so a failed form's errors reach
 * the page it lands on. Any other answer leaves the cookie as it is, unless
 * the request added to it or a page took the history's clear: what a request
 * sent may be older than the cookie by the time it answers.
 */
export const flashCookieTable: Table<FlashCookie, FlashEvent, CookieWrite> = {
  Empty: {
    Page: { to: ['Empty', 'Holding'], run: (state, { pending }) => addingOnly(state, empty(), pending) },
    Redirect: { to: ['Empty', 'Holding'], run: (state, { pending, to }) => addingOnly(state, empty(), addressed(pending, to)) },
    Other: { to: ['Empty', 'Holding'], run: (state, { pending }) => addingOnly(state, empty(), pending) },
    Prefetch: { to: ['Empty', 'Holding'], run: (state, { pending }) => addingOnly(state, empty(), pending) },
  },
  Holding: {
    Page: {
      to: ['Empty', 'Holding'],
      run: (state, { pending, cleared, here }) => {
        const clearHistory = state.data.clearHistory && !cleared

        if (isFor(state.data, here)) return leaving(merged({ ...empty(), clearHistory }, pending))

        // A page at another address takes none of the fields, and writes the
        // cookie only for what it changed: what it sent may be older than the
        // cookie, whose fields the page they are for may have taken since.
        return clearHistory === state.data.clearHistory
          ? addingOnly(state, state.data, pending)
          : leaving(merged({ ...state.data, clearHistory }, pending))
      },
    },
    Redirect: {
      to: ['Empty', 'Holding'],
      // From the page the fields are for, they go where it leads; from any
      // other, the cookie changes only by what this request set, as above.
      run: (state, { pending, here, to }) =>
        state.data.for !== undefined && state.data.for === here
          ? leaving(merged(addressed(state.data, to), addressed(pending, to)))
          : addingOnly(state, state.data, addressed(pending, to)),
    },
    Other: { to: ['Holding'], run: (state, { pending }) => addingOnly(state, state.data, pending) },
    Prefetch: { to: ['Holding'], run: (state, { pending }) => addingOnly(state, state.data, pending) },
  },
  Unreadable: {
    Page: { to: ['Empty', 'Holding'], run: (_, { pending }) => leaving(pending) },
    Redirect: { to: ['Empty', 'Holding'], run: (_, { pending, to }) => leaving(addressed(pending, to)) },
    Other: { to: ['Empty', 'Holding'], run: (_, { pending }) => leaving(pending) },
    Prefetch: { to: ['Unreadable', 'Holding'], run: (state, { pending }) => addingOnly(state, empty(), pending) },
  },
}

/** The cookie's data as it reads now: flash data past its minute has ended. */
const dataAt = (decoded: S.Schema.Type<typeof StoredFlash>, now: number): MutableFlash =>
  decoded.until !== undefined && decoded.until <= now
    ? { ...empty(), clearHistory: decoded.clearHistory === true }
    : addressed({ errors: decoded.errors, flash: decoded.flash, clearHistory: decoded.clearHistory === true }, decoded.for)

/** What `pending` holds that `shown` did not show. */
const unshown = (pending: MutableFlash, shown: FlashedPageData): MutableFlash => ({
  errors: Object.fromEntries(Object.entries(pending.errors).filter(([key, value]) => shown.errors[key] !== value)),
  flash: Object.fromEntries(Object.entries(pending.flash).filter(([key, value]) => shown.flash[key] !== value)),
  clearHistory: pending.clearHistory && !shown.clearHistory,
})

/** Open the flash store for a request. `pages` says whether the application has any page to show. */
export function openFlash(c: Context, options: { readonly pages?: boolean } = {}): FlashStore {
  const url = new URL(c.req.url)
  const secure = url.protocol === 'https:'
  // The address of the page this request is for, as a redirect names it.
  const here = url.pathname + url.search
  // The address a redirect leads to on this site, or none for another site.
  const addressOf = (location: string | undefined): string | undefined => {
    if (location === undefined) return undefined

    try {
      const to = new URL(location, url)

      return to.origin === url.origin ? to.pathname + to.search : undefined
    } catch {
      return undefined
    }
  }
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
  // Once the answer's cookie is written, a page rendered after it, such as
  // an error page replacing that answer, shows nothing: what it would show
  // is in that cookie, or already shown.
  let written = false

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
      // The cookie holds JSON, so a value it cannot hold fails here, where
      // it is set, not when the answer is finished.
      try {
        JSON.stringify(value)
      } catch (cause) {
        throw new TypeError(`The flash value ${key} cannot be stored in the flash cookie, which holds JSON: ${cause instanceof Error ? cause.message : String(cause)}`)
      }

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
      if (written) return empty()

      // Held fields show on the page they are for; the history's clear on any.
      shown = prefetch
        ? merged(empty(), pending)
        : merged(isFor(held, here) ? held : { ...empty(), clearHistory: held.clearHistory }, pending)

      return shown
    },

    cookie(answer) {
      written = true

      const left = shown === undefined || !answer.page ? pending : unshown(pending, shown)
      const event = prefetch
        ? FlashEvent.Prefetch({ pending: left })
        : answer.page
          ? FlashEvent.Page({ pending: left, cleared: answer.cleared, here })
          : answer.status >= 300 && answer.status < 400
            ? FlashEvent.Redirect({ pending: left, here, to: addressOf(answer.location) })
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
    ...(data.for === undefined ? {} : { for: data.for }),
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

  const errorsOnly = addressed({ errors: data.errors, flash: {}, clearHistory: data.clearHistory }, data.for)

  if (fits(errorsOnly)) return errorsOnly

  const entries = Object.entries(data.errors)
  const withFirst = (count: number): MutableFlash => addressed({
    errors: { ...Object.fromEntries(entries.slice(0, count)), form: ERRORS_LEFT_OUT },
    flash: {},
    clearHistory: data.clearHistory,
  }, data.for)
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
