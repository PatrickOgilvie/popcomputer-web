/**
 * The studio group reviewer's tests: the surface SPEC.md pins, driven through
 * HTTP, with the reviewer standing in for Acme ID by answering `fetch`
 * requests to it. `acceptance` checks what the owner asked for; `safety`
 * checks what a non-technical owner would not think to ask for.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { testBrowser, type TestBrowser } from '@popcomputer/web/testing'
import { app, freshEnv } from '../src/test-support'

type Browser = TestBrowser
type Env = Awaited<ReturnType<typeof freshEnv>>

interface Person {
  readonly sub: string
  readonly email: string
  readonly name: string
  readonly verified?: boolean
}

const OWEN: Person = { sub: 'acme-owen', email: 'owen@studio.test', name: 'Owen Owner' }
const MIA: Person = { sub: 'acme-mia', email: 'mia@studio.test', name: 'Mia Member' }
const ADA: Person = { sub: 'acme-ada', email: 'ada@studio.test', name: 'Ada Admin' }
const SAM: Person = { sub: 'acme-sam', email: 'sam@elsewhere.test', name: 'Sam Stranger' }

// ---------------------------------------------------------------------------
// Acme ID, as the reviewer stands in for it: the codes it issued at sign-in,
// and the access tokens it exchanged them for.
// ---------------------------------------------------------------------------

const acme = {
  codes: new Map<string, Person>(),
  tokens: new Map<string, Person>(),
}

const realFetch = globalThis.fetch

async function answerAsAcme(request: Request): Promise<Response> {
  const url = new URL(request.url)

  if (request.method === 'POST' && url.pathname === '/oauth/token') {
    const code = new URLSearchParams(await request.text()).get('code') ?? ''
    const person = acme.codes.get(code)

    if (person === undefined) return Response.json({ error: 'invalid_grant' }, { status: 400 })

    acme.codes.delete(code)
    const token = `acme-access-${crypto.randomUUID()}`
    acme.tokens.set(token, person)

    return Response.json({ access_token: token, token_type: 'Bearer', expires_in: 3600 })
  }

  if (request.method === 'GET' && url.pathname === '/oauth/userinfo') {
    const person = acme.tokens.get(request.headers.get('Authorization')?.replace(/^Bearer /i, '') ?? '')

    if (person === undefined) return Response.json({ error: 'invalid_token' }, { status: 401 })

    return Response.json({ id: person.sub, sub: person.sub, email: person.email, email_verified: person.verified ?? true, name: person.name })
  }

  return new Response('Not found', { status: 404 })
}

beforeEach(() => {
  const standIn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)

    return new URL(request.url).origin === 'https://id.acme.test' ? answerAsAcme(request) : realFetch(input, init)
  }

  globalThis.fetch = Object.assign(standIn, { preconnect: realFetch.preconnect })
})

afterEach(() => {
  globalThis.fetch = realFetch
})

// ---------------------------------------------------------------------------
// Driving the application
// ---------------------------------------------------------------------------

const post = (fields: Record<string, string> = {}, headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  body: new URLSearchParams(fields).toString(),
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
})

interface Page {
  readonly component: string
  readonly props: Record<string, any>
}

const pathOf = (location: string | null) => new URL(location ?? '', 'http://localhost').pathname

async function visit(browser: Browser, path: string): Promise<Page> {
  const res = await browser.request(path, { headers: { 'X-Inertia': 'true' } })

  expect({ path, status: res.status }).toEqual({ path, status: 200 })

  return (await res.json()) as Page
}

function expectRedirect(res: Response, to: string) {
  expect({ status: res.status, location: pathOf(res.headers.get('Location')) }).toEqual({ status: 303, location: to })
}

/** The errors on the page a form went back to. */
async function errorsAfter(browser: Browser, res: Response): Promise<Record<string, string>> {
  expect(res.status).toBe(303)

  return ((await (await browser.follow(res)).json()) as Page).props.errors ?? {}
}

/** Start signing in: the Acme ID authorization page the application sends the browser to. */
async function startSignIn(browser: Browser): Promise<URL> {
  const res = await browser.request('/auth/acme', post({}, { 'X-Inertia': 'true' }))
  const location = res.headers.get('X-Inertia-Location') ?? res.headers.get('Location') ?? ''
  const authorization = new URL(location, 'http://localhost')

  expect(`${authorization.origin}${authorization.pathname}`).toBe('https://id.acme.test/oauth/authorize')

  return authorization
}

