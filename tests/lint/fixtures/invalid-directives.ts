import { sql } from 'drizzle-orm'

declare const column: string

/* oxlint-disable-next-line popcomputer-web/no-sql-interpolation */ // expect: require-disable-reason
export const byName = sql.raw(`SELECT * FROM projects ORDER BY ${column}`)

export const byDate = sql.raw(`SELECT * FROM projects ORDER BY ${column}`) /* eslint-disable-line popcomputer-web/no-sql-interpolation */ // expect: require-disable-reason

/* oxlint-disable-next-line popcomputer-web/no-floating-effect - the dash is single */ // expect: require-disable-reason
export const single = column

/* oxlint-disable-next-line popcomputer-web/no-floating-effect -- . */ // expect: require-disable-reason
export const punctuation = column

/* oxlint-disable-next-line */ // expect: require-disable-reason
export const everything = column

/* oxlint-disable popcomputer-web/no-sql-interpolation, popcomputer-web/no-unscoped-write */ // expect: require-disable-reason
export const region = sql.raw(`SELECT * FROM tasks ORDER BY ${column}`)
/* oxlint-enable popcomputer-web/no-sql-interpolation, popcomputer-web/no-unscoped-write */

// A reason after two dashes, or a rule that is not the framework's, passes.
// oxlint-disable-next-line popcomputer-web/no-sql-interpolation -- the column comes from a fixed list of names
export const sorted = sql.raw(`SELECT * FROM projects ORDER BY ${column}`)
/* eslint-disable-next-line popcomputer-web/no-sql-interpolation -- the column comes from a fixed list */
export const sortedAgain = sql.raw(`SELECT * FROM projects ORDER BY ${column}`)
// oxlint-disable-next-line no-console
console.log(column)
