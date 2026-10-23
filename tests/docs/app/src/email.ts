// The mailer docs/setup.md's `src/app.ts` gives `createAuth`, as docs/auth.md
// describes it: the application's own, calling its mail provider's API.
import type { Bindings } from './env'

export declare function sendEmail(
  env: Bindings,
  email: { readonly to: string; readonly subject: string; readonly text: string }
): Promise<void>
