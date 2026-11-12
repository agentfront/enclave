import * as walk from 'acorn-walk';
import { ValidationRule, ValidationContext, ValidationSeverity } from '../interfaces';
import { RuleConfigurationError } from '../errors';
import { tryGetStaticComputedKeys } from './coercion-utils';
import { walkAll } from '../utils/ast-walk';

/**
 * Options for DisallowedIdentifierRule
 */
export interface DisallowedIdentifierOptions {
  /** List of identifier names that are not allowed */
  disallowed: string[];
  /**
   * Names refused only as PROPERTY names: `obj.name`, `obj['name']` (and every statically
   * resolvable computed form). Unlike `disallowed` they stay usable as variable names.
   * Use it for reflection entry points that are reached through a property, such as
   * `__lookupGetter__` or `getOwnPropertyDescriptor`.
   */
  disallowedProperties?: string[];
  /**
   * Refuse `__proto__` as an object-literal key (`{ __proto__: x }`, `{ "__proto__": x }`).
   * That form does not define a property: it sets the new object's prototype.
   * Default: false
   */
  blockProtoInObjectLiterals?: boolean;
  /** Custom message template (use {identifier} placeholder) */
  messageTemplate?: string;
}

/**
 * Rule that prevents usage of specific identifiers
 *
 * Useful for blocking access to dangerous globals or built-ins like:
 * - eval
 * - Function
 * - process
 * - require
 * - etc.
 */
export class DisallowedIdentifierRule implements ValidationRule {
  readonly name = 'disallowed-identifier';
  readonly description = 'Prevents usage of disallowed identifiers';
  readonly defaultSeverity = ValidationSeverity.ERROR;
  readonly enabledByDefault = true;

  constructor(private options: DisallowedIdentifierOptions) {
    if (!options.disallowed || options.disallowed.length === 0) {
      throw new RuleConfigurationError(
        'DisallowedIdentifierRule requires at least one disallowed identifier',
        'disallowed-identifier',
      );
    }
  }

  validate(context: ValidationContext): void {
    const disallowedSet = new Set(this.options.disallowed);
    const messageTemplate = this.options.messageTemplate || 'Access to "{identifier}" is not allowed';

    this.checkPropertyNames(context, messageTemplate);

    walk.simple(context.ast as any, {
      Identifier: (node: any) => {
        if (disallowedSet.has(node.name)) {
          context.report({
            code: 'DISALLOWED_IDENTIFIER',
            message: messageTemplate.replace('{identifier}', node.name),
            location: node.loc
              ? {
                  line: node.loc.start.line,
                  column: node.loc.start.column,
                }
              : undefined,
            data: { identifier: node.name },
          });
        }
      },
      MemberExpression: (node: any) => {
        // Check property name in member expressions
        // e.g., obj.constructor or obj['constructor']
        if (!node.property) return;

        if (node.property.type === 'Identifier' && !node.computed) {
          // obj.constructor
          const name = node.property.name;
          if (disallowedSet.has(name)) {
            context.report({
              code: 'DISALLOWED_IDENTIFIER',
              message: messageTemplate.replace('{identifier}', name),
              location: node.property.loc
                ? { line: node.property.loc.start.line, column: node.property.loc.start.column }
                : undefined,
              data: { identifier: name },
            });
          }
        } else if (node.computed) {
          // Handle all computed key coercion vectors:
          // literals, arrays, objects, template literals, conditionals, sequences, etc.
          const keys = tryGetStaticComputedKeys(node.property);
          for (const key of keys) {
            if (disallowedSet.has(key)) {
              context.report({
                code: 'DISALLOWED_IDENTIFIER',
                message: messageTemplate.replace('{identifier}', key),
                location: node.property.loc
                  ? { line: node.property.loc.start.line, column: node.property.loc.start.column }
                  : undefined,
                data: { identifier: key },
              });
              break; // one report per node is enough
            }
          }
        }
      },
    });
  }

  /**
   * Property-only names and the `__proto__` object-literal key. Walks every node, so a member
   * expression in an assignment target or a destructuring target is seen like any other.
   */
  private checkPropertyNames(context: ValidationContext, messageTemplate: string): void {
    const properties = new Set(this.options.disallowedProperties ?? []);
    const blockProto = this.options.blockProtoInObjectLiterals === true;
    if (properties.size === 0 && !blockProto) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- acorn doesn't export specific node types
    const report = (name: string, node: any): void => {
      context.report({
        code: 'DISALLOWED_IDENTIFIER',
        message: messageTemplate.replace('{identifier}', name),
        location: node?.loc ? { line: node.loc.start.line, column: node.loc.start.column } : undefined,
        data: { identifier: name, position: 'property' },
      });
    };

    walkAll(context.ast, (node, ancestors) => {
      if (node.type === 'MemberExpression' && node.property && properties.size > 0) {
        if (!node.computed) {
          if (node.property.type === 'Identifier' && properties.has(node.property.name)) {
            report(node.property.name, node.property);
          }
          return;
        }
        const blockedKey = tryGetStaticComputedKeys(node.property).find((key) => properties.has(key));
        if (blockedKey !== undefined) report(blockedKey, node.property);
        return;
      }

      if (blockProto && node.type === 'Property' && !node.computed && !node.shorthand) {
        const parent = ancestors[ancestors.length - 1];
        if (parent?.type !== 'ObjectExpression') return;
        const key = node.key;
        const isProto =
          (key?.type === 'Identifier' && key.name === '__proto__') ||
          (key?.type === 'Literal' && key.value === '__proto__');
        if (isProto) report('__proto__', key);
      }
    });
  }
}
