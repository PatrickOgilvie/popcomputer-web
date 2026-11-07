/**
 * Machines 16, 17, 21, 23 and 30: what a request or a job holds, and when it
 * lets go. A finalizer that dies after the answer cannot change it, every
 * failure of work that outlives the answer is reported, and what a request
 * holds is released whatever its background work did.
 */
import { describe, expect, spyOn, test } from 'bun:test'
import { Config, Context, Effect, Layer, Option, Schema as S, Stream } from 'effect'
import { Hono, type MiddlewareHandler } from 'hono'
import { action } from '../../src/effect/action.js'
import { background } from '../../src/effect/background.js'
import { effectBridge } from '../../src/effect/bridge.js'
import { cookie } from '../../src/effect/cookies.js'
import { EffectErrorObserverService, type EffectErrorEvent } from '../../src/effect/error-observer.js'
import { guard } from '../../src/effect/guard.js'
import { file, flash, json, redirect, redirectNow } from '../../src/effect/responses.js'
import { responseHeader } from '../../src/effect/response-headers.js'
import { effectRoutes } from '../../src/effect/routing.js'
import { ExecutionContextService } from '../../src/effect/services.js'
import { setupWeb } from '../../src/setup.js'
import { testBatch, testEnv } from '../../src/testing.js'
import { web } from '../../src/middleware.js'
import { webContext } from '../../src/request-context.js'
import { purgeCache } from '../../src/effect/response-cache.js'

class Held extends Context.Service<Held, { readonly open: () => boolean }>()('test/Held') {}

/** A service held for the request, whose release is counted and can die. */
const held = (log: string[], options: { readonly dies?: boolean } = {}) =>
  Layer.effect(Held, Effect.acquireRelease(
    Effect.sync(() => ({ isOpen: true })),
    (state) => Effect.sync(() => {
      state.isOpen = false
      log.push('released')
    }).pipe(Effect.andThen(options.dies === true ? Effect.die(new Error('the finalizer died')) : Effect.void))
  ).pipe(Effect.map((state) => Held.of({ open: () => state.isOpen }))))

function harness() {
  const events: EffectErrorEvent[] = []
  const app = new Hono()
  const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) }).services({
    app: Layer.succeed(EffectErrorObserverService, { observe: (event) => Effect.sync(() => void events.push(event)) }),
  })
  const worker = () => {
    const waiting: Promise<unknown>[] = []

    return {
      context: { waitUntil: (promise: Promise<unknown>) => void waiting.push(promise), passThroughOnException: () => {}, props: {} },
      settled: async () => {
        while (waiting.length > 0) await Promise.allSettled(waiting.splice(0))
      },
    }
  }

  return { app, routes, events, worker }
}

const api = { headers: { Accept: 'application/json' } }

describe('a finalizer that dies after the answer', () => {
  test('M21.T15: leaves a committed answer standing, and is reported', async () => {
    const { app, routes, events } = harness()
    const log: string[] = []

    routes.provide(held(log, { dies: true })).post('/save', action(json({ saved: true })))

    const res = await app.request('/save', { method: 'POST', ...api }, testEnv({}))

    expect(res.status).toBe(200)
    expect(log).toEqual(['released'])
    expect(events.some((event) => String(event.error).includes('the finalizer died'))).toBe(true)
  })

  test('M30.T10: leaves a job that succeeded resolved, and testEnv\'s services released', async () => {
    const { routes } = harness()
    const log: string[] = []
    const tests: string[] = []

    await expect(routes.provide(held(log, { dies: true })).run(Effect.succeed(1), testEnv(held(tests), {}))).resolves.toBe(1)
    expect(tests).toEqual(['released'])
  })

  test('M30.T12: as it does when it is testEnv\'s own', async () => {
    const { routes } = harness()

    await expect(routes.run(Effect.succeed(1), testEnv(held([], { dies: true }), {}))).resolves.toBe(1)
  })

  test('M17.T13: leaves a queue message whose work succeeded acknowledged', async () => {
    const { routes } = harness()
    let ran = 0
    const batch = testBatch([{ id: 'm1' }])

    await routes.provide(held([], { dies: true })).queue(S.Struct({ id: S.String }), () => Effect.sync(() => void (ran += 1)))(batch, {})

    expect(ran).toBe(1)
    expect(batch.acked()).toEqual([{ id: 'm1' }])
  })

  test('M16.T20, M30.T14: on a stack composed by hand, keeps the cookie the action set, and the job its result', async () => {
    const app = new Hono()
    const visit = cookie('visit', S.String, { path: '/' })

    app.use('*', web({ version: '1', render: (page) => JSON.stringify(page) }))
    app.use('*', effectBridge())

    const routes = effectRoutes(app).provide(held([], { dies: true }))

    routes.get('/c', action(Effect.andThen(visit.set('1'), json({ ok: true }))))

    const res = await app.request('/c', api)

    expect(res.headers.getSetCookie().join()).toContain('visit=1')
    await expect(routes.run(Effect.succeed(1), {})).resolves.toBe(1)
  })
})

