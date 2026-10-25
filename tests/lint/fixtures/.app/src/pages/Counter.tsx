import type { WebPage } from '@popcomputer/web/react'

// A page runs in one visitor's browser, where module state is that visitor's.
let renders = 0

const Counter: WebPage<'Counter'> = () => {
  renders += 1
  return <p>{renders}</p>
}

export default Counter
