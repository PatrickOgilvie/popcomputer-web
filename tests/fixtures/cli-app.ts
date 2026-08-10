import { Effect } from 'effect'
import { Hono } from 'hono'
import { effectRoutes } from '../../src/effect/routing.js'

const app = new Hono()

effectRoutes(app).get(
  '/cli-fixture',
  Effect.succeed(new Response('fixture')),
  { name: 'fixture.show' }
)

export default app
