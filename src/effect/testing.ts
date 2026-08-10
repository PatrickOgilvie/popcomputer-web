/**
 * Effect Testing Utilities
 *
 * Test helpers for integration testing Effect-based routes.
 * Enables `describeRoute()` pattern for real route testing.
 *
 * NOTE: This module uses lazy loading for 'bun:test' to avoid
 * bundling issues when deploying to Cloudflare Workers.
 */

import { Layer } from 'effect'

// Lazy-loaded bun:test exports (only loaded when tests actually run)
// Using a computed module name to prevent bundlers from statically analyzing this
let _bunTestModule: typeof import('bun:test') | null = null

function getBunTestSync(): typeof import('bun:test') {
  if (!_bunTestModule) {
    // Compute module name to prevent static analysis by bundlers
    const modName = ['bun', 'test'].join(':')
    // Use require for synchronous loading (available in Bun)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _bunTestModule = require(modName)
  }
  return _bunTestModule!
}
import type { Hono, Env } from 'hono'
import {
  RouteRegistry,
  getAppRouteRegistry,
  type RouteMetadata,
} from './route-registry.js'
import type { TestCaptures } from './test-layers.js'

/**
 * User types for authentication in tests.
 */
export type TestUserType = 'guest' | 'user' | 'admin'

/**
 * User object for custom authentication.
 */
export interface TestUser {
  id: string
  email?: string
  role?: string
  [key: string]: unknown
}

/**
 * Request options for a test case.
 */
export interface TestRequestOptions {
  /**
   * Authentication context.
   * - 'guest': No authentication
   * - 'user': Authenticate as standard user
   * - 'admin': Authenticate as admin user
   * - TestUser object: Custom user
   */
  as?: TestUserType | TestUser
  /**
   * Request body (JSON or FormData).
   */
  body?: Record<string, unknown> | FormData
  /**
   * Query string parameters.
   */
  query?: Record<string, string>
  /**
   * Additional request headers.
   */
  headers?: Record<string, string>
  /**
   * Route parameters (for parameterized routes).
   */
  params?: Record<string, string>
}

/**
 * Expected response for assertions.
 */
export interface TestExpectation {
  /**
   * Expected HTTP status code.
   */
  status?: number
  /**
   * Expected response headers (partial match).
   */
  headers?: Record<string, string | RegExp>
  /**
   * Expected JSON body (deep equality).
   */
  body?: unknown
  /**
   * Expected validation errors.
   */
  errors?: Record<string, string | string[]>
  /**
   * Expected Inertia props (partial match).
   */
  props?: Record<string, unknown>
  /**
   * Expected Inertia component name.
   */
  component?: string
}

/**
 * Context provided to custom assertions.
 */
export interface TestContext {
  /**
   * The response object.
   */
  response: Response
  /**
   * Parsed JSON body (if available).
   */
  json?: unknown
  /**
   * The authenticated user (if any).
   */
  user?: TestUser
  /**
   * Database client (if configured).
   */
  db?: unknown
  /**
   * Captured test data (emails, logs, events).
   */
  captured: TestCaptures
}

/**
 * Full test case options.
 */
export interface TestCaseOptions extends TestRequestOptions {
  /**
   * Expected response assertions.
   */
  expect?: TestExpectation
  /**
   * Custom assertion function.
   */
  assert?: (ctx: TestContext) => void | Promise<void>
}

/**
 * Test function signature.
 */
export type TestFn = (name: string, options: TestCaseOptions) => void

/**
 * Configuration for test app creation.
 */
export interface TestAppConfig<E extends Env = Env> {
  /**
   * Custom user factory for creating test users.
   */
  userFactory?: (type: TestUserType) => TestUser
  /**
   * Middleware to apply authentication.
   */
  authMiddleware?: (user: TestUser | null) => (c: any, next: () => Promise<void>) => Promise<void>
  /**
   * Database setup function (called before each test).
   */
  setupDatabase?: () => Promise<unknown>
  /**
   * Database cleanup function (called after each test).
   */
  cleanupDatabase?: (db: unknown) => Promise<void>
}

