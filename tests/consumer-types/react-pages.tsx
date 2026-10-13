/**
 * A page component typed with WebPage is a React function component: it
 * renders as JSX and resolves where React expects one.
 */
import type { FunctionComponent } from 'react'
import type { PagePropsFor, WebPage } from '@popcomputer/web/react'
import type { PageName } from '@popcomputer/web/effect'
import './augmented-app'

const Show: WebPage<'Projects/Show'> = ({ project, auth }) => (
  <main>
    <h1>{project.id}</h1>
    {auth.user && <p>{auth.user.name}</p>}
  </main>
)

export const asComponent: FunctionComponent<PagePropsFor<'Projects/Show'>> = Show

export const element = (props: PagePropsFor<'Projects/Show'>) => <Show {...props} />

// The page names are the registered pages.
export const name: PageName = 'Projects/Show'
// @ts-expect-error 'Projects/Missing' is not a registered page
export const missing: PageName = 'Projects/Missing'

// A map of every page to its component checks completeness.
export const components: { readonly [Name in PageName]: unknown } = { 'Projects/Show': Show }
