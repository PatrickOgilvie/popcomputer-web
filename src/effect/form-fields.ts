/**
 * Form and query fields named the way browsers and Inertia name nested
 * values, nested into the objects and lists a schema decodes.
 *
 * `lines[0][quantity]` and `lines.0.quantity` are `{ lines: [{ quantity }] }`,
 * the path a failing field's error is reported under, and `tags[]` collects
 * every value sent under it. A key that names nothing nested is kept as it is.
 */

/** A form field's value: text, or a file from a multipart form. */
export type FieldValue = string | File

/** One segment of a nested field name: a property, a list index, or `[]`. */
const SEGMENT = /\[([^\]]*)\]|\.([^.[\]]+)/g
const FIELD_NAME = /^[^.[\]]+(?:\[[^\]]*\]|\.[^.[\]]+)*$/
const INDEX = /^(?:0|[1-9]\d{0,3})$/
const UNSAFE = new Set(['__proto__', 'prototype', 'constructor'])
const MAX_DEPTH = 32

type Nested = { [key: string]: unknown }

/** The segments of a field name, or undefined when it names nothing nested. */
function segmentsOf(key: string): readonly string[] | undefined {
  if (!FIELD_NAME.test(key)) return undefined

  const head = key.slice(0, key.search(/[.[]/))
  if (head === '') return undefined

  const rest = [...key.slice(head.length).matchAll(SEGMENT)].map((match) => match[1] ?? match[2] ?? '')

  return [head, ...rest]
}

function isNested(value: unknown): value is Nested {
  return value instanceof Object && !Array.isArray(value) && !(value instanceof File)
}

/** An object keyed only by list indices, as a list; anything else as it is. */
function listsOf(value: unknown): unknown {
  if (!isNested(value)) return value

  const keys = Object.keys(value)
  const entries = keys.map((key) => [key, listsOf(value[key])] as const)

  if (keys.length > 0 && keys.every((key) => INDEX.test(key))) {
    const list: unknown[] = []

    for (const [key, item] of entries) list[Number(key)] = item

    return Array.from(list)
  }

  return Object.fromEntries(entries)
}

/**
 * Nest the fields of a form or query string. Values under a `[]` name are a
 * list; a field sent twice under another name keeps the value given.
 */
export function nestFields(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const nested: Nested = {}
  const created = new Set<string>()

  for (const [key, value] of Object.entries(fields)) {
    const segments = segmentsOf(key)

    if (segments === undefined || (segments.length === 1 && !key.endsWith('[]'))) {
      if (!UNSAFE.has(key)) nested[key] = value
      continue
    }

    if (segments.length > MAX_DEPTH || segments.some((segment) => UNSAFE.has(segment))) continue

    // Only a trailing `[]` collects values; `a[][b]` names nothing a list can hold.
    const appends = segments[segments.length - 1] === ''
    const path = appends ? segments.slice(0, -1) : segments

    if (path.length === 0 || path.includes('')) continue

    let container = nested

    for (const segment of path.slice(0, -1)) {
      const next = container[segment]

      container = isNested(next) ? next : (container[segment] = {})
    }

    container[path[path.length - 1]] = appends ? (Array.isArray(value) ? value : [value]) : value
    created.add(path[0])
  }

  for (const key of created) nested[key] = listsOf(nested[key])

  return nested
}
