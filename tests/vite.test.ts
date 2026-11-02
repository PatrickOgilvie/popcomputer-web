/**
 * The Worker under Vite's dev server.
 *
 * Cloudflare's Vite plugin runs the Worker in Vite's module runner, behind an
 * entry that accepts the hot updates of the Worker's modules. These tests run
 * a small application the same way, in Vite's own module runner behind such
 * an entry, and edit its files as a developer would while `bun run dev` runs.
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { createServer, createServerModuleRunner, resolveConfig, type ViteDevServer } from 'vite'
import type { ModuleRunner } from 'vite/module-runner'
import { reloadWorkerModules } from '../src/vite.js'

declare global {
  // The modules that ran, in order, and the entry's hot updates.
  var viteFixtureLoads: Array<string>
}

const src = `${import.meta.dir}/../src`
/** Inside the repository, so the application's imports find its node_modules. Each test writes it afresh. */
const directory = `${import.meta.dir}/.generated/vite`

// The routes import their actions before the app, as the template's do.
const routesWith = (...registrations: ReadonlyArray<string>) => `
import { Effect } from 'effect'
import { greeting } from './greeting'
import { routes } from './app'

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
  // The Cloudflare plugin's Worker entry, which imports the Worker's main
  // module twice, for its default and its other exports, and accepts the hot updates.
  'entry.ts': `
import * as worker from './worker'
export * from './worker'

export default worker.default

if (import.meta.hot) import.meta.hot.accept(() => globalThis.viteFixtureLoads.push('hot update'))
`,
  // A page's module, which only the browser loads, and which takes its own hot updates.
  'page.ts': `export const title = 'Home'\n\nif (import.meta.hot) import.meta.hot.accept()\n`,
} satisfies Readonly<Record<string, string>>

let server: ViteDevServer | undefined

afterEach(() => server?.close())

/** The package's entries, as an application's node_modules holds them, each made from this repository's source. */
const entries = {
  '.': 'index', './effect': 'effect/index', './schema': 'schema', './auth': 'auth', './paths': 'paths',
  './endpoint': 'endpoint', './drizzle': 'drizzle', './cache': 'cache', './env': 'env',
} satisfies Readonly<Record<string, string>>

/** The package in the application's node_modules, which Vite pre-bundles as it does an installed dependency. */
const installedPackage = async () => {
  const at = `${directory}/node_modules/@popcomputer/web`
  const exports = Object.fromEntries(Object.entries(entries).map(([entry, file]) => [entry, `./${file}.js`]))

  // The application's own, so `@popcomputer/web` no longer names the repository the application is in.
  await Bun.write(`${directory}/package.json`, JSON.stringify({ name: 'application', type: 'module' }))
  await Bun.write(`${at}/package.json`, JSON.stringify({ name: '@popcomputer/web', type: 'module', exports }))
  await Promise.all(Object.values(entries).map((file) => Bun.write(`${at}/${file}.js`, `export * from '${src}/${file}.ts'\n`)))
}

/**
 * Starts the dev server on a fresh copy of the application, and loads its
 * Worker. `optimize` sets the Worker's environment up as the Cloudflare
 * plugin does, pre-bundling the dependencies it finds as it goes, and has the
 * application import this package from its node_modules.
 */
async function devServer(options: { readonly reload: boolean; readonly optimize?: boolean }) {
  const source = options.optimize === true
    ? { ...application, 'app.ts': application['app.ts'].replace(`${src}/index.ts`, '@popcomputer/web') }
    : application
  await Bun.$`rm -rf ${directory}`
  await Promise.all(Object.entries(source).map(([file, text]) => Bun.write(`${directory}/${file}`, text)))
  if (options.optimize === true) await installedPackage()
  globalThis.viteFixtureLoads = []

  const vite = await createServer({
    root: directory,
    // Each test's own, as each application has its node_modules/.vite.
    cacheDir: `${directory}/.vite`,
    configFile: false,
    logLevel: 'silent',
    appType: 'custom',
    plugins: options.reload ? [reloadWorkerModules()] : [],
    server: { middlewareMode: true, ws: false, watch: null },
    environments: options.optimize === true
      ? { ssr: { resolve: { noExternal: true }, optimizeDeps: { noDiscovery: false, entries: ['entry.ts'] } } }
      : {},
  })
  server = vite
  // What the module runner reports, as the dev server's terminal shows it.
  const logged: Array<string> = []
  const runner = createServerModuleRunner(vite.environments.ssr, {
    hmr: { logger: { debug: () => undefined, error: (message) => void logged.push(String(message)) } },
  })
  await runner.import('/entry.ts')

  return { vite, edit: editIn(vite), request: requestTo(runner), logged }
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

  test('a first import of another of the package’s entries loads the Worker once, without Vite re-optimising', async () => {
    const { vite, edit, request, logged } = await devServer({ reload: true, optimize: true })
    const sent = spyOn(vite.environments.ssr.hot, 'send')

    await edit('greeting.ts', `import { kvCache } from '@popcomputer/web/cache'\n\nexport const greeting = typeof kvCache\n`)

    expect(await eventually(() => request('/hello'), '200 function')).toBe('200 function')
    // Re-optimising invalidated every module the reload was loading, which ran
    // the routes a second time on the app already loaded, and then reloaded.
    expect(logged).toEqual([])
    const reloads = sent.mock.calls.map((call) => JSON.stringify(call)).filter((call) => call.includes('"full-reload"'))
    expect(reloads).toEqual([JSON.stringify([{ type: 'full-reload' }])])
  })

  test('pre-bundles each of the package’s entries a Worker imports, only where the Worker’s dependencies are pre-bundled', async () => {
    const { exports } = await Bun.file(`${import.meta.dir}/../package.json`).json()
    // A Worker's environment as the Cloudflare plugin declares it, beside Vite's own two.
    const { environments } = await resolveConfig({
      root: directory,
      configFile: false,
      logLevel: 'silent',
      plugins: [reloadWorkerModules()],
      environments: { worker: { optimizeDeps: { noDiscovery: false } } },
    }, 'serve')
    // Entries a Worker never imports, which do not bundle for one.
    const elsewhere = ['./react', './lint', './fence', './testing', './fuzz', './vite']

    expect(environments.worker.optimizeDeps.include).toEqual(
      Object.keys(exports).filter((entry) => !elsewhere.includes(entry)).map((entry) => `@popcomputer/web${entry.slice(1)}`)
    )
    expect(environments.client.optimizeDeps.include).toEqual([])
    expect(environments.ssr.optimizeDeps.include).toEqual([])
  })

  test('without it, an edit to the routes registers every route a second time, and the error names it', async () => {
    const { edit, request } = await devServer({ reload: false })

    await edit('routes.ts', routesWith(hello, bye))

    const failure = await eventually(() => request('/bye'), 'registered twice')

    expect(failure).toContain('GET /hello is registered twice')
    expect(failure).toContain("Without reloadWorkerModules() from @popcomputer/web/vite in vite.config.ts's plugins, add it.")
    // And says what to do when vite.config.ts has the plugin already, as when
    // Vite re-optimises a dependency the plugin does not pre-bundle.
    expect(failure).toContain('With it, this follows Vite\'s "optimized dependencies changed. reloading"')
    expect(failure).toContain('restart the dev server if they are not')
  })
})