/**
 * Default user factory.
 */
function defaultUserFactory(type: TestUserType): TestUser {
  switch (type) {
    case 'user':
      return { id: 'test-user-1', email: 'user@test.com', role: 'user' }
    case 'admin':
      return { id: 'test-admin-1', email: 'admin@test.com', role: 'admin' }
    case 'guest':
    default:
      return { id: 'guest', role: 'guest' }
  }
}

const createEmptyCaptures = (): TestCaptures => ({
  emails: [],
  logs: [],
  events: [],
})

/**
 * Build the request URL with params and query.
 */
function buildUrl(
  route: RouteMetadata,
  params?: Record<string, string>,
  query?: Record<string, string>
): string {
  let path = route.fullPath

  // Replace route params
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      path = path.replace(`:${key}`, value)
    }
  }

  // Add query string
  if (query && Object.keys(query).length > 0) {
    const searchParams = new URLSearchParams(query)
    path = `${path}?${searchParams.toString()}`
  }

  return path
}

/**
 * Create a test function for a route.
 */
function createTestFn<E extends Env>(
  app: Hono<E>,
  route: RouteMetadata,
  config: TestAppConfig<E>,
  testLayer?: Layer.Layer<any, never, never>
): TestFn {
  const { test, expect: expectBun } = getBunTestSync()
  return (name: string, options: TestCaseOptions) => {
    test(name, async () => {
      // Setup database if configured
      let db: unknown
      if (config.setupDatabase) {
        db = await config.setupDatabase()
      }

      try {
        // Resolve user
        let user: TestUser | null = null
        if (options.as) {
          if (typeof options.as === 'string') {
            user = options.as === 'guest' ? null : (config.userFactory ?? defaultUserFactory)(options.as)
          } else {
            user = options.as
          }
        }

        // Build request
        const url = buildUrl(route, options.params, options.query)
        const method = route.method.toUpperCase()

        const headers: Record<string, string> = {
          'Accept': 'application/json',
          ...options.headers,
        }

        // Apply auth middleware by adding user info to headers
        // The actual auth handling depends on app configuration
        if (user && config.authMiddleware) {
          // For testing, we encode user info in a header that the middleware can decode
          headers['X-Test-User'] = JSON.stringify(user)
        }

        let body: BodyInit | undefined
        if (options.body) {
          if (options.body instanceof FormData) {
            body = options.body
          } else {
            headers['Content-Type'] = 'application/json'
            body = JSON.stringify(options.body)
          }
        }

        // Make request
        const env = testLayer ? ({ __testLayer: testLayer } as unknown as E) : undefined
        const response = await app.request(url, {
          method,
          headers,
          body,
        }, env)

        // Parse response
        let json: unknown
        const contentType = response.headers.get('Content-Type') ?? ''
        if (contentType.includes('application/json')) {
          try {
            json = await response.clone().json()
          } catch {
            // Not valid JSON
          }
        }

        // Create context
        const captured =
          ((response as any).__testCaptured as TestCaptures | undefined) ??
          createEmptyCaptures()
        const ctx: TestContext = {
          response,
          json,
          user: user ?? undefined,
          db,
          captured,
        }

        // Run assertions
        if (options.expect) {
          const exp = options.expect

          if (exp.status !== undefined) {
            expectBun(response.status).toBe(exp.status)
          }

          if (exp.headers) {
            for (const [key, value] of Object.entries(exp.headers)) {
              const actual = response.headers.get(key)
              if (value instanceof RegExp) {
                expectBun(actual).toMatch(value)
              } else {
                expectBun(actual).toBe(value)
              }
            }
          }

          if (exp.body !== undefined) {
            expectBun(json).toEqual(exp.body)
          }

          if (exp.errors) {
            // Check for validation errors in response
            const errorBody = json as { errors?: Record<string, unknown> } | undefined
            expectBun(errorBody?.errors).toBeDefined()
            for (const [field, expectedError] of Object.entries(exp.errors)) {
              const fieldErrors = errorBody?.errors?.[field]
              if (Array.isArray(expectedError)) {
                expectBun(fieldErrors).toEqual(expectedError)
              } else {
                // Check if the error message contains the expected string
                if (Array.isArray(fieldErrors)) {
                  expectBun(fieldErrors.some((e: string) => e.includes(expectedError))).toBe(true)
                } else {
                  expectBun(String(fieldErrors)).toContain(expectedError)
                }
              }
            }
          }

          if (exp.props || exp.component) {
            // Parse Inertia response
            const inertiaBody = json as { component?: string; props?: Record<string, unknown> } | undefined
            if (exp.component) {
              expectBun(inertiaBody?.component).toBe(exp.component)
            }
            if (exp.props) {
              for (const [key, value] of Object.entries(exp.props)) {
                expectBun(inertiaBody?.props?.[key]).toEqual(value)
              }
            }
          }
        }

        // Run custom assertions
        if (options.assert) {
          await options.assert(ctx)
        }
      } finally {
        // Cleanup database if configured
        if (config.cleanupDatabase && db !== undefined) {
          await config.cleanupDatabase(db)
        }
      }
    })
  }
}

