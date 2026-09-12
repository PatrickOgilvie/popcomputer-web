/* oxlint-disable effecttsgo/node-builtin-import -- This CLI adapter owns native Node/Bun IO and raw command output; preserve the stdout/stderr format. */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  findAppRouteRegistry,
  RouteRegistry,
} from '../effect/route-registry.js'

function isObjectLike<Value>(value: Value): value is Value & object {
  return value !== null && Object(value) === value
}

function registryFromExport<Value>(value: Value): RouteRegistry | undefined {
  if (value instanceof RouteRegistry) return value

  if (!isObjectLike(value)) return undefined

  const direct = findAppRouteRegistry(value)

  if (direct) return direct

  if ('routes' in value && value.routes instanceof RouteRegistry) {
    return value.routes
  }

  if ('app' in value && isObjectLike(value.app)) {
    return findAppRouteRegistry(value.app)
  }

  return undefined
}

/** Load an application module and return its app-owned route registry. */
// oxlint-disable-next-line effecttsgo/async-function -- Node/tsx module loading owns native import and loader-cleanup Promises at the CLI boundary.
export async function loadAppRouteRegistry(appPath: string): Promise<RouteRegistry> {
  const absolutePath = resolve(appPath)
  let unregisterTypeScriptLoader: (() => Promise<void>) | undefined

  if (!('Bun' in globalThis)) {
    const { register } = await import('tsx/esm/api')
    unregisterTypeScriptLoader = register()
  }

  let applicationModule: unknown

  try {
    applicationModule = await import(pathToFileURL(absolutePath).href)
  } finally {
    await unregisterTypeScriptLoader?.()
  }

  if (!isObjectLike(applicationModule)) {
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
