/**
 * Rules for route-model bindings: each says, beside its table, who may load
 * the record a path names, so no action has to remember to check.
 */

import {
  Imports,
  isCall,
  isIdentifier,
  isObject,
  keyName,
  unwrap,
  WEB,
  WEB_EFFECT,
  type AstNode,
  type CallExpression,
  type ImportDeclaration,
  type LintRule,
  type ObjectExpression,
  type Property,
  type VariableDeclarator,
} from './ast.js'

/** The options that say who may load a binding's record, and `scope`, under which its parent's say. */
const ACCESS = new Set(['ownedBy', 'public', 'publicWhen', 'guarded', 'scope'])

const isProperty = (node: AstNode): node is Property => node.type === 'Property'

/** Whether a value is written `undefined` or `void ...`, which says nothing. */
const isUndefinedLiteral = (node: AstNode): boolean =>
  (isIdentifier(node) && node.name === 'undefined') ||
  (node.type === 'UnaryExpression' && 'operator' in node && node.operator === 'void')

/**
 * Whether an options object says who may load the record: undefined when a
 * spread may say it, which the rule cannot see. An option written
 * `undefined` says nothing.
 */
function declaresAccess(options: ObjectExpression): boolean | undefined {
  let spread = false

  for (const property of options.properties) {
    if (!isProperty(property)) {
      spread = true
      continue
    }

    const name = keyName(property)
    const value = unwrap(property.value)

    // A scope names the parent it loads under; an empty one names none.
    if (name === 'scope' && isObject(value) && value.properties.length === 0) continue
    if (name !== undefined && ACCESS.has(name) && !isUndefinedLiteral(value)) return true
  }

  return spread ? undefined : false
}

/**
 * The publicWhen column an options object gives the literal value undefined
 * (or `void 0`), which says no value that makes a record public.
 */
function undefinedPublicWhen(options: ObjectExpression): string | undefined {
  for (const property of options.properties) {
    if (!isProperty(property) || keyName(property) !== 'publicWhen') continue

    const values = unwrap(property.value)

    if (!isObject(values)) return undefined

    for (const entry of values.properties) {
      if (isProperty(entry) && isUndefinedLiteral(unwrap(entry.value))) return keyName(entry) ?? 'column'
    }
  }

  return undefined
}

/** The access options an options object writes `undefined`, which setupWeb refuses. */
function undefinedOptions(options: ObjectExpression): Property[] {
  return options.properties.filter((property): property is Property => {
    if (!isProperty(property)) return false

    const name = keyName(property)

    return name !== undefined && ACCESS.has(name) && isUndefinedLiteral(unwrap(property.value))
  })
}

export const requireBindingAccess: LintRule = {
  meta: {
    type: 'problem',
    docs: { description: 'Route-model bindings say who may load their record.' },
    messages: {
      access:
        "Use routeBinding's options to say who may load this record: { ownedBy: 'userId' } for its owner only, { publicWhen: { visibility: 'public' } } for anyone when its columns hold those values, { public: true } for anyone, { guarded: true } when a guard layer decides, or scope when it is only loaded under its parent. Said beside the table, no action has to remember the check.",
      bare:
        "Use routeBinding(table, options) for binding \"{{name}}\", to say who may load its record: { ownedBy: 'userId' } for its owner only, { publicWhen: { visibility: 'public' } } for anyone when its columns hold those values, { public: true } for anyone, { guarded: true } when a guard layer decides, or scope when it is only loaded under its parent.",
      undefinedValue:
        "Use the value that makes a record public for \"{{column}}\", as publicWhen: { {{column}}: true }: undefined says none, and on a SQLite boolean column it matches the private records.",
      undefinedOption:
        "Use a value for {{option}}, as ownedBy: 'userId' or guarded: true, or leave it out: undefined says nothing about who may load the record, so setupWeb refuses it.",
    },
  },
  create(context) {
    const imports = new Imports()
    // Objects and routeBinding calls the file names, for bindings given by name.
    const objects = new Map<string, ObjectExpression>()
    const bindings = new Set<string>()

    const isRouteBinding = (node: AstNode): boolean =>
      isCall(node) && imports.calledName(node, WEB_EFFECT) === 'routeBinding'

    return {
      ImportDeclaration: (node: ImportDeclaration) => imports.add(node),
      VariableDeclarator(node: VariableDeclarator) {
        if (!isIdentifier(node.id) || node.init === null) return

        const init = unwrap(node.init)

        if (isObject(init)) objects.set(node.id.name, init)
        if (isRouteBinding(init)) bindings.add(node.id.name)
      },
      CallExpression(node: CallExpression) {
        if (isRouteBinding(node)) {
          const options = node.arguments[1] === undefined ? undefined : unwrap(node.arguments[1])
          const unset = isObject(options) ? undefinedOptions(options) : []

          // An option written undefined is reported as itself.
          if (unset.length === 0 && (options === undefined || (isObject(options) && declaresAccess(options) === false))) {
            context.report({ node, messageId: 'access' })
          }

          const column = isObject(options) ? undefinedPublicWhen(options) : undefined

          if (column !== undefined) context.report({ node, messageId: 'undefinedValue', data: { column } })

          for (const option of unset) {
            context.report({ node: option, messageId: 'undefinedOption', data: { option: keyName(option) ?? 'option' } })
          }

          return
        }

        if (imports.calledName(node, WEB) !== 'setupWeb') return

        const config = node.arguments[1] === undefined ? undefined : unwrap(node.arguments[1])

        if (!isObject(config)) return

        for (const property of config.properties) {
          if (!isProperty(property) || keyName(property) !== 'bindings') continue

          const value = unwrap(property.value)
          const declared = isObject(value) ? value : isIdentifier(value) ? objects.get(value.name) : undefined

          for (const binding of declared?.properties ?? []) {
            if (!isProperty(binding)) continue

            const definition = unwrap(binding.value)

            // routeBinding's own call is checked where it is made.
            if (isRouteBinding(definition) || (isIdentifier(definition) && bindings.has(definition.name))) continue

            const column = isObject(definition) ? undefinedPublicWhen(definition) : undefined
            const unset = isObject(definition) ? undefinedOptions(definition) : []

            if (column !== undefined) context.report({ node: binding, messageId: 'undefinedValue', data: { column } })

            for (const option of unset) {
              context.report({ node: option, messageId: 'undefinedOption', data: { option: keyName(option) ?? 'option' } })
            }

            if (unset.length > 0 || (isObject(definition) && declaresAccess(definition) !== false)) continue

            context.report({ node: binding, messageId: 'bare', data: { name: keyName(binding) ?? 'binding' } })
          }
        }
      },
    }
  },
}