describe('failures of what a request holds', () => {
  test('M21.T7: a guard that dies reaches the error observer, as an action that dies does', async () => {
    const { app, routes, events } = harness()

    routes.provide(guard(Effect.die(new Error('the guard died')))).get('/guarded', action(json({ ok: true })))

    expect((await app.request('/guarded', api, testEnv({}))).status).toBe(500)
    expect(events.some((event) => String(event.error).includes('the guard died'))).toBe(true)
  })

  test("M23.T22: a promise handed to waitUntil that rejects is reported, though the route's layer failed", async () => {
    const { app, routes, events } = harness()
    const failing = guard(Effect.gen(function* () {
      const execution = yield* ExecutionContextService

      execution.waitUntil(Promise.reject(new Error('the side work failed')))

      return yield* Effect.die(new Error('the guard died'))
    }))

    routes.provide(failing).get('/guarded', action(json({ ok: true })))
    await app.request('/guarded', api, testEnv({}))

    expect(events.some((event) => String(event.error).includes('the side work failed'))).toBe(true)
  })

  test('M23.T33: and a guard that redirects after one is answered with its redirect', async () => {
    const { app, routes } = harness()
    const sending = guard(Effect.gen(function* () {
      const execution = yield* ExecutionContextService

      execution.waitUntil(Promise.reject(new Error('the side work failed')))

      return yield* redirectNow('/elsewhere')
    }))

    routes.provide(sending).get('/guarded', action(json({ ok: true })))

    const res = await app.request('/guarded', {}, testEnv({}))

    expect(res.status).toBe(303)
    expect(res.headers.get('Location')).toBe('/elsewhere')
  })

  test("M23.T27, T28: work a finalizer hands waitUntil is reported, in a Worker and outside one", async () => {
    for (const inWorker of [true, false]) {
      const { app, routes, events, worker } = harness()
      const ctx = worker()
      const handing = Layer.effectDiscard(Effect.gen(function* () {
        const execution = yield* ExecutionContextService

        yield* Effect.addFinalizer(() => Effect.sync(() => execution.waitUntil(Promise.reject(new Error('the last work failed')))))
      }))

      routes.provide(handing).get('/hands', action(json({ ok: true })))
      await app.request('/hands', api, testEnv({}), inWorker ? ctx.context : undefined)
      await ctx.settled()

      expect(events.some((event) => String(event.error).includes('the last work failed'))).toBe(true)
    }
  })

  test("M23.T29: work a finalizer schedules runs before testEnv's services are released, in a Worker and outside one", async () => {
    for (const inWorker of [true, false]) {
      const { app, routes, worker } = harness()
      const ctx = worker()
      const seen: boolean[] = []
      // testEnv gives Held, so the route reads it as an option its type does not require.
      const scheduling = Layer.effectDiscard(Effect.gen(function* () {
        const execution = yield* ExecutionContextService
        const service = yield* Effect.serviceOption(Held)

        yield* Effect.addFinalizer(() => execution.schedule('late', Effect.sleep('5 millis').pipe(Effect.andThen(Effect.sync(() =>
          void seen.push(Option.match(service, { onNone: () => false, onSome: (held) => held.open() }))
        )))))
      }))

      routes.provide(scheduling).get('/late', action(json({ ok: true })))
      await app.request('/late', api, testEnv(held([]), {}), inWorker ? ctx.context : undefined)
      await ctx.settled()

      expect(seen).toEqual([true])
    }
  })

  test('M23.T29: a Worker answers without waiting for the work a finalizer started', async () => {
    const { app, routes, worker } = harness()
    const ctx = worker()
    let open = () => {}
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    const starting = Layer.effectDiscard(Effect.gen(function* () {
      const execution = yield* ExecutionContextService

      yield* Effect.addFinalizer(() => execution.schedule('late', Effect.promise(() => gate)))
    }))

    routes.provide(starting).get('/late', action(json({ ok: true })))

    const answered = await Promise.race([
      Promise.resolve(app.request('/late', api, testEnv({}), ctx.context)).then(() => 'answered'),
      new Promise((resolve) => setTimeout(() => resolve('held'), 50)),
    ])

    open()
    await ctx.settled()

    expect(answered).toBe('answered')
  })

  test("M23.T32: testEnv's services are released though the request's background work failed", async () => {
    const { app, routes } = harness()
    const log: string[] = []
    const failing = guard(Effect.gen(function* () {
      const execution = yield* ExecutionContextService

      execution.waitUntil(Promise.reject(new Error('the side work failed')))

      return yield* Effect.die(new Error('the guard died'))
    }))

    routes.provide(failing).get('/guarded', action(json({ ok: true })))
    await app.request('/guarded', api, testEnv(held(log), {}))

    expect(log).toEqual(['released'])
  })

  test('M23.T15: background work a waitUntil promise schedules during the drain still has its services', async () => {
    const { app, routes, worker } = harness()
    const ctx = worker()
    const seen: boolean[] = []

    routes.provide(held([])).get('/late', action(Effect.gen(function* () {
      const execution = yield* ExecutionContextService
      const context = yield* Effect.context<Held | ExecutionContextService>()
      const late = background('late', Effect.flatMap(Held, (service) =>
        Effect.sleep('5 millis').pipe(Effect.andThen(Effect.sync(() => void seen.push(service.open()))))
      ))

      execution.waitUntil(new Promise((resolve) => setTimeout(resolve, 5)).then(() => Effect.runPromise(Effect.provideContext(late, context))))

      return yield* json({ ok: true })
    })))

    await app.request('/late', api, testEnv({}), ctx.context)
    await ctx.settled()

    expect(seen).toEqual([true])
  })
})

