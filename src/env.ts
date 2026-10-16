/**
 * The Worker's vars and secrets, declared once: each one's schema, whether
 * it is a secret, whether the Worker needs it, and how to generate it. The
 * declaration types the bindings, `setupWeb` checks it when an isolate
 * starts, and an application's scripts check it locally and on Cloudflare.
 *
 * This entrypoint imports only `effect`, so scripts that run outside the
 * Worker, such as a deploy, read the same declaration.
 */

import { Cause, Exit, Result, Schema as S, SchemaIssue } from 'effect'
import { createStructuredError, ErrorCodes } from './effect/error-catalog.js'
import type { ErrorContext, StructuredError } from './effect/error-types.js'

/** A schema for one var or secret: the Worker receives each as a string. */
export type EnvSchema = S.Codec<unknown, string, never, never>

/** A secret: set with `wrangler secret put` and kept in `.dev.vars` locally, never in `wrangler.jsonc`. */
export interface EnvSecret<Schema extends EnvSchema = EnvSchema, Optional extends boolean = boolean> {
  readonly kind: 'secret'
  readonly schema: Schema
  readonly optional: Optional
  /** Makes a new value, for a secret nobody has to choose, such as a signing key. */
  readonly generate: (() => string) | undefined
}

/** A plain var: set in `wrangler.jsonc`'s `vars`, and committed with the code. */
export interface EnvVariable<Schema extends EnvSchema = EnvSchema, Optional extends boolean = boolean> {
  readonly kind: 'variable'
  readonly schema: Schema
  readonly optional: Optional
}

/** One var or secret of the declaration. */
export type EnvEntry = EnvSecret | EnvVariable

/** The Worker's vars and secrets by name, as `defineEnv` declares them. */
export interface EnvDeclaration<Entries extends Readonly<Record<string, EnvEntry>> = Readonly<Record<string, EnvEntry>>> {
  readonly entries: Entries
}

/** Options for {@link secret}. */
export interface SecretOptions<Optional extends boolean> {
  /** The Worker runs without it. Leave it out for a secret the Worker needs. */
  readonly optional?: Optional
  /**
   * Makes a value when the secret has none, such as {@link randomSecret}: the
   * first deploy uploads one, and a development server's first run writes
   * one locally. A secret without it must be set by hand.
   */
  readonly generate?: () => string
}

/** Options for {@link variable}. */
export interface VariableOptions<Optional extends boolean> {
  /** The Worker runs without it. Leave it out for a var the Worker needs. */
  readonly optional?: Optional
}

/**
 * Declares a secret, whose value `schema` checks; any non-empty string
 * without one. A secret is never shown in a failure, and a check that finds
 * one in `wrangler.jsonc`'s `vars`, where it would be committed, refuses it.
 *
 * @example
 * BETTER_AUTH_SECRET: secret(S.String.check(S.isMinLength(32)), { generate: randomSecret }),
 * RESEND_API_KEY: secret(S.String.check(S.isStartingWith('re_'))),
 * SENTRY_DSN: secret(S.String, { optional: true }),
 */
export function secret<Schema extends EnvSchema = typeof S.NonEmptyString>(
  schema?: Schema,
  options?: SecretOptions<false>
): EnvSecret<Schema, false>
export function secret<Schema extends EnvSchema = typeof S.NonEmptyString>(
  schema: Schema | undefined,
  options: SecretOptions<true> & { readonly optional: true }
): EnvSecret<Schema, true>
export function secret(schema?: EnvSchema, options: SecretOptions<boolean> = {}): EnvSecret {
  return {
    kind: 'secret',
    schema: schema ?? S.NonEmptyString,
    optional: options.optional ?? false,
    generate: options.generate,
  }
}

/**
 * Declares a plain var, whose value `schema` checks; any string without
 * one. Its value is set in `wrangler.jsonc`'s `vars`.
 *
 * @example
 * ENVIRONMENT: variable(S.Literals(['development', 'production', 'test'])),
 * TIME_ZONE: variable(S.String, { optional: true }),
 */
export function variable<Schema extends EnvSchema = typeof S.String>(
  schema?: Schema,
  options?: VariableOptions<false>
): EnvVariable<Schema, false>
export function variable<Schema extends EnvSchema = typeof S.String>(
  schema: Schema | undefined,
  options: VariableOptions<true> & { readonly optional: true }
): EnvVariable<Schema, true>
export function variable(schema?: EnvSchema, options: VariableOptions<boolean> = {}): EnvVariable {
  return { kind: 'variable', schema: schema ?? S.String, optional: options.optional ?? false }
}

/**
 * Declares the Worker's vars and secrets once. Pass the result to
 * `setupWeb`'s `env`, which checks each isolate's bindings against it, and
 * type the bindings with {@link EnvBindings}.
 *
 * @example
 * export const env = defineEnv({
 *   BETTER_AUTH_SECRET: secret(S.String.check(S.isMinLength(32)), { generate: randomSecret }),
 *   ENVIRONMENT: variable(S.Literals(['development', 'production', 'test'])),
 * })
 *
 * export type Bindings = EnvBindings<typeof env> & { DB: D1Database }
 */
