/**
 * Requests generated from the route table: `fuzzRequest` given the
 * application's `routes` makes a form for each route that writes, with
 * fields generated to pass the schema its action declares with
 * `form(Schema)`, and `ownership` gives `strangerWrites` the columns the
 * bindings' `ownedBy` names. The test names no form and no owner column, so
 * a new action is fuzzed as soon as it is registered.
 *
 * Every rule holds for an application that refuses everything, so the test
 * also checks each route that writes was reached: its action answered 2xx or
 * wrote, at least once. A failed form's 303 back to its page is no reach.
 */
import { describe, expect, test } from 'bun:test'
import {
  brokenPromises,
  fuzz,
  fuzzRequest,
  fuzzTimeout,
  leaks,
  ownership,
  sendFuzzRequest,
  strangerWrites,
  type FuzzRequest,
  type Refusal,
} from '../../src/fuzz.js'
import { signedIn, testEnv } from '../../src/testing.js'
import { CANARIES, createApp, paths, type Person, type ProjectRow } from './app'

const { routes } = createApp()

const request = fuzzRequest({
  paths,
  routes,
  params: {
    project: ['p1', 'g1', 'p2', 'missing'],
    task: ['t1', 't2'],
    showcase: ['p2', 'p1', 'g1'],
    organization: ['acme', 'globex'],
  },
  people: ['ada', 'grace'],
})

/** The routes that write, other than endpoints, each as a pattern its paths match. */
const writes = routes.getRegistry().all()
  .filter((route) => ['post', 'put', 'patch', 'delete'].includes(route.method) && route.endpoint === undefined)
  .map((route) => ({
    route: `${route.method.toUpperCase()} ${route.routePath}`,
    method: route.method.toUpperCase(),
    pattern: new RegExp(`^${route.routePath.replace(/\{[^}]+\}/g, '[^/]+')}$`),
  }))

const WRITE_STATEMENT = /^\s*(insert|update|delete)\b/i

/** How many times each route that writes reached its action: answered 2xx, or wrote. */
const reached = new Map(writes.map((write) => [write.route, 0]))
let cases = 0

const envFor = (person: Person | null) =>
  person === null ? testEnv({ ENVIRONMENT: 'production' }) : testEnv(signedIn({ id: person }), { ENVIRONMENT: 'production' })

async function send(sent: FuzzRequest<Person>): Promise<Refusal> {
  const { app, rows, statements } = createApp()
  const before = rows()

  cases += 1

  const answer = await sendFuzzRequest(app, sent, envFor(sent.person))

  if (answer === undefined) return undefined

  const write = writes.find((each) => each.method === sent.method && each.pattern.test(sent.path))

  const status = answer.response.status
  const wrote = statements.some((statement) => WRITE_STATEMENT.test(statement))

  if (write !== undefined && ((status >= 200 && status < 300) || wrote)) reached.set(write.route, (reached.get(write.route) ?? 0) + 1)

  return [
    ...brokenPromises(sent, answer),
    ...leaks(sent, answer, CANARIES),
    ...strangerWrites(sent, { before, after: rows() }, ownership<ProjectRow>(routes, 'projects')),
  ]
}

describe('requests made from the route table', () => {
  test('reach every route that writes, with the fields its form declares, and keep the rules', async () => {
    await fuzz(request, send, { runs: 600 })

    // A replay runs one case; a full run must have reached every route that writes.
    if (cases < 100) return

    expect([...reached].filter(([, times]) => times === 0).map(([route]) => route)).toEqual([])
    expect(writes.map((write) => write.route).sort()).toEqual([
      'DELETE /projects/{project}',
      'PATCH /projects/{project}',
      'POST /orders',
      'POST /projects',
      'POST /sign-in',
      'PUT /projects/{project}',
    ])
  }, fuzzTimeout)
})

describe('ownership', () => {
  test("reads a row's primary key and the column its binding's ownedBy names, by property key or snake_case", () => {
    const keys = ownership<object>(routes, 'projects')

    expect([keys.id({ id: 'p1', user_id: 'ada' }), keys.owner({ id: 'p1', user_id: 'ada' })]).toEqual(['p1', 'ada'])
    expect(keys.owner({ id: 'p1', userId: 'grace' })).toBe('grace')
  })

  test('names the fix for a table no binding says the owner of', () => {
    expect(() => ownership(routes, 'tasks')).toThrow('No binding of tasks says who owns its rows')
  })
})
