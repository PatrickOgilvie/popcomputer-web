/**
 * A page loaded while a deploy replaces the application's assets.
 *
 * For a few seconds after a deploy, the previous Worker version can still
 * answer, with a page naming the previous build's files, which the new
 * deploy no longer serves. The script createTemplate inlines reloads such a
 * page, a few times at most. These tests run that script, as the template
 * renders it, in a tab whose storage, clock and reloads they control.
 */

import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { ASSET_RELOAD_SCRIPT, TEMPLATE_SCRIPT_HASH, createTemplate } from '../src/helpers.js'
import type { PageObject } from '../src/types.js'

const page: PageObject = { component: 'Home', props: {}, url: '/', version: '1' }

const html = createTemplate({
  scripts: ['/assets/main-abc.js'],
  styles: ['/assets/main-abc.css'],
  head: '<script src="https://analytics.example/tag.js"></script>',
})(page)

/** The inline script exactly as the page carries it. */
const inlined = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? ''

/** An element a load error comes from: the template marks its own assets. */
class Element {
  constructor(private readonly attributes: ReadonlySet<string>) {}

  hasAttribute(name: string): boolean {
    return this.attributes.has(name)
  }
}

type Listener = (event: object) => void

/** One browser tab: its session storage outlives a reload, as a browser's does. */
function tab(storage: { getItem(key: string): string | null; setItem(key: string, value: string): void } = new Map<string, string>() as never) {
  const values = new Map<string, string>()
  const sessionStorage = storage instanceof Map
    ? { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) }
    : storage
  const clock = { now: 1_700_000_000_000 }
  /** The delay before each reload the page asked for. */
  const reloads: number[] = []

  /** Load the page: run its inline script, as each load does. */
  function load() {
    const listeners = new Map<string, Listener[]>()
    let delay = 0

    runInNewContext(inlined, {
      addEventListener: (type: string, listener: Listener) => listeners.set(type, [...(listeners.get(type) ?? []), listener]),
      sessionStorage,
      Element,
      Date: { now: () => clock.now },
      location: { reload: () => reloads.push(delay) },
      setTimeout: (callback: () => void, ms: number) => {
        delay = ms
        callback()
      },
    })

    const dispatch = (type: string, event: object) => {
      for (const listener of listeners.get(type) ?? []) listener(event)
    }

    return {
      /** A script or stylesheet failing to load, as the browser reports it. */
      fails: (element: Element) => dispatch('error', { target: element }),
      /** A chunk Vite could not load; whether the page stopped Vite throwing. */
      chunkFails: () => {
        const event = { prevented: false, preventDefault: () => void (event.prevented = true) }
        dispatch('vite:preloadError', event)
        return event.prevented
      },
    }
  }

  return { load, reloads, clock }
}

const ownAsset = new Element(new Set(['data-popweb-asset']))
const otherScript = new Element(new Set())

describe('a page whose assets a deploy replaced', () => {
  test('carries the script before any of its scripts and stylesheets, and marks its own assets', () => {
    expect(inlined).toBe(ASSET_RELOAD_SCRIPT)
    expect(html.indexOf(ASSET_RELOAD_SCRIPT)).toBeLessThan(html.indexOf('<link rel="stylesheet"'))
    expect(html.indexOf(ASSET_RELOAD_SCRIPT)).toBeLessThan(html.indexOf('<script type="module"'))
    expect(html).toContain('<script type="module" src="/assets/main-abc.js" data-popweb-asset></script>')
    expect(html).toContain('<link rel="stylesheet" href="/assets/main-abc.css" data-popweb-asset>')
    expect(html).toContain('<script src="https://analytics.example/tag.js"></script>')
  })

  test('reloads at once when one of its own scripts or stylesheets fails to load', () => {
    const browser = tab()

    browser.load().fails(ownAsset)

    expect(browser.reloads).toEqual([0])
  })

  test('reloads after 2 and then 4 seconds while the files are still missing, and no more than three times a minute', () => {
    const browser = tab()

    for (let load = 0; load < 4; load += 1) {
      browser.clock.now += 1_000
      browser.load().fails(ownAsset)
    }

    expect(browser.reloads).toEqual([0, 2_000, 4_000])
  })

  test('reloads again once a minute has passed since the earlier reloads', () => {
    const browser = tab()

    for (let load = 0; load < 3; load += 1) browser.load().fails(ownAsset)
    browser.clock.now += 60_000
    browser.load().fails(ownAsset)

    expect(browser.reloads).toEqual([0, 2_000, 4_000, 0])
  })

  test('reloads once however many of its files fail', () => {
    const browser = tab()
    const loaded = browser.load()

    loaded.fails(ownAsset)
    loaded.fails(ownAsset)
    loaded.chunkFails()

    expect(browser.reloads).toEqual([0])
  })

  test('never reloads for a script the application added itself, such as an analytics tag a blocker refuses', () => {
    const browser = tab()

    browser.load().fails(otherScript)

    expect(browser.reloads).toEqual([])
  })

  test('reloads when a chunk Vite loads is missing, and keeps Vite from throwing meanwhile', () => {
    const browser = tab()

    expect(browser.load().chunkFails()).toBe(true)
    expect(browser.reloads).toEqual([0])
  })

  test("lets Vite throw its own error once it has stopped reloading", () => {
    const browser = tab()

    for (let load = 0; load < 3; load += 1) browser.load().chunkFails()

    expect(browser.load().chunkFails()).toBe(false)
    expect(browser.reloads).toHaveLength(3)
  })

  test('never reloads where it cannot count its reloads, so it never loops', () => {
    const browser = tab({
      getItem: () => {
        throw new Error('The operation is insecure.')
      },
      setItem: () => undefined,
    })
    const loaded = browser.load()

    loaded.fails(ownAsset)

    expect(loaded.chunkFails()).toBe(false)
    expect(browser.reloads).toEqual([])
  })
})

test('TEMPLATE_SCRIPT_HASH allows the inline script under a Content-Security-Policy', () => {
  const digest = createHash('sha256').update(inlined).digest('base64')

  expect(TEMPLATE_SCRIPT_HASH).toBe(`'sha256-${digest}'`)
})
