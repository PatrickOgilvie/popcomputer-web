import { sum } from 'drizzle-orm' // expect: no-server-imports-in-pages
import type { Invoice } from '@/schema'

// A component's hook, beside it: it ships to the browser with the component.
export const useInvoiceTotals = (invoices: ReadonlyArray<Invoice>) => {
  void sum
  return invoices.length
}
