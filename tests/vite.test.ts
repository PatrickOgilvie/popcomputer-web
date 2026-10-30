/**
 * The Worker under Vite's dev server.
 *
 * Cloudflare's Vite plugin runs the Worker in Vite's module runner, behind an
 * entry that accepts the hot updates of the Worker's modules. These tests run
 * a small application the same way, in Vite's own module runner behind such
 * an entry, and edit its files as a developer would while `bun run dev` runs.
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { createServer, createServerModuleRunner, type ViteDevServer } from 'vite'
import type { ModuleRunner } from 'vite/module-runner'
import { reloadWorkerModules } from '../src/vite.js'

declare global {
  // The modules that ran, in order, and the entry's hot updates.
  var viteFixtureLoads: Array<string>
}

const src = `${import.meta.dir}/../src`
/** Inside the repository, so the application's imports find its node_modules. Each test writes it afresh. */
const directory = `${import.meta.dir}/.generated/vite`

const routesWith = (...registrations: ReadonlyArray<string>) => `
import { Effect } from 'effect'
import { routes } from './app'
import { greeting } from './greeting'

globalThis.viteFixtureLoads.push('routes')
routes${registrations.map((registration) => `\n  ${registration}`).join('')}
`

const hello = `.get('/hello', Effect.sync(() => new Response(greeting)))`
const bye = `.get('/bye', Effect.sync(() => new Response('bye')))`

const application = {
  'app.ts': `
import { Hono } from 'hono'
import { setupWeb } from '${src}/index.ts'

globalThis.viteFixtureLoads.push('app')
export const { app, routes } = setupWeb(new Hono(), { version: '1', render: (page) => JSON.stringify(page) })
`,
  // A module only the routes import, as an action is.
  'greeting.ts': `export const greeting = 'hello'\n`,
  'routes.ts': routesWith(hello),
  'worker.ts': `
import { app } from './app'
import './routes'

export default { fetch: app.fetch }
`,
  // The Cloudflare plugin's Worker entry, which accepts the hot updates.
  'entry.ts': `
import worker from './worker'

export default worker

if (import.meta.hot) import.meta.hot.accept(() => globalThis.viteFixtureLoads.push('hot update'))
`,
  // A page's module, which only the browser loads, and which takes its own hot updates.
  'page.ts': `export const title = 'Home'\n\nif (import.meta.hot) import.meta.hot.accept()\n`,
} satisfies Readonly<Record<string, string>>

let server: ViteDevServer | undefined

afterEach(() => server?.close())

/** Starts the dev server on a fresh copy of the application, and loads its Worker. */
async function devServer(options: { readonly reload: boolean }) {
  await Promise.all(Object.entries(application).map(([file, source]) => Bun.write(`${directory}/${file}`, source)))
  globalThis.viteFixtureLoads = []

  const vite = await createServer({
    root: directory,
    configFile: false,
    logLevel: 'silent',
    appType: 'custom',
    plugins: options.reload ? [reloadWorkerModules()] : [],
    server: { middlewareMode: true, ws: false, watch: null },
  })
  server = vite
  const runner = createServerModuleRunner(vite.environments.ssr, { hmr: { logger: false } })
  await runner.import('/entry.ts')

  return { vite, edit: editIn(vite), request: requestTo(runner) }
}

/** Changes a file of the application, as an editor saves it, and waits for Vite to send the updates it makes. */
const editIn = (vite: ViteDevServer) => async (file: string, source: string) => {
  const path = `${directory}/${file}`

  await Bun.write(path, source)
  await Promise.all(vite.watcher.listeners('change').map(async (listener) => listener(path)))
}

/** Asks the Worker the module runner holds now, as the Cloudflare plugin does for each request. */
const requestTo = (runner: ModuleRunner) => async (path: string) => {
  const entry: { default: { fetch(request: Request): Promise<Response> } } = await runner.import('/entry.ts')
  const response = await entry.default.fetch(new Request(`http://localhost${path}`))

  return `${response.status} ${await response.text()}`
}

/** What `read` answers, or the error it fails with, once that includes `expected`; or its last answer, after a second. */
async function eventually(read: () => Promise<string>, expected: string): Promise<string> {
  let last = ''

  for (let attempt = 0; attempt < 50; attempt++) {
    last = await read().catch(String)
    if (last.includes(expected)) return last
    await Bun.sleep(20)
  }

  return last
}

const loads = async () => globalThis.viteFixtureLoads.join(', ')

describe('reloadWorkerModules', () => {
  test('an edit to the routes takes effect without a restart', async () => {
    const { edit, request } = await devServer({ reload: true })

    await edit('routes.ts', routesWith(hello, bye))

    expect(await eventually(() => request('/bye'), '200 bye')).toBe('200 bye')
    expect(await request('/hello')).toBe('200 hello')
    // The application ran again from its first module, on a new app.
    expect(await loads()).toBe('app, routes, app, routes')
  })

  test('an edit to a module the routes import takes effect without a restart', async () => {
    const { edit, request } = await devServer({ reload: true })

    await edit('greeting.ts', `export const greeting = 'hello again'\n`)

    expect(await eventually(() => request('/hello'), '200 hello again')).toBe('200 hello again')
  })

  test('a route registered twice in one load is still refused, and the fix is served', async () => {
    const { edit, request } = await devServer({ reload: true })

    await edit('routes.ts', routesWith(hello, hello))

    expect(await eventually(() => request('/hello'), 'registered twice')).toContain(
      'GET /hello is registered twice; the second registration is never reached.'
    )

    await edit('routes.ts', routesWith(hello))

    expect(await eventually(() => request('/hello'), '200 hello')).toBe('200 hello')
  })

  test('the Worker’s main module keeps its hot update, on the app already loaded', async () => {
    const { edit, request } = await devServer({ reload: true })

    await edit('worker.ts', `${application['worker.ts']}\nexport const edited = true\n`)

    expect(await eventually(loads, 'hot update')).toBe('app, routes, hot update')
    expect(await request('/hello')).toBe('200 hello')
  })

  test('the browser’s modules keep Vite’s own update, and a file the Worker never loaded changes nothing in it', async () => {
    const { vite, edit } = await devServer({ reload: true })
    const browser = spyOn(vite.environments.client.hot, 'send')
    const worker = spyOn(vite.environments.ssr.hot, 'send')
    await vite.environments.client.transformRequest('/page.ts')

    await edit('page.ts', `${application['page.ts']}export const edited = true\n`)
    await edit('README.md', '# Notes\n')

    expect(browser.mock.calls).toMatchObject([[{ type: 'update' }]])
    expect(worker).not.toHaveBeenCalled()
  })

  test('without it, an edit to the routes registers every route a second time, and the error names it', async () => {
    const { edit, request } = await devServer({ reload: false })

    await edit('routes.ts', routesWith(hello, bye))

    const failure = await eventually(() => request('/bye'), 'registered twice')

    expect(failure).toContain('GET /hello is registered twice')
    expect(failure).toContain('add reloadWorkerModules() from @popcomputer/web/vite')
  })
})
