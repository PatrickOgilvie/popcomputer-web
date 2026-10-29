// The constants of SignInLimits.code.cfg and .1.6.cfg, which the view does not receive.
const Max = 2, Cooldown = 1, Window = 4
const cooldownAfter = (n) => (n < Max ? 0 : Math.min(Window, Cooldown * 2 ** (n - Max)))

const account = (v) => {
  const row = v.row
  if (!row.present) return 'No failures counted'
  if (row.count < Max) return 'Counting failures'
  if (row.last + cooldownAfter(row.count) > v.now) return 'Cooling down'
  return 'Cooldown over, count kept'
}

const checking = (v) => Object.values(v.pc).filter((pc) => pc === 'checked').length

export const title = "One account's password sign-ins"

export const state = (v) => {
  const n = checking(v)
  const owner = v.ownerIn ? ', owner signed in' : ''
  return `${account(v)}${owner}${n === 0 ? '' : `, ${n} password${n === 1 ? '' : 's'} being checked`}`
}

const phase = (v) => ({ 'No failures counted': 'No sign-ins counted', 'Counting failures': 'Counting sign-ins' })[account(v)] ?? account(v)

export const group = (v) => phase(v)

export const colors = {
  'No sign-ins counted': 'teal',
  'Counting sign-ins': 'blue',
  'Cooling down': 'orange',
  'Cooldown over, count kept': 'yellow',
}

export const step = (action, from, to) => {
  const entered = Object.keys(to.pc).find((p) => to.pc[p] === 'checked' && from.pc[p] !== 'checked')
  if (action.startsWith('YouSignIn')) {
    if (entered === undefined) return 'a sign-in is refused [cooling down]'
    return entered === 'owner' ? 'the owner passes the check' : 'a guess passes the check'
  }
  if (action.startsWith('BetterAuthAnswers')) return to.pc.owner === 'in' && from.pc.owner !== 'in' ? 'the owner signs in' : 'a wrong password fails'
  if (action.startsWith('CronSweeps')) return 'the sweep deletes the row'
  if (action.startsWith('Tick')) return 'time passes'
  return null
}
