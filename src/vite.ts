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
 */
export function reloadWorkerModules(): Plugin {
  return {
    name: '@popcomputer/web:reload-worker-modules',
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
