import { Effect } from 'effect'
import { Hono } from 'hono'
import { effectRoutes } from '@popcomputer/web/effect'

const app = new Hono()

effectRoutes(app).get(
  '/packaged-cli-fixture',
  Effect.succeed(new Response('fixture')),
  { name: 'fixture.packaged' }
)

export default app
