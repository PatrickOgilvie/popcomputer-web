/**
 * betterAuthHandler checks a body (the fields `settable` names, the account
 * a sign-in counts against) before Better Auth reads it, so the two must
 * read the same body, or refuse. Generated Content-Type headers and bodies
 * compare `bodyOf` with better-call's `getBody`, the parser Better Auth
 * runs, and find again run-2's N2 on 1.5.0, where a header led by U+00A0
 * read as a form to one and as JSON to the other.
 */
import { describe } from 'bun:test'
import { Arbitrary } from 'effect'
import { bodyOf } from '../../src/effect/better-auth-body'
import { oneOf, pick, property, show, textOf } from './property'

type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json }

/** What getBody reads: JSON, a form's fields, or the body as text, bytes or a stream. */
type BetterCallBody = Json | Readonly<Record<string, string | File>> | ArrayBuffer | Blob | ReadableStream | undefined

// better-call exports getBody from no entrypoint; its own module beside the
// one the package names is the parser Better Auth's router calls.
// SAFETY: better-call 1.4's utils.mjs exports getBody(request, allowedMediaTypes?) returning what it read.
const { getBody } = (await import(new URL('./utils.mjs', import.meta.resolve('better-call')).href)) as {
  getBody: (request: Request) => Promise<BetterCallBody>
}

/** A parsed body as JSON, each file by its name, so two parsers' readings compare as text. */
const asText = <Body>(body: Body): string =>
  JSON.stringify(body, (_key, item) => (item instanceof File ? { file: item.name } : item)) ?? 'nothing'

const BOUNDARY = 'X'

/** Bodies that read differently by type: JSON whose text is also a form, a form, multipart, and neither. */
const BODIES = [
  '{"email":"ada@example.com","x":"=1&email=eve@example.com&password=guess"}',
  'email=ada%40example.com&password=guess&email=eve%40example.com',
  `--${BOUNDARY}\r\nContent-Disposition: form-data; name="email"\r\n\r\nada@example.com\r\n--${BOUNDARY}--\r\n`,
  '["email","ada@example.com"]',
  'not a body',
] as const

const LEADS = ['', ' ', '\t', ' ', '\u000b', '\u000c', ' ', '﻿'] as const

const MEDIA = [
  'application/json',
  'application/x-www-form-urlencoded',
  'multipart/form-data',
  'APPLICATION/JSON',
  'application/vnd.api+json',
  'application/json-patch+json',
  'application/jsonx',
  'text/plain',
  'application/',
  'json',
] as const

const PARAMETERS = [
  '',
  '; charset=utf-8',
  `; boundary=${BOUNDARY}`,
  '; a=application/x-www-form-urlencoded',
  '; a=application/json',
  ', application/x-www-form-urlencoded',
  ', multipart/form-data',
  ';',
] as const

const contentType = oneOf(
  Arbitrary.map(
    Arbitrary.all([pick(LEADS), pick(MEDIA), pick(LEADS), pick(PARAMETERS), pick(PARAMETERS), pick(LEADS)]),
    (parts) => parts.join('')
  ),
  textOf(['application/', 'json', 'x-www-form-urlencoded', 'multipart/form-data', '+', ';', ',', ' ', ' ', '=', 'a'], 8)
)

describe('bodyOf', () => {
  property(
    'reads the body Better Auth reads, or none',
    Arbitrary.all([contentType, pick(BODIES)]),
    async ([type, body]) => {
      let request: Request

      try {
        request = new Request('https://app.test/api/auth/sign-up/email', {
          method: 'POST',
          headers: { 'content-type': type },
          body,
        })
      } catch {
        // A header Headers refuses never reaches either parser.
        return undefined
      }

      const checked = await bodyOf(request.clone())

      if (checked === undefined) return undefined

      let read: BetterCallBody

      try {
        read = await getBody(request.clone())
      } catch {
        // Better Auth refuses a body it cannot read, whatever the checks saw.
        return undefined
      }

      return asText(checked.body) === asText(read)
        ? undefined
        : `${show(type)}: checked ${asText(checked.body)}, Better Auth read ${asText(read)}`
    },
    { runs: 1000 }
  )
})
