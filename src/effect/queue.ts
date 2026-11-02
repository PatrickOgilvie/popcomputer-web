/**
 * A queue, declared once: the binding its messages are sent to and the
 * schema they keep. An action or a job sends through the declaration, and
 * `routes.queue(declaration, handle)` consumes what it sent, decoded by the
 * same schema.
 */

import { Effect, Predicate, Schema as S } from 'effect'
import type { Registered } from './register.js'
import { BindingsService } from './services.js'
import { ConfigurationError, QueueSendError } from './errors.js'

/** A queue binding, as far as sending uses it: Cloudflare's `Queue` has these. */
interface QueueBinding {
  send(body: unknown, options?: { readonly contentType?: 'json'; readonly delaySeconds?: number }): Promise<unknown>
  sendBatch(messages: Iterable<{ readonly body: unknown; readonly contentType?: 'json'; readonly delaySeconds?: number }>): Promise<unknown>
}

type DeclaredBindings = Registered<'bindings', never>

/**
 * The name of a queue binding: one the application declares with `send` and
 * `sendBatch`, as Cloudflare's `Queue` has, or any name before it declares
 * its bindings.
 */
export type QueueBindingName = [DeclaredBindings] extends [never]
  ? string
  : Extract<
      keyof {
        [Key in keyof DeclaredBindings as NonNullable<DeclaredBindings[Key]> extends {
          send(...args: never[]): unknown
          sendBatch(...args: never[]): unknown
        } ? Key : never]: unknown
      },
      string
    >

/** How a message is sent: `delaySeconds` holds it back before a consumer receives it. */
export interface QueueSendOptions {
  readonly delaySeconds?: number
}

/** A queue's declaration: send through it, and consume it with `routes.queue`. */
export interface QueueDeclaration<A, I> {
  /** The Worker's binding its messages are sent to. */
  readonly binding: string
  /** The schema its messages keep, encoded as JSON on the way. */
  readonly schema: S.Codec<A, I, never, never>
  /**
   * Send one message. It is encoded by the schema as JSON, which the
   * consumer decodes, so a `Date` or a branded id arrives as it left.
   */
  readonly send: (message: A, options?: QueueSendOptions) => Effect.Effect<void, QueueSendError | ConfigurationError, BindingsService>
  /** Send several messages in one request to the queue, each encoded as `send` encodes one. */
  readonly sendBatch: (messages: ReadonlyArray<A>, options?: QueueSendOptions) => Effect.Effect<void, QueueSendError | ConfigurationError, BindingsService>
}

const declarations = new WeakSet<object>()

/** Whether `queue` made this value, rather than it being a schema. */
export function isQueueDeclaration<A, I>(value: QueueDeclaration<A, I> | S.Codec<A, I, never, never>): value is QueueDeclaration<A, I> {
  return declarations.has(value)
}

const isQueueBinding = (value: unknown): value is QueueBinding =>
  Predicate.hasProperty(value, 'send') && Predicate.isFunction(value.send) &&
  Predicate.hasProperty(value, 'sendBatch') && Predicate.isFunction(value.sendBatch)

/**
 * Declare a queue once, in `src/queues.ts`: the binding its messages go to,
 * as `wrangler.jsonc`'s `queues.producers` names it, and the schema they
 * keep. An action or a job sends with `yield* reminders.send(message)`; the
 * Worker's `queue` handler is `routes.queue(reminders, handle)`. A message is
 * encoded by the schema as JSON and sent as JSON, which the consumer decodes
 * by the same schema. A queue that refuses it fails the send with
 * `QueueSendError`, which the error boundary answers with a 503; a binding
 * the Worker does not have is a configuration error.
 *
 * @example
 * export const reminders = queue('REMINDERS', S.Struct({ orderId: S.String, dueAt: S.Date }))
 *
 * yield* reminders.send({ orderId: order.id, dueAt }, { delaySeconds: 3600 })
 */
export function queue<A, I>(binding: QueueBindingName, schema: S.Codec<A, I, never, never>): QueueDeclaration<A, I> {
  const json = S.toCodecJson(schema)
  // A value of the schema's type that its checks refuse is a bug, not a failure to answer.
  const encode = (message: A) => S.encodeEffect(json)(message).pipe(Effect.orDie)

  const sending = (send: (target: QueueBinding) => Promise<unknown>): Effect.Effect<unknown, QueueSendError | ConfigurationError, BindingsService> =>
    Effect.flatMap(BindingsService, (bindings): Effect.Effect<unknown, QueueSendError | ConfigurationError> => {
      const target: unknown = Object.getOwnPropertyDescriptor(bindings, binding)?.value

      return isQueueBinding(target)
        ? Effect.tryPromise({ try: () => send(target), catch: (cause) => new QueueSendError({ binding, cause }) })
        : Effect.fail(ConfigurationError.queueBindingMissing(binding))
    })

  const declaration: QueueDeclaration<A, I> = {
    binding,
    schema,
    send: (message, options = {}) =>
      Effect.flatMap(encode(message), (body) => sending((target) => target.send(body, { contentType: 'json', ...options }))).pipe(
        Effect.asVoid,
        Effect.withSpan('Web.queueSend', { attributes: { binding } })
      ),
    sendBatch: (messages, options = {}) =>
      Effect.flatMap(Effect.forEach(messages, encode), (bodies) =>
        sending((target) => target.sendBatch(bodies.map((body) => ({ body, contentType: 'json', ...options }))))
      ).pipe(
        Effect.asVoid,
        Effect.withSpan('Web.queueSendBatch', { attributes: { binding, messages: messages.length } })
      ),
  }

  declarations.add(declaration)

  return declaration
}
