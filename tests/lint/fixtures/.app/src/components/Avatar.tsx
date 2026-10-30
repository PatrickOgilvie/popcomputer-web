// Under src/components, though it imports nothing from @popcomputer/web/react: a page's component.
import { config } from '@popcomputer/web/effect' // expect: no-server-imports-in-pages

export const Avatar = () => <img alt={String(config)} />
