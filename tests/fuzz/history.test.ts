/**
 * Inertia's history in one browser's two tabs, as sequences of visits, Back,
 * sign-ins and sign-outs by Ada and Grace, sessions that expire unseen,
 * prefetches and Better Auth's JSON answers. The server is the real one:
 * web()'s encryptHistory, clearHistory and version, the one-shot clear the
 * flash cookie carries, and Better Auth's session. The tabs follow
 * @inertiajs/core 3.9.1's client, as docs/state-machines/HistoryClear.tla
 * models it: a page with clearHistory drops the tab's key, and Back shows an
 * entry from history only when the tab can still decrypt it and its version
 * is the current page's, and otherwise asks the server. Whatever the order,
 * under `history.encrypt`'s default and `true`:
 *
 * - Back never shows a member's page from history in a tab whose page is now
 *   someone else's, or a guest's, without asking the server.
 */
import { describe } from 'bun:test'
import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { Arbitrary, Effect, Schema as S } from 'effect'
import { Hono } from 'hono'
import { betterAuthHandler } from '../../src/auth.js'
import { action } from '../../src/effect/action.js'
import { currentUser } from '../../src/effect/auth.js'
import { render } from '../../src/effect/responses.js'
import { setupWeb } from '../../src/setup.js'
import { testBrowser, testEnv, type TestBrowser } from '../../src/testing.js'
import { pick, property, show, weighted } from './property'

const MEMBERS = { ada: 'ada@example.com', grace: 'grace@example.com' } as const
const PASSWORD = 'correct horse'

async function createApp(encrypt: 'signed-in' | true) {
  const auth = betterAuth({
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    baseURL: 'http://localhost',
    secret: 'history-fuzz-secret-with-enough-entropy-0123456789',
    // A cheap hash: the property is about pages, not passwords.
    emailAndPassword: { enabled: true, password: { hash: async (password) => password, verify: async ({ hash, password }) => hash === password } },
    rateLimit: { enabled: false },
    logger: { disabled: true },
  })

  for (const [name, email] of Object.entries(MEMBERS)) await auth.api.signUpEmail({ body: { name, email, password: PASSWORD } })

  const app = new Hono()
  const { routes } = setupWeb(app, {
    version: '1',
    render: (page) => JSON.stringify(page),
    auth: { client: () => auth },
    history: { encrypt },
  })
  // Each page says whom the server rendered it for.
  const page = (component: string) => action(Effect.flatMap(currentUser, (user) => render(component, { who: user?.user.email ?? 'guest' })))

  routes
    .get('/', page('Home'))
    .get('/dashboard', page('Dashboard'))
    .get('/settings', page('Settings'))
    .all('/api/auth/*', betterAuthHandler())

  return testBrowser(app, testEnv({}))
}

/** What one tab does: open a page, press Back, prefetch one, or have Better Auth's client refetch the session. */
const tabStep = Arbitrary.all({
  act: weighted<'visit' | 'back' | 'prefetch' | 'session'>(['visit', 3], ['back', 3], ['prefetch', 1], ['session', 1]),
  tab: pick([0, 1]),
  path: pick(['/dashboard', '/', '/settings']),
})

/** A change to the browser's session, and what its tabs do before the next change. */
const turn = Arbitrary.all({
  change: weighted<Change>(['signIn', 3], ['signOut', 1], ['expire', 1]),
  member: pick(['ada', 'grace']),
  steps: Arbitrary.array(tabStep, { minLength: 1, maxLength: 4 }),
})

type Change = 'signIn' | 'signOut' | 'expire'

type Step =
  | (typeof tabStep extends Arbitrary.Arbitrary<infer A> ? A : never)
  | { readonly [Act in Change]: { readonly act: Act; readonly member: 'ada' | 'grace' } }[Change]

const steps = Arbitrary.map(Arbitrary.array(turn, { maxLength: 4 }), (turns): Step[] =>
  turns.flatMap((each) => [{ act: each.change, member: each.member }, ...each.steps])
)