describe('failures reported while others arrive', () => {
  test('M23.T23: a failure handed to waitUntil while a slow observer reports the first is reported too', async () => {
    const events: string[] = []
    const app = new Hono()
    const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) }).services({
      app: Layer.succeed(EffectErrorObserverService, {
        observe: (event) => Effect.sleep('5 millis').pipe(Effect.andThen(Effect.sync(() => void events.push(String(event.error))))),
      }),
    })

    routes.get('/two', action(Effect.gen(function* () {
      const execution = yield* ExecutionContextService

      execution.waitUntil(Promise.reject(new Error('first')))
      setTimeout(() => execution.waitUntil(Promise.reject(new Error('second'))), 2)

      return yield* json({ ok: true })
    })))

    await app.request('/two', api, testEnv({}))

    expect([...events].sort()).toEqual(['Error: first', 'Error: second'])
  })
})

describe("the deprecated request runtime", () => {
  test('M33.T11: read while the request runs, releases each request service it built', async () => {
    const log: string[] = []
    const counted = Layer.effect(Held, Effect.acquireRelease(
      Effect.sync(() => void log.push('built')),
      () => Effect.sync(() => void log.push('released'))
    ).pipe(Effect.as(Held.of({ open: () => true }))))
    const app = new Hono()
    const { routes } = setupWeb(app, {
      version: '1',
      render: (page) => JSON.stringify(page),
      middleware: [async (c, next) => {
        await webContext(c).runtime?.runPromise(Effect.void)
        await next()
      }],
    }).services({ request: () => counted })

    routes.get('/r', action(json({ ok: true })))
    await app.request('/r', api, testEnv({}))

    expect(log.filter((entry) => entry === 'built')).toHaveLength(2)
    expect(log.filter((entry) => entry === 'released')).toHaveLength(2)
  })

  test('M33.T11: is refused once the request has released its services, rather than built again', async () => {
    const app = new Hono()
    const reads: string[] = []

    app.use('*', async (c, next) => {
      await next()

      try {
        void webContext(c).runtime
        reads.push('built')
      } catch {
        reads.push('refused')
      }
    })

    const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) })

    routes.get('/r', action(json({ ok: true })))
    await app.request('/r', api, testEnv({}))

    expect(reads).toEqual(['refused'])
  })
})

