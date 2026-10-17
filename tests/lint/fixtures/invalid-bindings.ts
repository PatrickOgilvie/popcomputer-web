import { Hono } from 'hono'
import { Schema as S } from 'effect'
import { setupWeb } from '@popcomputer/web'
import { routeBinding } from '@popcomputer/web/effect'
import * as schema from './schema'

const options = { table: 'projects' }
const archived = routeBinding(schema.projects) // expect: require-binding-access

export const web = setupWeb(new Hono(), {
  version: '1',
  render: (page) => JSON.stringify(page),
  schema,
  bindings: {
    project: schema.projects, // expect: require-binding-access
    task: routeBinding(schema.tasks, { table: 'tasks' }), // expect: require-binding-access
    invitation: S.Struct({ id: S.String }), // expect: require-binding-access
    member: { schema: schema.memberships }, // expect: require-binding-access
    archived,
    named: routeBinding(schema.projects, options),
    unscoped: routeBinding(schema.tasks, { scope: {} }), // expect: require-binding-access
  },
})

const routeBindings = {
  organization: schema.organizations, // expect: require-binding-access
}

export const other = setupWeb(new Hono(), { version: '1', render: (page) => JSON.stringify(page), bindings: routeBindings })
