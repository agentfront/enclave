import * as walk from 'acorn-walk';
import { ValidationRule, ValidationContext, ValidationSeverity } from '../interfaces';
import { RuleConfigurationError } from '../errors';
import { propertyKeyNames, staticKeyNames, type StaticEvaluationOptions } from './static-keys';
import { walkAll } from '../utils/ast-walk';
import { sharedScopes } from '../utils/scope-analysis';

/**
 * Options for DisallowedIdentifierRule
 */
export interface DisallowedIdentifierOptions {
  /**
   * List of identifier names that are not allowed.
   *
   * A name on the list is refused as a variable and as a property, in every position a property
   * is read or written: a member (`obj.name`, `obj?.name`, `obj['name']`), an assignment target,
   * and the key of a destructuring pattern (see `checkDestructuringKeys`). A computed key is
   * evaluated, so a name spelled in pieces (`obj['na' + 'me']`, `obj[['na', 'me'].join('')]`) is
   * the name, and so is one held in a variable (see `resolveVariableKeys`); a key made of
   * constants that cannot be evaluated is refused with `STATIC_KEY_UNRESOLVED`. A key that depends
   * on a run-time value is not decided here (see `guardComputedMemberKeys`).
   *
   * `'this'` on the list refuses the `this` keyword in every position. It is not an identifier
   * in the syntax tree, but it is a name for a value like the others on such a list (outside a
   * method, the global object).
   */
  disallowed: string[];
  /**
   * Names refused only as PROPERTY names, in the same positions and spellings as above. Unlike
   * `disallowed` they stay usable as variable names. Use it for reflection entry points that are
   * reached through a property, such as `__lookupGetter__` or `getOwnPropertyDescriptor`.
   */
  disallowedProperties?: string[];
  /**
   * Refuse `__proto__` as an object-literal key (`{ __proto__: x }`, `{ "__proto__": x }`).
   * That form does not define a property: it sets the new object's prototype.
   * Default: false
   */
  blockProtoInObjectLiterals?: boolean;
  /**
   * Property names that are refused as a key of an object literal as well, in every spelling of
   * the key.
   *
   * `disallowedProperties` refuses a name where a property is read or assigned. A property can
   * also be installed by copying an object onto another (`Object.assign(target, { name: value })`):
   * for a name that has to be kept off an object, list it here too. Leave out a name that is
   * ordinary as a key of data.
   */
  disallowedObjectKeys?: string[];
  /**
   * Read a key through the variables of the script: `const k = 'name'; obj[k]` is `obj.name`.
   *
   * A `const` that holds a constant is that constant. For any other variable the constants the
   * script can be seen assigning to it are compared with the refused names (an initializer, an
   * assignment, a default value, an element of a literal a loop or a pattern takes it from).
   * What a parameter receives is only known at run time and is not decided here.
   *
   * Turn it off where the key of a computed member is checked at run time
   * (`guardComputedMemberKeys`) and that check, not the validator, should answer for a key held
   * in a variable: the AgentScript preset does, so that the answer follows the security level.
   *
   * Default: true
   */
  resolveVariableKeys?: boolean;
  /**
   * Refuse a listed name as the key of a destructuring pattern, which reads the same property a
   * member does: `const { name: x } = obj`, `({ name }) => ...`, `({ name: x } = obj)`, written
   * as an identifier, a string or a computed key.
   *
   * Turn it off where another rule decides which keys a pattern may read
   * (`NoComputedDestructuringRule`, as in the AgentScript preset).
   *
   * Default: true
   */
  checkDestructuringKeys?: boolean;
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

    // How a key is read: through the variables of the script, or as it is written
    const keys = { variables: this.options.resolveVariableKeys !== false };

    this.checkPropertyNames(context, messageTemplate, keys);
    if (this.options.checkDestructuringKeys !== false) {
      this.checkPatternKeys(context, disallowedSet, messageTemplate, keys);
    }

    if (disallowedSet.has('this')) {
      walkAll(context.ast, (node) => {
        if (node.type !== 'ThisExpression') return;
        context.report({
          code: 'DISALLOWED_IDENTIFIER',
          message: messageTemplate.replace('{identifier}', 'this'),
          location: node.loc ? { line: node.loc.start.line, column: node.loc.start.column } : undefined,
          data: { identifier: 'this' },
        });
      });
    }

