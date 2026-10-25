// Neither under src/pages nor importing @popcomputer/web/react: the rule cannot tell it is a page's.
import { config } from '@popcomputer/web/effect'

export const Avatar = () => <img alt={String(config)} />
