# Installation

To start from a complete application, create one from the
[demo](https://github.com/PatrickOgilvie/popcomputer-web-demo): React pages
from a Cloudflare Worker, with D1, Better Auth and tests, ready to deploy:

```bash
bun create PatrickOgilvie/popcomputer-web-demo my-app
```

It needs Node.js 22 or later (better 24, which portless is built for), Bun,
and portless running as a service, which the demo's README sets up
[once per computer](https://github.com/PatrickOgilvie/popcomputer-web-demo#once-per-computer).
Then `bun run dev` in `my-app` serves it at `https://my-app.localhost`.

To add the package to an application of your own:

```bash
bun add @popcomputer/web effect hono
```

Add only the optional integrations your application uses:

```bash
bun add better-auth                         # Better Auth integration
bun add drizzle-orm                         # Drizzle route model binding
bun add @inertiajs/react react react-dom    # React client
```

And the tools the documentation's setup uses while developing:

```bash
bun add -d drizzle-kit                      # migrations from the Drizzle schema
bun add -d @cloudflare/workers-types        # types for the Worker's bindings
bun add -d @electric-sql/pglite             # tests on Postgres, in process
bun add -d miniflare                        # tests on Cloudflare D1, in process
```

Applications built while developing the package used drizzle-kit
`^0.31.11`, `@cloudflare/workers-types` `^5.20261013.1`, PGlite `^0.5.9` and
Miniflare `^4.20260730.0`.

The application's `tsconfig.json` needs the DOM library and JSX for its React
pages, and Cloudflare's types for its bindings (`bun init` writes neither):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM"],
    "jsx": "react-jsx",
    "types": ["bun", "@cloudflare/workers-types"],
    "strict": true,
    "skipLibCheck": true
  }
}
```

The examples read a row from `.returning()` as `const [project] = ...`; with
`noUncheckedIndexedAccess` on, guard the row before using it.

The package's lint rules check what types cannot see, such as an update
without a `where`, a transaction that calls the network, or SQL built from a
string. They run in [Oxlint](https://oxc.rs), with nothing to configure
beyond turning them on:

```bash
bun add -d oxlint
```

```ts
// oxlint.config.ts
import { defineConfig } from 'oxlint'
import { webLint } from '@popcomputer/web/lint'

export default defineConfig(webLint())
```

`bunx oxlint` then reports each mistake with the API to use instead and why;
[Lint rules](lint-rules.md) lists them. Oxlint loads `oxlint.config.ts` as an
ES module: give `package.json` `"type": "module"`, or Node warns
`MODULE_TYPELESS_PACKAGE_JSON` on every run.

Coding agents should read `node_modules/@popcomputer/web/AGENTS.md`, a short
rulebook naming the one API to use for each task, and the files in
`node_modules/@popcomputer/web/docs/` as a task needs them:
[Which API for which task](which-api.md) names the file for each. Reference
the rulebook from the application's own `AGENTS.md` or `CLAUDE.md`. The same
rules ship as a Claude skill in `skills/popcomputer-web/SKILL.md`; copy that
directory into `~/.claude/skills/` or a project's `.claude/skills/`.

Effect and Hono are peer dependencies so an application owns one Effect runtime
and one Hono type identity. `better-auth` and `drizzle-orm` are optional peers:
an app without them still bundles for Cloudflare Workers. Route model binding
loads `drizzle-orm` when a bound route runs and reports a configuration error
if it isn't installed.
The package supports Effect 4 (`^4.0.0`, tested with 4.0.3), Hono 4.13.5 or
later 4.x (tested with 4.13.13), Better Auth 1.7 from 1.7.7, and Drizzle ORM
0.45.2 or later 0.x (tested with 0.45.4). Each floor is the first release
with the security fixes for the parts this package uses: Hono's cookies and
body parsing, Drizzle's identifiers, Better Auth's redirects and tokens. Hono 5 and Drizzle 1.0 are not
supported yet: both change APIs this package uses. Better Auth's range is one
minor version, the one the package's Better Auth tests pass against: they
drive its sign-in, sessions, two-factor, magic links, OAuth providers,
organizations, bearer tokens and admin plugins through an application, and
check [Better Auth's tables](auth-tables.md) against what Better Auth needs. A
release supports a newer Better Auth once they pass against it.
