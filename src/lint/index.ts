/**
 * `@popcomputer/web/lint`: the framework's rules, as an Oxlint (and ESLint)
 * plugin, versioned with the API they check.
 *
 * The type checker reports what the framework can see in types: a service
 * the setup does not provide, a failure an action leaves unhandled, a path
 * that is not declared. These rules report what types cannot: a write
 * without a `where`, a transaction that calls the network, SQL built from a
 * string, request input read around validation. Each message names the API
 * to use instead and why, so a rule teaches the pattern it enforces.
 *
 * A rule applies where a file uses the framework, with nothing to configure:
 * the action rules to files that import `action`, the database rules inside
 * `dbQuery`, `dbMutation`, `dbTransaction` and `dbBatch`.
 *
 * @example
 * // oxlint.config.ts
 * import { defineConfig } from 'oxlint'
 * import { webLint } from '@popcomputer/web/lint'
 *
 * export default defineConfig(webLint())
 */

import type { LintRule } from './ast.js'
import {
  noAuthApiInAction,
  noCatchAllInAction,
  noEffectRunnerInAction,
  noHonoContextInAction,
  noProvisionInAction,
  noRawRequestInput,
  noRawResponseInAction,
  noValidationInEndpoint,
  requireBackground,
} from './actions.js'
import {
  noDatabaseServiceInAction,
  noExternalWorkInTransaction,
  noSqlInterpolation,
  noUnscopedWrite,
  noWriteInDbQuery,
} from './database.js'

export type { LintRule } from './ast.js'

/** The plugin's name, which prefixes its rules: `popcomputer-web/no-unscoped-write`. */
export const PLUGIN_NAME = 'popcomputer-web'

/** Every rule, by name. */
export const rules: Readonly<Record<string, LintRule>> = {
  'no-unscoped-write': noUnscopedWrite,
  'no-write-in-db-query': noWriteInDbQuery,
  'no-external-work-in-transaction': noExternalWorkInTransaction,
  'no-sql-interpolation': noSqlInterpolation,
  'no-database-service-in-action': noDatabaseServiceInAction,
  'no-raw-request-input': noRawRequestInput,
  'no-hono-context-in-action': noHonoContextInAction,
  'no-effect-runner-in-action': noEffectRunnerInAction,
  'no-catch-all-in-action': noCatchAllInAction,
  'no-raw-response-in-action': noRawResponseInAction,
  'no-provision-in-action': noProvisionInAction,
  'require-background': requireBackground,
  'no-validation-in-endpoint': noValidationInEndpoint,
  'no-auth-api-in-action': noAuthApiInAction,
}

/** The plugin Oxlint's `jsPlugins` or ESLint's `plugins` loads. */
const plugin = { meta: { name: PLUGIN_NAME }, rules }

export default plugin

/** A rule's severity in an Oxlint or ESLint configuration. */
export type RuleSeverity = 'error' | 'warn' | 'off'

/**
 * What `webLint` adds to an Oxlint configuration. Each call builds a new
 * one, so its lists are Oxlint's own mutable types.
 */
export interface WebLintConfig {
  jsPlugins: Array<{ name: string; specifier: string }>
  rules: Record<string, RuleSeverity>
}

/**
 * An Oxlint configuration with every rule on as an error. Pass the severity
 * of a rule to change it, as `{ 'no-catch-all-in-action': 'warn' }`.
 *
 * @example
 * export default defineConfig({ ...webLint(), ignorePatterns: ['dist'] })
 */
export function webLint(severities: Readonly<Record<string, RuleSeverity>> = {}): WebLintConfig {
  const configured: Record<string, RuleSeverity> = {}

  for (const name of Object.keys(rules)) {
    configured[`${PLUGIN_NAME}/${name}`] = Object.hasOwn(severities, name) ? severities[name] : 'error'
  }

  return { jsPlugins: [{ name: PLUGIN_NAME, specifier: '@popcomputer/web/lint' }], rules: configured }
}
