/**
 * Helper utilities tests
 * 
 * Tests for createTemplate, createVersion, and related helper functions.
 */

import { describe, test, expect } from 'bun:test'
import { createTemplate, createVersion, serializePage, vite } from '../src/helpers.js'
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

      expect(html).toContain('<title inertia>App</title>')
    })

    test('marks the title for Inertia so <Head title> replaces it', () => {
      const template = createTemplate({ title: 'Fallback' })

      const html = template({
        component: 'Home',
        props: {},
        url: '/',
        version: '1.0.0',
      })

      expect(html.match(/<title[\s>]/g)).toHaveLength(1)
      expect(html).toContain('<title inertia>Fallback</title>')
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
      expect(html).toContain('data-page="inertia-root"')
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
      expect(html).toContain('"url":"/dashboard"')
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
      expect(html).toContain('\\u003c/script\\u003e')
      expect(html.match(/<script data-page="app" type="application\/json">/g)).toHaveLength(1)
      expect(html.match(/<\/script>/g)).toHaveLength(1)
    })

    test('writes & as a JSON escape, never an HTML entity, inside the script payload', () => {
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

      expect(html).toContain('foo\\u0026bar\\u0026baz')
      expect(html).not.toContain('&amp;')
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

    test('handles unicode characters', () => {
      const template = createTemplate({ title: '日本語アプリ' })

      const page: PageObject = {
        component: 'Home',
        props: { greeting: '你好世界' },
        url: '/',
        version: '1.0.0',
      }

      const html = template(page)

      expect(html).toContain('<title inertia>日本語アプリ</title>')
      expect(html).toContain('你好世界')
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

    test("versions a Vite manifest's object entries by their css files", () => {
      const version = createVersion({ 'src/main.tsx': { file: 'a.js', css: ['a.css'] } })

      expect(createVersion({ 'src/main.tsx': { file: 'a.js', css: ['a.css'] } })).toBe(version)
      expect(createVersion({ 'src/main.tsx': { file: 'a.js', css: ['b.css'] } })).not.toBe(version)
    })
  })

  describe('Edge Cases', () => {
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

    test('returns the base36 hash of the asset files', () => {
      expect(createVersion({ 'app.js': 'app.hash.js' })).toBe('wd31g')
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
    expect(html).toContain('<title inertia>My Dashboard</title>')
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
    expect(html).toContain('"url":"/dashboard"')
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

  test('keeps a comment and script opening from making the parser read past the element', () => {
    const page: PageObject = {
      component: 'Products/Index',
      props: { name: '<!--<script>', note: 'a & b > c', separators: '\u2028\u2029' },
      url: '/',
      version: '1.0.0',
    }

    const serialized = serializePage(page)

    expect(serialized).not.toMatch(/[<>&\u2028\u2029]/)
    expect(JSON.parse(serialized)).toEqual(page)
  })

  test('a page embedding visitor markup still parses as one element in the template', async () => {
    const render = createTemplate({ title: 'Shop', scripts: ['/main.js'] })
    const html = await render({ component: 'Products/Index', props: { name: '<!--<script>' }, url: '/', version: '1' })
    let pageData = ''
    const scripts: string[] = []

    await new HTMLRewriter()
      .on('script[data-page]', { text: (chunk) => { pageData += chunk.text } })
      .on('script[src]', { element: (element) => { scripts.push(element.getAttribute('src') ?? '') } })
      .transform(new Response(html))
      .text()

    expect(JSON.parse(pageData).props.name).toBe('<!--<script>')
    expect(scripts).toEqual(['/main.js'])
  })
})

describe('vite', () => {
  test('defaults to the localhost dev server on port 5173', () => {
    expect(vite.script()).toBe('http://localhost:5173/src/main.tsx')
    expect(vite.hmrHead()).toContain('import RefreshRuntime from "http://localhost:5173/@react-refresh"')
    expect(vite.hmrHead()).toContain('src="http://localhost:5173/@vite/client"')
  })

  test('accepts a port', () => {
    expect(vite.script('/src/app.tsx', 5174)).toBe('http://localhost:5174/src/app.tsx')
    expect(vite.hmrHead(5174)).toContain('src="http://localhost:5174/@vite/client"')
  })

  test('accepts an origin served by a local proxy', () => {
    const origin = 'https://vite.myapp.localhost'

    expect(vite.script('/src/main.tsx', origin)).toBe('https://vite.myapp.localhost/src/main.tsx')
    expect(vite.script('/src/main.tsx', new URL('http://vite.myapp.localhost:1355'))).toBe(
      'http://vite.myapp.localhost:1355/src/main.tsx'
    )
    expect(vite.hmrHead(origin)).toContain(
      'import RefreshRuntime from "https://vite.myapp.localhost/@react-refresh"'
    )
    expect(vite.hmrHead(origin)).toContain('src="https://vite.myapp.localhost/@vite/client"')
  })

  test('uses only the origin of a URL with a path', () => {
    expect(vite.script('/src/main.tsx', 'https://vite.myapp.localhost/ignored/path?x=1')).toBe(
      'https://vite.myapp.localhost/src/main.tsx'
    )
  })

  test.each([0, 65_536, 5173.5, Number.NaN])('rejects the invalid port %p', (port) => {
    expect(() => vite.script('/src/main.tsx', port)).toThrow('Vite dev server port')
  })

  test.each(['not a url', 'ftp://vite.myapp.localhost', 'javascript:alert(1)'])(
    'rejects the invalid origin %p',
    (origin) => {
      expect(() => vite.hmrHead(origin)).toThrow('Vite dev server origin')
    }
  )
})
