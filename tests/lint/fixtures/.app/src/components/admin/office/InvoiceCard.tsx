import { eq } from 'drizzle-orm' // expect: no-server-imports-in-pages
import { dbQuery } from '@popcomputer/web/effect' // expect: no-server-imports-in-pages
import { invoices } from '../../../schema' // expect: no-server-imports-in-pages
import type { Invoice } from '../../../schema'
import { type Database } from '../../../db'
import { href } from '@popcomputer/web/paths'
import { paths } from '../../../paths'

// A page's sub-component: it runs in the browser without importing @popcomputer/web/react.
export function InvoiceCard({ invoice }: { readonly invoice: Invoice }) {
  const db: Database | undefined = undefined
  void [eq, dbQuery, invoices, db]

  return <a href={href(paths.invoice, { invoice: invoice.id })}>{invoice.number}</a>
}