describe('a job run on a stack composed by hand', () => {
  const handStack = (bridge: MiddlewareHandler = effectBridge()) => {
    const app = new Hono()

    app.use('*', web({ version: '1', render: (page) => JSON.stringify(page) }))
    app.use('*', bridge)

    return effectRoutes(app)
  }

  test("M32.T12: is given testEnv's services over the builder's layers, as on setupWeb", async () => {
    const routes = handStack().provide(Layer.succeed(Held, Held.of({ open: () => true })))
    const fake = Layer.succeed(Held, Held.of({ open: () => false }))

    await expect(routes.run(Effect.map(Held, (held) => held.open()), testEnv(fake, {}))).resolves.toBe(false)
  })

  test('M30.T15: rejects with the failure of services that failed before it ran', async () => {
    const routes = handStack(effectBridge({ services: () => Layer.effect(Held, Effect.map(Config.String('MISSING_VAR'), () => Held.of({ open: () => true }))) }))
    const failure = await routes.run(Effect.succeed(1), {}).then(() => undefined, (error: unknown) => error)

    expect(String(failure)).toContain('MISSING_VAR')
  })
})

describe('what a request writes after its answer has left', () => {
  const late = (write: Effect.Effect<void, never, never>) => Effect.sleep('10 millis').pipe(Effect.andThen(write))

  for (const [row, what, write] of [
    ['M16.T23, M19.T13', 'a cookie', cookie('late', S.String, { path: '/' }).set('v')],
    ['M19.T14', 'a header', responseHeader('X-Late', 'v')],
    ['M19.T15', 'a flash value', flash('success', 'Saved.')],
  ] as const) {
    test(`${row}: ${what} that background work writes is refused and reported, in a Worker and outside one`, async () => {
      for (const inWorker of [true, false]) {
        const { app, routes, events, worker } = harness()
        const ctx = worker()

        // SAFETY: each write needs only the request's services, which the route gives.
        routes.get('/late', action(Effect.andThen(background('late', late(write as Effect.Effect<void>)), json({ ok: true }))))

        const res = await app.request('/late', api, testEnv({}), inWorker ? ctx.context : undefined)
        await ctx.settled()

        expect(res.headers.getSetCookie()).toEqual([])
        expect(res.headers.has('X-Late')).toBe(false)
        expect(events.some((event) => String(event.error).includes('after the response was finished'))).toBe(true)
      }
    })
  }
})

