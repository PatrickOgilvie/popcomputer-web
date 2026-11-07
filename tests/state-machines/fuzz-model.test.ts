/**
 * Machines 55, 56 and 64: the fuzz session's model of each record, which
 * reads a step's answer as succeeded, bounced or refused, gives a record
 * created again after a delete to its new creator, and knows the ids a
 * person sent exactly; a `fuzz` run's report of an input JSON cannot write;
 * and the components `openApi` shares between endpoints.
 */
import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { Arbitrary, Effect, Schema as S } from 'effect'
import { Hono } from 'hono'
import { action, form } from '../../src/effect/action.js'
import { background } from '../../src/effect/background.js'
import { bound, routeBinding } from '../../src/effect/binding.js'
import { reportEffectError } from '../../src/effect/error-observer.js'
import { dbMutation } from '../../src/effect/database.js'
import { redirect } from '../../src/effect/responses.js'
import { requiredString } from '../../src/effect/schema.js'
import { authorize } from '../../src/effect/services.js'
import { endpoint, openApi } from '../../src/endpoint.js'
import { fuzz, show, startFuzzSession, type FuzzAnswer, type FuzzRequest } from '../../src/fuzz.js'
import { setupWeb } from '../../src/setup.js'
import { signedIn, testEnv, type TestApp } from '../../src/testing.js'

type Person = 'ada' | 'grace'

const user = sqliteTable('user', { id: text('id').primaryKey() })
const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id),
})
const schema = { user, projects }
const paths = { projects: '/projects', project: '/projects/{project}' } as const

const NewProject = S.Struct({ slug: requiredString })
const Confirm = S.Struct({ confirm: requiredString })
const Id = S.Struct({ id: S.String })

/** Projects named by their slug, made by a form and deleted by one that must be confirmed; ada's `p-ada` to start. */
function projectsApp() {
  const sqlite = new Database(':memory:')
  sqlite.run('CREATE TABLE user (id TEXT PRIMARY KEY)')
  sqlite.run('CREATE TABLE projects (id TEXT PRIMARY KEY, user_id TEXT NOT NULL)')
  sqlite.run("INSERT INTO user (id) VALUES ('ada'), ('grace')")
  sqlite.run("INSERT INTO projects (id, user_id) VALUES ('p-ada', 'ada')")

  const db = drizzle(sqlite, { schema })
  const app = new Hono()
  const { routes } = setupWeb(app, {
    version: '1',
    render: (page) => JSON.stringify(page),
    database: () => db,
    schema,
    bindings: { project: routeBinding(projects, { ownedBy: 'userId' }) },
  })
  // SAFETY: These tests register no database type; the client is the Drizzle client above.
  const client = <Given>(given: Given): typeof db => given as never

  routes
    .post(paths.projects, action(form(NewProject), (input) => Effect.gen(function* () {
      const auth = yield* authorize()

      yield* dbMutation((given) => client(given).insert(projects).values({ id: input.slug, userId: auth.user.id }))

      return yield* redirect(paths.project, { project: input.slug })
    })))
    // A project made while another system is down: the action reports what
    // it handled, and its background work fails after the answer.
    .post('/drafts', action(form(NewProject), (input) => Effect.gen(function* () {
      const auth = yield* authorize()

      yield* dbMutation((given) => client(given).insert(projects).values({ id: input.slug, userId: auth.user.id }))
      yield* reportEffectError(new Error('the mailer is down'))
      yield* background('notify', Effect.fail(new Error('the mailer is down')))

      return yield* redirect(paths.project, { project: input.slug })
    })))
    .delete(paths.project, action(form(Confirm), () => Effect.gen(function* () {
      const project = S.decodeUnknownSync(Id)(yield* bound('project'))

      yield* dbMutation((given) => client(given).delete(projects).where(eq(projects.id, project.id)))

      return yield* redirect(paths.projects)
    })))

  const ids = () => sqlite.query<{ readonly id: string }, []>('SELECT id FROM projects ORDER BY id').all().map((row) => row.id)

  return { app, ids }
}

