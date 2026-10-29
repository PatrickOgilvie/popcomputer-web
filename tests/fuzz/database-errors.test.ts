/**
 * A failed statement's error can quote the values the request sent: Drizzle
 * repeats them after `params:`, SQLite quotes a JSON path or an FTS5 column,
 * Postgres the text a type refused or the key a unique index already holds,
 * MySQL the duplicate entry. Which constraint a write broke must never
 * depend on that text, or a visitor chooses the answer an action gives
 * (`uniqueFieldErrors`, `constraintFieldErrors`). Each driver's error,
 * quoting generated text, must be classified as it is quoting `x`: this
 * finds again run-1's C10 on 1.4.2 and run-2's F9 on 1.5.0.
 */
import { describe } from 'bun:test'
import { Arbitrary, Cause, Effect, Exit } from 'effect'
import { dbMutation } from '../../src/effect/database'
import { DatabaseService } from '../../src/effect/services'
import { anyText, oneOf, pick, property, show, textOf } from './property'

/** Each driver's error for a statement that failed quoting `value`, by the shape that driver gives it. */
const DRIVER_ERRORS = {
  'D1 SQLITE_ERROR': (value) => new Error(`D1_ERROR: JSON path error near '${value}': SQLITE_ERROR`),
  'bun:sqlite JSON path': (value) => Object.assign(new Error(`JSON path error near '${value}'`), { code: 'SQLITE_ERROR' }),
  'libsql FTS5 column': (value) => Object.assign(new Error(`SQLITE_ERROR: no such column: ${value}`), { code: 'SQLITE_ERROR', rawCode: 1 }),
  'Postgres invalid text': (value) => Object.assign(new Error(`invalid input syntax for type uuid: "${value}"`), { code: '22P02' }),
  'Postgres unique key': (value) =>
    Object.assign(new Error('duplicate key value violates unique constraint "pages_slug_unique"'), {
      code: '23505',
      detail: `Key (slug)=(${value}) already exists.`,
      constraint: 'pages_slug_unique',
    }),
  'MySQL duplicate entry': (value) =>
    Object.assign(new Error(`Duplicate entry '${value}' for key 'pages.pages_slug_unique'`), { code: 'ER_DUP_ENTRY', errno: 1062 }),
} satisfies Readonly<Record<string, (value: string) => Error>>

type Driver = keyof typeof DRIVER_ERRORS

/** Drizzle's wrapper around a driver's error, repeating the statement's bound values. */
function drizzleWrapped(driverError: Error, value: string): Error {
  const query = 'insert into "pages" ("slug") values (?)'

  return Object.assign(new Error(`Failed query: ${query}\nparams: ${value}`), { query, params: [value], cause: driverError })
}

/** What dbMutation answers when its statement fails with `error`: the failure's tag, and a violation's details. */
async function answerTo(error: Error): Promise<string> {
  const exit = await Effect.runPromiseExit(
    // SAFETY: the statement fails before reading the client, so no client is given.
    dbMutation(() => Promise.reject(error)).pipe(Effect.provideService(DatabaseService, {} as never))
  )

  if (Exit.isSuccess(exit)) return 'succeeded'

  const failure = Cause.findErrorOption(exit.cause)

  if (failure._tag === 'None') return `died: ${Cause.pretty(exit.cause).split('\n')[0]}`

  if (failure.value._tag !== 'DatabaseConstraintViolation') return show({ _tag: failure.value._tag })

  const { _tag, constraint, columns, constraintName } = failure.value

  return show({ _tag, constraint, columns, constraintName })
}

/** Text a visitor might send to steer the answer: each driver's constraint phrases, and the punctuation around them. */
const SPOOF_PIECES = [
  'UNIQUE constraint failed: ',
  'NOT NULL constraint failed: ',
  'CHECK constraint failed: ',
  'FOREIGN KEY constraint failed',
  'users.email',
  'title_not_blank',
  "index 'users_handle_unique'",
  ', ',
  ': ',
  ': SQLITE_CONSTRAINT',
  ' (extended: SQLITE_CONSTRAINT_UNIQUE)',
  'SQLITE_CONSTRAINT_TRIGGER',
  "' for key 'users.users_email_unique'",
  ') already exists. Key (email)=(',
  'duplicate key value violates unique constraint "users_email_unique"',
  '"',
  "'",
  '\n',
  'a',
] as const

describe('database failures', () => {
  property(
    'are classified by what failed, never by the request text the error quotes',
    Arbitrary.all([
      // SAFETY: DRIVER_ERRORS is a literal with entries, so its keys are a non-empty list of its drivers.
      pick(Object.keys(DRIVER_ERRORS) as [Driver, ...Driver[]]),
      pick([false, true]),
      oneOf(textOf(SPOOF_PIECES, 6), anyText),
    ]),
    async ([driver, wrapped, value]) => {
      const failed = (text: string) => {
        const driverError = DRIVER_ERRORS[driver](text)

        return wrapped ? drizzleWrapped(driverError, text) : driverError
      }
      const [answer, plain] = await Promise.all([answerTo(failed(value)), answerTo(failed('x'))])

      return answer === plain ? undefined : `${driver}${wrapped ? ' in Drizzle' : ''} quoting ${show(value)} answers ${answer}, not ${plain}`
    },
    { runs: 1000 }
  )
})
