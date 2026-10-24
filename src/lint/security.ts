/**
 * Rules for the protections the framework gives by default. A setting that
 * weakens one may be meant, so the rule warns rather than refuses, and asks
 * for a reasoned disable comment, which puts the choice where a reviewer
 * reads it.
 */

import {
  Imports,
  isIdentifier,
  isObject,
  keyName,
  unwrap,
  WEB,
  WEB_AUTH,
  WEB_EFFECT,
  type AstNode,
  type CallExpression,
  type ImportDeclaration,
  type LintRule,
  type ObjectExpression,
  type Property,
  type VariableDeclarator,
} from './ast.js'

/** The most bytes of a body the framework reads by default, `DEFAULT_BODY_LIMIT`. */
const DEFAULT_BODY_LIMIT = 1024 * 1024

const BETTER_AUTH = new Set(['better-auth', 'better-auth/minimal'])

/** The entrypoints whose options the rule reads by name: setupWeb's and webDefaults', validateRequest's, betterAuthHandler's. */
const WEB_SOURCES = ['@popcomputer/web', '@popcomputer/web/effect', '@popcomputer/web/auth']

const ACKNOWLEDGE =
  'If it is meant, say why where it is set, // oxlint-disable-next-line popcomputer-web/explain-security-loosening -- <reason>, so a reviewer sees the choice.'

const isProperty = (node: AstNode | null | undefined): node is Property => node?.type === 'Property'

const isLiteral = (node: AstNode, value: unknown): boolean =>
  node.type === 'Literal' && (node as { readonly value?: unknown }).value === value

/** An object literal's property by name. */
function property(object: ObjectExpression, name: string): Property | undefined {
  return object.properties.find((candidate): candidate is Property => isProperty(candidate) && keyName(candidate) === name)
}

/** The name of the property whose value is the object `node` belongs to: `verifyOrigin` for `{ verifyOrigin: { allowedOrigins } }`. */
function ownerKey(node: Property): string | undefined {
  const object = node.parent
  const owner = object?.parent

  return isProperty(owner) && owner.value === object ? keyName(owner) : undefined
}

/** Whether a value is an empty array literal, which allows nothing. */
const isEmptyArray = (node: AstNode): boolean => {
  const value = unwrap(node)

  return value.type === 'ArrayExpression' && 'elements' in value && Array.isArray(value.elements) && value.elements.length === 0
}

/** A number written as a literal, arithmetic on literals, or a module constant holding one. */
function numberOf(node: AstNode, constants: ReadonlyMap<string, AstNode>, depth = 0): number | undefined {
  const value = unwrap(node)

  if (depth > 8) return undefined
  if (value.type === 'Literal') {
    const literal = (value as { readonly value?: unknown }).value

    return typeof literal === 'number' ? literal : undefined
  }
  if (isIdentifier(value)) {
    const constant = constants.get(value.name)

    return constant === undefined ? undefined : numberOf(constant, constants, depth + 1)
  }
  if (value.type === 'BinaryExpression' && 'left' in value && 'right' in value && 'operator' in value) {
    // SAFETY: a binary expression's operands are syntax tree nodes.
    const left = numberOf(value.left as AstNode, constants, depth + 1)
    const right = numberOf(value.right as AstNode, constants, depth + 1)

    if (left === undefined || right === undefined) return undefined
    if (value.operator === '*') return left * right
    if (value.operator === '+') return left + right
    if (value.operator === '**') return left ** right
  }

  return undefined
}