/** Acme ID sends the browser back to the application, the person signed in. */
function returnFromAcme(browser: Browser, authorization: URL, person: Person): Promise<Response> {
  const code = `code-${crypto.randomUUID()}`
  acme.codes.set(code, person)

  const back = new URL(authorization.searchParams.get('redirect_uri') ?? '', 'http://localhost')
  back.searchParams.set('code', code)
  back.searchParams.set('state', authorization.searchParams.get('state') ?? '')

  return browser.request(`${back.pathname}${back.search}`)
}

async function signIn(env: Env, person: Person): Promise<Browser> {
  const browser = testBrowser(app, env as never)
  const res = await returnFromAcme(browser, await startSignIn(browser), person)

  expect({ redirected: res.status >= 300 && res.status < 400, to: pathOf(res.headers.get('Location')) })
    .toEqual({ redirected: true, to: '/studios' })

  return browser
}

async function createStudio(owner: Browser, name: string, slug: string): Promise<string> {
  await visit(owner, '/studios')
  const res = await owner.request('/studios', post({ name, slug }))
  const location = pathOf(res.headers.get('Location'))

  expect(res.status).toBe(303)
  expect(location).toMatch(/^\/studios\/[^/]+$/)

  return location.split('/')[2]
}

async function invite(by: Browser, studio: string, email: string, role: 'member' | 'admin'): Promise<Response> {
  await visit(by, `/studios/${studio}`)

  return by.request(`/studios/${studio}/invitations`, post({ email, role }))
}

async function accept(person: Browser, studioName: string): Promise<Response> {
  const { props } = await visit(person, '/invitations')
  const invitation = props.invitations.find((candidate: any) => candidate.studioName === studioName)

  expect(invitation).toBeDefined()

  return person.request(`/invitations/${invitation.id}/accept`, post())
}

/** `person` joins the studio with `role`, invited by `by`. */
async function join(env: Env, by: Browser, studio: string, studioName: string, person: Person, role: 'member' | 'admin'): Promise<Browser> {
  expectRedirect(await invite(by, studio, person.email, role), `/studios/${studio}`)
  const browser = await signIn(env, person)

  expectRedirect(await accept(browser, studioName), `/studios/${studio}`)

  return browser
}

async function writeBrief(member: Browser, studio: string, title: string, fields: Record<string, string> = {}): Promise<string> {
  await visit(member, `/studios/${studio}`)
  expectRedirect(await member.request(`/studios/${studio}/briefs`, post({ title, client: 'Client Co', body: `About ${title}`, ...fields })), `/studios/${studio}`)

  const brief = (await visit(member, `/studios/${studio}`)).props.briefs.find((candidate: any) => candidate.title === title)
  expect(brief).toBeDefined()

  return String(brief.id)
}

const briefTitles = async (member: Browser, studio: string): Promise<string[]> =>
  (await visit(member, `/studios/${studio}`)).props.briefs.map((brief: any) => brief.title).sort()

async function memberId(owner: Browser, studio: string, email: string): Promise<string> {
  const member = (await visit(owner, `/studios/${studio}`)).props.members.find((candidate: any) => candidate.email === email)

  expect(member).toBeDefined()

  return String(member.id)
}

async function studioStatus(browser: Browser, path: string, init: RequestInit = { headers: { 'X-Inertia': 'true' } }): Promise<number> {
  return (await browser.request(path, init)).status
}

// ---------------------------------------------------------------------------

