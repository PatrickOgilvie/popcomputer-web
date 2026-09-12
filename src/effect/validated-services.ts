/**
 * Validated Request Services
 *
 * Provides validated request data to Effect handlers.
 */

import { Context, Effect } from 'effect'
import type { Validated } from './validation.js'

export { ValidatedBrand } from './validation.js'

export class ValidatedBodyService extends Context.Service<
  ValidatedBodyService,
  unknown
>()('@popcomputer/web/ValidatedBody') {}

export class ValidatedQueryService extends Context.Service<
  ValidatedQueryService,
  unknown
>()('@popcomputer/web/ValidatedQuery') {}

export const validatedBody = <T>(): Effect.Effect<Validated<T>, never, ValidatedBodyService> =>
  Effect.map(ValidatedBodyService, (body) => {
    // SAFETY: validateRequestData populated this service from the route's body schema before the handler can access it.
    return body as Validated<T>
  })

export const validatedQuery = <T>(): Effect.Effect<Validated<T>, never, ValidatedQueryService> =>
  Effect.map(ValidatedQueryService, (query) => {
    // SAFETY: validateRequestData populated this service from the route's query schema before the handler can access it.
    return query as Validated<T>
  })
