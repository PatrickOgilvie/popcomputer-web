/**
 * The parts of the ESTree syntax tree the rules read, and the per-file view
 * of what the file imports, which decides where each rule applies.
 */

/** A syntax tree node, as Oxlint and ESLint give it to a rule. */
export interface AstNode {
  readonly type: string
  readonly parent: AstNode | null
}

export interface Identifier extends AstNode {
  readonly type: 'Identifier'
  readonly name: string
}

export interface Literal extends AstNode {
  readonly type: 'Literal'
  readonly value: unknown
}

export interface MemberExpression extends AstNode {
  readonly type: 'MemberExpression'
  readonly object: AstNode
  readonly property: AstNode
  readonly computed: boolean
}

export interface CallExpression extends AstNode {
  readonly type: 'CallExpression'
  readonly callee: AstNode
  readonly arguments: ReadonlyArray<AstNode>
}

export interface NewExpression extends AstNode {
  readonly type: 'NewExpression'
  readonly callee: AstNode
}

export interface TemplateLiteral extends AstNode {
  readonly type: 'TemplateLiteral'
  readonly expressions: ReadonlyArray<AstNode>
  readonly quasis: ReadonlyArray<{ readonly value: { readonly raw: string } }>
}

export interface ImportDeclaration extends AstNode {
  readonly type: 'ImportDeclaration'
  readonly source: { readonly value: string }
  readonly specifiers: ReadonlyArray<{
    readonly type: string
    readonly local: Identifier
    readonly imported?: { readonly type: string; readonly name?: string; readonly value?: string }
  }>
}

export interface VariableDeclarator extends AstNode {
  readonly type: 'VariableDeclarator'
  readonly id: AstNode
  readonly init: AstNode | null
}

export interface YieldExpression extends AstNode {
  readonly type: 'YieldExpression'
  readonly argument: AstNode | null
}

/** A fix: the replacement of a node's text. */
export interface Fixer {
  replaceText(node: AstNode, text: string): unknown
}

/** What a rule reports: the node, the message's id and its data, and a fix. */
export interface Report {
  readonly node: AstNode
  readonly messageId: string
  readonly data?: Readonly<Record<string, string>>
  readonly fix?: (fixer: Fixer) => unknown
}

/** The rule's view of the file it checks. */
export interface RuleContext {
  report(report: Report): void
}

/** A rule: its messages, and the visitor it builds for each file. */
export interface LintRule {
  readonly meta: {
    readonly type: 'problem' | 'suggestion'
    readonly docs: { readonly description: string }
    readonly messages: Readonly<Record<string, string>>
    readonly fixable?: 'code'
  }
  create(context: RuleContext): Readonly<Record<string, (node: never) => void>>
}

export const isIdentifier = (node: AstNode | null | undefined): node is Identifier => node?.type === 'Identifier'

export const isMember = (node: AstNode | null | undefined): node is MemberExpression => node?.type === 'MemberExpression'

export const isCall = (node: AstNode | null | undefined): node is CallExpression => node?.type === 'CallExpression'

const WRAPPERS = new Set([
  'ParenthesizedExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSTypeAssertion',
  'ChainExpression',
])

/** The expression inside parentheses, casts and optional chains. */
export function unwrap(node: AstNode): AstNode {
  let current = node

  while (WRAPPERS.has(current.type) && 'expression' in current) {
    const inner: unknown = current.expression

    if (typeof inner !== 'object' || inner === null) break
    // SAFETY: a wrapper's expression is a syntax tree node.
    current = inner as AstNode
  }

  return current
}

/** A member expression's property name, when it is written as a name or a string. */
export function propertyName(member: MemberExpression): string | undefined {
  if (!member.computed && isIdentifier(member.property)) return member.property.name

  const property = member.property

  return property.type === 'Literal' && typeof (property as Literal).value === 'string'
    ? String((property as Literal).value)
    : undefined
}

