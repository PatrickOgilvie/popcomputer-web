/**
 * A module's exports as Vite's SSR module runner gives `import * as schema`
 * to the code that imports it: a null-prototype object whose every export is
 * an enumerable getter. Bun, Node and workerd give data properties instead,
 * so a test that passes the module itself never sees the getters.
 */
export function viteNamespace<Module extends object>(module: Module): Module {
  const namespace: object = Object.create(null)

  Object.defineProperty(namespace, Symbol.toStringTag, { value: 'Module' })

  for (const [key, value] of Object.entries(module)) {
    Object.defineProperty(namespace, key, { enumerable: true, configurable: true, get: () => value })
  }

  // SAFETY: Every export of the module was defined above, under its own key, returning its own value.
  return namespace as Module
}