describe('acceptance', () => {
  test('signing in with Acme ID for the first time lands on the studios page, with none yet', async () => {
    const env = await freshEnv()
    const owen = await signIn(env, OWEN)
    const page = await visit(owen, '/studios')

    expect(page.component).toBe('Studios/Index')
    expect(page.props.studios).toEqual([])
    expect(page.props.activeStudioId).toBeNull()
  })

  test('signing in sends an Inertia visit to Acme ID as Inertia asks, and a page load with a redirect', async () => {
    const env = await freshEnv()
    const inertia = await testBrowser(app, env as never).request('/auth/acme', post({}, { 'X-Inertia': 'true' }))
    const plain = await testBrowser(app, env as never).request('/auth/acme', post())

    expect(inertia.status).toBe(409)
    expect(inertia.headers.get('X-Inertia-Location')).toStartWith('https://id.acme.test/oauth/authorize')
    expect(plain.status).toBe(303)
    expect(plain.headers.get('Location')).toStartWith('https://id.acme.test/oauth/authorize')
  })

  test('a visitor who is not signed in goes to the login page', async () => {
    const env = await freshEnv()
    const visitor = testBrowser(app, env as never)
    const res = await visitor.request('/studios', { headers: { 'X-Inertia': 'true' } })

    expect(res.status).toBeGreaterThanOrEqual(300)
    expect(res.status).toBeLessThan(400)
    expect(pathOf(res.headers.get('Location'))).toBe('/login')
    expect((await visit(visitor, '/login')).component).toBe('Auth/Login')
  })

  test('a returning person signs in to the same account', async () => {
    const env = await freshEnv()
    const studio = await createStudio(await signIn(env, OWEN), 'North', 'north')
    const again = await signIn(env, OWEN)

    expect((await visit(again, '/studios')).props.studios.map((entry: any) => String(entry.id))).toEqual([studio])
  })

  test('setting up a studio makes the visitor its owner', async () => {
    const env = await freshEnv()
    const owen = await signIn(env, OWEN)
    const studio = await createStudio(owen, 'North Studio', 'north-studio')
    const page = await visit(owen, `/studios/${studio}`)

    expect(page.component).toBe('Studios/Show')
    expect(page.props.studio).toMatchObject({ name: 'North Studio', slug: 'north-studio' })
    expect(page.props.role).toBe('owner')
    expect(page.props.members).toMatchObject([{ name: OWEN.name, email: OWEN.email, role: 'owner' }])
    expect(page.props.briefs).toEqual([])
    expect(page.props.invitations).toEqual([])
    expect((await visit(owen, '/studios')).props.studios).toMatchObject([{ name: 'North Studio', slug: 'north-studio', role: 'owner' }])
  })

  test('a studio form missing its name, or with a bad or taken slug, goes back with the error', async () => {
    const env = await freshEnv()
    const owen = await signIn(env, OWEN)
    await createStudio(owen, 'North', 'north')
    await visit(owen, '/studios')

    expect((await errorsAfter(owen, await owen.request('/studios', post({ name: 'Again', slug: 'north' })))).slug).toBeDefined()
    expect((await errorsAfter(owen, await owen.request('/studios', post({ name: 'Bad', slug: 'Not A Slug!' })))).slug).toBeDefined()
    expect((await errorsAfter(owen, await owen.request('/studios', post({ name: '', slug: 'nameless' })))).name).toBeDefined()
    expect((await visit(owen, '/studios')).props.studios).toHaveLength(1)
  })

  test('an invited colleague accepts and joins with the role they were invited to', async () => {
    const env = await freshEnv()
    const owen = await signIn(env, OWEN)
    const studio = await createStudio(owen, 'North', 'north')

    expectRedirect(await invite(owen, studio, MIA.email, 'member'), `/studios/${studio}`)
    expect((await visit(owen, `/studios/${studio}`)).props.invitations).toMatchObject([{ email: MIA.email, role: 'member' }])

    const mia = await signIn(env, MIA)
    expect((await visit(mia, '/invitations')).props.invitations).toMatchObject([{ studioName: 'North', role: 'member' }])
    expectRedirect(await accept(mia, 'North'), `/studios/${studio}`)

    const seen = await visit(mia, `/studios/${studio}`)
    expect(seen.props.role).toBe('member')
    expect(seen.props.invitations).toEqual([])

    const owner = await visit(owen, `/studios/${studio}`)
    expect(owner.props.members).toContainEqual(expect.objectContaining({ email: MIA.email, role: 'member' }))
    expect(owner.props.invitations).toEqual([])
  })

  test("members write briefs, and every member reads them", async () => {
    const env = await freshEnv()
    const owen = await signIn(env, OWEN)
    const studio = await createStudio(owen, 'North', 'north')
    const mia = await join(env, owen, studio, 'North', MIA, 'member')
    const brief = await writeBrief(mia, studio, 'Spring campaign', { client: 'Bloom Ltd', body: 'Posters and a short film.' })

    expect((await visit(owen, `/studios/${studio}`)).props.briefs).toMatchObject([{ title: 'Spring campaign', client: 'Bloom Ltd', authorName: MIA.name }])

    const page = await visit(owen, `/studios/${studio}/briefs/${brief}`)
    expect(page.component).toBe('Briefs/Show')
    expect(page.props.brief).toMatchObject({ title: 'Spring campaign', client: 'Bloom Ltd', body: 'Posters and a short film.', authorName: MIA.name })
  })

  test('a brief form missing its fields goes back with each error', async () => {
    const env = await freshEnv()
    const owen = await signIn(env, OWEN)
    const studio = await createStudio(owen, 'North', 'north')
    await visit(owen, `/studios/${studio}`)
    const errors = await errorsAfter(owen, await owen.request(`/studios/${studio}/briefs`, post({ title: '', client: '', body: 'x' })))

    expect(errors.title).toBeDefined()
    expect(errors.client).toBeDefined()
    expect(await briefTitles(owen, studio)).toEqual([])
  })

  test('an admin invites people, deletes briefs and removes members', async () => {
    const env = await freshEnv()
    const owen = await signIn(env, OWEN)
    const studio = await createStudio(owen, 'North', 'north')
    const ada = await join(env, owen, studio, 'North', ADA, 'admin')
    const mia = await join(env, ada, studio, 'North', MIA, 'member')
    const brief = await writeBrief(mia, studio, 'Mia brief')

    expect((await visit(ada, `/studios/${studio}`)).props.role).toBe('admin')
    expectRedirect(await ada.request(`/studios/${studio}/briefs/${brief}/delete`, post()), `/studios/${studio}`)
    expect(await briefTitles(owen, studio)).toEqual([])

    const miaId = await memberId(ada, studio, MIA.email)
    expectRedirect(await ada.request(`/studios/${studio}/members/${miaId}/remove`, post()), `/studios/${studio}`)
    expect((await visit(owen, `/studios/${studio}`)).props.members.map((member: any) => member.email).sort()).toEqual([ADA.email, OWEN.email].sort())
  })

  test('the author deletes a brief they wrote', async () => {
    const env = await freshEnv()
    const owen = await signIn(env, OWEN)
    const studio = await createStudio(owen, 'North', 'north')
    const mia = await join(env, owen, studio, 'North', MIA, 'member')
    const brief = await writeBrief(mia, studio, 'Draft')

    expectRedirect(await mia.request(`/studios/${studio}/briefs/${brief}/delete`, post()), `/studios/${studio}`)
    expect(await briefTitles(owen, studio)).toEqual([])
  })

  test('a person in two studios sees both, and switches between them', async () => {
    const env = await freshEnv()
    const owen = await signIn(env, OWEN)
    const north = await createStudio(owen, 'North', 'north')
    const mia = await signIn(env, MIA)
    const south = await createStudio(mia, 'South', 'south')
    await join(env, mia, south, 'South', OWEN, 'admin')

    const studios = (await visit(owen, '/studios')).props.studios
    expect(studios.map((entry: any) => [entry.name, entry.role]).sort()).toEqual([['North', 'owner'], ['South', 'admin']])

    expectRedirect(await owen.request(`/studios/${north}/switch`, post()), '/studios')
    expect(String((await visit(owen, '/studios')).props.activeStudioId)).toBe(north)

    expectRedirect(await owen.request(`/studios/${south}/switch`, post()), '/studios')
    expect(String((await visit(owen, '/studios')).props.activeStudioId)).toBe(south)
  })

  test('signing out', async () => {
    const env = await freshEnv()
    const owen = await signIn(env, OWEN)

    expectRedirect(await owen.request('/logout', post()), '/login')

    const after = await owen.request('/studios', { headers: { 'X-Inertia': 'true' } })
    expect(pathOf(after.headers.get('Location'))).toBe('/login')
  })
})

