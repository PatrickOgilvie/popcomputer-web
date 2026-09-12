/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
import { Hono } from 'hono'
import { registerErrorHandlers } from '../../src/setup.js'

type TestEnv = {
  Bindings: {
    ENVIRONMENT: string
  }
}

const environment = process.argv[2] ?? 'production'

const app = new Hono<TestEnv>()

app.use('*', async (context, next) => {
  // oxlint-disable-next-line no-param-reassign -- The Hono middleware fixture supplies the environment consumed by the error-boundary test.
  context.env = { ENVIRONMENT: environment }
  await next()
})

app.get('/failure', () => {
  throw new Error('error-handler-logging-fixture')
})

registerErrorHandlers(app)

await app.request('/failure')