    // The identifiers the walk below reports: an identifier that is read
    const reported = new Set<unknown>();

    walk.simple(context.ast as any, {
      Identifier: (node: any) => {
        if (disallowedSet.has(node.name)) {
          reported.add(node);
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
          // Every spelling of a key that is made of constants: the key is evaluated
          for (const key of staticKeyNames(context, node.property, keys)) {
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

    // An identifier that is assigned to stands in a target position, which the walk above does
    // not take for an expression. Naming a refused variable there is not a lesser use of it:
    // `name ||= 0` and `name ??= 0` read it and give its value, `name = x` replaces it.
    for (const reference of sharedScopes(context.ast).references) {
      if (!reference.write || reported.has(reference.node) || !disallowedSet.has(reference.name)) continue;
      const node = reference.node;
      context.report({
        code: 'DISALLOWED_IDENTIFIER',
        message: messageTemplate.replace('{identifier}', reference.name),
        location: node.loc ? { line: node.loc.start.line, column: node.loc.start.column } : undefined,
        data: { identifier: reference.name, position: 'assignment' },
      });
    }
  }

  /**
   * The key of a destructuring pattern reads a property, as a member does: `const { name: x } = obj`
   * is `const x = obj.name`. Every name refused as a member is refused here, in a declaration, a
   * parameter, an assignment and a catch clause, written as an identifier, a string or a computed key.
   */
  private checkPatternKeys(
    context: ValidationContext,
    disallowed: ReadonlySet<string>,
    messageTemplate: string,
    keys: StaticEvaluationOptions,
  ): void {
    const properties = new Set(this.options.disallowedProperties ?? []);

    walkAll(context.ast, (node, ancestors) => {
      if (node.type !== 'Property' || ancestors[ancestors.length - 1]?.type !== 'ObjectPattern') return;

      const name = propertyKeyNames(context, node, keys).find((key) => disallowed.has(key) || properties.has(key));
      if (name === undefined) return;

      context.report({
        code: 'DISALLOWED_IDENTIFIER',
        message: messageTemplate.replace('{identifier}', name),
        location: node.key?.loc ? { line: node.key.loc.start.line, column: node.key.loc.start.column } : undefined,
        data: { identifier: name, position: 'destructuring' },
      });
    });
  }

  /**
   * Property-only names and the `__proto__` object-literal key. Walks every node, so a member
   * expression in an assignment target or a destructuring target is seen like any other.
   */
  private checkPropertyNames(context: ValidationContext, messageTemplate: string, keys: StaticEvaluationOptions): void {
    const properties = new Set(this.options.disallowedProperties ?? []);
    const objectKeys = new Set(this.options.disallowedObjectKeys ?? []);
    const blockProto = this.options.blockProtoInObjectLiterals === true;
    if (properties.size === 0 && objectKeys.size === 0 && !blockProto) return;

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
        const blockedKey = staticKeyNames(context, node.property, keys).find((key) => properties.has(key));
        if (blockedKey !== undefined) report(blockedKey, node.property);
        return;
      }

      if (blockProto && node.type === 'Property' && !node.shorthand) {
        const parent = ancestors[ancestors.length - 1];
        if (parent?.type !== 'ObjectExpression') return;
        const key = node.key;
        // `{ __proto__: value }` sets the prototype of the new object. `{ ['__proto__']: value }`
        // makes a property of that name, which sets the prototype of whatever the object is
        // copied onto (`Object.assign(target, { ['__proto__']: value })`). Neither is accepted,
        // in any spelling of the key.
        const isProto = node.computed
          ? staticKeyNames(context, key, keys).includes('__proto__')
          : (key?.type === 'Identifier' && key.name === '__proto__') ||
            (key?.type === 'Literal' && key.value === '__proto__');
        if (isProto) {
          report('__proto__', key);
          return; // (once, also where `disallowedObjectKeys` lists the name)
        }
      }

      if (
        objectKeys.size > 0 &&
        node.type === 'Property' &&
        ancestors[ancestors.length - 1]?.type === 'ObjectExpression'
      ) {
        const name = propertyKeyNames(context, node, keys).find((key) => objectKeys.has(key));
        if (name !== undefined) report(name, node.key);
      }
    });
  }
}
