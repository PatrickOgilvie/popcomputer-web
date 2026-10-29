const name = (who) => (who === 'guest' ? 'a guest' : who === 'ada' ? 'Ada' : 'Grace')
const owner = (who) => (who === 'guest' ? "a guest's" : `${name(who)}'s`)

export const title = "Signed-in pages in two tabs' history"

export const state = (v) => ({
  Browser: `${v.session === 'guest' ? 'Signed out' : `${name(v.session)} signed in`}${v.flag ? ', clear pending' : ''}`,
  'Tab 1': `shows ${owner(v.page.t1.who)} page`,
  'Tab 2': `shows ${owner(v.page.t2.who)} page`,
})

export const step = (action, from, to) => {
  const tab = ['t1', 't2'].find((t) => JSON.stringify(from.page[t]) !== JSON.stringify(to.page[t]) || JSON.stringify(from.hist[t]) !== JSON.stringify(to.hist[t]))
  const where = tab === 't1' ? 'tab 1' : 'tab 2'
  if (action.startsWith('YouOpenAPage')) return `you open a page in ${where}`
  if (action.startsWith('SomeoneSignsIn')) return `${name(to.session)} signs in`
  if (action.startsWith('TheMemberSignsOut')) return `${name(from.session)} signs out`
  if (action.startsWith('TheSessionExpires')) return 'the session cookie expires'
  if (action.startsWith('YouPressBack')) {
    if (!to.leak || from.leak) return `you press Back in ${where}`
    return `you press Back in ${where}, which shows the earlier page from history`
  }
  return null
}
