export const title = "A failed form's errors and an overlapping request"
const formLabel = { editing: 'Editing the form', posted: 'Form posted, errors in the cookie', redirected: 'Following the redirect', shown: 'Form page shown' }
export const state = (v) => ({
  'Form tab': v.form === 'shown' ? (v.shown === 'errors' ? 'Form page shows the errors' : 'Form page shows no errors') : formLabel[v.form],
  Cookie: v.cookie === 'errors' ? 'Holds the errors' : 'Empty',
  'Other request': { idle: 'Not sent', sent: 'In flight', answered: 'Answered' }[v.other],
})
export const step = (action) => ({
  YouSubmitTheForm: 'you submit the form and it fails',
  InertiaFollowsTheRedirect: 'Inertia follows the redirect',
  TheFormPageArrives: 'the form page arrives',
  AnotherRequestLeaves: 'another request leaves (a poll, or another tab)',
  AnotherPageArrives: 'its page arrives',
})[action] ?? null
