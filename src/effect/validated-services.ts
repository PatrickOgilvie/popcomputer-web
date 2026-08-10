/**
 * Validated Request Services
 *
 * Provides validated request data to Effect handlers.
 */

import { Context, type Effect } from 'effect'
import type { Validated } from './validation.js'
export { ValidatedBrand } from './validation.js'

export class ValidatedBodyService extends Context.Tag('@popcomputer/web/ValidatedBody')<
  ValidatedBodyService,
  unknown
>() {}

export class ValidatedQueryService extends Context.Tag('@popcomputer/web/ValidatedQuery')<
  ValidatedQueryService,
  unknown
>() {}

export const validatedBody = <T>(): Effect.Effect<Validated<T>, never, ValidatedBodyService> =>
  ValidatedBodyService as unknown as Effect.Effect<
    Validated<T>,
    never,
    ValidatedBodyService
  >

export const validatedQuery = <T>(): Effect.Effect<Validated<T>, never, ValidatedQueryService> =>
  ValidatedQueryService as unknown as Effect.Effect<
    Validated<T>,
    never,
    ValidatedQueryService
  >
