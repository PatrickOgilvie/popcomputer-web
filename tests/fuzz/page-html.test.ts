/**
 * The HTML document createTemplate writes embeds the page object in a
 * `<script type="application/json">`, and a visitor writes much of it: a
 * page's props, the URL they asked for, a failed form's errors. Whatever
 * text the page holds, the document must parse, by the HTML tokenizer
 * Workers and browsers share (HTMLRewriter's), into the same elements as an
 * empty page's, and the data element's text must parse back to the page
 * object. Before 1.0.0, escaping '/' alone let a visitor's '<!--<script>'
 * hold the parser past the element's real end, so the page data stopped
 * parsing and the client bundle never loaded (fdd3f31).
 */
import { describe } from 'bun:test'
import { Arbitrary, Schema as S } from 'effect'
import { createTemplate } from '../../src/helpers.js'
import type { PageObject } from '../../src/types.js'
import { anyText, oneOf, pick, property, show, textOf } from './property'

const render = createTemplate({ title: 'App', scripts: ['/main.js'], styles: ['/main.css'] })

/** Text that means something to the HTML tokenizer inside a script element, or to JSON or JavaScript. */
const MARKUP = textOf(
  [
    '</script>', '</SCRIPT', '</script ', '</script/', '<script>', '<script', '<SCRIPT ', '<!--', '-->', '--!>',
    '<', '>', '/', '</', '&', '&amp;', '&lt;', '<![CDATA[', ']]>', '<?', '\\', '"', "'",
    ' ', ' ', '\u0000', '\r\n', '﻿', 'a', ' ', 'é',
  ],
  10
)

const text = oneOf(MARKUP, anyText)

/** A prop's value: text, a list of it, or fields of it. */
const value = oneOf<unknown>(
  text,
  Arbitrary.array(text, { maxLength: 3 }),
  Arbitrary.map(Arbitrary.array(Arbitrary.all({ key: text, value: text }), { maxLength: 3 }), (fields) =>
    Object.fromEntries(fields.map((field) => [field.key, field.value]))
  ),
  pick([0, true]),
  Arbitrary.Constant(null)
)

const page = Arbitrary.map(
  Arbitrary.all({
    component: text,
    props: Arbitrary.array(Arbitrary.all({ key: text, value }), { maxLength: 4 }),
    errors: Arbitrary.array(Arbitrary.all({ field: text, message: text }), { maxLength: 2 }),
    url: Arbitrary.map(text, (path) => `/${path}`),
    flash: oneOf<string | undefined>(Arbitrary.Constant(undefined), text),
  }),
  (parts): PageObject => ({
    component: parts.component,
    props: {
      ...Object.fromEntries(parts.props.map((prop) => [prop.key, prop.value])),
      errors: Object.fromEntries(parts.errors.map((error) => [error.field, error.message])),
    },
    url: parts.url,
    version: '1',
    ...(parts.flash === undefined ? {} : { flash: { success: parts.flash } }),
  })
)

interface Parsed {
  readonly elements: ReadonlyArray<string>
  readonly data: string
}

/** The document's elements, each with its src or href, and the text of the page data element. */
async function parse(html: string): Promise<Parsed> {
  const elements: string[] = []
  let data = ''

  await new HTMLRewriter()
    .on('*', {
      element: (element) => {
        const link = element.getAttribute('src') ?? element.getAttribute('href')

        elements.push(link === null ? element.tagName : `${element.tagName} ${link}`)
      },
    })
    .on('script[data-page]', { text: (chunk) => { data += chunk.text } })
    .transform(new Response(html))
    .text()

  return { elements, data }
}

const empty = await parse(render({ component: 'Empty', props: {}, url: '/', version: '1' }))

describe('the HTML document a page is embedded in', () => {
  property('parses into an empty page’s elements, and its data into the page', page, async (sent) => {
    const parsed = await parse(render(sent))

    if (show(parsed.elements) !== show(empty.elements)) {
      return `the document parsed into ${show(parsed.elements)}, not ${show(empty.elements)}, for ${show(sent)}`
    }

    const data = S.decodeUnknownExit(S.fromJsonString(S.Unknown))(parsed.data)

    if (data._tag === 'Failure') return `the page data ${show(parsed.data)} is not JSON, for ${show(sent)}`

    return show(data.value) === show(sent) ? undefined : `the page data read back as ${show(data.value)}, not ${show(sent)}`
  })
})
