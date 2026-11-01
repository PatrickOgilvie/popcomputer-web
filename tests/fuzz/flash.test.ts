/**
 * Flash values and a failed form's errors, as sequences of posts and visits
 * from two browsers. Each saved form flashes a message naming its own token,
 * and each failed one sends its field's error back. docs/state-machines/
 * Flash.tla accepts that the page the form's redirect lands on may miss them,
 * when another request from the same browser renders a page first: the
 * cookie is one value per browser. What must hold whatever the order:
 *
 * - a page shows only messages and errors its own browser's posts made;
 * - each message is shown at most once, and the errors once per post that
 *   made them;
 * - and they are shown: a browser that follows its post's redirect before
 *   it sends any other request, or only requests that redirect it on, as a
 *   guard does, is shown the message, or the errors, where it lands.
 *   Without it, a flash that never reached any page would keep the rules
 *   above.
 */
import { describe } from 'bun:test'
import { Hono } from 'hono'
import { Arbitrary, Effect, Schema as S } from 'effect'
import { action } from '../../src/effect/action.js'
import { flash, redirect, render } from '../../src/effect/responses.js'
import { requiredString } from '../../src/effect/schema.js'
import { validateRequest } from '../../src/effect/validation.js'
import { setupWeb } from '../../src/setup.js'
import { testBrowser, testEnv, type TestBrowser } from '../../src/testing.js'
import { stepsOf } from '../../src/fuzz.js'
import { property, show, weighted } from './property'

const Note = S.Struct({ name: requiredString, token: requiredString })

function createApp() {
  const app = new Hono()
  const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) })

  routes
    .get('/notes', action(render('Notes', {})))
    .get('/other', action(render('Other', {})))
    // A page that sends the visitor on, as a guard does.
    .get('/elsewhere', action(redirect('/notes')))
    .post('/notes', action(Effect.gen(function* () {
      const note = yield* validateRequest(Note)

      yield* flash('success', `saved ${note.token}`)

      return yield* redirect('/notes')
    })))

  return app
}

type Browser = 'one' | 'two'

const step = Arbitrary.all({
  browser: weighted<Browser>(['one', 1], ['two', 1]),
  act: weighted(['save', 2], ['fail', 2], ['visit', 2], ['other', 1], ['json', 1], ['follow', 2], ['bounce', 1]),
  inertia: weighted([true, 2], [false, 1]),
})

type Step = typeof step extends Arbitrary.Arbitrary<infer A> ? A : never

/** What a page shows of the flash: its message and whether it carries the form's errors. */
const Shown = S.Struct({
  props: S.Struct({ errors: S.optional(S.Record(S.String, S.Unknown)) }),
  flash: S.optional(S.Struct({ success: S.optional(S.String) })),
})

const form = (body: Readonly<Record<string, string>>): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: 'http://localhost/notes' },
  body: new URLSearchParams(body).toString(),
})

interface State {
  readonly browser: TestBrowser
  // Tokens this browser's saved forms flashed, not yet shown.
  readonly unshown: Set<string>
  // Failed posts whose errors no page has shown yet.
  failed: number
  // The redirect a post answered, which the browser has not followed yet.
  pending?: Response
  // What the post that answered it made, while the browser has sent nothing since.
  untouched?: { readonly token: string } | 'errors'
}

/** What a page showed of the flash: its message and its errors' fields. */
interface Seen {
  readonly message: string | undefined
  readonly errors: ReadonlyArray<string>
}

async function runSteps(steps: readonly Step[]): Promise<string[]> {
  const app = createApp()
  const env = testEnv({ ENVIRONMENT: 'production' })
  const stateOf = (browser: TestBrowser): State => ({ browser, unshown: new Set(), failed: 0 })
  const states = { one: stateOf(testBrowser(app, env)), two: stateOf(testBrowser(app, env)) }
  const shownTokens = new Set<string>()
  const broken: string[] = []
  let tokens = 0

  const read = async (who: Browser, res: Response): Promise<Seen | undefined> => {
    if (res.status !== 200 || !(res.headers.get('content-type') ?? '').includes('json')) return undefined

    const page = S.decodeUnknownExit(S.fromJsonString(Shown))(await res.text())

    if (page._tag === 'Failure') return undefined

    const state = states[who]
    const message = page.value.flash?.success
    const errors = Object.keys(page.value.props.errors ?? {})

    if (message !== undefined) {
      const token = message.replace(/^saved /, '')

      if (!state.unshown.has(token)) {
        broken.push(`browser ${who} was shown ${show(message)}, ${shownTokens.has(token) ? 'again' : 'which it never saved'}`)
      }

      state.unshown.delete(token)
      shownTokens.add(token)
    }

    if (errors.length > 0) {
      if (state.failed === 0) broken.push(`browser ${who} was shown errors ${show(errors)} it has no failed post for`)

      // The cookie holds one set of errors, so one page shows every failed post's.
      state.failed = 0
    }

    return { message, errors }
  }

  const headersOf = (sent: Step): Record<string, string> => (sent.inertia ? { 'X-Inertia': 'true', 'X-Inertia-Version': '1' } : {})

  for (const sent of steps) {
    const state = states[sent.browser]
    const untouched = state.untouched

    // Any request but following the redirect, or one that only redirects on,
    // leaves the post's flash to whichever page comes first.
    state.untouched = sent.act === 'bounce' ? untouched : undefined

    switch (sent.act) {
      case 'save': {
        const token = `t${++tokens}`

        state.unshown.add(token)
        state.pending = await state.browser.request('/notes', form({ name: 'A note', token }))
        state.untouched = { token }
        break
      }
      case 'fail':
        state.failed += 1
        state.pending = await state.browser.request('/notes', form({ name: '', token: 'x' }))
        state.untouched = 'errors'
        break
      case 'follow': {
        if (state.pending === undefined) break

        const seen = await read(sent.browser, await state.browser.follow(state.pending, { headers: headersOf(sent) }))

        state.pending = undefined

        // An Inertia visit reads the page as JSON; a full visit's HTML is not read.
        if (untouched !== undefined && sent.inertia) {
          const shown = untouched === 'errors' ? (seen?.errors.length ?? 0) > 0 : seen?.message === `saved ${untouched.token}`

          if (!shown) broken.push(`browser ${sent.browser} followed its post's redirect at once and was not shown ${untouched === 'errors' ? 'its errors' : `saved ${untouched.token}`}`)
        }
        break
      }
      case 'visit':
        await read(sent.browser, await state.browser.request('/notes', { headers: headersOf(sent) }))
        break
      case 'other':
        await read(sent.browser, await state.browser.request('/other', { headers: headersOf(sent) }))
        break
      case 'bounce':
        // The redirect carries what the browser received on to where it lands.
        state.pending = await state.browser.request('/elsewhere', { headers: headersOf(sent) })
        break
      case 'json':
        await read(sent.browser, await state.browser.request('/notes', { headers: { Accept: 'application/json' } }))
        break
    }
  }

  return broken
}

describe('flash and a failed form’s errors', () => {
  property(
    'reach only the browser that posted, each at most once, and the page its redirect lands on',
    stepsOf(step, { maxLength: 14 }),
    async (steps) => {
      const broken = await runSteps(steps)

      return broken.length === 0 ? undefined : `${broken.join('; ')} after ${show(steps)}`
    },
    { runs: 200 }
  )
})