/**
 * Describe a route for integration testing.
 *
 * @example
 * ```typescript
 * import { describeRoute, createTestApp } from '@popcomputer/web/test'
 *
 * const app = createTestApp((routes) => {
 *   routes.post('/projects', createProject, { name: 'projects.create' })
 * })
 *
 * describeRoute('projects.create', app, (test) => {
 *   test('requires authentication', {
 *     body: { name: 'Test' },
 *     expect: { status: 302 },
 *   })
 *
 *   test('validates required fields', {
 *     as: 'user',
 *     body: {},
 *     expect: { status: 422, errors: { name: 'required' } },
 *   })
 *
 *   test('creates project with valid data', {
 *     as: 'user',
 *     body: { name: 'Test Project' },
 *     expect: { status: 200 },
 *     assert: async (ctx) => {
 *       expect(ctx.json.project.name).toBe('Test Project')
 *     },
 *   })
 * })
 * ```
 */
export function describeRoute<E extends Env>(
  routeName: string,
  app: Hono<E>,
  callback: (test: TestFn) => void,
  config?: TestAppConfig<E>
): void
export function describeRoute<E extends Env>(
  routeName: string,
  app: Hono<E>,
  testLayer: Layer.Layer<any, never, never>,
  callback: (test: TestFn) => void,
  config?: TestAppConfig<E>
): void
export function describeRoute<E extends Env>(
  routeName: string,
  app: Hono<E>,
  registry: RouteRegistry,
  callback: (test: TestFn) => void,
  config?: TestAppConfig<E>
): void
export function describeRoute<E extends Env>(
  routeName: string,
  app: Hono<E>,
  registry: RouteRegistry,
  testLayer: Layer.Layer<any, never, never>,
  callback: (test: TestFn) => void,
  config?: TestAppConfig<E>
): void
export function describeRoute<E extends Env>(
  routeName: string,
  app: Hono<E>,
  registryOrLayerOrCallback:
    | RouteRegistry
    | Layer.Layer<any, never, never>
    | ((test: TestFn) => void),
  layerOrCallbackOrConfig?:
    | Layer.Layer<any, never, never>
    | ((test: TestFn) => void)
    | TestAppConfig<E>,
  callbackOrConfig?: ((test: TestFn) => void) | TestAppConfig<E>,
  maybeConfig?: TestAppConfig<E>
): void {
  // Handle overloads
  let registry: RouteRegistry
  let testLayer: Layer.Layer<any, never, never> | undefined
  let callback: (test: TestFn) => void
  let config: TestAppConfig<E>

  if (registryOrLayerOrCallback instanceof RouteRegistry) {
    registry = registryOrLayerOrCallback
    if (Layer.isLayer(layerOrCallbackOrConfig)) {
      testLayer = layerOrCallbackOrConfig
      callback = callbackOrConfig as (test: TestFn) => void
      config = maybeConfig ?? {}
    } else {
      callback = layerOrCallbackOrConfig as (test: TestFn) => void
      config = (callbackOrConfig as TestAppConfig<E>) ?? {}
    }
  } else if (Layer.isLayer(registryOrLayerOrCallback)) {
    registry = getAppRouteRegistry(app)
    testLayer = registryOrLayerOrCallback
    callback = layerOrCallbackOrConfig as (test: TestFn) => void
    config = (callbackOrConfig as TestAppConfig<E>) ?? {}
  } else {
    registry = getAppRouteRegistry(app)
    callback = registryOrLayerOrCallback
    config = (layerOrCallbackOrConfig as TestAppConfig<E>) ?? {}
  }

  // Find route in registry
  const route = registry.findByName(routeName)

  if (!route) {
    throw new Error(
      `Route '${routeName}' not found in registry. Available routes: ${registry
        .all()
        .map((r) => r.name)
        .filter(Boolean)
        .join(', ') || '(none)'}`
    )
  }

  // Create describe block
  const { describe } = getBunTestSync()
  describe(`Route: ${routeName} [${route.method.toUpperCase()} ${route.fullPath}]`, () => {
    const testFn = createTestFn(app, route, config, testLayer)
    callback(testFn)
  })
}

