export const title = "The member's magic link"
export const state = (v) => {
  const link = v.token === 'unused' ? 'Link unused' : 'Link used'
  const who = v.sessions.length === 0 ? 'no one signed in' : v.sessions.map((s) => (s === 'member' ? 'the member' : 'the scanner')).join(' and ') + ' signed in'
  return `${link}, ${who}${v.memberDone ? ', member followed it' : ''}`
}
export const step = (action) => ({ AScannerFetchesTheLink: 'a mail scanner fetches the link', TheMemberFollowsTheLink: 'the member follows the link' })[action] ?? null