describe('a body file() streams', () => {
  const chunks = (seen: boolean[], count: number) => Stream.fromIterable(Array.from({ length: count }, (_, index) => index)).pipe(
    Stream.mapEffect((index) => Effect.map(Held, (service) => {
      seen.push(service.open())

      return `${index}\n`
    }))
  )

  test('M22.T2, T6: is produced with the services the action had, which are released once it has been sent', async () => {
    const { app, routes } = harness()
    const log: string[] = []
    const seen: boolean[] = []

    routes.provide(held(log)).get('/rows', action(file(chunks(seen, 6), { contentType: 'text/csv' })))

    const res = await app.request('/rows', api, testEnv({}))

    expect(log).toEqual([])
    expect(await res.text()).toBe('0\n1\n2\n3\n4\n5\n')
    expect(seen).toEqual([true, true, true, true, true, true])
  })

  test('M22.T4: and in a Worker with background work running, released after both', async () => {
    const { app, routes, worker } = harness()
    const ctx = worker()
    const log: string[] = []
    const seen: boolean[] = []

    routes.provide(held(log)).get('/rows', action(Effect.andThen(
      background('hold', Effect.sleep('5 millis')),
      file(chunks(seen, 4), { contentType: 'text/csv' })
    )))

    const res = await app.request('/rows', api, testEnv({}), ctx.context)

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(log).toEqual([])
    await res.text()
    await ctx.settled()

    expect(seen).toEqual([true, true, true, true])
    expect(log).toEqual(['released'])
  })

  test('M22.T9: that fails part way ends the body and reaches the error observer', async () => {
    const { app, routes, events } = harness()
    const failing = Stream.make('one\n').pipe(Stream.concat(Stream.die(new Error('the second chunk died'))))

    routes.get('/rows', action(file(failing, { contentType: 'text/csv' })))

    const res = await app.request('/rows', api, testEnv({}))

    expect(res.status).toBe(200)
    await expect(res.text()).rejects.toBeDefined()
    expect(events.some((event) => String(event.error).includes('the second chunk died'))).toBe(true)
  })

  test('M22.T10: whose later chunk sets a cookie fails there, and is reported, rather than dropping it', async () => {
    const { app, routes, events } = harness()
    const visit = cookie('visit', S.String, { path: '/' })
    const setting = Stream.make('one\n', 'two\n', 'three\n').pipe(
      Stream.mapEffect((chunk) => chunk === 'three\n' ? Effect.as(visit.set('1'), chunk) : Effect.succeed(chunk))
    )

    routes.get('/rows', action(file(setting, { contentType: 'text/csv' })))

    const res = await app.request('/rows', api, testEnv({}))

    await expect(res.text()).rejects.toBeDefined()
    expect(res.headers.getSetCookie()).toEqual([])
    expect(events.some((event) => String(event.error).includes('The cookie visit'))).toBe(true)
  })
})

describe('a queue message', () => {
  const Message = S.Struct({ id: S.String })

  /** The log lines `run` writes while it runs, from Effect's logger. */
  const logLines = async (run: () => Promise<unknown>): Promise<string[]> => {
    const lines: string[] = []
    const spies = (['log', 'error', 'warn'] as const).map((level) =>
      spyOn(console, level).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(' ')))
    )

    try {
      await run()
    } finally {
      for (const spy of spies) spy.mockRestore()
    }

    return lines.filter((line) => line.includes('the queue will retry it'))
  }

  test('M17.T10: whose purge fails after its work succeeded is retried, and the retry is logged', async () => {
    const { routes } = harness()
    const batch = testBatch([{ id: 'm1' }])
    const ctx = {
      waitUntil: () => {},
      passThroughOnException: () => {},
      props: {},
      cache: { purge: () => Promise.reject(new Error('purge endpoint unavailable')) },
    }

    const lines = await logLines(() => routes.queue(Message, () => purgeCache('projects:p1'))(batch, {}, ctx))

    expect(batch.retried()).toEqual([{ id: 'm1' }])
    expect(lines).toHaveLength(1)
  })

  test("M17.T11: whose route's layer failed to build is retried, and the retry is logged", async () => {
    const { routes } = harness()
    const batch = testBatch([{ id: 'm1' }])
    const failing = Layer.effect(Held, Effect.die(new Error('the layer failed')))

    const lines = await logLines(() => routes.provide(failing).queue(Message, () => Effect.void)(batch, {}))

    expect(batch.retried()).toEqual([{ id: 'm1' }])
    expect(lines).toHaveLength(1)
  })

  test('M17.T11: whose own work fails is retried, and the retry is logged once', async () => {
    const { routes } = harness()
    const batch = testBatch([{ id: 'm1' }])

    const lines = await logLines(() => routes.queue(Message, () => Effect.fail(new Error('the work failed')))(batch, {}))

    expect(batch.retried()).toEqual([{ id: 'm1' }])
    expect(lines).toHaveLength(1)
  })

  test('M17.T16: is acknowledged once the background work it started has settled', async () => {
    const { routes, worker } = harness()
    const ctx = worker()
    const order: string[] = []
    const batch = testBatch([{ id: 'm1' }])
    const handler = routes.queue(Message, () => background('late', Effect.sleep('10 millis').pipe(Effect.andThen(Effect.sync(() => void order.push('work'))))))

    await handler(batch, {}, ctx.context)
    order.push(batch.acked().length === 1 ? 'ack' : 'no ack')
    await ctx.settled()

    expect(order).toEqual(['work', 'ack'])
  })
})

