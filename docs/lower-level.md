# Lower-level composition

Most applications should use `setupWeb`. The lower-level APIs are available
when another composition root owns part of the middleware stack:

```ts
// src/manual-app.ts
import { Hono } from 'hono'
import {
  createTemplate,
  createVersion,
  web,
  webContext,
  webDefaults,
  webServices,
} from '@popcomputer/web'
import { effectBridge } from '@popcomputer/web/effect'
import manifest from '../dist/manifest.json'
import { createDb } from './db'
import type { Bindings } from './env'

type Env = { Bindings: Bindings }

const app = new Hono<Env>()

app.use('*', webDefaults())
app.use('*', web({
  version: createVersion(manifest),
  render: createTemplate({ title: 'Projects' }),
}))
app.use('*', webServices<Env>((c) => ({
  db: createDb(c.env.DATABASE_URL),
})))
app.use('*', effectBridge())

app.use('/admin/*', async (c, next) => {
  const { authUser } = webContext(c)
  if (!authUser) return c.redirect('/login')
  await next()
})
```

`webDefaults()` comes first, so it sees every response: it is the policy
`setupWeb` installs, as three middleware also exported on their own.
`securityHeaders()` sends `nosniff`, a `Referrer-Policy` and refuses framing;
`privateByDefault()` marks a response that states no `Cache-Control` as
`private, no-cache`, or `no-store` when it is signed in or sets a cookie, so
Workers Cache never hands a page rendered for one visitor to the next; and
`verifyOrigin()` refuses a state-changing request from another site with a
JSON 403. It takes `setupWeb`'s `security` options:
`webDefaults({ verifyOrigin: { allowedOrigins: ['myapp://'] } })`. Without
`privateByDefault()` around it, `web()` gives what it answers the same
`Cache-Control` itself, so a stack composed before `webDefaults()` existed
keeps its pages out of shared caches too; it still lacks the headers and the
origin check.

Add `pageCache({ version })` after `webDefaults()` and before `webServices()`
to keep the default page cache; on a hit it answers before database and auth
setup.

Register routes with `effectRoutes(app)`. It cannot see which services the
hand-written middleware provides, so it accepts actions that use any framework
service and reports an unconfigured one at runtime, as a configuration error.
Pass extra service types it should accept as `effectRoutes<Env, Mailer>(app)`.

Plain Hono handlers can render through `c.var.web`:

```ts
app.get('/', (c) => c.var.web.render('Home'))
```

Effect actions normally use the higher-level `render` helper. The underlying
service is available as `PageService` when direct composition is useful.