/** The project a POST made, by its redirect's Location, as docs/fuzz-sessions.md's `created` reads it. */
function created(sent: FuzzRequest<Person>, answer: FuzzAnswer): Readonly<Record<string, string>> | undefined {
  const location = answer.response.headers.get('location') ?? ''
  const id = /^\/projects\/([^/]+)$/.exec(URL.canParse(location, 'http://localhost') ? new URL(location, 'http://localhost').pathname : '')?.[1]

  return sent.method === 'POST' && id !== undefined ? { project: id } : undefined
}

const envFor = (person: Person | null) =>
  person === null ? testEnv({ ENVIRONMENT: 'production' }) : testEnv(signedIn({ id: person }), { ENVIRONMENT: 'production' })

const sessionOf = (app: TestApp, owners: Readonly<Record<string, Person>> = { 'p-ada': 'ada' }) =>
  startFuzzSession(app, { paths, env: envFor, owners, created })

/** A form a person posts, as a browser on the site sends it. */
const step = (
  person: Person | null,
  method: string,
  path: string,
  fields: ReadonlyArray<string>,
  headers: Readonly<Record<string, string>> = {}
): FuzzRequest<Person> => ({
  person,
  method,
  path,
  query: '',
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
  body: { as: 'form', fields },
})

describe('the fuzz session model', () => {
  test("M55.T5: a form bounced back to a seeded record's page creates nothing", async () => {
    const { app } = projectsApp()
    const session = sessionOf(app)
    const bounced = await session.send(step('ada', 'POST', paths.projects, ['slug='], { referer: 'http://localhost/projects/p-ada' }))

    // The Location names p-ada, which `created` reads; the form failed, so no step made it.
    expect(bounced?.answer.response.status).toBe(303)
    expect(new URL(bounced?.answer.response.headers.get('location') ?? '', 'http://localhost').pathname).toBe('/projects/p-ada')
    expect(session.canaries('grace', {})).toEqual({})
    expect(session.history.at(-1)).toBe('ada POST /projects form slug=: 303, bounced')

    // A form that passes makes its project, which only ada knows.
    await session.send(step('ada', 'POST', paths.projects, ['slug=apollo']))

    expect(session.canaries('grace', {})).toEqual({ ada: ['apollo'] })
    expect(session.ownerOf('apollo')).toBe('ada')
  })

  test('M55.T5: a step that succeeded naming a seeded record lists it as created by no step', async () => {
    const app = new Hono().post('/projects', (c) => c.redirect('/projects/p-ada', 303))
    const session = sessionOf(app)

    await session.send(step('ada', 'POST', paths.projects, []))

    expect(session.canaries('grace', {})).toEqual({})
    expect(session.ownerOf('p-ada')).toBe('ada')
    expect(session.history).toEqual(['ada POST /projects form : 303'])
  })

  test('M55.T8: a DELETE whose form bounces back leaves its record existing', async () => {
    const { app, ids } = projectsApp()
    const session = sessionOf(app)
    const bounced = await session.send(step('ada', 'DELETE', '/projects/p-ada', [], { referer: 'http://localhost/projects/p-ada' }))

    expect(bounced?.answer.response.status).toBe(303)
    expect(ids()).toEqual(['p-ada'])
    expect(session.exists('p-ada')).toBe(true)

    // Signed out, the visitor is sent to sign in, which deletes nothing
    // either; grace, who may not load it, is refused.
    await session.send(step(null, 'DELETE', '/projects/p-ada', ['confirm=yes']))
    await session.send(step('grace', 'DELETE', '/projects/p-ada', ['confirm=yes']))

    expect(session.exists('p-ada')).toBe(true)
    expect(session.history.slice(1)).toEqual([
      'a visitor DELETE /projects/p-ada form confirm=yes: 302, bounced',
      'grace DELETE /projects/p-ada form confirm=yes: 404',
    ])

    // Confirmed, the delete goes through and redirects.
    const deleted = await session.send(step('ada', 'DELETE', '/projects/p-ada', ['confirm=yes']))

    expect(deleted?.answer.response.status).toBe(303)
    expect(ids()).toEqual([])
    expect(session.exists('p-ada')).toBe(false)
  })

  test('M55.T2: a step whose action succeeded creates its record, though it reported a failure it handled and its background work failed', async () => {
    const { app } = projectsApp()
    const session = sessionOf(app)
    const made = await session.send(step('ada', 'POST', '/drafts', ['slug=draft']))

    expect(made?.answer.observed.map((event) => [event.handling, event.metadata?.operation])).toEqual([['handled', undefined], ['unhandled', 'notify']])
    expect(session.exists('draft')).toBe(true)
    expect(session.history).toEqual(['ada POST /drafts form slug=draft: 303, created project draft'])
  })

  test('M55.T10: an answer at 400 or above is refused, and only a 3xx to sign in bounces without a failure', async () => {
    // Each answer is the status and Location the step's query asks for.
    const app = new Hono().all('*', (c) => new Response(null, { status: Number(c.req.query('status')), headers: { location: c.req.query('location') ?? '' } }))
    const session = sessionOf(app)
    const answering = (method: string, path: string, query: string) => session.send({ ...step('ada', method, path, []), query })

    await answering('POST', paths.projects, 'status=400&location=/projects/refused')
    await answering('DELETE', '/projects/p-ada', 'status=300&location=/login')
    await answering('POST', paths.projects, 'status=201&location=/login')

    expect(session.exists('refused')).toBe(false)
    expect(session.exists('p-ada')).toBe(true)

    // A Location no URL parses names no page to sign in on.
    await answering('DELETE', '/projects/p-ada', 'status=302&location=http%3A%2F%2F%5B')

    expect(session.exists('p-ada')).toBe(false)
    expect(session.history).toEqual([
      'ada POST /projects?status=400&location=/projects/refused form : 400',
      'ada DELETE /projects/p-ada?status=300&location=/login form : 300, bounced',
      'ada POST /projects?status=201&location=/login form : 201',
      'ada DELETE /projects/p-ada?status=302&location=http%3A%2F%2F%5B form : 302',
    ])
  })

  test('M55.T9: a redirect to sign in is no success, though no failure the framework saw made it', async () => {
    const app = new Hono()
      .delete('/projects/:project', (c) => c.redirect('/login', 302))
      .post('/projects', (c) => c.redirect('/projects/made', 303))
    const session = sessionOf(app)

    await session.send(step('ada', 'DELETE', '/projects/p-ada', []))
    await session.send(step('ada', 'POST', paths.projects, []))

    expect(session.exists('p-ada')).toBe(true)
    expect(session.exists('made')).toBe(true)
    expect(session.history).toEqual(['ada DELETE /projects/p-ada form : 302, bounced', 'ada POST /projects form : 303, created project made'])
  })

  test('M55.T15: a record created again after its delete is a new one, its creator its owner', async () => {
    const { app, ids } = projectsApp()
    const session = sessionOf(app, {})

    await session.send(step('ada', 'POST', paths.projects, ['slug=slug-a']))
    await session.send(step('ada', 'POST', paths.projects, ['slug=slug-b']))
    await session.send(step('ada', 'DELETE', '/projects/slug-a', ['confirm=yes']))

    expect(session.exists('slug-a')).toBe(false)

    await session.send(step('grace', 'POST', paths.projects, ['slug=slug-a']))

    expect(ids()).toEqual(['p-ada', 'slug-a', 'slug-b'])
    expect(session.exists('slug-a')).toBe(true)
    expect(session.ownerOf('slug-a')).toBe('grace')
    // The latest project a step created is slug-a again.
    expect((await session.send(step('grace', 'DELETE', '/projects/~project.0', ['confirm=yes'])))?.sent.path).toBe('/projects/slug-a')
    expect(session.exists('slug-a')).toBe(false)
    expect(session.ownerOf('slug-b')).toBe('ada')
  })

  test('M55.T4: a live record a step names as created again keeps its owner, and its references', async () => {
    const app = new Hono()
      .post('/projects', (c) => c.redirect('/projects/shared', 303))
      .post('/showcases', (c) => c.redirect('/projects/shared', 303))
      .get('*', (c) => c.text('page'))
    const session = startFuzzSession(app, {
      paths,
      env: envFor,
      owners: {},
      // The same project, named again by the placeholder that shows it.
      created: (sent, answer) => {
        const placeholder = sent.path === '/showcases' ? 'showcase' : 'project'

        return sent.method === 'POST' ? { [placeholder]: answer.response.headers.get('location')?.split('/').at(-1) ?? '' } : undefined
      },
    })

    await session.send(step('ada', 'POST', paths.projects, []))
    await session.send(step('grace', 'POST', paths.projects, []))
    await session.send(step('grace', 'POST', '/showcases', []))

    expect(session.ownerOf('shared')).toBe('ada')
    expect(session.canaries(null, {})).toEqual({ ada: ['shared'] })
    expect((await session.send(step('ada', 'GET', '/showcase/~showcase.0/~project.1', [])))?.sent.path).toBe('/showcase/shared/shared')
  })

  test('M55.T23: a person knows an id they sent whole, not one inside another value', async () => {
    // Each POST makes the project its body names, and answers its id.
    const app = new Hono()
      .post('/projects', async (c) => c.text(await c.req.text(), 201))
      .get('/projects/:project', (c) => c.text('page'))
    const session = startFuzzSession(app, {
      paths,
      env: envFor,
      owners: {},
      created: (sent, answer) => (sent.method === 'POST' && sent.path === paths.projects ? { project: answer.text } : undefined),
    })
    const made = (id: string) => session.send({ ...step('ada', 'POST', paths.projects, []), body: { as: 'text', text: id } })

    for (const id of ['1', 'a b', 'on-page', 'in-query', 'in-header', 'as-field', 'in-field']) await made(id)

    await session.send(step('grace', 'GET', '/projects/12', []))
    // A GET sends no body, so the field it holds goes nowhere.
    await session.send({ ...step('grace', 'GET', '/projects/x', ['id=as-field'], { referer: 'http://localhost/projects/on-page-2?q=in-query-2' }), query: 'q=a%20bc' })

    expect(session.canaries('grace', {})).toEqual({ ada: ['1', 'a b', 'on-page', 'in-query', 'in-header', 'as-field', 'in-field'] })

    // Sent whole, as a segment, a query value, a Referer's segment or query
    // value, another header or a field, or by a reference inside a field,
    // each is known.
    await session.send(step('grace', 'GET', '/projects/1', []))
    await session.send({ ...step('grace', 'GET', '/projects/x', []), query: 'q=a%20b' })
    await session.send(step('grace', 'GET', '/projects/x', [], { referer: 'http://localhost/projects/on-page?q=in-query', 'x-project': 'in-header' }))
    await session.send(step('grace', 'POST', '/notes', ['id=as-field', 'body=see ~project.0']))

    expect(session.canaries('grace', {})).toEqual({})
    // A step that only reads a record leaves it.
    expect(session.exists('1')).toBe(true)
  })
})

