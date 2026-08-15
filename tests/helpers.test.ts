/**
 * Honertia Helper Utilities Tests
 * 
 * Tests for createTemplate, createVersion, and related helper functions.
 */

import { describe, test, expect } from 'bun:test'
import { createTemplate, createVersion, serializePage } from '../src/helpers.js'
import type { PageObject } from '../src/types.js'

describe('createTemplate', () => {
  describe('Basic Template Generation', () => {
    test('generates valid HTML document', () => {
      const template = createTemplate({})
      const page: PageObject = {
        component: 'Home',
        props: { title: 'Welcome' },
        url: '/',
        version: '1.0.0',
      }

      const html = template(page)

      expect(html).toContain('<!DOCTYPE html>')
      expect(html).toContain('<html lang="en">')
      expect(html).toContain('</html>')
    })

    test('includes default title', () => {
      const template = createTemplate({})
      const page: PageObject = {
        component: 'Home',
        props: {},
        url: '/',
        version: '1.0.0',
      }

      const html = template(page)

      expect(html).toContain('<title>App</title>')
    })

    test('uses custom title', () => {
      const template = createTemplate({ title: 'My Application' })
      const page: PageObject = {
        component: 'Home',
        props: {},
        url: '/',
        version: '1.0.0',
      }

      const html = template(page)

      expect(html).toContain('<title>My Application</title>')
    })

    test('includes viewport meta tag', () => {
      const template = createTemplate({})
      const page: PageObject = {
        component: 'Home',
        props: {},
        url: '/',
        version: '1.0.0',
      }

      const html = template(page)

      expect(html).toContain(
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
      )
    })

    test('includes charset meta tag', () => {
      const template = createTemplate({})
      const page: PageObject = {
        component: 'Home',
        props: {},
        url: '/',
        version: '1.0.0',
      }

      const html = template(page)

      expect(html).toContain('<meta charset="utf-8">')
    })
  })

  describe('Root Element', () => {
    test('uses default root id "app"', () => {
      const template = createTemplate({})
      const page: PageObject = {
        component: 'Home',
        props: {},
        url: '/',
        version: '1.0.0',
      }

      const html = template(page)

      expect(html).toContain('id="app"')
    })

    test('uses custom root id', () => {
      const template = createTemplate({ rootId: 'inertia-root' })
      const page: PageObject = {
        component: 'Home',
        props: {},
        url: '/',
        version: '1.0.0',
      }

      const html = template(page)

      expect(html).toContain('id="inertia-root"')
    })

    test('includes script element with serialized page object', () => {
      const template = createTemplate({})
      const page: PageObject = {
        component: 'Dashboard',
        props: { userId: 123 },
        url: '/dashboard',
        version: '2.0.0',
      }

      const html = template(page)

      expect(html).toContain('<script data-page="app" type="application/json">')
      expect(html).toContain('<div id="app"></div>')
      expect(html).toContain('"component":"Dashboard"')
      expect(html).toContain('"url":"\\/dashboard"')
      expect(html).toContain('"version":"2.0.0"')
    })
  })

  describe('Scripts and Styles', () => {
    test('includes script tags for provided scripts', () => {
      const template = createTemplate({
        scripts: ['/assets/app.js', '/assets/vendor.js'],
      })
      const page: PageObject = {
        component: 'Home',
        props: {},
        url: '/',
        version: '1.0.0',
      }

      const html = template(page)

      expect(html).toContain(
        '<script type="module" src="/assets/app.js"></script>'
      )
      expect(html).toContain(
        '<script type="module" src="/assets/vendor.js"></script>'
      )
    })

    test('includes link tags for provided styles', () => {
      const template = createTemplate({
        styles: ['/assets/app.css', '/assets/vendor.css'],
      })
      const page: PageObject = {
        component: 'Home',
        props: {},
        url: '/',
        version: '1.0.0',
      }

      const html = template(page)

      expect(html).toContain('<link rel="stylesheet" href="/assets/app.css">')
      expect(html).toContain(
        '<link rel="stylesheet" href="/assets/vendor.css">'
      )
    })

    test('handles empty scripts array', () => {
      const template = createTemplate({ scripts: [] })
      const page: PageObject = {
        component: 'Home',
        props: {},
        url: '/',
        version: '1.0.0',
      }

      const html = template(page)

      expect(html).not.toContain('<script type="module"')
    })

    test('handles empty styles array', () => {
      const template = createTemplate({ styles: [] })
      const page: PageObject = {
        component: 'Home',
        props: {},
        url: '/',
        version: '1.0.0',
      }

      const html = template(page)

      expect(html).not.toContain('<link rel="stylesheet"')
    })
  })

  describe('Custom Head Content', () => {
    test('includes custom head content', () => {
      const template = createTemplate({
        head: '<meta name="description" content="My app">',
      })
      const page: PageObject = {
        component: 'Home',
        props: {},
        url: '/',
        version: '1.0.0',
      }

      const html = template(page)

      expect(html).toContain('<meta name="description" content="My app">')
    })

    test('includes multiple custom head elements', () => {
      const template = createTemplate({
        head: `
          <link rel="icon" href="/favicon.ico">
          <meta property="og:title" content="My App">
          <script>window.__CONFIG__ = {};</script>
        `,
      })
      const page: PageObject = {
        component: 'Home',
        props: {},
        url: '/',
        version: '1.0.0',
      }

      const html = template(page)

      expect(html).toContain('<link rel="icon" href="/favicon.ico">')
      expect(html).toContain('<meta property="og:title" content="My App">')
      expect(html).toContain('window.__CONFIG__')
    })
  })

  describe('XSS Prevention', () => {
    test('neutralizes closing script tags in page props', () => {
      const template = createTemplate({})
      const page: PageObject = {
        component: 'Home',
        props: {
          userInput: '<script>alert("xss")</script>',
        },
        url: '/',
        version: '1.0.0',
      }

      const html = template(page)

      expect(html).not.toContain('</script><script>alert("xss")')
      expect(html).toContain('<\\/script>')
      expect(html.match(/<script data-page="app" type="application\/json">/g)).toHaveLength(1)
      expect(html.match(/<\/script>/g)).toHaveLength(1)
    })

    test('does not need HTML entity escaping inside JSON script payload', () => {
      const template = createTemplate({})
      const page: PageObject = {
        component: 'Home',
        props: {
          query: 'foo&bar&baz',
        },
        url: '/',
        version: '1.0.0',
      }

      const html = template(page)

      expect(html).toContain('foo&bar&baz')
      expect(html).not.toContain('\\u0026')
    })

    test('allows single quotes in props without attribute escaping', () => {
      const template = createTemplate({})
      const page: PageObject = {
        component: 'Home',
        props: {
          text: "it's working",
        },
        url: '/',
        version: '1.0.0',
      }

      const html = template(page)

      expect(html).toContain("it's working")
      expect(html).not.toContain('\\u0027')
    })

    test('escapes title to prevent XSS', () => {
      const template = createTemplate({
        title: '<script>alert("xss")</script>',
      })
      const page: PageObject = {
        component: 'Home',
        props: {},
        url: '/',
        version: '1.0.0',
      }

      const html = template(page)

      expect(html).not.toContain('<script>alert("xss")</script></title>')
      expect(html).toContain('&lt;script&gt;')
    })

    test('escapes script src to prevent XSS', () => {
      const template = createTemplate({
        scripts: ['"><script>alert("xss")</script>'],
      })
      const page: PageObject = {
        component: 'Home',
        props: {},
        url: '/',
        version: '1.0.0',
      }

      const html = template(page)

      expect(html).toContain('&quot;')
      expect(html).toContain('&gt;')
    })
  })

  describe('Edge Cases', () => {
    test('handles empty props', () => {
      const template = createTemplate({})
      const page: PageObject = {
        component: 'Empty',
        props: {},
        url: '/empty',
        version: '1.0.0',
      }

      const html = template(page)

      expect(html).toContain('"props":{}')
    })

    test('handles nested props with special characters', () => {
      const template = createTemplate({})
      const page: PageObject = {
        component: 'Complex',
        props: {
          user: {
            name: "O'Brien",
            bio: 'Loves <coding> & testing',
          },
        },
        url: '/complex',
        version: '1.0.0',
      }

      const html = template(page)

      expect(html).toContain("O'Brien")
      expect(html).toContain('Loves <coding> & testing')
    })

    test('handles unicode characters', () => {
      const template = createTemplate({ title: '日本語アプリ' })
      const page: PageObject = {
        component: 'Home',
        props: { greeting: '你好世界' },
        url: '/',
        version: '1.0.0',
      }

      const html = template(page)

      expect(html).toContain('<title>日本語アプリ</title>')
      expect(html).toContain('你好世界')
    })

    test('handles emoji in props', () => {
      const template = createTemplate({})
      const page: PageObject = {
        component: 'Home',
        props: { emoji: '🎉🚀👨‍👩‍👧‍👦' },
        url: '/',
        version: '1.0.0',
      }

      const html = template(page)

      expect(html).toContain('🎉🚀👨‍👩‍👧‍👦')
    })

    test('handles clearHistory and encryptHistory options', () => {
      const template = createTemplate({})
      const page: PageObject = {
        component: 'Login',
        props: {},
        url: '/login',
        version: '1.0.0',
        clearHistory: true,
        encryptHistory: true,
      }

      const html = template(page)

      expect(html).toContain('"clearHistory":true')
      expect(html).toContain('"encryptHistory":true')
    })
  })
})

