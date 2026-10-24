/**
 * Rules for where code runs. A Worker's isolate serves request after request,
 * so what a module holds, every visitor shares; tests' fakes stay in tests;
 * and a page, which runs in the browser, imports no server code.
 */

import {
  Imports,
  isIdentifier,
  isMember,
  propertyName,
  unwrap,
  type AstNode,
  type CallExpression,
  type ImportDeclaration,
  type LintRule,
  type VariableDeclarator,
} from './ast.js'
import { isPagePath, isTestFile, isToolingPath, projectPath } from './files.js'

/** The framework's entrypoint for page components, whose importers run in the browser. */
const WEB_REACT = '@popcomputer/web/react'

interface VariableDeclaration extends AstNode {
  readonly type: 'VariableDeclaration'
  readonly kind: string
  readonly declare?: boolean
  readonly declarations: ReadonlyArray<VariableDeclarator>
}

const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'])

/** Whether `node` runs when a function is called, rather than when the module loads. */
function inFunction(node: AstNode): boolean {
  for (let current = node.parent; current !== null; current = current.parent) {
    if (FUNCTIONS.has(current.type)) return true
  }

  return false
}

/** Whether a declaration is one of the module's own statements, `export let` included. */
function atModuleScope(node: VariableDeclaration): boolean {
  const parent = node.parent

  return parent?.type === 'Program' || (parent?.type === 'ExportNamedDeclaration' && parent.parent?.type === 'Program')
}

/** What a module-scope `const` holds, when it is a collection a function can change. */
function collectionKind(init: AstNode | null): string | undefined {
  const value = init === null ? undefined : unwrap(init)

  if (value?.type === 'ArrayExpression') return 'array'
  if (value?.type !== 'NewExpression' || !('callee' in value)) return undefined

  // SAFETY: a new expression's callee is a syntax tree node.
  const callee = unwrap(value.callee as AstNode)

  return isIdentifier(callee) && (callee.name === 'Map' || callee.name === 'Set') ? callee.name : undefined
}

const MUTATORS = new Set(['set', 'add', 'delete', 'clear', 'push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill'])

const bindingName = (declarator: VariableDeclarator): string => (isIdentifier(declarator.id) ? declarator.id.name : 'this binding')

const SHARED_STATE_ADVICE =
  'Keep a request\'s values inside its action, provide a service built once with web.services({ app }), and keep data across requests with cache(key, effect, schema, { ttl, tags }).'

export const noModuleLevelMutableState: LintRule = {
  meta: {
    type: 'problem',
    docs: { description: "An application module holds no state that changes: a Worker's isolate shares it across requests." },
    messages: {
      variable:
        `A module-scope {{kind}} lives as long as the Worker's isolate, which serves request after request and visitor after visitor, so what one request writes to "{{name}}" the next one reads. ${SHARED_STATE_ADVICE}`,
      collection:
        `"{{name}}" is a module-scope {{collection}} a function changes, so it holds what every request the Worker's isolate serves writes to it, one visitor's data beside the next one's. ${SHARED_STATE_ADVICE}`,
    },
  },
  create(context) {
    const imports = new Imports()
    const variables: Array<{ readonly node: VariableDeclarator; readonly kind: string }> = []
    const collections = new Map<string, { readonly node: VariableDeclarator; readonly kind: string }>()
    const mutated = new Set<string>()

    /** Records a change to a module-scope name made inside a function. */
    const change = (target: AstNode, node: AstNode) => {
      const object = unwrap(target)

      if (isIdentifier(object) && inFunction(node)) mutated.add(object.name)
    }

    return {
      ImportDeclaration: (node: ImportDeclaration) => imports.add(node),
      VariableDeclaration(node: VariableDeclaration) {
        if (node.declare === true) return

        // A var anywhere outside a function is the module's, wherever it is written.
        const shared = node.kind === 'var' ? !inFunction(node) : node.kind === 'let' && atModuleScope(node)

        if (shared) {
          for (const declarator of node.declarations) variables.push({ node: declarator, kind: node.kind })
          return
        }

        if (node.kind !== 'const' || !atModuleScope(node)) return

        for (const declarator of node.declarations) {
          const kind = collectionKind(declarator.init)

          if (kind !== undefined && isIdentifier(declarator.id)) collections.set(declarator.id.name, { node: declarator, kind })
        }
      },
      CallExpression(node: CallExpression) {
        const callee = unwrap(node.callee)
        const method = isMember(callee) ? propertyName(callee) : undefined

        if (isMember(callee) && method !== undefined && MUTATORS.has(method)) change(callee.object, node)
      },
      AssignmentExpression(node: AstNode) {
        const left = 'left' in node && typeof node.left === 'object' && node.left !== null
          // SAFETY: an assignment's target is a syntax tree node.
          ? unwrap(node.left as AstNode)
          : undefined

        if (isMember(left)) change(left.object, node)
      },
      'Program:exit'() {
        const path = projectPath(context)

        if (variables.length === 0 && ![...collections.keys()].some((name) => mutated.has(name))) return
        // Tests, tools and scripts run once, outside the Worker; a page runs in one visitor's browser.
        if (isToolingPath(path) || isPagePath(path) || imports.importsFrom(WEB_REACT) || isTestFile(context, path)) return

        for (const { node, kind } of variables) {
          context.report({ node, messageId: 'variable', data: { kind, name: bindingName(node) } })
        }

        for (const [name, { node, kind }] of collections) {
          if (mutated.has(name)) context.report({ node, messageId: 'collection', data: { name, collection: kind } })
        }
      },
    }
  },
}
