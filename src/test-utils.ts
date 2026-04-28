/**
 * Honertia Test Utilities
 * 
 * Shared utilities for testing Honertia middleware and components.
 * Inspired by Inertia.js test patterns.
 */

import { Hono } from 'hono'
import { honertia, HEADERS } from './middleware.js'
import { serializePage } from './helpers.js'
import type { PageObject, HonertiaConfig } from './types.js'

// =============================================================================
// Types
// =============================================================================

export interface TestAppOptions {
  version?: string | (() => string)
  render?: (page: PageObject) => string | Promise<string>
}

export interface TestRequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: BodyInit | null
}

export interface InertiaRequestOptions extends TestRequestOptions {
  version?: string
  partialComponent?: string
  partialData?: string
  partialExcept?: string
}

// =============================================================================
// App Factory
// =============================================================================

/**
 * Creates a test Hono app with honertia middleware configured
 */
export function createTestApp(options: TestAppOptions = {}) {
  const {
    version = '1.0.0',
    render = (page: PageObject) =>
      `<!DOCTYPE html><html><body><script data-page="app" type="application/json">${serializePage(page)}</script><div id="app"></div></body></html>`,
  } = options

  const app = new Hono()

  app.use(
    '*',
    honertia({
      version,
      render,
    })
  )

  return app
}

// =============================================================================
// Request Helpers
// =============================================================================

/**
 * Makes a regular (non-Inertia) request
 */
export function makeRequest(
  app: Hono,
  path: string,
  options: TestRequestOptions = {}
) {
  const { method = 'GET', headers = {}, body } = options
  
  return app.request(path, {
    method,
    headers,
    body,
  })
}

/**
 * Makes an Inertia request with X-Inertia header
 */
export function makeInertiaRequest(
  app: Hono,
  path: string,
  options: InertiaRequestOptions = {}
) {
  const {
    method = 'GET',
    headers = {},
    body,
    version,
    partialComponent,
    partialData,
    partialExcept,
  } = options

  const inertiaHeaders: Record<string, string> = {
    [HEADERS.HONERTIA]: 'true',
    ...headers,
  }

  if (version) {
    inertiaHeaders[HEADERS.VERSION] = version
  }

  if (partialComponent) {
    inertiaHeaders[HEADERS.PARTIAL_COMPONENT] = partialComponent
  }

  if (partialData) {
    inertiaHeaders[HEADERS.PARTIAL_DATA] = partialData
  }

  if (partialExcept) {
    inertiaHeaders[HEADERS.PARTIAL_EXCEPT] = partialExcept
  }

  return app.request(path, {
    method,
    headers: inertiaHeaders,
    body,
  })
}

// =============================================================================
// Response Helpers
// =============================================================================

/**
 * Parses an Inertia JSON response
 */
export async function parseInertiaResponse(res: Response): Promise<PageObject> {
  const json = await res.json()
  return json as PageObject
}

/**
 * Extracts page object from HTML response
 */
export async function parseHtmlResponse(res: Response): Promise<PageObject | null> {
  const html = await res.text()
  const scriptMatch = html.match(
    /<script\s+data-page="[^"]+"\s+type="application\/json">([\s\S]*?)<\/script>/
  )

  if (scriptMatch) {
    return JSON.parse(scriptMatch[1]) as PageObject
  }

  return null
}

// =============================================================================
// Assertions
// =============================================================================

/**
 * Asserts that a response is a valid Inertia JSON response
 */
export function assertInertiaResponse(res: Response) {
  if (res.status !== 200) {
    throw new Error(`Expected status 200, got ${res.status}`)
  }
  
  const contentType = res.headers.get('Content-Type')
  if (!contentType?.includes('application/json')) {
    throw new Error(`Expected JSON content type, got ${contentType}`)
  }
  
  if (res.headers.get(HEADERS.HONERTIA) !== 'true') {
    throw new Error(`Missing ${HEADERS.HONERTIA} header`)
  }
}

/**
 * Asserts that a response is a valid HTML response
 */
export function assertHtmlResponse(res: Response) {
  if (res.status !== 200) {
    throw new Error(`Expected status 200, got ${res.status}`)
  }
  
  const contentType = res.headers.get('Content-Type')
  if (!contentType?.includes('text/html')) {
    throw new Error(`Expected HTML content type, got ${contentType}`)
  }
}

/**
 * Asserts that a response is a version mismatch (409)
 */
export function assertVersionMismatch(res: Response, expectedLocation?: string) {
  if (res.status !== 409) {
    throw new Error(`Expected status 409, got ${res.status}`)
  }
  
  const location = res.headers.get(HEADERS.LOCATION)
  if (!location) {
    throw new Error(`Missing ${HEADERS.LOCATION} header`)
  }
  
  if (expectedLocation && !location.includes(expectedLocation)) {
    throw new Error(`Expected location to include ${expectedLocation}, got ${location}`)
  }
}

/**
 * Asserts that a page object has the expected structure
 */
export function assertPageObject(page: PageObject, expected: Partial<PageObject>) {
  if (expected.component !== undefined && page.component !== expected.component) {
    throw new Error(`Expected component ${expected.component}, got ${page.component}`)
  }
  
  if (expected.url !== undefined && page.url !== expected.url) {
    throw new Error(`Expected url ${expected.url}, got ${page.url}`)
  }
  
  if (expected.version !== undefined && page.version !== expected.version) {
    throw new Error(`Expected version ${expected.version}, got ${page.version}`)
  }
}

// =============================================================================
// Mock Data
// =============================================================================

export const mockUsers = [
  { id: 1, name: 'Alice', email: 'alice@example.com' },
  { id: 2, name: 'Bob', email: 'bob@example.com' },
  { id: 3, name: 'Charlie', email: 'charlie@example.com' },
]

export const mockProjects = [
  { id: 1, name: 'Project A', status: 'active' },
  { id: 2, name: 'Project B', status: 'archived' },
]

export const mockErrors = {
  email: 'Invalid email address',
  password: 'Password must be at least 8 characters',
}

// =============================================================================
// Special Characters / Edge Cases
// =============================================================================

export const edgeCaseStrings = {
  emoji: '😀🎉🚀',
  unicode: '日本語テスト',
  multiByteEmoji: '👨‍👩‍👧‍👦',
  htmlEntities: '<script>alert("xss")</script>',
  quotes: `"single'quotes"`,
  newlines: 'line1\nline2\rline3\r\n',
  specialChars: '& < > " \' / \\',
  longString: 'a'.repeat(10000),
  emptyString: '',
  whitespace: '   \t\n  ',
}

// =============================================================================
// Timing Utilities
// =============================================================================

/**
 * Creates a delayed promise for testing async behavior
 */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Creates a lazy prop that resolves after a delay
 */
export function lazyProp<T>(value: T, delayMs = 0): () => Promise<T> {
  return async () => {
    if (delayMs > 0) {
      await delay(delayMs)
    }
    return value
  }
}

// =============================================================================
// Request Tracking (for testing request cancellation etc.)
// =============================================================================

export interface RequestTracker {
  requests: Array<{ path: string; method: string; timestamp: number }>
  track: (path: string, method: string) => void
  reset: () => void
  count: () => number
}

export function createRequestTracker(): RequestTracker {
  const requests: Array<{ path: string; method: string; timestamp: number }> = []
  
  return {
    requests,
    track(path: string, method: string) {
      requests.push({ path, method, timestamp: Date.now() })
    },
    reset() {
      requests.length = 0
    },
    count() {
      return requests.length
    },
  }
}
