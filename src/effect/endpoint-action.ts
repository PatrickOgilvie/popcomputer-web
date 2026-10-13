/**
 * The server half of an endpoint contract: the action that implements it,
 * with its input decoded before it runs and its success and declared
 * failures encoded after.
 */

import { Effect, Predicate, Schema as S } from 'effect'
import type {
  Endpoint,
  EndpointError,
  EndpointErrorSchema,
  EndpointInput,
  EndpointSpec,
  EndpointSuccess,
} from '../endpoint.js'
import { HttpError, type ValidationError } from './errors.js'
import { json, noContent } from './responses.js'
import { RequestService, type ResponseFactoryService } from './services.js'
import { validateRequest, validateUnknown } from './validation.js'

/** The action implementing an endpoint, which `routes.endpoint` registers on the endpoint's method and path. */
export interface EndpointAction<Ep extends Endpoint, Err, R> {
  readonly endpoint: Ep
  readonly effect: Effect.Effect<Response, Err, R>
}

/** A failure an endpoint declares, with the status it answers and the schema its fields encode with. */
interface DeclaredFailure {
  readonly status: number
  readonly schema: EndpointErrorSchema
  readonly is: (value: unknown) => boolean
}

function declaredFailures(spec: EndpointSpec): ReadonlyArray<DeclaredFailure> {
  const failures: DeclaredFailure[] = []

  for (const [status, declared] of Object.entries(spec.errors ?? {})) {
    for (const schema of Array.isArray(declared) ? declared : [declared]) {
      failures.push({ status: Number(status), schema, is: S.is(S.toType(schema)) })
    }
  }

  return failures
}

const isTagged = (value: unknown): value is { readonly _tag: string } =>
  Predicate.hasProperty(value, '_tag') && typeof value._tag === 'string'

/** The message a declared failure's envelope reports: its own, or its tag. */
function messageOf(failure: { readonly _tag: string }): string {
  const message: unknown = Reflect.get(failure, 'message')

  return typeof message === 'string' && message !== '' ? message : failure._tag
}

/** A declared failure as the error boundary answers it: its status, its tag, and its fields as the body. */
function answerDeclared(declared: DeclaredFailure, failure: { readonly _tag: string }): Effect.Effect<never, HttpError> {
  return S.encodeUnknownEffect(S.toCodecJson(declared.schema))(failure).pipe(
    Effect.mapError((issue) => new Error(`The ${failure._tag} failure does not match the schema its endpoint declares: ${issue.message}`)),
    Effect.orDie,
    Effect.flatMap((body) =>
      Effect.fail(new HttpError({ status: declared.status, message: messageOf(failure), body, tag: failure._tag }))
    )
  )
}

/** The request's headers by lowercase name, as a declared `headers` schema decodes them. */
function headerFields(headers: Headers): Record<string, string> {
  const fields: Record<string, string> = {}

  headers.forEach((value, name) => {
    fields[name.toLowerCase()] = value
  })

  return fields
}

/**
 * Implement an endpoint: `handler` receives the input the endpoint declares,
 * decoded, and returns its success value. A request whose input does not
 * decode is answered `422` with each field's message before the handler
 * runs; a failure the endpoint declares is answered with its status.
 */
export function endpointAction<const Ep extends Endpoint, Err, R>(
  ep: Ep,
  handler: (input: EndpointInput<Ep>) => Effect.Effect<EndpointSuccess<Ep>, Err, R>
): EndpointAction<
  Ep,
  Exclude<Err, EndpointError<Ep>> | ValidationError,
  R | RequestService | ResponseFactoryService
> {
  const spec: EndpointSpec = ep.spec
  const failures = declaredFailures(spec)

  const effect = Effect.gen(function* () {
    const request = yield* RequestService
    const input: Record<string, unknown> = { params: request.params() }

    if (spec.query !== undefined) {
      input.query = yield* validateRequest(spec.query, { request: { order: ['query'] } })
    }

    if (spec.body !== undefined) {
      input.body = yield* validateRequest(spec.body, { request: { order: ['body'] } })
    }

    if (spec.headers !== undefined) {
      input.headers = yield* validateUnknown(spec.headers, headerFields(request.headers))
    }

    // SAFETY: input holds the path's parameters and each part the spec
    // declares, decoded with its schema, which is what EndpointInput<Ep> says.
    const value: unknown = yield* handler(input as EndpointInput<Ep>).pipe(
      Effect.catch((failure): Effect.Effect<never, Err | HttpError> => {
        const declared = failures.find((candidate) => candidate.is(failure))

        // A failure the endpoint declares is tagged: its schema decoded it.
        return declared === undefined || !isTagged(failure) ? Effect.fail(failure) : answerDeclared(declared, failure)
      })
    )

    if (spec.success !== undefined) return yield* json(spec.success, value, spec.status ?? 200)
    if (spec.status !== undefined && spec.status !== 204) return new Response(null, { status: spec.status })

    return yield* noContent()
  })

  // SAFETY: catchIf removed the declared failures, which it answers as
  // HttpError, so the action fails only with the rest, HttpError and
  // ValidationError from decoding the input.
  return { endpoint: ep, effect: effect as Effect.Effect<Response, Exclude<Err, EndpointError<Ep>> | ValidationError, R | RequestService | ResponseFactoryService> }
}
