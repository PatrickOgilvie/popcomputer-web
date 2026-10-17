# Security regression tests

Each file attacks the framework the way a class of bug attacked another
framework: its header names the advisories it guards against. A test here
that fails is a vulnerability, not a style regression. The fixture
application in `app.ts` binds every record with who may load it, and logs
every statement the database receives.

| Class | File |
| --- | --- |
| A guarded path spelled another way; headers that tell a framework about the request; method overrides; Host and forwarded headers | `requests.test.ts` |
| Writes from another site, for every body type, spelling, `Origin: null` and method | `cross-site.test.ts` |
| Undeclared fields, prototype keys, arrays for strings, the path's record swapped by the body or query | `input.test.ts` |
| Uploads served back as pages; download names breaking out of their header | `served-content.test.ts` |
| Where sign-in returns to, and where a failed form goes back to | `redirects.test.ts` |
| Signed cookies moved or changed; page data breaking out of the HTML | `cookies-and-pages.test.ts` |
| A shared cache keeping one visitor's response; concurrent requests seeing each other's user | `cache-and-isolation.test.ts` |
| Error detail in production; the client address; validators made slow; dependency floors | `production.test.ts` |
| Who may load a record, through a route that checks nothing itself | `../effect/careless-route.test.ts` |
| Guards, roles and permissions | `../effect/guard.test.ts` |
| Better Auth's endpoints reached with another body type or path | `../better-auth/seam.test.ts`, `../effect/sign-in-limits.test.ts` |

`gaps.test.ts` lists, as `todo`, the classes the framework does not yet
guard against, so each run shows them.
