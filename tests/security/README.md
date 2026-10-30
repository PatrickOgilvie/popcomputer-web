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
| Undeclared fields, prototype keys, keys naming an inherited method, arrays for strings, the path's record swapped by the body or query | `input.test.ts` |
| Uploads served back as pages, including types a browser may read as XML, such as `text/rdf`; download names breaking out of their header | `served-content.test.ts` |
| Where sign-in returns to, and where a failed form goes back to, from a Referer whose path begins `//`; a redirect to a `javascript:` or `data:` URL an Inertia visit would run | `redirects.test.ts` |
| A path placeholder filled with `..`, `.` or an empty value, reaching another route or host, or a stored one failing every page and job that lists it | `redirects.test.ts`, `../paths.test.ts`, `../effect/endpoint.test.ts` |
| Signed cookies moved or changed; page data breaking out of the HTML | `cookies-and-pages.test.ts` |
| A shared cache keeping one visitor's response; concurrent requests seeing each other's user | `cache-and-isolation.test.ts` |
| A body over the limit, streamed or declared, read whole before anything refused it, by validation or by Better Auth; a list of thousands of invalid items, each kept, observed and answered as an error of its own | `sizes.test.ts`, `../better-auth/seam.test.ts` |
| Back after sign-out showing the previous user's pages from the browser's history | `history.test.ts` |
| Error detail in production; submitted passwords, cookies and tokens, and tokens in a URL or Referer, handed to the error observer; the client address, and an IPv6 network counted as one client; validators made slow; dependency floors | `production.test.ts` |
| Who may load a record, through a route that checks nothing itself | `../effect/careless-route.test.ts` |
| Guards, roles and permissions | `../effect/guard.test.ts` |
| Better Auth's endpoints reached with another body type or path | `../better-auth/seam.test.ts`, `../effect/sign-in-limits.test.ts` |
| Password guesses at one account through another of its sign-ins, or a body naming another account | `../effect/sign-in-limits.test.ts` |
| An account registered with someone else's address keeping a session, password or two-factor challenge once its owner signs in by a link (Better Auth CVE-2026-53516 and GHSA-qq9h-g4jm-xgf3, NextAuth CVE-2022-35924) | `../better-auth/seam.test.ts` |

`gaps.test.ts` lists, as `todo`, the classes the framework does not yet
guard against, so each run shows them.
