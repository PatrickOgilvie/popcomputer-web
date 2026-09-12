/**
 * Route Registry
 *
 * Stores route metadata for introspection, CLI tooling, and test generation.
 * Enables `honertia routes` command and `describeRoute()` test helper.
 */

import type { Schema as S } from 'effect'
import * as SchemaAST from 'effect/SchemaAST'
import type { ParsedBinding } from './binding.js'

/**
 * HTTP methods supported by the router.
 */
export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'all'

export interface RoutesByMethod {
  get: readonly RouteMetadata[]
  post: readonly RouteMetadata[]
  put: readonly RouteMetadata[]
  patch: readonly RouteMetadata[]
  delete: readonly RouteMetadata[]
  all: readonly RouteMetadata[]
}

export interface RoutesByPrefix {
  [prefix: string]: readonly RouteMetadata[]
}

function getSchemaMetadata(schema: S.Top): SchemaMetadata | undefined {
  const identifier = SchemaAST.resolveIdentifier(schema.ast)
  const title = SchemaAST.resolveTitle(schema.ast)
  const description = SchemaAST.resolveDescription(schema.ast)

  if (!identifier && !title && !description) return undefined

  return {
    ...(identifier && { identifier }),
    ...(title && { title }),
    ...(description && { description }),
  }
}

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
  /** Route params validation schema (if configured) */
  readonly paramsSchema?: S.Top
  /** Route body validation schema (if configured) */
  readonly bodySchema?: S.Top
  /** Route query validation schema (if configured) */
  readonly querySchema?: S.Top
  /** Route response schema (if configured) */
  readonly responseSchema?: S.Top
  /** Path prefix applied to this route */
  readonly prefix: string
  /** Optional route name for named routes */
  readonly name?: string
  /** Handler name extracted from function (if available) */
  readonly handlerName?: string
  /** File location where route was registered (if captured) */
  readonly sourceLocation?: {
    readonly file: string
    readonly line: number
  }
}

/**
 * Safe schema metadata for CLI output.
 * Avoids exposing full schema shape outside explicit generators.
 */
export interface SchemaMetadata {
  identifier?: string
  title?: string
  description?: string
}

/**
 * JSON-serializable route metadata for CLI output.
 */
export interface RouteMetadataJson {
  method: HttpMethod
  path: string
  honoPath: string
  fullPath: string
  bindings: Array<{ param: string; column: string }>
  hasParamsSchema: boolean
  hasBodySchema: boolean
  hasQuerySchema: boolean
  hasResponseSchema: boolean
  paramsSchema?: SchemaMetadata
  bodySchema?: SchemaMetadata
  querySchema?: SchemaMetadata
  responseSchema?: SchemaMetadata
  prefix: string
  name?: string
  handlerName?: string
  sourceLocation?: { file: string; line: number }
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
  /** Match path pattern (supports wildcards) */
  pathPattern?: string
}

