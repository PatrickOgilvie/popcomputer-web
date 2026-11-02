/**
 * Effect Action Composables
 *
 * Composable helpers for building Effect-based request handlers.
 * Actions are fully opt-in - yield* only what you need.
 */

import { Effect, type Schema as S } from 'effect'
import type { Endpoint, EndpointError, EndpointInput, EndpointSuccess } from '../endpoint.js'
import { endpointAction, type EndpointAction } from './endpoint-action.js'
import type { Redirect, UnauthorizedError, ValidationError } from './errors.js'
import type { RequestService, ResponseFactoryService } from './services.js'
import { validateRequest, type ValidateOptions } from './validation.js'

/**
 * The input an action declares, with how it reads it: the schema the
 * request's fields decode with, and validateRequest's options.
 */
export interface FormInputDeclaration<A, I> {
  readonly schema: S.Codec<A, I>
  readonly options: ValidateOptions
}

const declarations = new WeakSet<object>()

/**
 * Declare the input an action takes, as its first argument:
 * `action(form(UpdateProject), (input) => ...)` decodes the request's route
 * parameters, query and body with the schema before the handler runs, as
 * `validateRequest` does, and the route table records the schema. A form
 * that fails goes back to its page with the field errors, and a JSON client
 * gets a 422. The options are validateRequest's: `bodyLimit` for a form that
 * uploads large files, `request` for the sources it reads.
 *
 * @example
 * export const updateProject = action(form(UpdateProject), (input) =>
 *   Effect.gen(function* () {
 *     const project = yield* bound('project')
 *
 *     yield* dbMutation((db) => db.update(projects).set(input).where(eq(projects.id, project.id)))
 *
 *     return yield* redirect(paths.project, { project: project.id })
 *   })
 * )
 */
export function form<A, I>(schema: S.Codec<A, I>, options: ValidateOptions = {}): FormInputDeclaration<A, I> {
  const declared = { schema, options }

  declarations.add(declared)

  return declared
}

/** The input each action made with `action(form(Schema), handler)` declares, which the route table records. */
const actionInputs = new WeakMap<object, FormInputDeclaration<unknown, unknown>>()

/** The input `action` declares, if it was made with `action(form(Schema), handler)`. */
export const actionInputOf = (action: object): FormInputDeclaration<unknown, unknown> | undefined => actionInputs.get(action)

/**
 * Mark an Effect as a route action.
 *
 * Everything an action does is opt-in: it yields the services and helpers it
 * needs and ends every branch with a response helper.
 *
 * @example
 * const createProject = action(
 *   Effect.gen(function* () {
 *     const auth = yield* authorize()
 *     const input = yield* validateRequest(S.Struct({ name: requiredString }))
 *
 *     const [project] = yield* dbMutation((db) =>
 *       db.insert(projects).values({ ...input, userId: auth.user.id }).returning()
 *     )
 *
 *     return yield* redirect(paths.project, { project: project.id })
 *   })
 * )
 */
export function action<R, E>(
  handler: Effect.Effect<Response | Redirect, E, R>
): Effect.Effect<Response | Redirect, E, R>
/**
 * An action that takes the input its `form(Schema)` declares: the handler
 * receives it decoded, after the route's layers and before anything the
 * handler does, and ends every branch with a response helper. Input that
 * does not decode goes back to the form's page with its errors, or answers a
 * JSON client 422, and the handler does not run. The route table records the
 * schema, so a test or a review reads what each route accepts.
 *
 * @example
 * export const createProject = action(form(CreateProject), (input) =>
 *   Effect.gen(function* () {
 *     const auth = yield* authorize()
 *     const [project] = yield* dbMutation((db) =>
 *       db.insert(projects).values({ ...input, userId: auth.user.id }).returning()
 *     )
 *
 *     return yield* redirect(paths.project, { project: project.id })
 *   })
 * )
 */
export function action<A, I, E, R>(
  input: FormInputDeclaration<A, I>,
  handler: (input: A) => Effect.Effect<Response | Redirect, E, R>
): Effect.Effect<Response | Redirect, E | ValidationError, R | RequestService>
/**
 * Implement an endpoint declared with `endpoint` from
 * `@popcomputer/web/endpoint`: the handler receives the input it declares,
 * decoded, and returns its success value, which the response encodes. Input
 * that does not decode is answered `422` before the handler runs, and a
 * failure the endpoint declares is answered with its status. Register it with
 * `routes.endpoint(action)`.
 *
 * @example
 * export const createPlace = action(endpoints.createPlace, ({ body }) =>
 *   Effect.gen(function* () {
 *     const auth = yield* authorize()
 *     const [place] = yield* dbMutation((db) =>
 *       db.insert(places).values({ ...body, ownerId: auth.user.id }).returning()
 *     )
 *
 *     return place
 *   })
 * )
 */
export function action<const Ep extends Endpoint, Err, R>(
  endpoint: Ep,
  handler: (input: EndpointInput<Ep>) => Effect.Effect<EndpointSuccess<Ep>, Err, R>
): EndpointAction<Ep, Exclude<Err, EndpointError<Ep>> | ValidationError | UnauthorizedError, R | RequestService | ResponseFactoryService>
export function action(
  first: Effect.Effect<Response | Redirect, unknown, unknown> | FormInputDeclaration<unknown, unknown> | Endpoint,
  handler?: (input: never) => Effect.Effect<unknown, unknown, unknown>
): Effect.Effect<Response | Redirect, unknown, unknown> | EndpointAction<Endpoint, unknown, unknown> {
  if (Effect.isEffect(first)) return first
  if (handler === undefined) {
    throw new TypeError('action(form(Schema), handler) and action(endpoint, handler) take the handler that receives the input.')
  }

  if (isFormInput(first)) {
    // SAFETY: the overload above typed the handler by this schema's decoded input.
    const handle = handler as (input: unknown) => Effect.Effect<Response | Redirect, unknown, unknown>
    const declared = Effect.flatMap(validateRequest(first.schema, first.options), handle)

    actionInputs.set(declared, first)

    return declared
  }

  // SAFETY: the overload above typed the handler by this endpoint.
  return endpointAction(first, handler as (input: EndpointInput<Endpoint>) => Effect.Effect<void, unknown, unknown>)
}

/** Whether `form` made this value, rather than `endpoint`. */
function isFormInput(value: FormInputDeclaration<unknown, unknown> | Endpoint): value is FormInputDeclaration<unknown, unknown> {
  return declarations.has(value)
}
