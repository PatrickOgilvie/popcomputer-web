/**
 * Compile-time contracts for React page props, checked by `bun run test:types`.
 */
import type { PagePropsFor } from '../src/react.js'

// A page typed by its own props also receives field errors, by field or by bag.
export const page = (props: PagePropsFor<{ title: string }>): ReadonlyArray<string> => {
  const field: string = props.errors.title
  const inBag: string = props.errors.createProject.name

  return [props.title, field, inBag]
}
