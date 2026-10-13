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

// A form's fields derive from the schema its action validates them with.
import type { FormInput } from '@popcomputer/web/react'
import { Schema as FormSchema } from 'effect'
import { coercedNumber, nullableString, requiredString, upload } from '@popcomputer/web/schema'

const CreateLease = FormSchema.Struct({
  startDate: requiredString,
  rent: coercedNumber,
  note: nullableString,
  tenantEmails: FormSchema.Array(requiredString),
  contract: upload({ types: ['application/pdf'] }),
})

export const leaseForm: FormInput<typeof CreateLease> = {
  startDate: '2026-11-01',
  rent: '1200',
  note: null,
  tenantEmails: [''],
  contract: null,
}

// @ts-expect-error startDate is the field's name, not start
export const misnamed: FormInput<typeof CreateLease> = { start: '', rent: 0, note: null, tenantEmails: [], contract: null }
