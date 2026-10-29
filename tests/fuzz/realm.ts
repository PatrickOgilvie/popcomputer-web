/**
 * A check that a call left the realm's shared built-ins as they were, for
 * code that reads names a visitor chose: nestFields once wrote request
 * values onto them (run-1 C1), which every later request in the isolate
 * then shared.
 */
import { Predicate } from 'effect'
import type { Refusal } from './property'

/** The objects every request in a realm shares, by name. */
const INTRINSICS: ReadonlyArray<readonly [string, object]> = [
  ['Object', Object],
  ['Function', Function],
  ['Array', Array],
  ['String', String],
  ['Number', Number],
  ['Boolean', Boolean],
  ['Symbol', Symbol],
  ['Object.prototype', Object.prototype],
  ['Function.prototype', Function.prototype],
  ['Array.prototype', Array.prototype],
  ['String.prototype', String.prototype],
]

/**
 * The own keys of each shared intrinsic, and of each object hanging from
 * one, so a check can see what a call added to them and take it away again:
 * a change left in place would fail every later case, and shrinking could
 * not find the input that made it.
 */
export function realmGuard(): () => Refusal {
  const shared = new Map<object, string>()

  for (const [name, root] of INTRINSICS) {
    shared.set(root, name)

    for (const key of Reflect.ownKeys(root)) {
      const value: unknown = Object.getOwnPropertyDescriptor(root, key)?.value

      if (Predicate.isObjectKeyword(value) && !shared.has(value)) shared.set(value, `${name}.${String(key)}`)
    }
  }

  const before = [...shared].map(([object, name]) => ({ object, name, keys: new Set(Reflect.ownKeys(object)) }))

  return () => {
    const added: string[] = []

    for (const { object, name, keys } of before) {
      for (const key of Reflect.ownKeys(object)) {
        if (keys.has(key)) continue

        added.push(`${name}.${String(key)}`)
        Reflect.deleteProperty(object, key)
      }
    }

    return added.length === 0 ? undefined : `wrote ${added.join(', ')} on the realm's built-ins`
  }
}
