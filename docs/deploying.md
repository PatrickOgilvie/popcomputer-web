# Deploying

The demo's README shows the commands that deploy an application with
Wrangler, in
[Deploying](https://github.com/PatrickOgilvie/popcomputer-web-demo#deploying).
What the framework does around a deploy:

- The Worker's entry imports every module of registrations, as
  [Wire the Worker](setup.md#6-wire-the-worker) shows.
- Each deploy starts the page cache empty once `wrangler.jsonc` binds the
  version metadata, as [Page caching](page-cache.md) shows.
- The sign-in limiter is a Rate Limiting binding declared in
  `wrangler.jsonc`, as [Limiting password guessing](auth.md#limiting-password-guessing)
  shows.
- Each isolate checks the Worker's vars and secrets against `src/env.ts`
  before it serves, and a script checks them before a deploy with
  `checkEnv`, as [Vars and secrets](env.md) shows.

## Version values

Three different versions may appear around an application:

| Value | Meaning | Change it when | Effect of changing it |
|---|---|---|---|
| npm package version | Version of `@popcomputer/web` | You upgrade the dependency | Selects framework code and public API |
| `setupWeb({ version })` | Inertia asset version | Client assets or their manifest change | The next mismatched GET receives an Inertia location response and reloads the current assets |
| cache `version` | Namespace for one cached value shape | The cached schema or interpretation changes | Reads and writes use a fresh cache key |

`createVersion(manifest)` derives the Inertia asset version from manifest asset
paths. It is unrelated to the npm package version. An application without a
client build yet, or a test, passes a constant (`version: '1'`) and changes it
when the client does; export it so tests send the same `X-Inertia-Version`.

The asset version reloads a visitor already on the site when a deploy changes
the client. A page loaded during a deploy needs more: for a few seconds after
`wrangler deploy`, the previous version can still answer at some edge
locations, with a page naming the previous build's scripts, which the new
deploy no longer serves, and the page would stay blank. `createTemplate`
inlines a small script first in every page's head that reloads the page when
one of the template's own scripts or stylesheets fails to load, or a chunk
Vite loads does (`vite:preloadError`). It reloads at once, then after 2 and 4
seconds, and no more than three times a minute in a tab, so a file missing for
another reason never reloads the page in a loop; a script the application adds
through `head`, such as an analytics tag a blocker refuses, never reloads it.
An application that sends its own `Content-Security-Policy` with a
`script-src` allows the script with `TEMPLATE_SCRIPT_HASH` from
`@popcomputer/web`:

```ts
import { TEMPLATE_SCRIPT_HASH } from '@popcomputer/web'

const scriptSrc = `script-src 'self' ${TEMPLATE_SCRIPT_HASH}`
```
