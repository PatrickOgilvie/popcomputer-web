/**
 * Bytes a visitor uploaded, served back on the application's origin: a type
 * a browser reads differently from the check, markup sent as an image, and
 * a download name that breaks out of its header.
 *
 * Precedents: Livewire CVE-2024-47823 (an extension guessed from the MIME
 * type), Rails CVE-2024-26144 and CVE-2018-16477 (Active Storage's served
 * types and dispositions), Next.js CVE-2021-39178 (SVG served as an image
 * ran script), Django CVE-2022-36359 and Gin CVE-2023-29401 (a file name
 * escaped its Content-Disposition), and this framework's own 1.3.0, which
 * served `image/png;x=,text/html` back as a page.
 */

import { describe, expect, test } from 'bun:test'
import { Effect, Schema as S } from 'effect'
import { file } from '../../src/effect/responses.js'
import { upload } from '../../src/effect/schema.js'

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const page = Uint8Array.from([...png, ...new TextEncoder().encode('<html><script>alert(1)</script>')])
const decode = (accepted: ReadonlyArray<string>, sent: File) =>
  Effect.runPromiseExit(S.decodeUnknownEffect(upload({ types: accepted }))(sent))

describe('an upload', () => {
  test('whose type is a list, or names a page, is refused under image/*', async () => {
    const accepted: string[] = []

    for (const type of [
      'image/png;x=,text/html',
      'image/png, text/html',
      'image/png;a="b",text/html',
      'text/html',
      'image/svg+xml',
      'image/x-anything+xml',
      'application/xhtml+xml',
    ]) {
      if ((await decode(['image/*'], new File([page], 'photo.png', { type })))._tag === 'Success') accepted.push(type)
    }

    expect(accepted).toEqual([])
  })

  test('that is markup sent as an image is refused, whatever its first bytes claim', async () => {
    for (const [type, bytes] of [
      ['image/png', new TextEncoder().encode('<html><script>alert(1)</script>')],
      ['image/x-icon', new TextEncoder().encode('\ufeff  <svg onload=alert(1)>')],
      ['image/gif', new TextEncoder().encode('<?xml version="1.0"?><svg/>')],
    ] as const) {
      expect({ type, decoded: (await decode(['image/*'], new File([bytes], 'x', { type })))._tag }).toEqual({ type, decoded: 'Failure' })
    }
  })

  test('of a type a browser may read as XML, such as text/rdf, is refused under text/* and accepted only when named', async () => {
    const xml = new TextEncoder().encode('<?xml version="1.0"?><doc xmlns:h="http://www.w3.org/1999/xhtml"><h:script>alert(1)</h:script></doc>')

    for (const type of ['text/rdf', 'Text/RDF; charset=utf-8', 'text/xml', 'text/xsl']) {
      expect({ type, decoded: (await decode(['text/*'], new File([xml], 'doc.bin', { type })))._tag }).toEqual({ type, decoded: 'Failure' })
    }

    expect((await decode(['text/rdf'], new File([xml], 'doc.rdf', { type: 'text/rdf' })))._tag).toBe('Success')
    expect((await decode(['text/*'], new File(['a,b'], 'rows.csv', { type: 'text/csv' })))._tag).toBe('Success')
  })

  test('keeps only its media type, so what is stored is one type', async () => {
    const decoded = await decode(['image/*'], new File([png], 'photo.png', { type: 'IMAGE/PNG; charset=x' }))

    expect(decoded._tag === 'Success' ? decoded.value.type : decoded._tag).toBe('image/png')
  })
})