/**
 * Route Registry for storing and querying route metadata.
 *
 * @example
 * ```typescript
 * const registry = new RouteRegistry()
 *
 * // Register routes with the registry
 * effectRoutes(app, { registry })
 *   .get('/projects/{project}', showProject)
 *
 * // Query routes for CLI output
 * registry.all() // => RouteMetadata[]
 * registry.toJson() // => RouteMetadataJson[]
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
    return this.routes.filter((route) => {
      if (options.method && route.method !== options.method) return false

      if (options.prefix && !route.fullPath.startsWith(options.prefix)) return false

      if (options.name && route.name !== options.name) return false

      if (options.pathPattern) {
        try {
          const pattern = options.pathPattern
            .replace(/\*/g, '.*')
            .replace(/\{[^}]+\}/g, '[^/]+')

          const regex = new RegExp(`^${pattern}$`)

          if (!regex.test(route.fullPath)) return false
        } catch {
          // Invalid regex pattern, skip matching
          return false
        }
      }

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
   * Find a route by exact path and method.
   */
  findByPathAndMethod(path: string, method: HttpMethod): RouteMetadata | undefined {
    return this.routes.find(
      (route) => route.fullPath === path && route.method === method
    )
  }

  /**
   * Get routes grouped by method.
   */
  byMethod(): RoutesByMethod {
    const grouped = {
      get: new Array<RouteMetadata>(),
      post: new Array<RouteMetadata>(),
      put: new Array<RouteMetadata>(),
      patch: new Array<RouteMetadata>(),
      delete: new Array<RouteMetadata>(),
      all: new Array<RouteMetadata>(),
    } satisfies Record<HttpMethod, RouteMetadata[]>

    for (const route of this.routes) {
      grouped[route.method].push(route)
    }

    return grouped
  }

  /**
   * Get routes grouped by prefix.
   */
  byPrefix(): RoutesByPrefix {
    const grouped: Record<string, RouteMetadata[]> = {}

    for (const route of this.routes) {
      const prefix = route.prefix || '/'

      if (!grouped[prefix]) grouped[prefix] = []
      grouped[prefix].push(route)
    }

    return grouped
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
   * Clear all registered routes.
   * Useful for testing.
   */
  clear(): void {
    this.routes = []
  }

  /**
   * Convert all routes to JSON-serializable format.
   * Used by `honertia routes --json` CLI command.
   */
  toJson(): RouteMetadataJson[] {
    return this.routes.map((route) => {
      const paramsSchema = route.paramsSchema
        ? getSchemaMetadata(route.paramsSchema)
        : undefined

      const bodySchema = route.bodySchema ? getSchemaMetadata(route.bodySchema) : undefined
      const querySchema = route.querySchema ? getSchemaMetadata(route.querySchema) : undefined

      const responseSchema = route.responseSchema
        ? getSchemaMetadata(route.responseSchema)
        : undefined

      return {
        ...(paramsSchema && { paramsSchema }),
        ...(bodySchema && { bodySchema }),
        ...(querySchema && { querySchema }),
        ...(responseSchema && { responseSchema }),
      method: route.method,
      path: route.path,
      honoPath: route.honoPath,
      fullPath: route.fullPath,
      bindings: route.bindings.map((b) => ({ param: b.param, column: b.column })),
      hasParamsSchema: route.paramsSchema !== undefined,
      hasBodySchema: route.bodySchema !== undefined,
      hasQuerySchema: route.querySchema !== undefined,
      hasResponseSchema: route.responseSchema !== undefined,
      prefix: route.prefix,
      ...(route.name && { name: route.name }),
      ...(route.handlerName && { handlerName: route.handlerName }),
      ...(route.sourceLocation && { sourceLocation: route.sourceLocation }),
      }
    })
  }

  /**
   * Format routes as a table string for CLI display.
   */
  toTable(): string {
    if (this.routes.length === 0) {
      return 'No routes registered.'
    }

    // Calculate column widths
    const methodWidth = Math.max(6, ...this.routes.map((r) => r.method.length))
    const pathWidth = Math.max(4, ...this.routes.map((r) => r.fullPath.length))
    const nameWidth = Math.max(4, ...this.routes.map((r) => r.name?.length ?? 0))

    const lines: string[] = []

    // Header
    const header = [
      'METHOD'.padEnd(methodWidth),
      'PATH'.padEnd(pathWidth),
      nameWidth > 4 ? 'NAME'.padEnd(nameWidth) : null,
      'BINDINGS',
    ]
      .filter((segment) => segment !== null && segment.length > 0)
      .join('  ')

    lines.push(header)
    lines.push('-'.repeat(header.length))

    // Routes
    for (const route of this.routes) {
      const bindings =
        route.bindings.length > 0
          ? route.bindings.map((b) => `{${b.param}:${b.column}}`).join(', ')
          : '-'

      const row = [
        route.method.toUpperCase().padEnd(methodWidth),
        route.fullPath.padEnd(pathWidth),
        nameWidth > 4 ? (route.name ?? '').padEnd(nameWidth) : null,
        bindings,
      ]
        .filter((segment) => segment !== null && segment.length > 0)
        .join('  ')

      lines.push(row)
    }

    return lines.join('\n')
  }
}

/**
 * Global route registry instance.
 * Used when no custom registry is provided to effectRoutes().
 */
let globalRegistry: RouteRegistry | null = null

const appRegistries = new WeakMap<object, RouteRegistry>()

/** Get the registry owned by one Hono application. */
export function getAppRouteRegistry<App extends object>(app: App): RouteRegistry {
  const existing = appRegistries.get(app)

  if (existing) return existing

  const registry = new RouteRegistry()
  appRegistries.set(app, registry)

  return registry
}

/** Read an application's registry without creating one. */
export function findAppRouteRegistry<App extends object>(app: App): RouteRegistry | undefined {
  return appRegistries.get(app)
}

/**
 * Get the global route registry.
 * Creates one if it doesn't exist.
 */
export function getGlobalRegistry(): RouteRegistry {
  globalRegistry ??= new RouteRegistry()

  return globalRegistry
}

/**
 * Reset the global registry.
 * Useful for testing.
 */
export function resetGlobalRegistry(): void {
  globalRegistry = null
}
