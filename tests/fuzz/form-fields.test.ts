/**
 * nestFields reads the name of every field a visitor sends, in the query
 * string of every request and in every form body. Generated names find
 * run-1's two bugs again on 1.4.2: segments that walk into an inherited
 * method and write the visitor's value onto the realm's built-ins, which
 * every later request shares (C1), and a sparse index that turns a few
 * bytes into a list of thousands of slots (C4).
 */
import { describe } from 'bun:test'
import { Arbitrary } from 'effect'
import { nestFields } from '../../src/effect/form-fields'
import { anyText, oneOf, pick, property, textOf } from './property'
import { realmGuard } from './realm'

/** How many more slots than items sent a list may hold, as nestFields allows. */
const MAX_LIST_GAP = 20

const SEGMENTS = ['a', 'b', '0', '1', '', '9999', '__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'valueOf', 'call', 'bind', 'length', 'name'] as const

/** A field name: a head, then segments in brackets or after dots. */
const fieldName = (segments: readonly [string, ...string[]]) =>
  Arbitrary.map(
    Arbitrary.all([pick(segments), Arbitrary.array(Arbitrary.all([pick(segments), pick(['[]', '.'])]), { maxLength: 4 })]),
    ([head, rest]) => head + rest.map(([segment, style]) => (style === '.' ? `.${segment}` : `[${segment}]`)).join('')
  )

/** The fields of one form: names from `names`, short text values. */
const formOf = (names: Arbitrary.Arbitrary<string>) =>
  Arbitrary.array(Arbitrary.all([names, textOf(['x', 'y', '1'], 3)]), { maxLength: 8 })

/** Names a browser could send: the segments above, or any text with brackets and dots in it. */
const anyName = oneOf(fieldName(SEGMENTS), textOf(['a', '[', ']', '.', '0', '__proto__', 'toString', '\u0000', 'é'], 10), anyText)

/** The length of every list in nested fields, however deep. */
function listLengths(nested: ReturnType<typeof nestFields>): number[] {
  const lengths: number[] = []

  JSON.stringify(nested, (_key, item) => {
    if (Array.isArray(item)) lengths.push(item.length)

    return item
  })

  return lengths
}

/** Nested fields as JSON with each list written as the object of its indices, as a path reads either. */
function byPath(nested: ReturnType<typeof nestFields>): string {
  return JSON.stringify(nested, (_key, item) => (Array.isArray(item) ? Object.fromEntries(item.entries()) : item))
}

describe('nestFields', () => {
  const realmChanges = realmGuard()

  property('never writes to the realm, whatever the field names', formOf(anyName), (fields) => {
    let thrown: Error | undefined

    try {
      nestFields(Object.fromEntries(fields))
    } catch (error) {
      thrown = error instanceof Error ? error : new Error('a value that is not an Error')
    }

    // The realm is checked, and put right, whether or not the call threw.
    return realmChanges() ?? (thrown instanceof Error ? `threw ${thrown.message}` : undefined)
  }, { runs: 1000 })

  property('holds no list longer than the fields sent and the gap allowed', formOf(fieldName(SEGMENTS)), (fields) => {
    const nested = nestFields(Object.fromEntries(fields))
    realmChanges()

    const longest = Math.max(0, ...listLengths(nested))

    return longest > fields.length + MAX_LIST_GAP ? `a list of ${longest} slots from ${fields.length} fields` : undefined
  })

  property(
    'puts a lone field at the path its name spells',
    Arbitrary.all([fieldName(['a', 'b', '0', '1', '9999', 'items']), textOf(['x', 'y'], 3)]),
    ([name, value]) => {
      if (name.includes('[]')) return undefined

      const path = [...name.matchAll(/[^.[\]]+/g)].map(([segment]) => segment)
      const expected = JSON.stringify(path.reduceRight<object | string>((inner, segment) => ({ [segment]: inner }), value))
      const nested = byPath(nestFields({ [name]: value }))

      return nested === expected ? undefined : `${name} nests as ${nested}`
    }
  )
})