/**
 * Create a route tester for a specific route without describe block.
 * Useful for programmatic test generation.
 *
 * @example
 * ```typescript
 * const testRoute = createRouteTester('projects.show', app)
 *
 * testRoute('shows project', {
 *   as: 'user',
 *   params: { project: '123' },
 *   expect: { status: 200 },
 * })
 * ```
 */
export function createRouteTester<E extends Env>(
  routeName: string,
  app: Hono<E>,
  registry: RouteRegistry = getAppRouteRegistry(app),
  config: TestAppConfig<E> = {}
): TestFn {
  const route = registry.findByName(routeName)

  if (!route) {
    throw new Error(
      `Route '${routeName}' not found in registry. Available routes: ${registry
        .all()
        .map((r) => r.name)
        .filter(Boolean)
        .join(', ') || '(none)'}`
    )
  }

  return createTestFn(app, route, config)
}

/**
 * Generate test cases from route metadata.
 * Returns an array of test case definitions that can be used with describeRoute.
 *
 * @example
 * ```typescript
 * const cases = generateTestCases('projects.create', app)
 * // Returns: [{ name: 'returns 404 for invalid params', options: { ... } }, ...]
 * ```
 */
export function generateTestCases<E extends Env>(
  routeName: string,
  app: Hono<E>,
  registry: RouteRegistry = getAppRouteRegistry(app)
): Array<{ name: string; options: TestCaseOptions }> {
  const route = registry.findByName(routeName)
  if (!route) return []

  const cases: Array<{ name: string; options: TestCaseOptions }> = []

  // Generate basic accessibility test
  cases.push({
    name: 'route is accessible',
    options: {
      expect: { status: 200 },
    },
  })

  // If route has bindings, generate param tests
  if (route.bindings.length > 0) {
    cases.push({
      name: 'returns 404 for non-existent resource',
      options: {
        params: Object.fromEntries(
          route.bindings.map((b) => [b.param, 'non-existent-id'])
        ),
        expect: { status: 404 },
      },
    })
  }

  // For non-GET routes, generate body validation test
  if (route.method !== 'get') {
    cases.push({
      name: 'validates request body',
      options: {
        body: {},
        expect: { status: 422 },
      },
    })
  }

  return cases
}