describe('a served file', () => {
  test('whose type is not one media type is sent as bytes', async () => {
    for (const contentType of ['image/png;x=,text/html', 'text/html, image/png', 'text/html\r\nSet-Cookie: x=1', 'text/html;', '']) {
      const response = await Effect.runPromise(file(page, { contentType }))

      expect({ contentType, sent: response.headers.get('Content-Type') }).toEqual({ contentType, sent: 'application/octet-stream' })
    }
  })

  test('that a browser runs script in is shown inline only sandboxed, and never sniffed', async () => {
    for (const contentType of ['text/html', 'image/svg+xml', 'application/xml', 'application/rss+xml', 'text/xsl', 'text/rdf', 'Text/RDF; charset=utf-8']) {
      const response = await Effect.runPromise(file('<x/>', { contentType }))

      expect({ contentType, csp: response.headers.get('Content-Security-Policy'), nosniff: response.headers.get('X-Content-Type-Options') })
        .toEqual({ contentType, csp: 'sandbox', nosniff: 'nosniff' })
    }
  })

  // No list of the types a browser reads as a page is complete: only types
  // it shows without running script are shown inline unsandboxed.
  test('of any type but an image, a PDF, plain text, JSON, audio or video is shown inline only sandboxed', async () => {
    const shown = async (contentType: string, options: { readonly filename?: string; readonly headers?: HeadersInit } = {}) =>
      (await Effect.runPromise(file('<x/>', { contentType, ...options }))).headers.get('Content-Security-Policy')

    for (const contentType of [
      'text/xml-external-parsed-entity',
      'application/xml-external-parsed-entity',
      'application/xml-dtd',
      'text/vtt',
      'text/cache-manifest',
      'text/csv',
      'application/javascript',
      'application/octet-stream',
      'application/x-unknown',
      'image/x-anything+xml',
    ]) {
      expect({ contentType, csp: await shown(contentType) }).toEqual({ contentType, csp: 'sandbox' })
    }

    for (const contentType of ['image/png', 'image/jpeg', 'application/pdf', 'text/plain; charset=utf-8', 'application/json', 'audio/mpeg', 'video/mp4']) {
      expect({ contentType, csp: await shown(contentType) }).toEqual({ contentType, csp: null })
    }

    expect(await shown('text/rdf', { headers: { 'Content-Security-Policy': "default-src 'none'" } })).toBe("default-src 'none'")
  })

  // Content-Disposition is the only other control on a download, and a web
  // view without a download handler may show the body in its place.
  test('sandboxes a download of an active upload, and leaves an inert one as it is', async () => {
    const shown = async (contentType: string, options: { readonly filename: string; readonly headers?: HeadersInit }) =>
      (await Effect.runPromise(file('<x/>', { contentType, ...options }))).headers.get('Content-Security-Policy')

    for (const contentType of ['text/html', 'image/svg+xml', 'application/xhtml+xml', 'text/xml', 'text/rdf', 'text/csv', 'application/octet-stream']) {
      expect({ contentType, csp: await shown(contentType, { filename: 'shared.bin' }) }).toEqual({ contentType, csp: 'sandbox' })
    }

    for (const contentType of ['application/pdf', 'image/png', 'text/plain', 'application/json', 'audio/mpeg', 'video/mp4']) {
      expect({ contentType, csp: await shown(contentType, { filename: 'shared.bin' }) }).toEqual({ contentType, csp: null })
    }

    expect(await shown('text/html', { filename: 'page.html', headers: { 'Content-Security-Policy': "default-src 'none'" } })).toBe("default-src 'none'")
  })

  test('names its download in one quoted value, however the name tries to break out', async () => {
    for (const filename of ['setup.bat";x=.txt', 'a\r\nSet-Cookie: x=1', '../../.dev.vars', 'naïve "résumé".pdf', 'a\\";b']) {
      const disposition = (await Effect.runPromise(file('x', { contentType: 'text/plain', filename }))).headers.get('Content-Disposition') ?? ''
      const quoted = /^attachment; filename="([^"\\\r\n]*)"; filename\*=UTF-8''([A-Za-z0-9%!'()*._~-]*)$/.exec(disposition)

      expect({ filename, wellFormed: quoted !== null }).toEqual({ filename, wellFormed: true })
      expect(decodeURIComponent(quoted?.[2] ?? '')).toBe(filename)
    }
  })
})
