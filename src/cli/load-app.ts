import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  findAppRouteRegistry,
  RouteRegistry,
} from '../effect/route-registry.js'

function registryFromExport(value: unknown): RouteRegistry | undefined {
  if (value instanceof RouteRegistry) return value
  if (typeof value !== 'object' || value === null) return undefined

  const direct = findAppRouteRegistry(value)
  if (direct) return direct

  if ('routes' in value && value.routes instanceof RouteRegistry) {
    return value.routes
  }
  if ('app' in value && typeof value.app === 'object' && value.app !== null) {
    return findAppRouteRegistry(value.app)
  }
  return undefined
}

/** Load an application module and return its app-owned route registry. */
export async function loadAppRouteRegistry(appPath: string): Promise<RouteRegistry> {
  const absolutePath = resolve(appPath)
  let unregisterTypeScriptLoader: (() => Promise<void>) | undefined

  if (typeof Bun === 'undefined') {
    const { register } = await import('tsx/esm/api')
    unregisterTypeScriptLoader = register()
  }

  let applicationModule: unknown
  try {
    applicationModule = await import(pathToFileURL(absolutePath).href)
  } finally {
    await unregisterTypeScriptLoader?.()
  }

  if (typeof applicationModule !== 'object' || applicationModule === null) {
    throw new Error(`Application module "${appPath}" has no exports.`)
  }

  for (const value of Object.values(applicationModule)) {
    const registry = registryFromExport(value)
    if (registry) return registry
  }

  throw new Error(
    `Application module "${appPath}" did not export a configured Hono app, web application, or RouteRegistry.`
  )
}