export function defineEnv<const Entries extends Readonly<Record<string, EnvEntry>>>(entries: Entries): EnvDeclaration<Entries> {
  return { entries }
}

type Simplify<T> = { [Key in keyof T]: T[Key] } & {}

/**
 * The bindings a declaration describes, as the Worker receives them: each
 * var and secret as its schema's string, optional ones optional.
 */
export type EnvBindings<Declaration> = Declaration extends EnvDeclaration<infer Entries>
  ? Simplify<
      {
        -readonly [Name in keyof Entries as Entries[Name]['optional'] extends true ? never : Name]:
          Entries[Name]['schema']['Encoded']
      } & {
        -readonly [Name in keyof Entries as Entries[Name]['optional'] extends true ? Name : never]?:
          Entries[Name]['schema']['Encoded']
      }
    >
  : never

/** A new random secret: 32 random bytes in base64, for a secret's `generate`. */
export function randomSecret(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
}

/** A var or secret that is missing, or whose value its schema refuses. Never holds the value. */
export interface EnvProblem {
  readonly name: string
  readonly kind: EnvEntry['kind']
  readonly problem: 'missing' | 'invalid'
  /** What the schema expects, for an invalid value. */
  readonly expected?: string
}

const formatIssue = SchemaIssue.makeFormatterDefault()

/**
 * Hides the value wherever a message repeats it, as a filter's own message
 * might. Short values are left, so a word such as "test" in a message stays.
 */
function redact(message: string, value: string): string {
  return value.length >= 8 ? message.split(value).join('[redacted]') : message
}

/**
 * Checks values, such as a Worker's bindings or a `.dev.vars` file, against
 * the declaration, and lists each var or secret that is missing or invalid.
 * An empty secret is missing. Values are never in the result.
 *
 * @example
 * const problems = checkEnv(env, { ...wranglerVars, ...devVars })
 * for (const problem of problems) console.error(describeEnvProblem(problem))
 */
export function checkEnv(env: EnvDeclaration, values: object): ReadonlyArray<EnvProblem> {
  const problems: Array<EnvProblem> = []

  for (const [name, entry] of Object.entries(env.entries)) {
    const value: unknown = Object.getOwnPropertyDescriptor(values, name)?.value

    if (value === undefined || (entry.kind === 'secret' && value === '')) {
      if (!entry.optional) problems.push({ name, kind: entry.kind, problem: 'missing' })
      continue
    }

    const decoded = S.decodeUnknownExit(entry.schema)(value, { errors: 'all' })

    if (Exit.isFailure(decoded)) {
      const error = Cause.findError(decoded.cause)
      const message = Result.isSuccess(error) && S.isSchemaError(error.success)
        ? formatIssue(error.success.issue)
        : 'a value its schema accepts'
      const expected = message.split('\n').map((line) => line.trim()).filter((line) => !line.startsWith('at ')).join('; ')

      problems.push({
        name,
        kind: entry.kind,
        problem: 'invalid',
        expected: typeof value === 'string' ? redact(expected, value) : expected,
      })
    }
  }

  return problems
}

/** One problem as a sentence: `The secret RESEND_API_KEY is missing.` */
export function describeEnvProblem(problem: EnvProblem): string {
  const subject = `The ${problem.kind} ${problem.name}`

  return problem.problem === 'missing'
    ? `${subject} is missing.`
    : `${subject} is invalid: ${(problem.expected ?? 'its schema refuses it').replace(/\.$/, '')}.`
}

const EnvProblemSchema = S.Struct({
  name: S.String,
  kind: S.Literals(['secret', 'variable']),
  problem: S.Literals(['missing', 'invalid']),
  expected: S.optional(S.String),
})

/**
 * The Worker's bindings do not match the env declaration: `setupWeb` fails a
 * request with it, and `routes.scheduled`, `routes.queue` and `routes.run`
 * reject with it. Its message names each var and secret, never a value.
 * Outside development, a page shows only that the server failed.
 */
export class EnvInvalid extends S.TaggedError<EnvInvalid>()('EnvInvalid', {
  message: S.String,
  problems: S.Array(EnvProblemSchema),
}) {
  /** The error for these problems, with a message listing each. */
  static of(problems: ReadonlyArray<EnvProblem>): EnvInvalid {
    const lines = problems.map((problem) => `- ${describeEnvProblem(problem)}`)

    return new EnvInvalid({
      message: ["The Worker's vars and secrets do not match the env declaration:", ...lines].join('\n'),
      problems,
    })
  }

  get httpStatus(): number {
    return 500
  }

  toStructured(context: ErrorContext = {}): StructuredError {
    const names = this.problems.map((problem) => problem.name).join(', ')
    const base = createStructuredError(ErrorCodes.CFG_306_ENV_INVALID, { names }, context)
    const hint = "Set a secret with `wrangler secret put NAME`, and in .dev.vars for the development server; set a var in wrangler.jsonc's vars."

    return { ...base, message: this.message, fixes: [{ description: hint }, ...base.fixes] }
  }
}
