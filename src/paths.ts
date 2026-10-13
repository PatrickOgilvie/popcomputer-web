/**
 * Links from route paths.
 *
 * A route's path is declared once, as a template such as
 * `'/projects/{project}'` in a module of the application's paths, and every
 * URL to it is built from that template: the route registration, a server
 * redirect and a client link. The parameters a template needs are typed from
 * its placeholders.
 *
 * @example
 * ```ts
 * // src/paths.ts
 * export const paths = {
 *   projects: '/projects',
 *   project: '/projects/{project}',
 * } as const
 *
 * href(paths.project, { project: 'p1' }) // '/projects/p1'
 * ```
 */

/** A route path's placeholder names: `{project}` and `{project:slug}` are both `project`. */
export type PathParamName<Path extends string> =
  Path extends `${string}{${infer Placeholder}}${infer Rest}`
    ? (Placeholder extends `${infer Name}:${string}` ? Name : Placeholder) | PathParamName<Rest>
    : never

/** The parameters a route path needs, by placeholder. */
export type PathParams<Path extends string> = {
  readonly [Name in PathParamName<Path>]: string | number
}

/** `href`'s parameters argument: required when the path has placeholders. */
export type PathArguments<Path extends string> = [PathParamName<Path>] extends [never]
  ? [params?: Readonly<Record<string, never>>, query?: QueryParams]
  : [params: PathParams<Path>, query?: QueryParams]

/** Query string values; `undefined` and `null` leave the key out. */
export type QueryParams = Readonly<Record<string, string | number | boolean | null | undefined>>

/**
 * Build the URL to a route path, filling its placeholders and adding a query.
 *
 * @example
 * href('/projects/{project}/tasks/{task}', { project: 'p1', task: 7 }) // '/projects/p1/tasks/7'
 * href('/projects', {}, { page: 2, q: 'launch' })                     // '/projects?page=2&q=launch'
 */
export function href<const Path extends string>(path: Path, ...[params, query]: PathArguments<Path>): string {
  const values: Readonly<Record<string, string | number>> = params ?? {}

  const filled = path.replace(/\{([^}:]+)(?::[^}]+)?\}/g, (_placeholder, name: string) => {
    const value = Object.hasOwn(values, name) ? values[name] : undefined

    return value === undefined ? `{${name}}` : encodeURIComponent(String(value))
  })

  const search = new URLSearchParams()

  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) search.set(key, String(value))
  }

  const queryString = search.toString()

  return queryString === '' ? filled : `${filled}?${queryString}`
}