describe('the response output', () => {
  test('M16.T22: a cookie whose string value starts with a quote reads back the same', async () => {
    const { app, routes } = harness()
    const quoted = cookie('q', S.String, { path: '/' })

    routes.get('/set', action(Effect.andThen(quoted.set('"quoted"'), json({ ok: true }))))
    routes.get('/read', action(Effect.flatMap(quoted.read, (value) => json({ value: value._tag === 'Some' ? value.value : null }))))

    const set = await app.request('/set', api, testEnv({}))
    const sent = set.headers.getSetCookie()[0]?.split(';')[0] ?? ''
    const read = await app.request('/read', { headers: { ...api.headers, Cookie: sent } }, testEnv({}))

    expect(await read.json()).toEqual({ value: '"quoted"' })
  })

  test('M19.T10: a flash value the cookie cannot hold fails where it is set, as a defect the observer sees', async () => {
    const { app, routes, events } = harness()
    const cyclic: Record<string, unknown> = {}

    cyclic.self = cyclic
    // SAFETY: a cyclic value is what the row is about; PageProps types cannot exclude it.
    routes.post('/save', action(Effect.andThen(flash('success', cyclic as never), json({ ok: true }))))

    const res = await app.request('/save', { method: 'POST', ...api }, testEnv({}))

    expect(res.status).toBe(500)
    expect(events.some((event) => String(event.error).includes('The flash value success cannot be stored'))).toBe(true)
  })

  test('M19.T12: application middleware that calls next() twice runs the members after it once', async () => {
    let ran = 0
    const app = new Hono()
    const { routes } = setupWeb(app, {
      version: '1',
      render: (page) => JSON.stringify(page),
      middleware: [
        async (_c, next) => {
          await next()
          await next()
        },
        async (_c, next) => {
          ran += 1
          await next()
        },
      ],
    })

    routes.get('/twice', action(json({ ok: true })))

    const res = await app.request('/twice', api, testEnv({}))

    expect(ran).toBe(1)
    expect(res.status).toBe(500)
  })

  test("M19.T16: an error page that replaces a finished redirect shows no flash, and carries neither the redirect's Location nor its cookies", async () => {
    const app = new Hono()
    const { routes } = setupWeb(app, {
      version: '1',
      render: (page) => JSON.stringify(page),
      middleware: [async (_c, next) => {
        await next()
        throw new Error('after the route')
      }],
    })

    routes.post('/save', action(Effect.andThen(flash('success', 'Saved.'), redirect('/done'))))

    const res = await app.request('/save', { method: 'POST', headers: { 'X-Inertia': 'true', 'X-Inertia-Version': '1' } }, testEnv({}))
    const body = await res.text()

    expect(res.status).toBe(500)
    expect(res.headers.get('Location')).toBeNull()
    expect(res.headers.getSetCookie()).toEqual([])
    expect(res.headers.has('x-popweb-page')).toBe(false)
    expect(body).not.toContain('Saved.')

    const asJson = await app.request('/save', { method: 'POST', ...api }, testEnv({}))

    expect(asJson.status).toBe(500)
    expect(asJson.headers.get('Location')).toBeNull()
    expect(asJson.headers.getSetCookie()).toEqual([])
  })
})

