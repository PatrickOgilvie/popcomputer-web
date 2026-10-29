// A coarser view for SignInLimits.chart.cfg, whose whole graph the chart
// draws: the account's state, and whether a password is being checked.
import { colors, group } from './SignInLimits.view.mjs'

export { colors, group }

const Max = 2, Cooldown = 1, Window = 4
const cooldownAfter = (n) => (n < Max ? 0 : Math.min(Window, Cooldown * 2 ** (n - Max)))

const account = (v) => {
  if (!v.row.present) return 'No sign-ins counted'
  if (v.row.count < Max) return 'Counting sign-ins'
  return v.row.last + cooldownAfter(v.row.count) > v.now ? 'Cooling down' : 'Cooldown over, count kept'
}

export const title = "One account's password sign-ins"

export const state = (v) => {
  const checking = Object.values(v.pc).some((pc) => pc === 'checked') ? ', a password being checked' : ''

  return `${account(v)}${checking}`
}

export const step = (action, from, to) => {
  const entered = Object.keys(to.pc).find((p) => to.pc[p] === 'checked' && from.pc[p] !== 'checked')

  if (action.startsWith('YouSignIn')) {
    if (entered === undefined) return 'a sign-in is refused [cooling down]'
    return entered === 'owner' ? 'the owner sends the password' : 'a guess is counted'
  }
  if (action.startsWith('BetterAuthAnswers')) return to.pc.owner === 'in' && from.pc.owner !== 'in' ? 'the owner signs in' : 'a guess fails'
  if (action.startsWith('CronSweeps')) return 'the sweep deletes the row'
  if (action.startsWith('Tick')) return 'time passes'
  return null
}