describe('a probe beside the session', () => {
  test("M55.T25: sends each cookie the person's browser held only to the paths it covers", async () => {
    const app = new Hono()
      .get('/set', (c) => {
        c.header('Set-Cookie', 'scoped=1; Path=/only', { append: true })
        c.header('Set-Cookie', 'everywhere=1; Path=/', { append: true })

        return c.text('set')
      })
      .get('/only', (c) => c.text(c.req.header('cookie') ?? ''))
      .get('/elsewhere', (c) => c.text(c.req.header('cookie') ?? ''))
    const session = startFuzzSession(app, { paths: { set: '/set', only: '/only', elsewhere: '/elsewhere' }, env: envFor, owners: {}, created: () => undefined })
    const get = (path: string): FuzzRequest<Person> => ({ person: 'ada', method: 'GET', path, query: '', headers: {}, body: { as: 'none' } })

    await session.send(get('/set'))
    expect((await session.send(get('/only')))?.answer.text).toBe('scoped=1; everywhere=1')
    expect((await session.send(get('/elsewhere')))?.answer.text).toBe('everywhere=1')

    expect((await session.probe(get('/elsewhere')))?.text).toBe('everywhere=1')
    expect((await session.probe(get('/only')))?.text).toBe('scoped=1; everywhere=1')
  })

  test('M55.T25: holds the cookies as they stood before the last step, those it cleared gone and none it set', async () => {
    const app = new Hono()
      .get('/set', (c) => {
        c.header('Set-Cookie', 'kept=1; Path=/', { append: true })
        c.header('Set-Cookie', 'cleared=1; Path=/', { append: true })

        return c.text('set')
      })
      .get('/clear', (c) => {
        c.header('Set-Cookie', 'cleared=; Path=/; Max-Age=0')

        return c.text('cleared')
      })
      .get('/late', (c) => {
        c.header('Set-Cookie', 'late=1; Path=/')

        return c.text(c.req.header('cookie') ?? '')
      })
    const session = startFuzzSession(app, { paths: { set: '/set', clear: '/clear', late: '/late' }, env: envFor, owners: {}, created: () => undefined })
    const get = (path: string): FuzzRequest<Person> => ({ person: 'ada', method: 'GET', path, query: '', headers: {}, body: { as: 'none' } })

    await session.send(get('/set'))
    await session.send(get('/clear'))
    await session.send(get('/late'))

    expect((await session.probe(get('/late')))?.text).toBe('kept=1')
    expect((await session.send(get('/late')))?.answer.text).toBe('kept=1; late=1')
  })
})

