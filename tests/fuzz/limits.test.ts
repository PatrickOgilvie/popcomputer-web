/**
 * The framework's limits, each at its edge. A limit set for production, a
 * nesting depth of 32 or a cookie of 3,800 bytes, is one no generated input
 * reaches, so a check one past its edge (`<` for `<=`) passes every other
 * property. Here each limit is set from the input instead: one less than
 * what the input needs, exactly that, or one more, as Chris Wellons shrinks
 * a fuzz target's fixed buffers so its fuzzer reaches their edges
 * ("Tips for More Effective Fuzz Testing with AFL++", nullprogram.com, 2025).
 * Each property says what the limit keeps and what it refuses, so a limit
 * that refuses too much fails as surely as one that keeps too much.
 */
import { describe } from 'bun:test'
import { Arbitrary, Predicate } from 'effect'
import { FIELD_LIMITS, nestFields } from '../../src/effect/form-fields'
import { prepareCacheTagsWithLimits } from '../../src/effect/response-cache'
import { withinBudget, type MutableFlash } from '../../src/flash'
import { pick, property, show, textOf } from './property'
import { stepsOf } from '../../src/fuzz.js'

/** One less than the input needs, exactly that, or one more; shrinks toward exactly. */
const edge = pick([0, -1, 1])

/** A field name of 2 to 6 segments, in brackets or after dots. */
const deepName = Arbitrary.map(
  Arbitrary.all({
    head: pick(['a', 'items', 'b']),
    rest: Arbitrary.map(Arbitrary.all([stepsOf(Arbitrary.all([pick(['a', 'b', '0', '1', 'name']), pick(['[]', '.'])]), { maxLength: 4 }), Arbitrary.all([pick(['a', '0']), pick(['[]', '.'])])]), ([more, last]) => [...more, last]),
  }),
  ({ head, rest }) => ({ name: head + rest.map(([segment, style]) => (style === '.' ? `.${segment}` : `[${segment}]`)).join(''), depth: rest.length + 1, path: [head, ...rest.map(([segment]) => segment)] })
)

/** The value under `key`, in an object or a list, or nothing. */
function at(value: unknown, key: string): unknown {
  return Predicate.isObjectKeyword(value) ? Reflect.get(value, key) : undefined
}

/** Nested fields as JSON with each list written as the object of its indices, as a path reads either. */
function byPath(nested: unknown): string {
  return JSON.stringify(nested, (_key, item: unknown) => (Array.isArray(item) ? Object.fromEntries(item.entries()) : item))
}

/** The length of a cookie that holds `text` as base64url: four characters for each three bytes, unpadded. */
function cookieLength(text: string): number {
  return Math.ceil((new TextEncoder().encode(text).length * 4) / 3)
}

/** The cookie text the flash data is stored as: its errors and flash, and clearHistory only when set. */
function storedLength(data: MutableFlash): number {
  return cookieLength(JSON.stringify(data.clearHistory ? data : { errors: data.errors, flash: data.flash }))
}

const someText = textOf(['a', 'é', '"', 'Saved.'], 4)
const record = <A>(value: Arbitrary.Arbitrary<A>) =>
  Arbitrary.map(stepsOf(Arbitrary.all([pick(['name', 'email', 'notice', 'success']), value]), { maxLength: 3 }), (entries) => Object.fromEntries(entries))

const flashData: Arbitrary.Arbitrary<MutableFlash> = Arbitrary.all({
  errors: record(someText),
  flash: record(someText),
  clearHistory: pick([false, true]),
})

