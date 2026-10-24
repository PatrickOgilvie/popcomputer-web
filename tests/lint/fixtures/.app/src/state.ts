import { Effect } from 'effect'
import { action, json } from '@popcomputer/web/effect'

let lastVisitor = '' // expect: no-module-level-mutable-state
export let requests = 0 // expect: no-module-level-mutable-state
var hits = 0 // expect: no-module-level-mutable-state
if (hits === 0) {
  var warmed = true // expect: no-module-level-mutable-state
}
const carts = new Map<string, string>() // expect: no-module-level-mutable-state
const seen = new Set<string>() // expect: no-module-level-mutable-state
const log: string[] = [] // expect: no-module-level-mutable-state

// Built once as the module loads and only read after: the same for every visitor.
const plans = new Map([['free', 0], ['pro', 12]])
const regions = ['eu', 'us']
const ordered = new Set<string>()
ordered.add('eu')
declare let __BUILD__: string

export const visit = action(Effect.gen(function* () {
  lastVisitor = 'someone'
  requests += 1
  carts.set('visitor', 'cart')
  seen.add('visitor')
  log.push('visited')

  // A request's own values.
  let total = 0
  const items: string[] = []
  items.push('a')
  total += items.length

  return yield* json({ total, plans: plans.size, regions, ordered: ordered.size, warmed, build: __BUILD__ })
}))
