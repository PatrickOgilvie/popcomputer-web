/** Rendering and asset helpers for @popcomputer/web. */

import type { Context } from 'hono'
import type { PageObject } from './types.js'
import { HonertiaConfigurationError } from './effect/errors.js'

export interface PageProps {
  errors?: Record<string, string>
}

export interface AssetManifestEntry {
  file?: string
  css?: string[]
  assets?: string[]
}

export type AssetManifest = Record<string, string | AssetManifestEntry>

export interface TemplateOptions {
  title?: string
  scripts?: string[]
  styles?: string[]
  head?: string
  rootId?: string
}

/**
 * Serialize an Inertia page object for embedding in a
 * `<script type="application/json">` initial page payload.
 *
 * Escaping `/` prevents a `</script>` sequence inside JSON data from closing
 * the script element early. This mirrors the approach used by @hono/inertia
 * and Inertia's script-element initial page transport.
 */
export function serializePage(page: PageObject): string {
  return JSON.stringify(page).replace(/\//g, '\\/')
}

/**
 * Creates a template renderer function.
 * 
 * Can accept either static options or a function that receives context
 * for environment-aware configuration.
 * 
 * @example Static config
 * ```ts
 * createTemplate({ title: 'App', scripts: ['/main.js'] })
 * ```
 * 
 * @example Dynamic config based on environment
 * ```ts
 * const entry = manifest['src/main.tsx']
 * const assetPath = (path: string) => `/${path}`
 *
 * createTemplate((ctx) => ({
 *   title: 'App',
 *   scripts: ctx.env.ENVIRONMENT === 'production'
 *     ? [assetPath(entry.file)]
 *     : [vite.script()],
 *   styles: ctx.env.ENVIRONMENT === 'production'
 *     ? (entry.css ?? []).map(assetPath)
 *     : [],
 *   head: ctx.env.ENVIRONMENT === 'production' ? '' : vite.hmrHead(),
 * }))
 * ```
 */
export function createTemplate(
  options: TemplateOptions | ((ctx: Context) => TemplateOptions)
): (page: PageObject, ctx?: Context) => string {
  return (page: PageObject, ctx?: Context) => {
    // If options is a function but no context provided, throw helpful error
    if (typeof options === 'function' && !ctx) {
      throw new HonertiaConfigurationError({
        message: 'createTemplate requires context when using dynamic options function.',
        hint: 'Pass the Hono context to the render function, or use static options.',
      })
    }
    const resolvedOptions = typeof options === 'function' ? options(ctx!) : options
    
    const {
      title = 'App',
      scripts = [],
      styles = [],
      head = '',
      rootId = 'app',
    } = resolvedOptions

    const scriptTags = scripts
      .map(src => `<script type="module" src="${escapeHtml(src)}"></script>`)
      .join('\n    ')

    const styleTags = styles
      .map(href => `<link rel="stylesheet" href="${escapeHtml(href)}">`)
      .join('\n    ')

    const pageJson = serializePage(page)

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    ${styleTags}
    ${head}
  </head>
  <body>
    <script data-page="${escapeHtml(rootId)}" type="application/json">${pageJson}</script>
    <div id="${escapeHtml(rootId)}"></div>
    ${scriptTags}
  </body>
</html>`
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function createVersion(manifest: AssetManifest): string {
  const assetFiles: string[] = []

  for (const value of Object.values(manifest)) {
    if (typeof value === 'string') {
      assetFiles.push(value)
      continue
    }
    if (!value || typeof value !== 'object') {
      continue
    }
    if (typeof value.file === 'string') {
      assetFiles.push(value.file)
    }
    if (Array.isArray(value.css)) {
      assetFiles.push(...value.css)
    }
    if (Array.isArray(value.assets)) {
      assetFiles.push(...value.assets)
    }
  }

  const combined = assetFiles.sort().join('')
  let hash = 0
  for (let i = 0; i < combined.length; i++) {
    const char = combined.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return Math.abs(hash).toString(36)
}

/**
 * Vite development configuration helpers.
 */
export const vite = {
  /**
   * Returns the HMR (Hot Module Replacement) head scripts for Vite dev server.
   * 
   * @param port - Vite dev server port (default: 5173)
   * @example
   * ```ts
   * head: isProd ? '' : vite.hmrHead()
   * ```
   */
  hmrHead(port = 5173): string {
    return `
      <script type="module">
        import RefreshRuntime from 'http://localhost:${port}/@react-refresh'
        RefreshRuntime.injectIntoGlobalHook(window)
        window.$RefreshReg$ = () => {}
        window.$RefreshSig$ = () => (type) => type
        window.__vite_plugin_react_preamble_installed__ = true
      </script>
      <script type="module" src="http://localhost:${port}/@vite/client"></script>
    `
  },

  /**
   * Returns the main entry script URL for Vite dev server.
   * 
   * @param entry - Entry file path (default: '/src/main.tsx')
   * @param port - Vite dev server port (default: 5173)
   * @example
   * ```ts
   * scripts: isProd ? [manifest['src/main.tsx'].file] : [vite.script()]
   * ```
   */
  script(entry = '/src/main.tsx', port = 5173): string {
    return `http://localhost:${port}${entry}`
  },
}
