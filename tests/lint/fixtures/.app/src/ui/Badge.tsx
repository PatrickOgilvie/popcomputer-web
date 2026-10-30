// Neither under src/pages, src/components or src/layouts nor importing @popcomputer/web/react: the rule cannot tell it is a page's.
import { config } from '@popcomputer/web/effect'

export const Badge = () => <span>{String(config)}</span>
