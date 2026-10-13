/**
 * Route Registry
 *
 * Records every route an application registers, so the application, its
 * tests and its agents can list them.
 */

import type { ParsedBinding } from './binding.js'

/**
 * HTTP methods supported by the router.
 */
export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'all'

/**
 * Metadata stored for each registered route.
 */
export interface RouteMetadata {
  /** HTTP method */
  readonly method: HttpMethod
  /** Original Laravel-style path (e.g., '/projects/{project}') */
  readonly path: string
  /** Converted Hono-style path (e.g., '/projects/:project') */
  readonly honoPath: string
  /** Full path including prefix */
  readonly fullPath: string
  /** Parsed route model bindings */
  readonly bindings: readonly ParsedBinding[]
  /** Path prefix applied to this route */
  readonly prefix: string
  /** Optional route name for named routes */
  readonly name?: string
}

/**
 * JSON-serializable route metadata.
 */
export interface RouteMetadataJson {
  method: HttpMethod
  path: string
  fullPath: string
  bindings: Array<{ param: string; column: string }>
  name?: string
}

/**
 * Options for finding routes.
 */
export interface FindRouteOptions {
  /** Filter by HTTP method */
  method?: HttpMethod
  /** Filter by path prefix */
  prefix?: string
  /** Filter by route name */
  name?: string
  /** Match path pattern (`*` matches anything, `{param}` one segment) */
  pathPattern?: string
}

/**
 * The routes registered on one application.
 *
 * @example
 * ```typescript
 * const { routes } = setupWeb(app, config)
 *
 * routes.toJson() // => [{ method: 'get', fullPath: '/projects/:project', ... }]
 * routes.findByName('projects.show')
 * ```
 */
export class RouteRegistry {
  private routes: RouteMetadata[] = []

  /**
   * Register a new route.
   * Called internally by EffectRouteBuilder.
   * @throws Error if a route with the same name already exists
   */
  register(metadata: RouteMetadata): void {
    if (metadata.name) {
      const existing = this.findByName(metadata.name)

      if (existing) {
        throw new Error(
          `Duplicate route name '${metadata.name}'. ` +
            `Already registered for ${existing.method.toUpperCase()} ${existing.fullPath}`
        )
      }
    }

    this.routes.push(metadata)
  }

  /**
   * Get all registered routes.
   */
  all(): readonly RouteMetadata[] {
    return this.routes
  }

  /**
   * Get routes filtered by criteria.
   */
  find(options: FindRouteOptions = {}): readonly RouteMetadata[] {
    const pattern = options.pathPattern === undefined
      ? undefined
      : new RegExp(
          `^${options.pathPattern
            .replace(/[.+?^$()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\{[^}]+\}/g, '[^/]+')}$`
        )

    return this.routes.filter((route) => {
      if (options.method && route.method !== options.method) return false

      if (options.prefix && !route.fullPath.startsWith(options.prefix)) return false

      if (options.name && route.name !== options.name) return false

      if (pattern && !pattern.test(route.fullPath)) return false

      return true
    })
  }

  /**
   * Find a route by name.
   */
  findByName(name: string): RouteMetadata | undefined {
    return this.routes.find((route) => route.name === name)
  }

  /**
   * Get total count of registered routes.
   */
  count(): number {
    return this.routes.length
  }

  /**
   * Check if a route exists.
   */
  has(path: string, method?: HttpMethod): boolean {
    return this.routes.some(
      (route) =>
        route.fullPath === path && (method === undefined || route.method === method)
    )
  }

  /**
   * Convert all routes to JSON-serializable format.
   */
  toJson(): RouteMetadataJson[] {
    return this.routes.map((route) => ({
      method: route.method,
      path: route.path,
      fullPath: route.fullPath,
      bindings: route.bindings.map((binding) => ({
        param: binding.param,
        column: binding.column,
      })),
      ...(route.name && { name: route.name }),
    }))
  }
}

const appRegistries = new WeakMap<object, RouteRegistry>()

/** Get the registry owned by one Hono application. */
export function getAppRouteRegistry<App extends object>(app: App): RouteRegistry {
  const existing = appRegistries.get(app)

  if (existing) return existing

  const registry = new RouteRegistry()
  appRegistries.set(app, registry)

  return registry
}
