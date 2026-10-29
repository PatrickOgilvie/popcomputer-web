/**
 * A page's version: the application's assets', and for a signed-in visitor a
 * mark of who they are. Inertia shows a page from a tab's history only when
 * its version is the current page's, and otherwise asks the server for it,
 * so once a tab shows a page that went to someone else, Back there shows no
 * page from history that went to the previous member or a guest. It reaches
 * every tab, where clearing the history reaches the one that shows the first
 * page after the session changed.
 */

/** The mark's separator, and the mark: the first 12 hex digits of a SHA-256. */
const MARK = /^~[0-9a-f]{12}$/

/** The id of the signed-in user an AuthUser gives, if its user has one. */
export function userIdOf(authUser: unknown): string | undefined {
  const user: unknown = authUser instanceof Object ? Reflect.get(authUser, 'user') : undefined
  const id: unknown = user instanceof Object ? Reflect.get(user, 'id') : undefined

  return typeof id === 'string' ? id : undefined
}

/**
 * The version of a page rendered for `member`, a signed-in user's id (empty
 * when the page goes to one whose id is not known), or for a guest.
 */
export function pageVersion(assets: string, member: string | undefined): Promise<string> {
  if (member === undefined) return Promise.resolve(assets)

  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(`popweb-page:${member}`)).then((digest) => {
    const mark = [...new Uint8Array(digest).slice(0, 6)].map((byte) => byte.toString(16).padStart(2, '0')).join('')

    return `${assets}~${mark}`
  })
}

/** Whether a client's `X-Inertia-Version` is the current assets', whoever its page went to. */
export function isCurrentVersion(sent: string, assets: string): boolean {
  return sent === assets || (sent.startsWith(assets) && MARK.test(sent.slice(assets.length)))
}
