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
  context.env = { ENVIRONMENT: environment }
  await next()
})

app.get('/failure', () => {
  throw new Error('error-handler-logging-fixture')
})

registerErrorHandlers(app)
await app.request('/failure')