export const explainSecurityLoosening: LintRule = {
  meta: {
    type: 'suggestion',
    docs: { description: 'A setting that weakens a protection the framework gives says why.' },
    messages: {
      publicBinding:
        `{ public: true } lets anyone, signed in or not, load every record of this table by its id. Use ownedBy, publicWhen or guarded when only some records are anyone's. ${ACKNOWLEDGE}`,
      settable:
        `settable lets a visitor write these user fields through Better Auth's API, without the application's actions checking them. Use settable: [] and an action that validates the field with validateRequest, unless Better Auth's client SDK must set it. ${ACKNOWLEDGE}`,
      allowedOrigins:
        `allowedOrigins lets pages on these origins post to the application with the visitor's cookies, past the cross-site request check. Use it only for an origin the application owns, such as a native app's. ${ACKNOWLEDGE}`,
      originCheckOff:
        `verifyOrigin: false turns off the check that refuses a state-changing request from another site, so a page anywhere can post a form with the visitor's cookies. Use allowedOrigins to admit one origin instead. ${ACKNOWLEDGE}`,
      headersOff:
        `headers: false sends none of the security headers the framework adds, so another site may frame the application's pages to trick a visitor into clicking, and responses lose nosniff and the referrer policy. Use headers: { frames: 'same-origin' } to let the application frame its own pages. ${ACKNOWLEDGE}`,
      bodyLimit:
        `bodyLimit {{bytes}} reads more than the 1 MiB default of a body before it refuses one, which every visitor can send. Use the larger limit on the one action that takes large files, validateRequest(Schema, { bodyLimit }), rather than for every route. ${ACKNOWLEDGE}`,
      historyPlain:
        `{{setting}} keeps signed-in pages' props in the browser's history unencrypted, so Back after sign-out can show the previous user's pages to the next person at the computer. Use the default, 'signed-in', which encrypts them with a key the tab forgets when the session ends. ${ACKNOWLEDGE}`,
      emailVerification:
        `Password sign-in without requireEmailVerification: true signs in someone who registers another person's address first, and what they hold survives the owner's own sign-in by a link or a provider. Use emailAndPassword: { enabled: true, requireEmailVerification: true }. ${ACKNOWLEDGE}`,
      autoSignIn:
        `autoSignInAfterVerification: true signs in an owner who follows the link for an account someone else registered with their address, to an account whose password that someone chose. Use the default, false, and let the member sign in next. ${ACKNOWLEDGE}`,
    },
  },
  create(context) {
    const imports = new Imports()
    const constants = new Map<string, AstNode>()
    const bodyLimits: Property[] = []

    const usesWeb = () => WEB_SOURCES.some((source) => imports.importsFrom(source))

    const checkBetterAuth = (options: ObjectExpression) => {
      const password = property(options, 'emailAndPassword')
      const passwordOptions = password === undefined ? undefined : unwrap(password.value)

      if (password !== undefined && isObject(passwordOptions)) {
        const enabled = property(passwordOptions, 'enabled')
        const verified = property(passwordOptions, 'requireEmailVerification')

        if (enabled !== undefined && isLiteral(unwrap(enabled.value), true) && (verified === undefined || !isLiteral(unwrap(verified.value), true))) {
          context.report({ node: verified ?? password, messageId: 'emailVerification' })
        }
      }

      const verification = property(options, 'emailVerification')
      const verificationOptions = verification === undefined ? undefined : unwrap(verification.value)
      const autoSignIn = isObject(verificationOptions) ? property(verificationOptions, 'autoSignInAfterVerification') : undefined

      if (autoSignIn !== undefined && isLiteral(unwrap(autoSignIn.value), true)) context.report({ node: autoSignIn, messageId: 'autoSignIn' })
    }

    return {
      ImportDeclaration: (node: ImportDeclaration) => imports.add(node),
      VariableDeclarator(node: VariableDeclarator) {
        if (isIdentifier(node.id) && node.init !== null && node.parent?.type === 'VariableDeclaration' && 'kind' in node.parent && node.parent.kind === 'const') {
          constants.set(node.id.name, node.init)
        }
      },
      CallExpression(node: CallExpression) {
        const options = node.arguments[0] === undefined ? undefined : unwrap(node.arguments[0])

        if (imports.calledName(node, BETTER_AUTH) === 'betterAuth' && isObject(options)) checkBetterAuth(options)

        if (imports.calledName(node, WEB_AUTH) === 'betterAuthHandler' && isObject(options)) {
          const settable = property(options, 'settable')

          if (settable !== undefined && !isEmptyArray(settable.value)) context.report({ node: settable, messageId: 'settable' })
        }

        if (imports.calledName(node, WEB_EFFECT) === 'routeBinding') {
          const access = node.arguments[1] === undefined ? undefined : unwrap(node.arguments[1])
          const open = isObject(access) ? property(access, 'public') : undefined

          if (open !== undefined && isLiteral(unwrap(open.value), true)) context.report({ node: open, messageId: 'publicBinding' })
        }

        // verifyOrigin({ allowedOrigins }), as Hono middleware.
        if (imports.calledName(node, WEB) === 'verifyOrigin' && isObject(options)) {
          const allowed = property(options, 'allowedOrigins')

          if (allowed !== undefined && !isEmptyArray(allowed.value)) context.report({ node: allowed, messageId: 'allowedOrigins' })
        }
      },
      Property(node: Property) {
        if (!usesWeb()) return

        const name = keyName(node)
        const value = unwrap(node.value)
        const owner = ownerKey(node)

        if (name === 'allowedOrigins' && owner === 'verifyOrigin' && !isEmptyArray(value)) context.report({ node, messageId: 'allowedOrigins' })
        else if (name === 'verifyOrigin' && isLiteral(value, false)) context.report({ node, messageId: 'originCheckOff' })
        else if (name === 'headers' && owner === 'security' && isLiteral(value, false)) context.report({ node, messageId: 'headersOff' })
        else if (name === 'encrypt' && owner === 'history' && isLiteral(value, false)) {
          context.report({ node, messageId: 'historyPlain', data: { setting: 'history: { encrypt: false }' } })
        } else if (name === 'encryptHistory' && isLiteral(value, false)) {
          context.report({ node, messageId: 'historyPlain', data: { setting: 'encryptHistory: false' } })
        } else if (name === 'bodyLimit') bodyLimits.push(node)
        // A binding written as an object, { schema, public: true }, in setupWeb's bindings.
        else if (name === 'public' && isLiteral(value, true) && isObject(node.parent) && property(node.parent, 'schema') !== undefined) {
          context.report({ node, messageId: 'publicBinding' })
        }
      },
      'Program:exit'() {
        for (const node of bodyLimits) {
          const bytes = numberOf(node.value, constants)

          if (bytes !== undefined && bytes > DEFAULT_BODY_LIMIT) context.report({ node, messageId: 'bodyLimit', data: { bytes: String(bytes) } })
        }
      },
    }
  },
}