/** What the client reads of a page the server sent. */
const Page = S.Struct({
  url: S.String,
  version: S.String,
  props: S.Struct({ who: S.String }),
  encryptHistory: S.optional(S.Boolean),
  clearHistory: S.optional(S.Boolean),
})

interface Entry {
  readonly page: typeof Page.Type
  /** The tab's key generation the entry was written with. */
  readonly key: number
}

interface Tab {
  key: number
  current: Entry | undefined
  readonly history: Entry[]
}

const inertia = (version: string | undefined): Record<string, string> =>
  version === undefined ? { 'X-Inertia': 'true' } : { 'X-Inertia': 'true', 'X-Inertia-Version': version }

const authApi = (browser: TestBrowser, path: string, body: unknown) =>
  browser.request(`/api/auth${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' },
    body: JSON.stringify(body),
  })

async function runSteps(encrypt: 'signed-in' | true, sequence: readonly Step[]): Promise<string | undefined> {
  const browser = await createApp(encrypt)
  const tabs: Tab[] = [{ key: 0, current: undefined, history: [] }, { key: 0, current: undefined, history: [] }]

  /** The tab asks the server for a page with an Inertia visit, and applies it as the client does. */
  const visit = async (tab: Tab, path: string): Promise<string | undefined> => {
    const res = await browser.request(path, { headers: inertia(tab.current?.page.version) })

    if (res.status !== 200) return `${path} answered ${res.status}`

    const page = S.decodeUnknownSync(Page)(await res.json())

    if (page.clearHistory === true) tab.key += 1
    tab.current = { page, key: tab.key }
    return undefined
  }

  for (const [index, sent] of sequence.entries()) {
    const at = `step ${index + 1}, ${show(sent)}`

    if (sent.act === 'signIn') {
      await authApi(browser, '/sign-in/email', { email: MEMBERS[sent.member], password: PASSWORD })
      continue
    }
    if (sent.act === 'signOut') {
      await authApi(browser, '/sign-out', {})
      continue
    }
    if (sent.act === 'expire') {
      // The browser stops sending the session's cookies, as once they expire; the flash cookie stays.
      for (const name of browser.cookies.keys()) if (name.startsWith('better-auth.')) browser.setCookie(name, '', '/expired')
      continue
    }

    const tab = tabs[sent.tab]

    switch (sent.act) {
      case 'visit': {
        if (tab.current !== undefined) tab.history.push(tab.current)
        const failed = await visit(tab, sent.path)
        if (failed !== undefined) return `${at}: ${failed}`
        break
      }
      case 'back': {
        const entry = tab.history.pop()
        const current = tab.current
        if (entry === undefined || current === undefined) break

        const readable = entry.page.encryptHistory !== true || entry.key === tab.key

        if (readable && entry.page.version === current.page.version) {
          const shown = entry.page.props.who

          if (shown !== 'guest' && shown !== current.page.props.who) {
            return `${at}: Back in tab ${sent.tab + 1} showed ${shown}'s ${entry.page.url} from history over ${current.page.props.who}'s page`
          }
          tab.current = entry
        } else {
          const failed = await visit(tab, entry.page.url)
          if (failed !== undefined) return `${at}: ${failed}`
        }
        break
      }
      case 'prefetch':
        // Inertia keeps a prefetched page for a later visit, and applies nothing now.
        await browser.request(sent.path, { headers: { ...inertia(tab.current?.page.version), Purpose: 'prefetch' } })
        break
      case 'session':
        // Better Auth's client refetches the session: a JSON answer, not a page.
        await browser.request('/api/auth/get-session')
        break
    }
  }

  return undefined
}

describe("Inertia's history across two tabs and two members", () => {
  for (const encrypt of ['signed-in', true] as const) {
    property(
      `never shows from history another person's page, under history.encrypt ${show(encrypt)}`,
      steps,
      async (sequence) => {
        const refusal = await runSteps(encrypt, sequence)

        return refusal === undefined ? undefined : `${refusal}, after ${show(sequence)}`
      },
      { runs: 200 }
    )
  }
})

