/**
 * Rules for turning rules off. A line that breaks one of the framework's
 * rules on purpose says why, after ` -- `, where a reviewer reads it: Oxlint
 * and ESLint parse the reason, and require none.
 */

import type { DisableDirective, LintRule, RuleContext } from './ast.js'

/** The prefix of the framework's rules in a directive, `popcomputer-web/no-sql-interpolation`. */
const RULE_PREFIX = 'popcomputer-web/'

const LABEL = /^\s*((?:eslint|oxlint)-(disable(?:(?:-next)?-line)?|enable))(?:\s|$)/u
const JUSTIFICATION = /\s-{2,}\s/u

/** The file's disable directives: the linter's own parse, or the same read from its comments. */
function directivesOf(context: RuleContext): ReadonlyArray<DisableDirective> {
  const parsed = context.sourceCode.getDisableDirectives?.()

  if (parsed !== undefined) return parsed.directives

  return context.sourceCode.getAllComments().flatMap((comment): DisableDirective[] => {
    const separator = JUSTIFICATION.exec(comment.value)
    const directive = (separator === null ? comment.value : comment.value.slice(0, separator.index)).trim()
    const label = comment.type === 'Shebang' ? null : LABEL.exec(directive)

    if (label === null) return []

    return [{
      // SAFETY: the label pattern matches only these four types.
      type: label[2] as DisableDirective['type'],
      node: comment,
      value: directive.slice(label[0].length).trim(),
      justification: separator === null ? '' : comment.value.slice(separator.index + separator[0].length).trim(),
    }]
  })
}

export const requireDisableReason: LintRule = {
  meta: {
    type: 'problem',
    docs: { description: "A comment that turns off one of the framework's rules says why." },
    messages: {
      reason:
        "Say why {{rules}} is off here, after two dashes: // oxlint-disable-next-line {{rules}} -- the values are constants. A reviewer reads the reason where the rule is off; when there is none, use the API the rule's message names instead.",
      blanket:
        "This comment turns off every rule, the framework's among them, and says neither which nor why. Name the rules it means and say why after two dashes, // oxlint-disable-next-line popcomputer-web/no-sql-interpolation -- the values are constants, or use the API each rule's message names instead.",
    },
  },
  create(context) {
    return {
      Program() {
        for (const directive of directivesOf(context)) {
          // A reason is words: `-- .` or `--` alone says nothing.
          if (directive.type === 'enable' || /\p{L}/u.test(directive.justification)) continue

          const names = directive.value.split(/[\s,]+/).filter((name) => name !== '')
          const rules = names.filter((name) => name.startsWith(RULE_PREFIX))

          if (names.length === 0) context.report({ node: directive.node, messageId: 'blanket' })
          else if (rules.length > 0) context.report({ node: directive.node, messageId: 'reason', data: { rules: rules.join(', ') } })
        }
      },
    }
  },
}
