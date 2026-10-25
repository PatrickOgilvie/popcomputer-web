/**
 * Rules for Effects: a framework call builds an Effect, which does nothing
 * until something runs it. Written as a statement, it is built and dropped,
 * and the write, the flash or the redirect silently never happens.
 */

import {
  EFFECT,
  Imports,
  isCall,
  isIdentifier,
  isMember,
  propertyName,
  unwrap,
  WEB_AUTH,
  WEB_CACHE,
  WEB_EFFECT,
  type AstNode,
  type ImportDeclaration,
  type LintRule,
  type VariableDeclarator,
  type YieldExpression,
} from './ast.js'

/** The framework's functions that return an Effect, by entrypoint. */
const WEB_EFFECTS = new Set([
  'dbQuery', 'dbMutation', 'dbTransaction', 'dbBatch',
  'authorize', 'bound', 'validateRequest', 'validateUnknown',
  'render', 'redirect', 'back', 'json', 'text', 'noContent', 'file', 'jsonOrRender', 'ifChanged',
  'notFound', 'forbidden', 'invalid', 'httpError', 'redirectNow',
  'flash', 'share', 'responseHeader', 'purgeCache', 'tagCache', 'background', 'intendedUrl', 'reportEffectError',
])
const AUTH_EFFECTS = new Set(['betterAuthRedirect', 'betterAuthCall'])
const CACHE_EFFECTS = new Set(['cache', 'cacheGet', 'cacheSet', 'cacheInvalidate', 'cacheInvalidatePrefix', 'invalidateCacheTags'])

/** Effect's functions that run an Effect or return something else, which a statement may call. */
const NOT_EFFECTS = new Set([
  'runPromise', 'runPromiseExit', 'runSync', 'runSyncExit', 'runFork', 'runCallback', 'fn', 'fnUntraced', 'isEffect',
])

/** A cookie declaration's members that are Effects: `cart.read` and `cart.clear`, and `cart.set(value)`'s result. */
const COOKIE_EFFECTS = new Set(['read', 'clear'])

interface ExpressionStatement extends AstNode {
  readonly type: 'ExpressionStatement'
  readonly expression: AstNode
}

export const noFloatingEffect: LintRule = {
  meta: {
    type: 'problem',
    docs: { description: 'An Effect a framework call builds is yielded or returned, so it runs.' },
    messages: {
      floating:
        '{{name}} builds an Effect and drops it: nothing runs it, so it never happens. yield* it inside Effect.gen, or return it, so the request runs it and its failures reach the error boundary.',
      bareYield:
        'yield {{name}} without * types its result as never rather than the value the Effect succeeds with: yield* it.',
    },
  },
  create(context) {
    const imports = new Imports()
    // Cookies the file declares, and statements to check once every declaration is known.
    const cookies = new Set<string>()
    const statements: ExpressionStatement[] = []

    const isCookie = (node: AstNode): boolean => {
      const value = unwrap(node)

      if (isCall(value)) return imports.calledName(value, WEB_EFFECT) === 'cookie'
      if (!isIdentifier(value)) return false

      // A cookie declared in another module is known by its name, as `cartCookie`.
      return cookies.has(value.name) || (imports.isImported(value.name) && /cookie$/i.test(value.name))
    }

    const cookieName = (node: AstNode): string => {
      const value = unwrap(node)

      return isIdentifier(value) ? value.name : 'cookie(...)'
    }

    /** The call a node builds an Effect with, named as the message shows it. */
    const effectCall = (node: AstNode): string | undefined => {
      const value = unwrap(node)

      if (isMember(value)) {
        const member = propertyName(value)

        return member !== undefined && COOKIE_EFFECTS.has(member) && isCookie(value.object)
          ? `${cookieName(value.object)}.${member}`
          : undefined
      }

      if (!isCall(value)) return undefined

      const web = imports.calledName(value, WEB_EFFECT)
      const auth = imports.calledName(value, WEB_AUTH)
      const cache = imports.calledName(value, WEB_CACHE)
      const effect = imports.calledName(value, EFFECT, 'Effect')

      if (web !== undefined && WEB_EFFECTS.has(web)) return `${web}(...)`
      if (auth !== undefined && AUTH_EFFECTS.has(auth)) return `${auth}(...)`
      if (cache !== undefined && CACHE_EFFECTS.has(cache)) return `${cache}(...)`
      if (effect !== undefined) return NOT_EFFECTS.has(effect) ? undefined : `Effect.${effect}(...)`

      const callee = unwrap(value.callee)

      if (!isMember(callee)) return undefined

      const method = propertyName(callee)

      // dbMutation(...).pipe(Effect.orDie) is the same Effect, piped.
      if (method === 'pipe') {
        const piped = effectCall(callee.object)

        return piped === undefined ? undefined : `${piped}.pipe(...)`
      }

      return method === 'set' && isCookie(callee.object) ? `${cookieName(callee.object)}.set(...)` : undefined
    }

    /** The Effect a statement's expression builds and drops, through `void`, `&&`, `?:` and commas. */
    const dropped = (node: AstNode): string | undefined => {
      const value = unwrap(node)

      if (value.type === 'UnaryExpression' && 'operator' in value && value.operator === 'void' && 'argument' in value) {
        // SAFETY: a unary expression's argument is a syntax tree node.
        return dropped(value.argument as AstNode)
      }
      if (value.type === 'LogicalExpression' && 'right' in value) {
        // SAFETY: a logical expression's operands are syntax tree nodes.
        return dropped(value.right as AstNode)
      }
      if (value.type === 'ConditionalExpression' && 'consequent' in value && 'alternate' in value) {
        // SAFETY: a conditional expression's branches are syntax tree nodes.
        return dropped(value.consequent as AstNode) ?? dropped(value.alternate as AstNode)
      }
      if (value.type === 'SequenceExpression' && 'expressions' in value && Array.isArray(value.expressions)) {
        for (const expression of value.expressions as ReadonlyArray<AstNode>) {
          const name = dropped(expression)

          if (name !== undefined) return name
        }

        return undefined
      }

      return effectCall(value)
    }

    return {
      ImportDeclaration: (node: ImportDeclaration) => imports.add(node),
      VariableDeclarator(node: VariableDeclarator) {
        if (isIdentifier(node.id) && node.init !== null && isCall(unwrap(node.init)) && isCookie(node.init)) cookies.add(node.id.name)
      },
      ExpressionStatement: (node: ExpressionStatement) => statements.push(node),
      YieldExpression(node: YieldExpression) {
        const name = node.delegate || node.argument === null ? undefined : effectCall(node.argument)

        if (name !== undefined) context.report({ node, messageId: 'bareYield', data: { name } })
      },
      'Program:exit'() {
        for (const statement of statements) {
          const name = dropped(statement.expression)

          if (name !== undefined) context.report({ node: statement, messageId: 'floating', data: { name } })
        }
      },
    }
  },
}