describe('a fuzz run', () => {
  const failure = (run: Promise<void>): Promise<string> => run.then(
    () => 'passed',
    (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error))
  )

  test('M56.T3: a refused example JSON cannot write is reported with why and the input', async () => {
    const cyclic: { readonly name: string; self?: unknown } = { name: 'loop' }
    cyclic.self = cyclic

    const reported = await failure(fuzz(Arbitrary.Constant(cyclic), () => 'no', { examples: [cyclic] }))

    expect(reported).toStartWith('Error: Example 1 of 1 refused: no\nInput: ')
    expect(reported).toContain('loop')
  })

  test('M56.T8: a refused case JSON cannot write shrinks and reports why, with a replay token', async () => {
    const reported = await failure(fuzz(Arbitrary.schema(S.BigInt), () => 'refused', { runs: 5 }))

    expect(reported).toStartWith('Error: Property falsified')
    expect(reported).toContain('Shrunk input: 0n\n')
    expect(reported).toContain('Replay: ')
    expect(reported).toContain('Refused: refused')
    expect(reported).toContain('First failure: refused')
  })

  test('show writes what JSON cannot, and the rest as JSON', () => {
    const cyclic: { readonly name: string; self?: unknown } = { name: 'loop' }
    cyclic.self = cyclic

    expect(show({ amount: 12n })).toBe('{"amount":12n}')
    expect(show(cyclic)).toBe('{"name":"loop","self":[Circular]}')
    expect(show({ at: new Date(0), name: 'café' })).toBe('{"at":"1970-01-01T00:00:00.000Z","name":"caf\\u00e9"}')
    expect(show(undefined)).toBe('undefined')
  })
})

