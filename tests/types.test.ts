/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
/**
 * Types and React utilities tests
 */

import { describe, test, expect } from 'bun:test'
import { HEADERS } from '../src/types.js'
import type {
  PageObject,
  WebConfig,
  RenderOptions,
} from '../src/types.js'
import type { PagePropsFor } from '../src/react.js'

describe('HEADERS Constant', () => {
  test('all header names follow X-Inertia convention', () => {
    expect(HEADERS.INERTIA).toMatch(/^X-Inertia/)
    expect(HEADERS.VERSION).toMatch(/^X-Inertia/)
    expect(HEADERS.PARTIAL_COMPONENT).toMatch(/^X-Inertia/)
    expect(HEADERS.PARTIAL_DATA).toMatch(/^X-Inertia/)
    expect(HEADERS.PARTIAL_EXCEPT).toMatch(/^X-Inertia/)
    expect(HEADERS.LOCATION).toMatch(/^X-Inertia/)
  })

  test('HEADERS has const assertion type', () => {
    // TypeScript const assertion makes it readonly at the type level
    // At runtime, we verify the expected values are correct strings
    expect(HEADERS.INERTIA).toEqual(expect.any(String))
    expect(HEADERS.VERSION).toEqual(expect.any(String))
    expect(HEADERS.PARTIAL_COMPONENT).toEqual(expect.any(String))
    expect(HEADERS.PARTIAL_DATA).toEqual(expect.any(String))
    expect(HEADERS.PARTIAL_EXCEPT).toEqual(expect.any(String))
    expect(HEADERS.LOCATION).toEqual(expect.any(String))
  })

  test('all expected headers are defined', () => {
    const expectedHeaders = [
      'INERTIA',
      'VERSION',
      'PARTIAL_COMPONENT',
      'PARTIAL_DATA',
      'PARTIAL_EXCEPT',
      'LOCATION',
    ]

    for (const header of expectedHeaders) {
      expect(HEADERS).toHaveProperty(header)
      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      expect(HEADERS[header as keyof typeof HEADERS]).toEqual(expect.any(String))
    }
  })
})

describe('Type Definitions', () => {
  describe('PageObject', () => {
    test('accepts minimal valid page object', () => {
      const page: PageObject = {
        component: 'Home',
        props: {},
        url: '/',
        version: '1.0.0',
      }

      expect(page.component).toBe('Home')
      expect(page.props).toEqual({})
      expect(page.url).toBe('/')
      expect(page.version).toBe('1.0.0')
    })

    test('accepts page object with errors', () => {
      const page: PageObject = {
        component: 'Form',
        props: {
          errors: {
            email: 'Invalid email',
            password: 'Too short',
          },
        },
        url: '/form',
        version: '1.0.0',
      }

      expect(page.props.errors?.email).toBe('Invalid email')
    })

    test('accepts page object with optional history flags', () => {
      const page: PageObject = {
        component: 'Login',
        props: {},
        url: '/login',
        version: '1.0.0',
        clearHistory: true,
        encryptHistory: true,
      }

      expect(page.clearHistory).toBe(true)
      expect(page.encryptHistory).toBe(true)
    })

    test('accepts typed props generic', () => {
      interface UserPageProps {
        user: { id: number; name: string }
        permissions: string[]
      }

      const page: PageObject<UserPageProps> = {
        component: 'User/Profile',
        props: {
          user: { id: 1, name: 'John' },
          permissions: ['read', 'write'],
        },
        url: '/users/1',
        version: '1.0.0',
      }

      expect(page.props.user.name).toBe('John')
      expect(page.props.permissions).toContain('read')
    })
  })

  describe('RenderOptions', () => {
    test('accepts empty options', () => {
      const options: RenderOptions = {}
      expect(options.clearHistory).toBeUndefined()
      expect(options.encryptHistory).toBeUndefined()
    })

    test('accepts history control options', () => {
      const options: RenderOptions = {
        clearHistory: true,
        encryptHistory: false,
      }

      expect(options.clearHistory).toBe(true)
      expect(options.encryptHistory).toBe(false)
    })
  })
})

describe('React page props', () => {
  test('a page typed by its own props also receives field errors, by field or by bag', () => {
    const page = (props: PagePropsFor<{ title: string }>) => {
      const field: string = props.errors.title
      const inBag: string = props.errors.createProject.name

      return [props.title, field, inBag]
    }

    expect(page).toBeInstanceOf(Function)
  })
})

describe('Type Compatibility', () => {
  test('WebConfig accepts string version', () => {
    const config: WebConfig = {
      version: '1.0.0',
      render: (page) => `<html>${JSON.stringify(page)}</html>`,
    }

    expect(config.version).toBe('1.0.0')
  })

  test('WebConfig accepts function version', () => {
    const config: WebConfig = {
      version: () => '1.0.0',
      render: (page) => `<html>${JSON.stringify(page)}</html>`,
    }

    expect(config.version).toBeInstanceOf(Function)
    // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
    expect((config.version as () => string)()).toBe('1.0.0')
  })

  test('WebConfig render can be async', () => {
    const config: WebConfig = {
      version: '1.0.0',
      render: async (page) => {
        await Promise.resolve()

        return `<html>${JSON.stringify(page)}</html>`
      },
    }

    expect(config.render).toBeInstanceOf(Function)
  })
})
