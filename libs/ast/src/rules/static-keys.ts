/**
 * How a rule reads a property name that is not written as an identifier.
 *
 * A rule that refuses a name refuses it in every spelling: `o.name`, `o['name']`,
 * `o['na' + 'me']`, `o[['na', 'me'].join('')]`. The spelling is not matched; the key is evaluated
 * (see `utils/static-eval`), and the rule compares what it may be.
 *
 * A key that is made of constants and that the evaluation could not compute is refused, with
 * `STATIC_KEY_UNRESOLVED`: it names one fixed property, and a rule that cannot tell which one
 * cannot say that it is not a refused one. A key that depends on a run-time value is not the
 * validator's to decide; `guardComputedMemberKeys` checks it where the script runs.
 *
 * @packageDocumentation
 */

import { ValidationSeverity, type ValidationContext, type ValidationIssue } from '../interfaces';
import type { AnyNode } from '../utils/ast-walk';
import {
  StaticKeyExpansionError,
  evaluateStatic,
  noteUnresolvedKey,
  resolveStaticKey,
  takeUnresolvedKeys,
  type StaticEvaluationOptions,
} from '../utils/static-eval';

export { StaticKeyExpansionError };
export type { StaticEvaluationOptions } from '../utils/static-eval';

/**
 * Every name a computed key may be, as far as it is known without running the script.
 *
 * A key that is made of constants and could not be resolved is refused: the validator reports it
 * (`STATIC_KEY_UNRESOLVED`, see {@link reportUnresolvedKeys}) after the rule that read it has
 * reported what it found itself. A key several rules read is reported once.
 *
 * @param context The validation the key belongs to
 * @param key The key expression: `MemberExpression.property` of a computed member, `Property.key`
 *   of a computed property
 * @param options How a variable in the key is read (default: as a run-time value)
 */
export function staticKeyNames(
  context: ValidationContext,
  key: AnyNode,
  options: StaticEvaluationOptions = {},
): string[] {
  const { names, unresolved } = resolveStaticKey(context.ast, key, options);
  if (unresolved) noteUnresolvedKey(context.ast, key);
  return names;
}

/** How much an issue of a severity counts: a rule that counts for more raises an issue a lesser one made. */
const SEVERITY_RANK: Record<string, number> = {
  [ValidationSeverity.INFO]: 1,
  [ValidationSeverity.WARNING]: 2,
  [ValidationSeverity.ERROR]: 3,
};

/**
 * The keys the rule that just ran could not resolve and that are not yet reported at its
 * severity or above. The validator reports each one once (`unresolvedKeyIssue`): a key several
 * rules read keeps one issue, at the highest of their severities, so that a rule a host has
 * turned down to a warning does not make the refusal of another rule a warning.
 *
 * @param context The context the rule ran with
 * @param severity The severity the rule reports at
 */
export function unresolvedKeysOf(context: ValidationContext, severity: ValidationSeverity): AnyNode[] {
  return takeUnresolvedKeys(context.ast, SEVERITY_RANK[severity] ?? SEVERITY_RANK[ValidationSeverity.ERROR]);
}

/** The issue for a key that is made of constants and that no rule could read. */
export function unresolvedKeyIssue(key: AnyNode): Omit<ValidationIssue, 'severity'> {
  return {
    code: 'STATIC_KEY_UNRESOLVED',
    message:
      'Computed property key cannot be resolved. It is made of constants, so it names one fixed property, ' +
      'and the validator cannot tell which. Write the property name directly.',
    location: key?.loc ? { line: key.loc.start.line, column: key.loc.start.column } : undefined,
    data: { keyType: key?.type },
  };
}

/**
 * Every name a member access may read: `o.name` is `name`; `o[key]` is what `key` may be.
 *
 * @param context The validation the member belongs to
 * @param member A `MemberExpression`
 * @param options How a variable in a computed key is read
 */
export function memberKeyNames(
  context: ValidationContext,
  member: AnyNode,
  options: StaticEvaluationOptions = {},
): string[] {
  const property = member?.property;
  if (!property) return [];
  if (!member.computed) return property.type === 'Identifier' ? [property.name] : [];
  return staticKeyNames(context, property, options);
}

/**
 * Every name the key of a property of an object pattern or an object literal may be.
 *
 * @param context The validation the property belongs to
 * @param property A `Property`
 * @param options How a variable in a computed key is read
 */
export function propertyKeyNames(
  context: ValidationContext,
  property: AnyNode,
  options: StaticEvaluationOptions = {},
): string[] {
  const key = property?.key;
  if (!key) return [];
  if (property.computed) return staticKeyNames(context, key, options);
  if (key.type === 'Identifier') return [key.name];
  if (key.type === 'Literal') return [key.bigint !== undefined ? String(key.bigint) : String(key.value)];
  return [];
}

/**
 * The names a computed key may be, without refusing anything: for a rule that looks for a name
 * and leaves it to the rules that refuse names to refuse a key that cannot be read.
 *
 * @param context The validation the key belongs to
 * @param key The key expression
 * @param options How a variable in the key is read
 */
export function peekKeyNames(
  context: ValidationContext,
  key: AnyNode,
  options: StaticEvaluationOptions = {},
): string[] {
  try {
    return resolveStaticKey(context.ast, key, options).names;
  } catch (error) {
    // A key too large to build is not a short name
    if (error instanceof StaticKeyExpansionError) return [];
    throw error;
  }
}

/**
 * The names an expression may be when it is used as a key, without refusing anything: for an
 * expression that is not a key where it stands (the initializer of a variable).
 *
 * @param context The validation the expression belongs to
 * @param node The expression
 * @param options How a variable in the expression is read
 */
export function staticKeyCandidates(
  context: ValidationContext,
  node: AnyNode,
  options: StaticEvaluationOptions = {},
): string[] {
  // (A set: an expression may be one of very many names, and each is looked up once)
  const names = new Set<string>();
  for (const alternative of evaluateStatic(context.ast, node, options)) {
    if (alternative.key !== undefined) names.add(alternative.key);
  }
  return [...names];
}