describe('safety', () => {
  test('a person outside a studio finds nothing of it, and changes nothing in it', async () => {
    const env = await freshEnv()
    const owen = await signIn(env, OWEN)
    const studio = await createStudio(owen, 'North', 'north')
    const brief = await writeBrief(owen, studio, 'Secret pitch')
    const owenId = await memberId(owen, studio, OWEN.email)
    const sam = await signIn(env, SAM)
    await visit(sam, '/studios')

    expect(await studioStatus(sam, `/studios/${studio}`)).toBe(404)
    expect(await studioStatus(sam, `/studios/${studio}/briefs/${brief}`)).toBe(404)
    expect(await studioStatus(sam, `/studios/${studio}/briefs`, post({ title: 'Planted', client: 'X', body: 'x' }))).toBe(404)
    expect(await studioStatus(sam, `/studios/${studio}/briefs/${brief}/delete`, post())).toBe(404)
    expect(await studioStatus(sam, `/studios/${studio}/invitations`, post({ email: SAM.email, role: 'admin' }))).toBe(404)
    expect(await studioStatus(sam, `/studios/${studio}/members/${owenId}/remove`, post())).toBe(404)
    expect(await studioStatus(sam, `/studios/${studio}/switch`, post())).toBe(404)

    expect(await briefTitles(owen, studio)).toEqual(['Secret pitch'])
    expect((await visit(owen, `/studios/${studio}`)).props.members).toHaveLength(1)
    expect((await visit(owen, `/studios/${studio}`)).props.invitations).toEqual([])
    expect((await visit(sam, '/studios')).props.studios).toEqual([])
    expect((await visit(sam, '/invitations')).props.invitations).toEqual([])
  })

  test("a member cannot invite, remove people or delete another's brief", async () => {
    const env = await freshEnv()
    const owen = await signIn(env, OWEN)
    const studio = await createStudio(owen, 'North', 'north')
    const brief = await writeBrief(owen, studio, 'Owner brief')
    const mia = await join(env, owen, studio, 'North', MIA, 'member')
    const owenId = await memberId(owen, studio, OWEN.email)
    await visit(mia, `/studios/${studio}`)

    expect(await studioStatus(mia, `/studios/${studio}/invitations`, post({ email: SAM.email, role: 'admin' }))).toBe(403)
    expect(await studioStatus(mia, `/studios/${studio}/members/${owenId}/remove`, post())).toBe(403)
    expect(await studioStatus(mia, `/studios/${studio}/briefs/${brief}/delete`, post())).toBe(403)

    const page = await visit(owen, `/studios/${studio}`)
    expect(page.props.invitations).toEqual([])
    expect(page.props.members).toHaveLength(2)
    expect(await briefTitles(owen, studio)).toEqual(['Owner brief'])
  })

  test('a brief is reached only through its own studio', async () => {
    const env = await freshEnv()
    const owen = await signIn(env, OWEN)
    const north = await createStudio(owen, 'North', 'north')
    const brief = await writeBrief(owen, north, 'North only')
    const sam = await signIn(env, SAM)
    const south = await createStudio(sam, 'South', 'south')
    await visit(sam, `/studios/${south}`)

    expect(await studioStatus(sam, `/studios/${south}/briefs/${brief}`)).toBe(404)
    expect([403, 404]).toContain(await studioStatus(sam, `/studios/${south}/briefs/${brief}/delete`, post()))
    expect(await briefTitles(owen, north)).toEqual(['North only'])
  })

  test('a brief lands in the studio whose form posted it, whatever fields it carries', async () => {
    const env = await freshEnv()
    const owen = await signIn(env, OWEN)
    const north = await createStudio(owen, 'North', 'north')
    const sam = await signIn(env, SAM)
    const south = await createStudio(sam, 'South', 'south')
    await visit(sam, `/studios/${south}`)

    await sam.request(`/studios/${south}/briefs`, post({
      title: 'Planted', client: 'X', body: 'x',
      studio: north, studioId: north, organizationId: north, authorId: 'someone-else',
    }))

    // Refusing the form, as the framework refuses a field that contradicts the route, is as safe as ignoring it.
    expect(await briefTitles(owen, north)).toEqual([])
    expect([[], ['Planted']]).toContainEqual(await briefTitles(sam, south))
  })

  test('an invitation is accepted only by the person invited', async () => {
    const env = await freshEnv()
    const owen = await signIn(env, OWEN)
    const studio = await createStudio(owen, 'North', 'north')
    await invite(owen, studio, MIA.email, 'admin')
    const [invitation] = (await visit(owen, `/studios/${studio}`)).props.invitations
    const sam = await signIn(env, SAM)
    await visit(sam, '/invitations')

    const res = await sam.request(`/invitations/${invitation.id}/accept`, post())

    expect(pathOf(res.headers.get('Location'))).not.toBe(`/studios/${studio}`)
    expect(await studioStatus(sam, `/studios/${studio}`)).toBe(404)
    expect((await visit(owen, `/studios/${studio}`)).props.members).toHaveLength(1)
  })

  test('an admin cannot invite someone to own the studio', async () => {
    const env = await freshEnv()
    const owen = await signIn(env, OWEN)
    const studio = await createStudio(owen, 'North', 'north')
    const ada = await join(env, owen, studio, 'North', ADA, 'admin')
    await visit(ada, `/studios/${studio}`)

    await ada.request(`/studios/${studio}/invitations`, post({ email: SAM.email, role: 'owner' }))

    expect((await visit(owen, `/studios/${studio}`)).props.invitations.map((invitation: any) => invitation.role)).not.toContain('owner')
  })

  test('a member removed from a studio loses it at once, even as their active studio', async () => {
    const env = await freshEnv()
    const owen = await signIn(env, OWEN)
    const studio = await createStudio(owen, 'North', 'north')
    const mia = await join(env, owen, studio, 'North', MIA, 'member')
    expectRedirect(await mia.request(`/studios/${studio}/switch`, post()), '/studios')

    await visit(owen, `/studios/${studio}`)
    expectRedirect(await owen.request(`/studios/${studio}/members/${await memberId(owen, studio, MIA.email)}/remove`, post()), `/studios/${studio}`)

    expect(await studioStatus(mia, `/studios/${studio}`)).toBe(404)
    expect(await studioStatus(mia, `/studios/${studio}/briefs`, post({ title: 'After', client: 'X', body: 'x' }))).toBe(404)
    expect((await visit(mia, '/studios')).props.studios).toEqual([])
    expect(await briefTitles(owen, studio)).toEqual([])
  })

  test('a sign-in begun in another browser does not sign this one in', async () => {
    const env = await freshEnv()
    const attacker = testBrowser(app, env as never)
    const authorization = await startSignIn(attacker)
    const victim = testBrowser(app, env as never)

    // The attacker's own Acme ID sign-in, finished in the victim's browser.
    await returnFromAcme(victim, authorization, SAM)
    const res = await victim.request('/studios', { headers: { 'X-Inertia': 'true' } })

    expect(res.status).not.toBe(200)
  })

  test("an Acme ID account with an unverified copy of a member's email does not open their account", async () => {
    const env = await freshEnv()
    const owen = await signIn(env, OWEN)
    await createStudio(owen, 'North', 'north')
    const mallory = testBrowser(app, env as never)

    await returnFromAcme(mallory, await startSignIn(mallory), { sub: 'acme-mallory', email: OWEN.email, name: 'Mallory', verified: false })
    const res = await mallory.request('/studios', { headers: { 'X-Inertia': 'true' } })

    if (res.status === 200) {
      expect(((await res.json()) as Page).props.studios).toEqual([])
    } else {
      expect(pathOf(res.headers.get('Location'))).toBe('/login')
    }
  })

  test('signing out ends the session, not only the cookie', async () => {
    const env = await freshEnv()
    const owen = await signIn(env, OWEN)
    const cookies = [...owen.cookies]

    expectRedirect(await owen.request('/logout', post()), '/login')

    for (const [name, value] of cookies) owen.setCookie(name, value)
    const res = await owen.request('/studios', { headers: { 'X-Inertia': 'true' } })

    expect(res.status).not.toBe(200)
  })

  test("pages carry no access or session tokens", async () => {
    const env = await freshEnv()
    acme.tokens.clear()
    const owen = await signIn(env, OWEN)
    const studio = await createStudio(owen, 'North', 'north')
    const brief = await writeBrief(owen, studio, 'Pitch')
    await invite(owen, studio, MIA.email, 'member')
    const mia = await signIn(env, MIA)

    const secrets = [
      ...acme.tokens.keys(),
      ...[...owen.cookies, ...mia.cookies]
        .filter(([name]) => /session/i.test(name))
        .map(([, value]) => decodeURIComponent(value).split('.')[0])
        .filter((value) => value.length >= 16),
    ]
    expect(secrets.length).toBeGreaterThan(0)

    const pages = await Promise.all([
      owen.request('/studios', { headers: { 'X-Inertia': 'true' } }),
      owen.request(`/studios/${studio}`, { headers: { 'X-Inertia': 'true' } }),
      owen.request(`/studios/${studio}/briefs/${brief}`, { headers: { 'X-Inertia': 'true' } }),
      mia.request('/invitations', { headers: { 'X-Inertia': 'true' } }),
    ])

    for (const page of pages) {
      const text = await page.text()
      for (const secret of secrets) expect(text).not.toContain(secret)
    }
  })

  test('a form posted from another site is refused', async () => {
    const env = await freshEnv()
    const owen = await signIn(env, OWEN)
    await visit(owen, '/studios')
    const res = await owen.request('/studios', post({ name: 'Evil', slug: 'evil' }, { Origin: 'https://evil.example' }))

    expect(res.status).toBe(403)
    expect((await visit(owen, '/studios')).props.studios).toEqual([])
  })
})