/** The identifier a chain such as `db.select().from(x)` starts from. */
export function rootOf(node: AstNode): Identifier | undefined {
  let current = unwrap(node)

  for (;;) {
    if (isMember(current)) current = unwrap(current.object)
    else if (isCall(current)) current = unwrap(current.callee)
    else return isIdentifier(current) ? current : undefined
  }
}

/** Where a local name was imported from, and under which name. */
interface ImportedName {
  readonly source: string
  readonly imported: string
}

/**
 * The names a file imports, collected as its import declarations are
 * visited, which come before the code that uses them.
 */
export class Imports {
  private readonly names = new Map<string, ImportedName>()

  add(node: ImportDeclaration): void {
    for (const specifier of node.specifiers) {
      const imported = specifier.type === 'ImportNamespaceSpecifier'
        ? '*'
        : specifier.type === 'ImportDefaultSpecifier'
          ? 'default'
          : specifier.imported?.name ?? specifier.imported?.value ?? specifier.local.name

      this.names.set(specifier.local.name, { source: node.source.value, imported })
    }
  }

  /** Whether a local name is imported at all, rather than a global. */
  isImported(name: string): boolean {
    return this.names.has(name)
  }

  /** Whether the file imports anything from `source`. */
  importsFrom(source: string): boolean {
    for (const imported of this.names.values()) {
      if (imported.source === source) return true
    }

    return false
  }

  /** Whether the file imports `name` from any of `sources`. */
  has(sources: ReadonlySet<string>, name: string): boolean {
    for (const imported of this.names.values()) {
      if (sources.has(imported.source) && imported.imported === name) return true
    }

    return false
  }

  /** The local name the file imports `name` from `sources` as. */
  localName(sources: ReadonlySet<string>, name: string): string | undefined {
    for (const [local, imported] of this.names) {
      if (sources.has(imported.source) && imported.imported === name) return local
    }

    return undefined
  }

  /** The imported name a local identifier refers to, when it comes from one of `sources`. */
  importedName(identifier: Identifier, sources: ReadonlySet<string>): string | undefined {
    const imported = this.names.get(identifier.name)

    return imported !== undefined && sources.has(imported.source) ? imported.imported : undefined
  }

  /**
   * The name a call invokes from `sources`: `dbQuery(...)` for an imported
   * `dbQuery`, or `Effect.runPromise(...)` as `runPromise` when `Effect` is
   * imported from them.
   */
  calledName(call: CallExpression, sources: ReadonlySet<string>, namespace?: string): string | undefined {
    const callee = unwrap(call.callee)

    if (isIdentifier(callee)) return this.importedName(callee, sources)
    if (!isMember(callee)) return undefined

    const object = unwrap(callee.object)

    if (!isIdentifier(object)) return undefined

    const imported = this.importedName(object, sources)

    return imported === '*' || (namespace !== undefined && imported === namespace) ? propertyName(callee) : undefined
  }
}

/** The framework's entrypoint for actions, routes and the database. */
export const WEB_EFFECT = new Set(['@popcomputer/web/effect'])

/** Effect's entrypoints a file imports `Effect` from. */
export const EFFECT = new Set(['effect', 'effect/Effect'])

/** The calls, from innermost outwards, whose arguments contain `node`. */
export function* enclosingCalls(node: AstNode): Generator<CallExpression> {
  let child = node
  let current = node.parent

  while (current !== null) {
    if (isCall(current) && current.arguments.includes(child)) yield current
    child = current
    current = current.parent
  }
}

/** Whether `node`, or any node under it, satisfies `test`. */
export function contains(node: AstNode, test: (candidate: AstNode) => boolean): boolean {
  if (test(node)) return true

  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent' || typeof value !== 'object' || value === null) continue

    const children: ReadonlyArray<unknown> = Array.isArray(value) ? value : [value]

    for (const child of children) {
      if (typeof child === 'object' && child !== null && 'type' in child && typeof child.type === 'string') {
        // SAFETY: an object with a string `type` under a syntax tree node is a node.
        if (contains(child as AstNode, test)) return true
      }
    }
  }

  return false
}
