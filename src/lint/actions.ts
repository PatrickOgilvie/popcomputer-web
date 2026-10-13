/**
 * Rules for actions: input read through validation or a contract, answers
 * through response helpers, failures left to the error boundary, and work
 * run by the request.
 *
 * A file is an action module when it imports `action` from
 * `@popcomputer/web/effect`; these rules apply to the whole of it.
 */

import {
  contains,
  EFFECT,
  enclosingCalls,
  Imports,
  isCall,
  isIdentifier,
  isMember,
  propertyName,
  rootOf,
  unwrap,
  WEB_EFFECT,
  type AstNode,
  type CallExpression,
  type ImportDeclaration,
  type LintRule,
  type MemberExpression,
  type NewExpression,
  type VariableDeclarator,
} from './ast.js'

const isActionModule = (imports: Imports) => imports.has(WEB_EFFECT, 'action')

const REQUEST_INPUT = new Set(['json', 'parseBody', 'query', 'queries', 'params', 'param', 'formData', 'text', 'arrayBuffer'])

export const noRawRequestInput: LintRule = {
  meta: {
    type: 'problem',
    docs: { description: 'Actions read request input through validateRequest or an endpoint contract.' },
    messages: {
      input:
        "Read request input with validateRequest(Schema), which decodes it and drops keys the schema does not declare, or declare it in the endpoint's contract. RequestService is for headers and a webhook's raw body.",
    },
  },
  create(context) {
    const imports = new Imports()
    const requests = new Set<string>()

    return {
      ImportDeclaration: (node: ImportDeclaration) => imports.add(node),
      VariableDeclarator(node: VariableDeclarator) {
        const init = node.init === null ? undefined : unwrap(node.init)

        if (init?.type !== 'YieldExpression' || !isIdentifier(node.id)) return

        const argument = 'argument' in init && init.argument !== null && typeof init.argument === 'object'
          // SAFETY: a yield's argument is a syntax tree node.
          ? unwrap(init.argument as AstNode)
          : undefined

        if (isIdentifier(argument) && imports.importedName(argument, WEB_EFFECT) === 'RequestService') requests.add(node.id.name)
      },
      CallExpression(node: CallExpression) {
        const callee = unwrap(node.callee)

        if (!isMember(callee)) return

        const object = unwrap(callee.object)
        const method = propertyName(callee)

        if (method === undefined || !REQUEST_INPUT.has(method) || readsRawRequest(object)) return

        // request.json(), or request.raw().json() reading the body around validation.
        const reader = isIdentifier(object)
          ? object
          : isMember(object) || object.type === 'CallExpression'
            ? rootOf(object)
            : undefined

        if (reader !== undefined && requests.has(reader.name)) context.report({ node, messageId: 'input' })
      },
    }
  },
}

/** Whether a chain goes through `.raw()`, the request itself, as a webhook reads its signed body. */
function readsRawRequest(node: AstNode): boolean {
  let current = unwrap(node)

  for (;;) {
    if (isMember(current)) {
      if (propertyName(current) === 'raw') return true
      current = unwrap(current.object)
    } else if (current.type === 'CallExpression' && 'callee' in current) {
      current = unwrap((current as CallExpression).callee)
    } else {
      return false
    }
  }
}

const CONTEXT_NAMES = new Set(['c', 'ctx', 'context'])
const CONTEXT_MEMBERS = new Set(['req', 'env', 'var', 'executionCtx', 'json', 'html', 'text', 'redirect', 'body', 'header', 'status'])

export const noHonoContextInAction: LintRule = {
  meta: {
    type: 'problem',
    docs: { description: "Actions do not use Hono's context." },
    messages: {
      context:
        "Actions do not see Hono's context: read input with validateRequest, bindings with config.string('NAME'), headers with RequestService, and answer with a response helper.",
    },
  },
  create(context) {
    const imports = new Imports()

    return {
      ImportDeclaration: (node: ImportDeclaration) => imports.add(node),
      MemberExpression(node: MemberExpression) {
        const object = unwrap(node.object)
        const name = propertyName(node)

        if (!isIdentifier(object) || !CONTEXT_NAMES.has(object.name) || name === undefined || !CONTEXT_MEMBERS.has(name)) return

        // Hono's context reaches an action only by closure, as from a
        // handler written around it; setupWeb's `(c) => ...` callbacks are
        // outside any action.
        const inAction = [...enclosingCalls(node)].some((call) => imports.calledName(call, WEB_EFFECT) === 'action')

        if (inAction) context.report({ node, messageId: 'context' })
      },
    }
  },
}

const RUNNERS = new Set(['runPromise', 'runPromiseExit', 'runSync', 'runSyncExit', 'runFork', 'runCallback'])

export const noEffectRunnerInAction: LintRule = {
  meta: {
    type: 'problem',
    docs: { description: 'The request runs an action’s Effects.' },
    messages: {
      runner:
        'The request runs this Effect: yield* it, so its failures reach the error boundary and its services come from the route.',
    },
  },
  create(context) {
    const imports = new Imports()

    return {
      ImportDeclaration: (node: ImportDeclaration) => imports.add(node),
      CallExpression(node: CallExpression) {
        const name = imports.calledName(node, EFFECT, 'Effect')

        if (isActionModule(imports) && name !== undefined && RUNNERS.has(name)) context.report({ node, messageId: 'runner' })
      },
    }
  },
}

const BROAD_RECOVERY = new Set(['catch', 'catchAll', 'catchCause', 'catchAllCause', 'ignore', 'orElseSucceed', 'orDie', 'orDieWith'])