describe('createVersion', () => {
  describe('Basic Functionality', () => {
    test('generates a string version from manifest', () => {
      const manifest = {
        'app.js': 'app.abc123.js',
        'app.css': 'app.def456.css',
      }

      const version = createVersion(manifest)

      expect(version).toEqual(expect.any(String))
      expect(version.length).toBeGreaterThan(0)
    })

    test('generates consistent version for same manifest', () => {
      const manifest = {
        'app.js': 'app.abc123.js',
        'vendor.js': 'vendor.xyz789.js',
      }

      const version1 = createVersion(manifest)
      const version2 = createVersion(manifest)

      expect(version1).toBe(version2)
    })

    test('generates different version for different manifests', () => {
      const manifest1 = {
        'app.js': 'app.abc123.js',
      }
      const manifest2 = {
        'app.js': 'app.def456.js',
      }

      const version1 = createVersion(manifest1)
      const version2 = createVersion(manifest2)

      expect(version1).not.toBe(version2)
    })
  })

  describe('Edge Cases', () => {
    test('handles empty manifest', () => {
      const manifest = {}
      const version = createVersion(manifest)

      expect(version).toEqual(expect.any(String))
    })

    test('handles single entry manifest', () => {
      const manifest = {
        'main.js': 'main.hash.js',
      }

      const version = createVersion(manifest)

      expect(version).toEqual(expect.any(String))
      expect(version.length).toBeGreaterThan(0)
    })

    test('handles large manifest', () => {
      const manifest: Record<string, string> = {}
      for (let i = 0; i < 100; i++) {
        manifest[`file${i}.js`] = `file${i}.${Math.random().toString(36)}.js`
      }

      const version = createVersion(manifest)

      expect(version).toEqual(expect.any(String))
    })

    test('handles special characters in filenames', () => {
      const manifest = {
        'app.min.js': 'app.min.abc123.js',
        '@vendor/package.js': '@vendor/package.xyz789.js',
        'styles[main].css': 'styles[main].def456.css',
      }

      const version = createVersion(manifest)

      expect(version).toEqual(expect.any(String))
    })

    test('order independence - same files in different order produce same version', () => {
      const manifest1 = {
        'a.js': 'a.123.js',
        'b.js': 'b.456.js',
        'c.js': 'c.789.js',
      }
      const manifest2 = {
        'c.js': 'c.789.js',
        'a.js': 'a.123.js',
        'b.js': 'b.456.js',
      }

      const version1 = createVersion(manifest1)
      const version2 = createVersion(manifest2)

      expect(version1).toBe(version2)
    })

    test('returns base36 encoded string', () => {
      const manifest = {
        'app.js': 'app.hash.js',
      }

      const version = createVersion(manifest)

      // Base36 only contains 0-9 and a-z
      expect(version).toMatch(/^[0-9a-z]+$/)
    })
  })
})

