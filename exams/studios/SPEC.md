# Design studio briefs

## What the owner asked for

> We're a group of design studios. Each studio wants its own private space
> where its people keep client briefs. Everyone in the group signs in with
> their Acme ID, our company login, so nobody has another password to
> forget. Anyone can set up a studio, and whoever sets it up runs it: they
> invite colleagues by email and can make some of them admins, who can invite
> people too and tidy up (delete briefs, remove people). Everyone in a studio
> can read and write its briefs, and delete the ones they wrote. People often
> work in more than one studio, so they need to switch between them.

## The surface the group's reviewer will test

The reviewer has their own test suite, which drives the application through
HTTP exactly as described here. Build everything else as you see fit.

### Test support

`src/test-support.ts` exports:

- `app`: the Hono application, with every route registered.
- `freshEnv(): Promise<unknown>`: the third argument of `app.request(...)`
  for a fresh application served at `http://localhost`: its bindings, with a
  newly created, migrated and empty database, and Acme ID's client ID and
  secret set to any values. Each call returns an independent one.

The reviewer's tests use `testBrowser(app, await freshEnv())` from
`@popcomputer/web/testing`, so pages are requested as Inertia visits
(`X-Inertia: true`) and every form is posted urlencoded.

### Acme ID

Acme ID is an OAuth 2.0 provider, using the authorization code flow (PKCE
welcome):

| Endpoint | |
| --- | --- |
| Authorization page | `https://id.acme.test/oauth/authorize` |
| Token | `POST https://id.acme.test/oauth/token`, form-encoded, client credentials in the body or as Basic authentication; answers `{ "access_token", "token_type": "Bearer", "expires_in" }` |
| User info | `GET https://id.acme.test/oauth/userinfo` with `Authorization: Bearer <access_token>`; answers `{ "id", "sub", "email", "email_verified", "name" }`, where `id` and `sub` are the same, stable for each person |

The client ID and secret are the Worker's `ACME_CLIENT_ID` and
`ACME_CLIENT_SECRET`. The reviewer's tests stand in for Acme ID by answering
`fetch` requests to `https://id.acme.test/` themselves, so the application
must reach Acme ID through `fetch`, at exactly these URLs.

### Signing in

| Request | Answer |
| --- | --- |
| `GET /login` | page `Auth/Login` |
| `POST /auth/acme` | sends the visitor to Acme ID's authorization page, with a `redirect_uri` back to the application. Asked as an Inertia visit, it answers `409` with `X-Inertia-Location`, as Inertia asks for another site; otherwise `303` with `Location`. |
| `GET` the `redirect_uri`, with `code` and `state` | Acme ID sends the browser back here once the person has signed in. Signs them in, making their account the first time, and redirects to `/studios`. |
| `POST /logout` | `303` to `/login`, signed out |

A visitor who is not signed in and requests any page below is redirected to
`/login`.

### Studios

| Request | Who | Answer |
| --- | --- | --- |
| `GET /studios` | anyone signed in | page `Studios/Index`, props `studios`: the studios the visitor belongs to, each `{ id, name, slug, role }`; and `activeStudioId`: the studio the visitor works in now, or `null` |
| `POST /studios` | anyone signed in | fields `name` (non-empty) and `slug` (3 to 40 lowercase letters, digits and dashes); makes a studio the visitor owns (`role` `owner`): `303` to `/studios/{id}`. A field missing or invalid, or a slug already taken: back with `errors.name` or `errors.slug`. |
| `GET /studios/{studio}` | members | page `Studios/Show`, props `studio` (`{ id, name, slug }`), `role` (the visitor's), `members` (each `{ id, name, email, role }`, where `id` is the person's), `briefs` (each `{ id, title, client, authorName }`) and `invitations` (the pending ones, each `{ id, email, role }`, for owners and admins; `[]` for members) |
| `POST /studios/{studio}/switch` | members | makes it the visitor's active studio: `303` to `/studios` |
| `POST /studios/{studio}/invitations` | owners and admins | fields `email` and `role` (`member` or `admin`): `303` to `/studios/{studio}`. A field missing or invalid: back with `errors.email` or `errors.role`. |
| `GET /invitations` | anyone signed in | page `Invitations/Index`, props `invitations`: the pending invitations to the visitor's email, each `{ id, studioName, role }` |
| `POST /invitations/{invitation}/accept` | the person invited | joins the studio with the invitation's role: `303` to `/studios/{studio}` |
| `POST /studios/{studio}/members/{member}/remove` | owners and admins | `{member}` is a member's `id`: removes them from the studio, `303` to `/studios/{studio}` |
| `POST /studios/{studio}/briefs` | members | fields `title` and `client` (both non-empty) and `body`: `303` to `/studios/{studio}`. A field missing: back with `errors.title` or `errors.client`. |
| `GET /studios/{studio}/briefs/{brief}` | members | page `Briefs/Show`, props `brief` (`{ id, title, client, body, authorName }`) |
| `POST /studios/{studio}/briefs/{brief}/delete` | owners, admins and the brief's author | `303` to `/studios/{studio}` |

Someone signed in who is not a member of a studio gets `404` for its pages
and forms. A member whose role does not allow a form gets `403`.

The database is Cloudflare D1.
