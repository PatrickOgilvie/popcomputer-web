# The route table

Each registration adds a row to the application's route table, holding every
fact it states. `routes.toJson()` lists the rows, so a test, a review or an
agent reads who may reach a route and what it loads without reading its
code. The row of `routes.provide(RequireAuthLayer).put(paths.project,
updateProject, { purges: true })`:

```json
{
  "method": "put",
  "path": "/projects/{project}",
  "routePath": "/projects/{project}",
  "models": [
    { "param": "project", "column": "id", "table": "projects", "primaryKey": "id", "access": { "ownedBy": "userId" }, "personal": true }
  ],
  "visitors": "signed-in",
  "guards": 0,
  "middleware": 0,
  "answers": "page",
  "cache": "default",
  "pageCache": false,
  "purges": "records",
  "form": "/projects/{project}"
}
```

- `models`: each record the path names, its table and primary key, who may
  load it (`ownedBy`, `publicWhen`, `"public"`, `"guarded"`, or `"unsaid"`
  for a binding that gives none), and whether it is someone's own.
- `visitors`: `"signed-in"` under `RequireAuthLayer`, `"guests"` under
  `RequireGuestLayer` or `createGuestLayer`, else `"anyone"`. `guards` and
  `middleware` count the `guard(...)` layers and Hono middleware that decide
  before the action.
- `answers`: `"json"` on `routes.jsonApi()` and for `routes.endpoint(...)`,
  whose row also has `"endpoint": true`.
- `cache` is the route's `cache` option, and `pageCache` whether the default
  page cache may keep its pages. `purges` is `"records"` for `purges: true`.
- `form`: where a failed form goes when the request names no page: its
  action's `form(Schema, { page })` or the route's `form` option, or the
  page at its own path. A JSON route, on
  `jsonApi()` or an endpoint, answers a failed form with a 422 and has none.
- `input`: the fields its action's `form(Schema)` decodes, and its
  `bodyLimit` when it sets one. A route whose action declares no input has
  none.

The framework builds each route's handler from its row, so the table says
what the route does. `routes.getRegistry().all()` gives the rows themselves,
an endpoint's with its contract and a route's with its `params` schema.

## Who reaches each route

`routes.access()` reads the table as who reaches each route: a signed-out
visitor, a member who owns the records its path names, and a member who does
not. Each gets what the route's layers, endpoint contract and bindings
answer before the action can use its records:

| Answer | Meaning |
| --- | --- |
| `reaches` | the action runs with the records, and decides |
| `sign-in` | asked to sign in: under `RequireAuthLayer`, an endpoint's `auth: true`, or a record only its owner may load |
| `home` | a signed-in member sent to `auth.homePath` from a guests' page |
| `not-found` | a 404, as a missing record answers |
| `when-public` | records whose columns hold their `publicWhen` values, and a 404 for any other |
| `guard` | a guard decides |

`{ method: 'put', path: '/projects/{project}', signedOut: 'sign-in', owner:
'reaches', stranger: 'not-found' }` is the project's owner-only edit. An
action that refuses more, with `authorize(rule)` or `forbidden`, does so
past the table, which holds what is declared. A review reads it for a write
everyone `reaches` that should not, and `fuzzRequest` makes each such
route's form from the same table, as [Fuzzing](fuzzing.md#requests-to-the-application)
shows.
