import { Layer } from 'effect'
import { RequireAuthLayer } from '@popcomputer/web/effect'
import { routes } from './app'
import { showDashboard, showStatus } from './actions'

routes.provide(RequireAuthLayer) // expect: no-dropped-route-builder
routes.middleware(async (_c, next) => next()) // expect: no-dropped-route-builder
routes.prefix('/api') // expect: no-dropped-route-builder
routes.jsonApi() // expect: no-dropped-route-builder
void routes.provide(RequireAuthLayer).prefix('/admin') // expect: no-dropped-route-builder

routes.group((route) => {
  route.provide(RequireAuthLayer) // expect: no-dropped-route-builder
  route.get('/dashboard', showDashboard)
})

// Registered on, or kept: no mistake.
routes.provide(RequireAuthLayer).get('/dashboard', showDashboard)
routes.prefix('/api').jsonApi().get('/api/status', showStatus)
export const authed = routes.provide(RequireAuthLayer)

// Effect's own provide builds no route.
Layer.provide(Layer.empty, Layer.empty)
