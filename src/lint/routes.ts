/**
 * Rules for the route table: a builder's `provide`, `middleware`, `prefix`
 * and `jsonApi` return a new builder and change nothing on the one they are
 * called on. Written as a statement, the new builder is dropped, and the
 * routes registered after it have none of what it adds: a guard, a prefix,
 * the JSON answers.
 */

import { Imports, isCall, isMember, propertyName, rootOf, unwrap, type AstNode, type ImportDeclaration, type LintRule } from './ast.js'

/** The builder methods that derive a new builder. */
const DERIVING = new Set(['provide', 'middleware', 'prefix', 'jsonApi'])

interface ExpressionStatement extends AstNode {
  readonly type: 'ExpressionStatement'
  readonly expression: AstNode
}

/** The expression a statement drops, through `void`. */
function droppedValue(node: AstNode): AstNode {
  const value = unwrap(node)

  if (value.type === 'UnaryExpression' && 'operator' in value && value.operator === 'void' && 'argument' in value) {
    // SAFETY: a unary expression's argument is a syntax tree node.
    return droppedValue(value.argument as AstNode)
  }

  return value
}

export const noDroppedRouteBuilder: LintRule = {
  meta: {
    type: 'problem',
    docs: { description: "A route builder's provide, middleware, prefix or jsonApi is registered on or kept, not dropped." },
    messages: {
      dropped:
        '{{name}}(...) returns a new builder and changes nothing on the one it is called on: as a statement its result is dropped, so the routes registered after it have none of what it adds. Register on what it returns, as {{name}}(...).get(path, action), or keep it in a const and register on that.',
    },
  },
  create(context) {
    const imports = new Imports()

    return {
      ImportDeclaration: (node: ImportDeclaration) => imports.add(node),
      ExpressionStatement(node: ExpressionStatement) {
        const value = droppedValue(node.expression)

        if (!isCall(value)) return

        const callee = unwrap(value.callee)

        if (!isMember(callee)) return

        const name = propertyName(callee)

        if (name === undefined || !DERIVING.has(name)) return

        // Effect's own Layer.provide or Effect.provide is no route builder.
        const root = rootOf(callee.object)
        const source = root === undefined ? undefined : imports.importedName(root, EFFECT_SOURCES)

        if (source !== undefined) return

        context.report({ node, messageId: 'dropped', data: { name } })
      },
    }
  },
}

/** Effect's entrypoints, whose `provide` builds no route. */
const EFFECT_SOURCES: ReadonlySet<string> = new Set(['effect', 'effect/Effect', 'effect/Layer', 'effect/Stream'])