describe('openApi components', () => {
  const component = (document: ReturnType<typeof openApi>): Readonly<Record<string, unknown>> => {
    const components: unknown = JSON.parse(JSON.stringify(document)).components

    return S.decodeUnknownSync(S.Struct({ schemas: S.Record(S.String, S.Unknown) }))(components).schemas
  }

  test('M64.T4: a definition holding a $ref that endpoints share is one component', () => {
    const Inner = S.Struct({ name: S.String }).annotate({ identifier: 'Inner' })
    const Outer = S.Struct({ inner: Inner }).annotate({ identifier: 'Outer' })
    const document = openApi({
      first: endpoint.get('/api/first', { success: Outer }),
      second: endpoint.get('/api/second', { success: Outer }),
      third: endpoint.get('/api/third', { success: S.Struct({ outer: Outer }) }),
    }, { title: 'Shared', version: '1' })

    expect(Object.keys(component(document)).sort()).toEqual(['ErrorResponse', 'Inner', 'Outer'])
    expect(component(document).Outer).toMatchObject({ properties: { inner: { $ref: '#/components/schemas/Inner' } } })
  })

  test('M64.T4: a recursive definition endpoints share is one component, pointing at itself', () => {
    interface Tree {
      readonly children: ReadonlyArray<Tree>
    }
    const Tree = S.Struct({ children: S.Array(S.suspend((): S.Codec<Tree> => Tree)) }).annotate({ identifier: 'Tree' })
    const document = openApi({
      first: endpoint.get('/api/first', { success: Tree }),
      second: endpoint.get('/api/second', { success: Tree }),
    }, { title: 'Trees', version: '1' })

    expect(Object.keys(component(document)).sort()).toEqual(['ErrorResponse', 'Tree'])
    expect(JSON.stringify(component(document).Tree)).toContain('#/components/schemas/Tree')
  })

  test('M64.T4: a definition alike in text whose $ref names another definition of that name is a component of its own', () => {
    const Outer = <A, I>(inner: S.Codec<A, I>) => S.Struct({ inner }).annotate({ identifier: 'Outer' })
    const document = openApi({
      first: endpoint.get('/api/first', { success: Outer(S.Struct({ name: S.String }).annotate({ identifier: 'Inner' })) }),
      second: endpoint.get('/api/second', { success: Outer(S.Struct({ size: S.Number }).annotate({ identifier: 'Inner' })) }),
    }, { title: 'Apart', version: '1' })
    const schemas = component(document)

    expect(Object.keys(schemas).sort()).toEqual(['ErrorResponse', 'Inner', 'Inner2', 'Outer', 'Outer2'])
    expect(schemas.Outer2).toMatchObject({ properties: { inner: { $ref: '#/components/schemas/Inner2' } } })
    expect(schemas.Outer).toMatchObject({ properties: { inner: { $ref: '#/components/schemas/Inner' } } })
  })

  test('M64.T3: a name taken by another definition, or by one of the same document, moves on to the next free one', () => {
    const Named = (identifier: string, field: string) => S.Struct({ [field]: S.String }).annotate({ identifier })
    const document = openApi({
      first: endpoint.get('/api/first', { success: Named('Foo', 'a') }),
      second: endpoint.get('/api/second', { success: S.Struct({ one: Named('Foo', 'b'), two: Named('Foo2', 'c') }) }),
      third: endpoint.get('/api/third', { success: Named('Foo', 'd') }),
    }, { title: 'Taken', version: '1' })
    const schemas = component(document)
    const success = (path: string) => JSON.stringify(JSON.parse(JSON.stringify(document)).paths[path].get.responses['200'])

    expect(Object.keys(schemas).sort()).toEqual(['ErrorResponse', 'Foo', 'Foo2', 'Foo3', 'Foo4'])
    expect([schemas.Foo, schemas.Foo2, schemas.Foo3, schemas.Foo4]).toMatchObject([
      { properties: { a: {} } },
      { properties: { c: {} } },
      { properties: { b: {} } },
      { properties: { d: {} } },
    ])
    expect(success('/api/second')).toContain('"one":{"$ref":"#/components/schemas/Foo3"},"two":{"$ref":"#/components/schemas/Foo2"}')
  })
})
