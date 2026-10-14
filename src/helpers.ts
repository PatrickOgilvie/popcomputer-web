/** Rendering and asset helpers for @popcomputer/web. */

import type { Context } from 'hono'
import { Schema as S } from 'effect'
import type { PageObject } from './types.js'
import { ConfigurationError } from './effect/errors.js'

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
 * The script `createTemplate` puts first in every page's head.
 *
 * A deploy replaces the application's built scripts and stylesheets, whose
 * names carry their content's hash. For a few seconds after `wrangler
 * deploy`, the previous version can still answer at some edge locations,
 * with a page naming the previous build's files, which the new deploy no
 * longer serves: without them the page stays blank. The script reloads the
 * page when one of the template's own scripts or stylesheets
 * (`data-popweb-asset`) fails to load, or a chunk Vite loads does
 * (`vite:preloadError`), so the next request gets the new deploy's page. It
 * reloads at once, then after 2 and 4 seconds, and no more than three times
 * a minute in a tab, so a file missing for another reason never reloads the
 * page in a loop; where it cannot count, in a browser without
 * `sessionStorage`, it never reloads.
 */
export const ASSET_RELOAD_SCRIPT =
  "(()=>{let pending=false;const reload=()=>{if(pending)return true;try{const now=Date.now();const stored=JSON.parse(sessionStorage.getItem('popweb:reloads')||'[]');const recent=Array.isArray(stored)?stored.filter((at)=>now-at<60000):[];if(recent.length>=3)return false;sessionStorage.setItem('popweb:reloads',JSON.stringify([...recent,now]));setTimeout(()=>location.reload(),recent.length*2000);return pending=true}catch{return false}};addEventListener('vite:preloadError',(event)=>{if(reload())event.preventDefault()});addEventListener('error',(event)=>{if(event.target instanceof Element&&event.target.hasAttribute('data-popweb-asset'))reload()},true)})()"

/**
 * The Content-Security-Policy source that allows the script `createTemplate`
 * inlines in every page: an application that sends its own `script-src` adds
 * it, as in `script-src 'self' ${TEMPLATE_SCRIPT_HASH}`. Without it, the
 * browser refuses the script and a page loaded during a deploy stays blank.
 */
export const TEMPLATE_SCRIPT_HASH = "'sha256-IDbte3Rzc2LSWWO5xmHTv9h/7f/zz8VToylr2k7C4Sg='"

/** The characters escaped in page data, as JSON's own `\\u` escapes, which `JSON.parse` reads back. */
const SCRIPT_UNSAFE: Readonly<Record<string, string>> = {
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
}

/**
 * Serialize an Inertia page object for embedding in a
 * `<script type="application/json">` initial page payload.
 *
 * Every `<`, `>` and `&` in the data is written as a JSON `\\u` escape, so no
 * value a visitor wrote can form markup the HTML parser acts on inside the
 * script element: not a `</script>` that would close it early, nor a `<!--`
 * and `<script` that would make the parser read past its real end and take
 * the rest of the page with it.
 */
export function serializePage(page: PageObject): string {
  return JSON.stringify(page).replace(/[<>&\u2028\u2029]/g, (character) => SCRIPT_UNSAFE[character] ?? character)
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
    let resolvedOptions: TemplateOptions

    if (options instanceof Function) {
      if (!ctx) {
        throw new ConfigurationError({
          message: 'createTemplate requires context when using dynamic options function.',
          hint: 'Pass the Hono context to the render function, or use static options.',
        })
      }

      resolvedOptions = options(ctx)
    } else {
      resolvedOptions = options
    }
    
    const {
      title = 'App',
      scripts = [],
      styles = [],
      head = '',
      rootId = 'app',
    } = resolvedOptions

    // Marked, so the inlined script reloads the page when one fails to load.
    const scriptTags = scripts
      .map(src => `<script type="module" src="${escapeHtml(src)}" data-popweb-asset></script>`)
      .join('\n    ')

    const styleTags = styles
      .map(href => `<link rel="stylesheet" href="${escapeHtml(href)}" data-popweb-asset>`)
      .join('\n    ')

    const pageJson = serializePage(page)

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <script>${ASSET_RELOAD_SCRIPT}</script>
    <title inertia>${escapeHtml(title)}</title>
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
    if (S.is(S.String)(value)) {
      assetFiles.push(value)
      continue
    }

    if (value.file !== undefined) {
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
 * Where the Vite dev server listens: a port on `localhost`, or an exact
 * HTTP(S) origin such as `https://vite.myapp.localhost` when a local proxy
 * (for example portless) serves Vite under its own hostname.
 */
export type ViteDevServer = number | string | URL

const DEFAULT_VITE_PORT = 5173

const VitePort = S.Int.check(S.isBetween({ minimum: 1, maximum: 65_535 }))

function viteOrigin(server: ViteDevServer): string {
  if (S.is(S.Number)(server)) {
    if (!S.is(VitePort)(server)) {
      throw new ConfigurationError({
        message: `Vite dev server port must be an integer from 1 to 65535, received ${String(server)}.`,
        hint: 'vite.script(\'/src/main.tsx\', 5173)',
      })
    }
    return `http://localhost:${server}`
  }

  let url: URL
  try {
    url = new URL(server)
  } catch {
    throw new ConfigurationError({
      message: 'Vite dev server origin must be an absolute HTTP(S) URL.',
      hint: "vite.script('/src/main.tsx', 'https://vite.myapp.localhost')",
    })
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigurationError({
      message: `Vite dev server origin must use http or https, received ${url.protocol}`,
      hint: "vite.script('/src/main.tsx', 'https://vite.myapp.localhost')",
    })
  }

  return url.origin
}

function viteAssetUrl(path: string, server: ViteDevServer): string {
  return new URL(path, viteOrigin(server)).href
}

/**
 * Vite development configuration helpers.
 */
export const vite = {
  /**
   * Returns the HMR (Hot Module Replacement) head scripts for Vite dev server.
   *
   * @param server - Vite dev server port, or its origin (default: 5173)
   * @example
   * ```ts
   * head: isProd ? '' : vite.hmrHead()
   * head: isProd ? '' : vite.hmrHead('https://vite.myapp.localhost')
   * ```
   */
  hmrHead(server: ViteDevServer = DEFAULT_VITE_PORT): string {
    const refreshRuntime = JSON.stringify(viteAssetUrl('/@react-refresh', server))
    const client = escapeHtml(viteAssetUrl('/@vite/client', server))

    return `
      <script type="module">
        import RefreshRuntime from ${refreshRuntime}
        RefreshRuntime.injectIntoGlobalHook(window)
        window.$RefreshReg$ = () => {}
        window.$RefreshSig$ = () => (type) => type
        window.__vite_plugin_react_preamble_installed__ = true
      </script>
      <script type="module" src="${client}"></script>
    `
  },

  /**
   * Returns the main entry script URL for Vite dev server.
   *
   * @param entry - Entry file path (default: '/src/main.tsx')
   * @param server - Vite dev server port, or its origin (default: 5173)
   * @example
   * ```ts
   * scripts: isProd ? [manifest['src/main.tsx'].file] : [vite.script()]
   * scripts: [vite.script('/src/main.tsx', 'https://vite.myapp.localhost')]
   * ```
   */
  script(entry = '/src/main.tsx', server: ViteDevServer = DEFAULT_VITE_PORT): string {
    return viteAssetUrl(entry, server)
  },
}
