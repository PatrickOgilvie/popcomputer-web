import type { ReactNode } from 'react'
import { env } from '~/env' // expect: no-server-imports-in-pages

export function OfficeLayout({ children }: { readonly children: ReactNode }) {
  void env
  return <main>{children}</main>
}