describe('each limit at its edge', () => {
  property(
    'a field name nests while it has no more segments than the depth allows, and is dropped past it',
    Arbitrary.all({ field: deepName, offset: edge }),
    ({ field, offset }) => {
      const maxDepth = field.depth + offset
      const nested = byPath(nestFields({ [field.name]: 'v' }, { ...FIELD_LIMITS, maxDepth }))
      const expected = field.depth > maxDepth ? '{}' : JSON.stringify(field.path.reduceRight<object | string>((inner, segment) => ({ [segment]: inner }), 'v'))

      return nested === expected ? undefined : `${field.name} (${field.depth} segments, depth ${maxDepth}) nests as ${nested}, not ${expected}`
    }
  )

  property(
    'indices make a list while the largest is within the gap of the items sent, and stay keys past it',
    Arbitrary.all({ indices: stepsOf(pick([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), { maxLength: 5 }), under: pick(['items', 'order[lines]']), offset: edge }),
    ({ indices, under, offset }) => {
      const sent = [...new Set([0, ...indices])]
      const largest = Math.max(...sent)
      // The smallest gap that makes these indices a list.
      const maxListGap = Math.max(0, largest - sent.length + 1 + offset)
      const nested = nestFields(Object.fromEntries(sent.map((index) => [`${under}[${index}]`, `v${index}`])), { ...FIELD_LIMITS, maxListGap })
      const held = under === 'items' ? at(nested, 'items') : at(at(nested, 'order'), 'lines')
      const isList = largest < sent.length + maxListGap
      const holds = sent.every((index) => at(held, String(index)) === `v${index}`)

      return Array.isArray(held) === isList && holds
        ? undefined
        : `indices ${show(sent)} under ${under} with gap ${maxListGap} nest as ${show(held)}, ${isList ? 'not a list' : 'a list'}`
    }
  )

  property(
    'flash keeps everything that fits its cookie, then errors alone, then only the history clear',
    Arbitrary.all({ data: flashData, aimAt: pick(['everything', 'errors']), offset: edge }),
    ({ data, aimAt, offset }) => {
      const errorsOnly = { errors: data.errors, flash: {}, clearHistory: data.clearHistory }
      const maxBytes = storedLength(aimAt === 'everything' ? data : errorsOnly) + offset
      const expected = storedLength(data) <= maxBytes ? data : storedLength(errorsOnly) <= maxBytes ? errorsOnly : { errors: {}, flash: {}, clearHistory: data.clearHistory }
      const kept = withinBudget(data, maxBytes)

      return show(kept) === show(expected) ? undefined : `${show(data)} in ${maxBytes} bytes kept ${show(kept)}, not ${show(expected)}`
    }
  )

  property(
    'cache tags pass while each tag, their count and their header are within their limits, and fail past any',
    Arbitrary.all({
      tags: stepsOf(Arbitrary.map(textOf(['a', 'B', 'b', ' ', ',', 'é', 'x'], 4), (tag) => tag || 'a'), { maxLength: 5 }),
      aimAt: pick(['length', 'count', 'header']),
      offset: edge,
    }),
    ({ tags, aimAt, offset }) => {
      const sent = tags.length === 0 ? ['a'] : tags
      const unlimited = prepareCacheTagsWithLimits(sent, { maxLength: Infinity, maxCount: Infinity, maxAggregateLength: Infinity })

      if (unlimited._tag === 'invalid') return `${show(sent)} were refused with no limit: ${unlimited.reason}`

      const needs = {
        length: Math.max(...unlimited.tags.map((tag) => tag.length)),
        count: unlimited.tags.length,
        header: unlimited.tags.join(',').length,
      }
      const limit = needs[aimAt] + offset
      const limits = {
        maxLength: aimAt === 'length' ? limit : Infinity,
        maxCount: aimAt === 'count' ? limit : Infinity,
        maxAggregateLength: aimAt === 'header' ? limit : Infinity,
      }
      const prepared = prepareCacheTagsWithLimits(sent, limits)
      const passes = needs[aimAt] <= limit

      return (prepared._tag === 'valid') === passes
        ? undefined
        : `${show(sent)} need ${aimAt} ${needs[aimAt]} and with ${limit} were ${prepared._tag === 'valid' ? 'kept' : `refused: ${prepared.reason}`}`
    }
  )
})
