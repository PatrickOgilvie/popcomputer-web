/**
 * The Vite plugin for an application whose Worker runs inside Vite's dev
 * server, as Cloudflare's Vite plugin runs it.
 *
 * @example
 * ```ts
 * // vite.config.ts
 * import { cloudflare } from '@cloudflare/vite-plugin'
 * import { defineConfig } from 'vite'
 * import { reloadWorkerModules } from '@popcomputer/web/vite'
 *
 * export default defineConfig({ plugins: [reloadWorkerModules(), cloudflare()] })
 * ```
 */

import type { Plugin } from 'vite'

/**
 * The package's entries a Worker imports. Its others run in the browser
 * (`react`), or in Node and Bun alone (`lint`, `fence`, `testing`, `fuzz`,
 * `vite`), and fail to bundle for a Worker.
 */
const WORKER_ENTRIES = ['', '/effect', '/schema', '/auth', '/paths', '/endpoint', '/drizzle', '/cache', '/env']
  .map((entry) => `@popcomputer/web${entry}`)

/**
 * The entries a Worker imports that Vite can bundle where this package is
 * installed: `@popcomputer/web/drizzle` imports drizzle-orm, an optional peer
 * the others load only when a route binding runs, so it is left out where
 * drizzle-orm does not resolve from here, as Vite would resolve it.
 */
function bundledWorkerEntries(): ReadonlyArray<string> {
  try {
    import.meta.resolve('drizzle-orm')

    return WORKER_ENTRIES
  } catch {
    return WORKER_ENTRIES.filter((entry) => entry !== '@popcomputer/web/drizzle')
  }
}

/**
 * Runs the Worker's modules afresh when one of them changes in development.
 *
 * The routes register once, when src/routes.ts runs, on the `routes` that
 * src/app.ts made. A hot update runs again only the module that changed and
 * the modules that import it, up to the Cloudflare plugin's Worker entry,
 * which accepts it: a change to an action or to src/routes.ts would run
 * src/routes.ts again on the routes already loaded, and every request would
 * then fail with "GET /login is registered twice" until the dev server
 * restarted. In place of the hot update, this sends the Worker a full reload,
 * which clears its modules and runs them all again, on a new app.
 *
 * The Worker's main module, the one the accepting entry imports, keeps the
 * hot update: it runs again alone, on the app and routes already loaded, and
 * the Cloudflare plugin restarts the dev server when what it exports changes.
 * The browser's modules update as before.
 *
 * It also pre-bundles each of the package's entries a Worker imports when the
 * dev server starts, in the Worker's environment, where the Cloudflare plugin
 * has Vite pre-bundle each dependency as the Worker first imports it. Without
 * that, an application's first import of another entry, such as
 * `@popcomputer/web/drizzle`, has Vite pre-bundle its dependencies again
 * while the Worker's modules load and invalidate every module they loaded,
 * which runs src/routes.ts a second time on the app already loaded.
 */
export function reloadWorkerModules(): Plugin {
  return {
    name: '@popcomputer/web:reload-worker-modules',
    configEnvironment(name, config) {
      // The Cloudflare plugin turns discovery on for the Worker's environment;
      // Vite's own server environment, which a Worker does not run in, has it off.
      if (name === 'client' || config.optimizeDeps?.noDiscovery !== false) return

      return { optimizeDeps: { include: [...bundledWorkerEntries()] } }
    },
    hotUpdate({ modules }) {
      // The browser's modules update as usual, and a file the Worker never
      // loaded changes nothing in it.
      if (this.environment.config.consumer === 'client' || modules.length === 0) return

      const main = modules.some((module) => [...module.importers].some((importer) => importer.isSelfAccepting === true))
      if (main) return

      this.environment.hot.send({ type: 'full-reload' })
      return []
    },
  }
}
