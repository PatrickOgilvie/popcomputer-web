/**
 * Rules for the database: writes scoped and typed, transactions that hold
 * only database work, and SQL that binds its values.
 */

import {
  EFFECT,
  enclosingCalls,
  Imports,
  isCall,
  isIdentifier,
  isMember,
  propertyName,
  unwrap,
  WEB_EFFECT,
  type AstNode,
  type CallExpression,
  type ImportDeclaration,
  type LintRule,
  type MemberExpression,
  type TemplateLiteral,
  type YieldExpression,
} from './ast.js'

const OPERATIONS = new Set(['dbQuery', 'dbMutation', 'dbTransaction', 'dbBatch'])

/** The framework database operation whose argument holds `node`, innermost first. */
function enclosingOperation(node: AstNode, imports: Imports): string | undefined {
  for (const call of enclosingCalls(node)) {
    const name = imports.calledName(call, WEB_EFFECT)

    if (name !== undefined && OPERATIONS.has(name)) return name
  }

  return undefined
}

/** `x.update(table)` or `x.delete(table)`: the method, when the call is one. */
function writeMethod(call: CallExpression, methods: ReadonlySet<string>): string | undefined {
  const callee = unwrap(call.callee)

  if (!isMember(callee)) return undefined

  const name = propertyName(callee)

  return name !== undefined && methods.has(name) ? name : undefined
}

/** The names of the methods chained onto `call`, as `.set(...).where(...)`. */
function chainedMethods(call: CallExpression): ReadonlyArray<string> {
  const names: string[] = []
  let current: AstNode = call

  for (;;) {
    const parent = current.parent

    if (isMember(parent) && parent.object === current) {
      const name = propertyName(parent)
      if (name !== undefined) names.push(name)
      current = parent
    } else if (isCall(parent) && parent.callee === current) {
      current = parent
    } else if (parent !== null && (parent.type === 'ParenthesizedExpression' || parent.type === 'TSNonNullExpression' || parent.type === 'TSAsExpression')) {
      current = parent
    } else {
      return names
    }
  }
}

function tableName(call: CallExpression): string {
  const table = call.arguments[0]

  if (table === undefined) return 'the table'
  if (isIdentifier(table)) return table.name
  if (isMember(table)) return propertyName(table) ?? 'the table'

  return 'the table'
}

const SCOPED_WRITES = new Set(['update', 'delete'])

export const noUnscopedWrite: LintRule = {
  meta: {
    type: 'problem',
    docs: { description: 'An update or delete in a database operation names the rows it changes with .where(...).' },
    messages: {
      unscoped:
        "This {{method}} has no .where(...), so it changes every row of {{table}}. Scope it to the record it means, by the bound model or the signed-in user: .where(eq({{table}}.id, record.id)).",
    },
  },
  create(context) {
    const imports = new Imports()

    return {
      ImportDeclaration: (node: ImportDeclaration) => imports.add(node),
      CallExpression(node: CallExpression) {
        const method = writeMethod(node, SCOPED_WRITES)

        if (method === undefined || enclosingOperation(node, imports) === undefined) return
        if (chainedMethods(node).includes('where')) return

        context.report({ node, messageId: 'unscoped', data: { method, table: tableName(node) } })
      },
    }
  },
}

const WRITES = new Set(['insert', 'update', 'delete'])

export const noWriteInDbQuery: LintRule = {
  meta: {
    type: 'problem',
    docs: { description: 'dbQuery reads; writes run in dbMutation, dbTransaction or dbBatch.' },
    messages: {
      write:
        'dbQuery reads. Run this {{method}} with dbMutation, so a failure is a typed DatabaseError and a constraint it breaks can be shown on a form field.',
    },
    fixable: 'code',
  },
  create(context) {
    const imports = new Imports()

    return {
      ImportDeclaration: (node: ImportDeclaration) => imports.add(node),
      CallExpression(node: CallExpression) {
        const method = writeMethod(node, WRITES)

        if (method === undefined) return

        for (const call of enclosingCalls(node)) {
          const name = imports.calledName(call, WEB_EFFECT)

          if (name === undefined || !OPERATIONS.has(name)) continue
          if (name !== 'dbQuery') return

          const mutation = imports.localName(WEB_EFFECT, 'dbMutation')
          const callee = unwrap(call.callee)

          context.report({
            node,
            messageId: 'write',
            data: { method },
            fix: mutation === undefined || !isIdentifier(callee) ? undefined : (fixer) => fixer.replaceText(callee, mutation),
          })
          return
        }
      },
    }
  },
}

const EXTERNAL_GLOBALS = new Set(['fetch', 'setTimeout', 'setInterval', 'queueMicrotask'])
const EXTERNAL_WEB = new Set(['background', 'betterAuthCall'])
const EXTERNAL_CACHE = new Set(['cache', 'cacheGet', 'cacheSet', 'cacheInvalidate', 'cacheInvalidatePrefix', 'invalidateCacheTags'])
const EXTERNAL_EFFECT = new Set(['sleep', 'promise', 'tryPromise'])
const CACHE = new Set(['@popcomputer/web/cache'])