describe('Template Integration', () => {
  test('full template with all options', () => {
    const template = createTemplate({
      title: 'My Dashboard',
      scripts: ['/assets/main.js', '/assets/vendor.js'],
      styles: ['/assets/main.css'],
      head: '<link rel="icon" href="/favicon.ico">',
      rootId: 'root',
    })

    const page: PageObject = {
      component: 'Dashboard',
      props: {
        user: { id: 1, name: 'John' },
        notifications: [],
      },
      url: '/dashboard',
      version: createVersion({ 'main.js': 'main.abc.js' }),
    }

    const html = template(page)

    // Check structure
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('<title>My Dashboard</title>')
    expect(html).toContain('id="root"')
    expect(html).toContain('<script data-page="root" type="application/json">')
    expect(html).toContain('<div id="root"></div>')

    // Check assets
    expect(html).toContain('src="/assets/main.js"')
    expect(html).toContain('src="/assets/vendor.js"')
    expect(html).toContain('href="/assets/main.css"')
    expect(html).toContain('<link rel="icon" href="/favicon.ico">')

    // Check page data
    expect(html).toContain('"component":"Dashboard"')
    expect(html).toContain('"url":"\\/dashboard"')
  })
})

describe('serializePage', () => {
  test('serializes page data as JSON parseable script text', () => {
    const page: PageObject = {
      component: 'Home',
      props: { message: 'Hello' },
      url: '/',
      version: '1.0.0',
    }

    expect(JSON.parse(serializePage(page))).toEqual(page)
  })

  test('escapes forward slashes to prevent closing script injection', () => {
    const page: PageObject = {
      component: 'Home',
      props: { userInput: '</script><script>alert("xss")</script>' },
      url: '/',
      version: '1.0.0',
    }

    const serialized = serializePage(page)

    expect(serialized).toContain('<\\/script>')
    expect(serialized).not.toContain('</script>')
    expect(JSON.parse(serialized)).toEqual(page)
  })
})
