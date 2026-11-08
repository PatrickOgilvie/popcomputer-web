/**
 * Paths as the fence compares them: `/` for each separator, no `.`
 * segment, no repeated `/`, and each `..` taken against the segment before
 * it. A relative path is relative to the directory the hook runs in, `''`.
 */

/** A path with its `.` and `..` segments and repeated separators resolved. */
export function normalizePath(path: string): string {
  const slashed = path.replaceAll('\\', '/')
  const absolute = slashed.startsWith('/')
  const segments: string[] = []

  for (const segment of slashed.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment !== '..') segments.push(segment)
    else if (segments.length > 0 && segments[segments.length - 1] !== '..') segments.pop()
    else if (!absolute) segments.push(segment)
  }

  return (absolute ? '/' : '') + segments.join('/')
}

export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(path)
}

/** `path` from the directory `base`, or undefined when `base` is unknown and `path` relative. */
export function joinPath(base: string | undefined, path: string): string | undefined {
  if (isAbsolutePath(path)) return normalizePath(path)
  if (base === undefined) return undefined
  return normalizePath(base === '' ? path : `${base}/${path}`)
}

/** The directory holding `path`, or undefined at the root. */
export function parentPath(path: string): string | undefined {
  return path === '/' ? undefined : joinPath(path, '..')
}
