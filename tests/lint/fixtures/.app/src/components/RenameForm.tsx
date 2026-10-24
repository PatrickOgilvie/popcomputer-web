import { useForm } from '@inertiajs/react'
import type { PagePropsFor } from '@popcomputer/web/react'
import { setupWeb } from '@popcomputer/web' // expect: no-server-imports-in-pages
import { betterAuthCall } from '@popcomputer/web/auth' // expect: no-server-imports-in-pages

export function RenameForm(_props: Partial<PagePropsFor<'Projects/Show'>>) {
  const form = useForm({ name: '' })
  const loadAuth = () => import('@/auth') // expect: no-server-imports-in-pages
  void [setupWeb, betterAuthCall, loadAuth]

  return <input value={form.data.name} />
}
