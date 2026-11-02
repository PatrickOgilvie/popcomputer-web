/**
 * Route Registry
 *
 * The route table: one row for every route an application registers, holding
 * every fact its registration states, so the application, its tests and its
 * agents can list them, and the framework derives each route's handler and
 * startup checks from its row.
 */

import type { Schema as S } from 'effect'
import type { ParsedBinding } from './binding.js'
import type { Endpoint } from '../endpoint.js'
import type { RouteCacheOptions } from './response-cache.js'

/**
 * HTTP methods supported by the router.
 */
export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'options' | 'all'

/**
 * Who may load a record a route's path names, as its binding in setupWeb's
 * `bindings` says: its owner, anyone when its columns hold these values,
 * anyone, whoever a guard lets in, or `'unsaid'` for a binding that gives
 * none, which loads any record for anyone.
 */
export type RouteModelAccess =
  | { readonly ownedBy: string }
  | { readonly publicWhen: Readonly<Record<string, unknown>> }
  | 'public'
  | 'guarded'
  | 'unsaid'

/** A record a route's path names, as its binding declares it. */
export interface RouteModelMetadata {
  /** The placeholder: 'project' in '/projects/{project}'. */
  readonly param: string
  /** The column the placeholder's value is looked up by. */
  readonly column: string
  /** The table its record is a row of: its key in the Drizzle schema, or its SQL name. */
  readonly table: string
  readonly access: RouteModelAccess
  /** Whether the record depends on who is visiting: someone's own, or under someone's own. */
  readonly personal: boolean
}

/**
 * Who a route's provided layers let reach its action: anyone, signed-in
 * visitors only (`RequireAuthLayer`), or visitors who are not signed in
 * (`RequireGuestLayer`, `createGuestLayer`).
 */
export type RouteVisitors = 'anyone' | 'signed-in' | 'guests'

/**
 * Metadata stored for each registered route. The fields after `name` are the
 * route table's other columns: the framework's registrations give them all,
 * and `register` fills a missing one with what a route without that option
 * has.
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
  /** The whole Laravel-style path, its prefix included: '/orgs/{org}/members'. */
  readonly routePath?: string
  /** The records its path names, as the bindings given to setupWeb or effectRoutes declare them. */
  readonly models?: readonly RouteModelMetadata[]
  /** Pages and redirects, or JSON whatever the client sends (`jsonApi()`, `endpoint()`). */
  readonly answers?: 'page' | 'json'
  /** Its `cache` option, or `'default'` without one. */
  readonly cache?: RouteCacheOptions | 'private' | 'no-store' | 'default'
  /**
   * Whether the default page cache may keep its pages: it has no `cache`
   * option, no placeholders, and no guard or route middleware that decides
   * before it. A page that reads request state is still not kept.
   */
  readonly pageCache?: boolean
  /** The Cache-Tags it purges once its action succeeds: `'records'` for its records' (`purges: true`). */
  readonly purges?: 'records' | readonly string[]
  /** Its `form` option: the page a failed form goes back to without a Referer. */
  readonly form?: string
  readonly visitors?: RouteVisitors
  /** How many `guard(...)` layers decide before its action. */
  readonly guards?: number
  /** How many Hono middleware run before its action. */
  readonly middleware?: number
  /** Its `params` option: the schema its placeholders are checked by. */
  readonly params?: S.Codec<unknown, unknown, never, never>
  /** The contract it implements, when registered with `endpoint()`. */
  readonly endpoint?: Endpoint
}

/** A registered route: its row of the route table, every column filled. */
export type RouteRow = RouteMetadata & Required<Pick<
  RouteMetadata,
  'routePath' | 'models' | 'answers' | 'cache' | 'pageCache' | 'purges' | 'visitors' | 'guards' | 'middleware'
>>

/**
 * JSON-serializable route metadata.
 */
export interface RouteMetadataJson {
  method: HttpMethod
  path: string
  fullPath: string
  bindings: Array<{ param: string; column: string }>
  name?: string
  routePath: string
  models: readonly RouteModelMetadata[]
  answers: 'page' | 'json'
  cache: RouteCacheOptions | 'private' | 'no-store' | 'default'
  pageCache: boolean
  purges: 'records' | readonly string[]
  /** The page a failed form goes back to without a Referer: its `form` option, or the page at its own path. */
  form?: string
  visitors: RouteVisitors
  guards: number
  middleware: number
  /** Whether it implements an endpoint contract. */
  endpoint?: true
}

/**
 * A route's row: a column its metadata leaves out holds what a route without
 * that option has, so every row reads the same way.
 */
export function routeRowOf(metadata: RouteMetadata): RouteRow {
  return Object.freeze({
    routePath: metadata.path,
    models: [],
    answers: 'page',
    cache: 'default',
    pageCache: metadata.bindings.length === 0,
    purges: [],
    visitors: 'anyone',
    guards: 0,
    middleware: 0,
    ...metadata,
  })
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
  private routes: RouteRow[] = []

  /**
   * Register a new route.
   * Called internally by EffectRouteBuilder.
   * @throws Error if a route with the same name already exists
   */
  register(metadata: RouteMetadata): RouteRow {
    if (metadata.name) {
      const existing = this.findByName(metadata.name)

      if (existing) {
        throw new Error(
          `Duplicate route name '${metadata.name}'. ` +
            `Already registered for ${existing.method.toUpperCase()} ${existing.fullPath}`
        )
      }
    }

    const row = routeRowOf(metadata)

    this.routes.push(row)

    return row
  }

  /**
   * Get all registered routes.
   */
  all(): readonly RouteRow[] {
    return this.routes
  }

  /**
   * The page a failed form on this route goes back to when the request names
   * no page of this site: its `form` option, else its own path when a page
   * is registered there.
   */
  formPageOf(route: RouteRow): string | undefined {
    if (route.form !== undefined) return route.form

    return this.routes.some((other) => other.method === 'get' && other.fullPath === route.fullPath)
      ? route.routePath
      : undefined
  }

  /**
   * Get routes filtered by criteria.
   */
  find(options: FindRouteOptions = {}): readonly RouteRow[] {
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
  findByName(name: string): RouteRow | undefined {
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
    return this.routes.map((route) => {
      const form = route.method === 'get' ? undefined : this.formPageOf(route)

      return {
        method: route.method,
        path: route.path,
        fullPath: route.fullPath,
        bindings: route.bindings.map((binding) => ({
          param: binding.param,
          column: binding.column,
        })),
        ...(route.name && { name: route.name }),
        routePath: route.routePath,
        models: route.models,
        answers: route.answers,
        cache: route.cache,
        pageCache: route.pageCache,
        purges: route.purges,
        ...(form !== undefined && { form }),
        visitors: route.visitors,
        guards: route.guards,
        middleware: route.middleware,
        ...(route.endpoint !== undefined && { endpoint: true as const }),
      }
    })
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