export const noExternalWorkInTransaction: LintRule = {
  meta: {
    type: 'problem',
    docs: { description: 'A transaction holds only database work.' },
    messages: {
      external:
        'A transaction holds its locks until it commits. Call {{name}} before or after dbTransaction, so a slow or failing call cannot hold the locks, and nothing outside the database happens for writes that roll back.',
    },
  },
  create(context) {
    const imports = new Imports()

    return {
      ImportDeclaration: (node: ImportDeclaration) => imports.add(node),
      CallExpression(node: CallExpression) {
        const inTransaction = [...enclosingCalls(node)].some((call) => imports.calledName(call, WEB_EFFECT) === 'dbTransaction')

        if (!inTransaction) return

        const callee = unwrap(node.callee)
        let name: string | undefined

        if (isIdentifier(callee) && EXTERNAL_GLOBALS.has(callee.name) && !imports.isImported(callee.name)) {
          name = `${callee.name}()`
        } else {
          const web = imports.calledName(node, WEB_EFFECT)
          const cache = imports.calledName(node, CACHE)
          const effect = imports.calledName(node, EFFECT, 'Effect')

          if (web !== undefined && EXTERNAL_WEB.has(web)) name = `${web}()`
          else if (cache !== undefined && EXTERNAL_CACHE.has(cache)) name = `${cache}()`
          else if (effect !== undefined && EXTERNAL_EFFECT.has(effect)) name = `Effect.${effect}()`
          else if (isMember(callee) && propertyName(callee) === 'waitUntil') name = 'waitUntil()'
        }

        if (name !== undefined) context.report({ node, messageId: 'external', data: { name } })
      },
    }
  },
}

const SQL_KEYWORDS = /\b(select|insert|update|delete|where|from|into|values|set)\b/i
const RAW_SQL_METHODS = new Set(['run', 'execute', 'prepare', 'exec', 'query', 'all'])

/** A string built from values at runtime: a template with expressions, or a concatenation. */
function interpolatedText(node: AstNode): string | undefined {
  const value = unwrap(node)

  if (value.type === 'TemplateLiteral') {
    const template = value as TemplateLiteral

    return template.expressions.length > 0 ? template.quasis.map((quasi) => quasi.value.raw).join(' ') : undefined
  }

  if (value.type === 'BinaryExpression' && 'operator' in value && value.operator === '+') {
    return 'concatenation'
  }

  return undefined
}

export const noSqlInterpolation: LintRule = {
  meta: {
    type: 'problem',
    docs: { description: 'SQL binds its values as parameters.' },
    messages: {
      raw: "sql.raw sends its text as SQL as it is, so a value in it can change the statement. Build the statement with sql`... ${value}`, which binds each value as a parameter.",
      string:
        "This SQL is built from a string with values in it, so a value can change the statement. Use Drizzle's query builder, or sql`... ${value}`, which binds each value as a parameter.",
    },
  },
  create(context) {
    const imports = new Imports()
    const DRIZZLE = new Set(['drizzle-orm'])

    return {
      ImportDeclaration: (node: ImportDeclaration) => imports.add(node),
      CallExpression(node: CallExpression) {
        const callee = unwrap(node.callee)

        if (!isMember(callee)) return

        const method = propertyName(callee)
        const object = unwrap(callee.object)
        const argument = node.arguments[0]

        if (argument === undefined) return

        if (method === 'raw' && isIdentifier(object) && imports.importedName(object, DRIZZLE) === 'sql') {
          const literal = unwrap(argument)
          const constant = literal.type === 'Literal' || (literal.type === 'TemplateLiteral' && (literal as TemplateLiteral).expressions.length === 0)

          if (!constant) context.report({ node, messageId: 'raw' })
          return
        }

        if (method === undefined || !RAW_SQL_METHODS.has(method)) return

        const text = interpolatedText(argument)

        if (text !== undefined && (text === 'concatenation' || SQL_KEYWORDS.test(text))) {
          context.report({ node, messageId: 'string' })
        }
      },
    }
  },
}

export const noDatabaseServiceInAction: LintRule = {
  meta: {
    type: 'problem',
    docs: { description: 'Actions reach the database through dbQuery, dbMutation, dbTransaction and dbBatch.' },
    messages: {
      service:
        'Use dbQuery to read and dbMutation, dbTransaction or dbBatch to write: they run on the request’s database, or the open transaction, and fail with typed errors. DatabaseService is for adapters.',
    },
  },
  create(context) {
    const imports = new Imports()

    return {
      ImportDeclaration: (node: ImportDeclaration) => imports.add(node),
      YieldExpression(node: YieldExpression) {
        const argument = node.argument === null ? undefined : unwrap(node.argument)

        if (!imports.has(WEB_EFFECT, 'action') || !isIdentifier(argument)) return
        if (imports.importedName(argument, WEB_EFFECT) === 'DatabaseService') context.report({ node, messageId: 'service' })
      },
      MemberExpression(node: MemberExpression) {
        if (imports.has(WEB_EFFECT, 'action') && propertyName(node) === '$client') context.report({ node, messageId: 'service' })
      },
    }
  },
}