/** The framework's calls whose failures the error boundary answers: the database, sign-in and route models. */
const ANSWERED_BY_BOUNDARY = new Set(['dbQuery', 'dbMutation', 'dbTransaction', 'dbBatch', 'authorize', 'bound', 'validateRequest'])

/** The Effect a recovery applies to: the receiver of `.pipe(Effect.catch(...))`, or the first argument of `Effect.catch(effect, f)`. */
function recovered(node: CallExpression): AstNode | undefined {
  const parent = node.parent

  if (parent !== null && isCall(parent) && parent.arguments.includes(node)) {
    const callee = unwrap(parent.callee)

    if (isMember(callee) && propertyName(callee) === 'pipe') return callee.object
  }

  // Data first, Effect.orDie(effect) or Effect.catch(effect, f); data last, the first argument is the handler.
  const first = node.arguments[0]

  return first === undefined || first.type === 'ArrowFunctionExpression' || first.type === 'FunctionExpression' ? undefined : first
}

export const noCatchAllInAction: LintRule = {
  meta: {
    type: 'problem',
    docs: { description: 'Actions do not recover broadly from database, sign-in or validation failures.' },
    messages: {
      broad:
        'Effect.{{name}} recovers from every failure of {{operation}}: a DatabaseError, a constraint a form field should show, an expired session. Handle the failures this action can answer with Effect.catchTag(...), and let the error boundary answer the rest.',
    },
  },
  create(context) {
    const imports = new Imports()

    return {
      ImportDeclaration: (node: ImportDeclaration) => imports.add(node),
      CallExpression(node: CallExpression) {
        const name = imports.calledName(node, EFFECT, 'Effect')

        if (name === undefined || !BROAD_RECOVERY.has(name)) return

        const effect = recovered(node)
        let operation: string | undefined

        if (effect !== undefined) {
          contains(effect, (candidate) => {
            const called = isCall(candidate) ? imports.calledName(candidate, WEB_EFFECT) : undefined

            if (called !== undefined && ANSWERED_BY_BOUNDARY.has(called)) operation ??= called

            return operation !== undefined
          })
        }

        if (operation !== undefined) context.report({ node, messageId: 'broad', data: { name, operation: `${operation}()` } })
      },
    }
  },
}

export const noRawResponseInAction: LintRule = {
  meta: {
    type: 'problem',
    docs: { description: 'Actions answer with response helpers.' },
    messages: {
      response:
        'Answer with a response helper: json(Schema, value) encodes through a schema, file(...) serves user files with nosniff and a sandbox, noContent(), text(), redirect(...) and render(...) keep content negotiation.',
    },
  },
  create(context) {
    const imports = new Imports()

    return {
      ImportDeclaration: (node: ImportDeclaration) => imports.add(node),
      NewExpression(node: NewExpression) {
        const callee = unwrap(node.callee)

        if (isActionModule(imports) && isIdentifier(callee) && callee.name === 'Response' && !imports.isImported('Response')) {
          context.report({ node, messageId: 'response' })
        }
      },
    }
  },
}

const PROVISION = new Set(['provide', 'provideService', 'provideServiceEffect'])

export const noProvisionInAction: LintRule = {
  meta: {
    type: 'problem',
    docs: { description: 'Services are provided by the setup or the routes, not inside actions.' },
    messages: {
      provide:
        "Provide services in setupWeb's services, or for a group of routes with routes.provide(layer), so the action's type lists what it needs and a test replaces it with testEnv(layer).",
    },
  },
  create(context) {
    const imports = new Imports()

    return {
      ImportDeclaration: (node: ImportDeclaration) => imports.add(node),
      CallExpression(node: CallExpression) {
        const name = imports.calledName(node, EFFECT, 'Effect')

        if (isActionModule(imports) && name !== undefined && PROVISION.has(name)) context.report({ node, messageId: 'provide' })
      },
    }
  },
}

export const requireBackground: LintRule = {
  meta: {
    type: 'problem',
    docs: { description: 'Work that outlives the response runs with background().' },
    messages: {
      background:
        "Run work that outlives the response with background('name', effect), which names it, reports its failure and gives it the request's services.",
    },
  },
  create(context) {
    const imports = new Imports()

    return {
      ImportDeclaration: (node: ImportDeclaration) => imports.add(node),
      CallExpression(node: CallExpression) {
        const callee = unwrap(node.callee)

        if (isActionModule(imports) && isMember(callee) && propertyName(callee) === 'waitUntil') {
          context.report({ node, messageId: 'background' })
        }
      },
    }
  },
}

const ENDPOINT_REDUNDANT = new Set(['validateRequest', 'json', 'jsonOrRender'])

export const noValidationInEndpoint: LintRule = {
  meta: {
    type: 'problem',
    docs: { description: "An endpoint's action reads its input and answers through its contract." },
    messages: {
      validateRequest:
        "This endpoint's contract decodes its input: read it from the handler's argument, ({ params, query, body }) =>, and declare any other field in the contract.",
      json: "Return the success value: the endpoint's contract encodes it with its status. A failure a client tells apart is declared in the contract's errors.",
    },
  },
  create(context) {
    const imports = new Imports()

    return {
      ImportDeclaration: (node: ImportDeclaration) => imports.add(node),
      CallExpression(node: CallExpression) {
        const name = imports.calledName(node, WEB_EFFECT)

        if (name === undefined || !ENDPOINT_REDUNDANT.has(name)) return

        const inEndpoint = [...enclosingCalls(node)].some((call) =>
          imports.calledName(call, WEB_EFFECT) === 'action' && call.arguments.length === 2
        )

        if (inEndpoint) context.report({ node, messageId: name === 'validateRequest' ? 'validateRequest' : 'json' })
      },
    }
  },
}
