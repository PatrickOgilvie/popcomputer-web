/**
 * The options that say who may load a route binding's record: those
 * `routeBinding` takes and the lint rule asks every binding for, kept in one
 * place so the two cannot drift apart. It imports nothing, so the lint
 * plugin loads it without the framework.
 */

/** Who may load the record: its owner, anyone, anyone when its columns say so, or a guard layer. */
export const BINDING_ACCESS_OPTIONS = ['ownedBy', 'public', 'publicWhen', 'guarded'] as const

/** The option that scopes a binding to a parent, whose own access then decides. */
export const BINDING_SCOPE_OPTION = 'scope'
