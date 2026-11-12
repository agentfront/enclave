import type { ValidationRule, ValidationContext } from '../interfaces';
import { ValidationSeverity } from '../interfaces';
import * as walk from 'acorn-walk';
import { tryGetStaticComputedKeys } from './coercion-utils';
import { walkAll, staticPropertyName, type AnyNode } from '../utils/ast-walk';
import { analyzeScopes } from '../utils/scope-analysis';

/**
 * Configuration options for NoGlobalAccessRule
 */
export interface NoGlobalAccessOptions {
  /** List of global object names to block access to */
  blockedGlobals?: string[];
  /** Whether to block member access to globals */
  blockMemberAccess?: boolean;
  /** Whether to block computed access to globals */
  blockComputedAccess?: boolean;
  /**
   * Require the global `Object` to be used directly: as `Object.name` with a name written in the
   * source, called or constructed (`Object(x)`, `new Object()`), or as the operand of `typeof` /
   * `instanceof`.
   *
   * The statics this rule refuses (`Object.create`, `Object.defineProperty`, ...) are refused by
   * name on `Object`. Every other use of the global would take them out of sight and is refused
   * with this option: an alias (`const O = Object`), passing or storing it as a value,
   * destructuring from it, a name that is only known at run time (`Object[key]`), and
   * `Object.valueOf()`, which returns the object itself. A variable of the script that is called
   * `Object` is not the global and is left alone.
   *
   * Default: false
   */
  requireDirectObjectUse?: boolean;
}

/** Statics of `Object` that read or rewrite prototypes and property descriptors. */
const OBJECT_META_STATICS: ReadonlySet<string> = new Set([
  'getOwnPropertyDescriptor',
  'getOwnPropertyDescriptors',
  'getPrototypeOf',
  'setPrototypeOf',
  'defineProperty',
  'defineProperties',
  'create', // Can create objects with arbitrary prototypes
]);

/** Every name a member access may resolve to without running the script. */
function memberNames(node: AnyNode): string[] {
  if (!node.property) return [];
  if (!node.computed) return node.property.type === 'Identifier' ? [node.property.name] : [];
  const literal = staticPropertyName(node.property, true);
  return literal !== undefined ? [literal] : tryGetStaticComputedKeys(node.property, { foldConstants: true });
}

/**
 * Rule that prevents access to global objects (window, globalThis, this)
 *
 * This blocks attack vectors like:
 * - window['eval']
 * - globalThis.Function
 * - this['constructor']
 * - window[dynamicVar]
 *
 * Rationale: Even with identifier transformation, attackers can access
 * dangerous functions through global object references.
 */
export class NoGlobalAccessRule implements ValidationRule {
  readonly name = 'no-global-access';
  readonly description = 'Prevents access to global objects that can bypass security';
  readonly defaultSeverity = ValidationSeverity.ERROR;
  readonly enabledByDefault = false;

  private readonly blockedGlobals: Set<string>;
  private readonly blockMemberAccess: boolean;
  private readonly blockComputedAccess: boolean;
  private readonly requireDirectObjectUse: boolean;

  constructor(options: NoGlobalAccessOptions = {}) {
    this.blockedGlobals = new Set(options.blockedGlobals || ['window', 'globalThis', 'self', 'global', 'this']);
    this.blockMemberAccess = options.blockMemberAccess ?? true;
    this.blockComputedAccess = options.blockComputedAccess ?? true;
    this.requireDirectObjectUse = options.requireDirectObjectUse === true;
  }

  validate(context: ValidationContext): void {
    const { ast, report } = context;

    if (this.requireDirectObjectUse) {
      this.checkDirectObjectUse(context);
    }

    walk.simple(ast, {
      // Check member expressions: window.eval, globalThis['Function'], this['eval']
      MemberExpression: (node: any) => {
        let objectName: string | null = null;

        // Check for Identifier (window, globalThis, self, global)
        if (node.object && node.object.type === 'Identifier') {
          objectName = node.object.name;
        }
        // Check for ThisExpression (this)
        else if (node.object && node.object.type === 'ThisExpression') {
          objectName = 'this';
        }

        // Check if accessing a blocked global
        if (objectName && this.blockedGlobals.has(objectName)) {
          // Member access: window.eval, globalThis.Function
          if (!node.computed && this.blockMemberAccess) {
            const propertyName = node.property?.type === 'Identifier' ? node.property.name : '(unknown)';
            report({
              code: 'NO_GLOBAL_ACCESS',
              message: `Access to ${objectName}.${propertyName} is not allowed`,
              location: node.object.loc
                ? {
                    line: node.object.loc.start.line,
                    column: node.object.loc.start.column,
                  }
                : undefined,
              data: {
                global: objectName,
                property: propertyName,
                accessType: 'member',
              },
            });
          }

          // Computed access: window['eval'], globalThis[someVar]
          if (node.computed && this.blockComputedAccess) {
            const propertyName =
              node.property.type === 'Literal'
                ? String(node.property.value)
                : node.property.type === 'Identifier'
                  ? node.property.name
                  : '(dynamic)';

            report({
              code: 'NO_GLOBAL_ACCESS',
              message: `Computed access to ${objectName}[${propertyName}] is not allowed`,
              location: node.object.loc
                ? {
                    line: node.object.loc.start.line,
                    column: node.object.loc.start.column,
                  }
                : undefined,
              data: {
                global: objectName,
                property: propertyName,
                accessType: 'computed',
              },
            });
          }
        }

        // Check for .constructor access (bypasses Function restriction)
        if (
          node.property &&
          ((node.property.type === 'Identifier' && node.property.name === 'constructor') ||
            (node.property.type === 'Literal' && node.property.value === 'constructor') ||
            (node.computed && tryGetStaticComputedKeys(node.property).includes('constructor')))
        ) {
          report({
            code: 'NO_CONSTRUCTOR_ACCESS',
            message: 'Access to .constructor property is not allowed',
            location: node.property.loc
              ? {
                  line: node.property.loc.start.line,
                  column: node.property.loc.start.column,
                }
              : undefined,
            data: {
              property: 'constructor',
            },
          });
        }

        // Reflection statics, wherever the member is read: called, called through call/apply/bind,
        // kept in a variable, passed as a value. The name is matched in every spelling that can
        // be resolved without running the script.
        if (node.object?.type === 'Identifier' && node.object.name === 'Object') {
          const methodName = memberNames(node).find((name) => OBJECT_META_STATICS.has(name));
          if (methodName !== undefined) {
            report({
              code: 'NO_META_PROGRAMMING',
              message: `Use of Object.${methodName}() is not allowed`,
              location: node.loc
                ? {
                    line: node.loc.start.line,
                    column: node.loc.start.column,
                  }
                : undefined,
              data: {
                api: 'Object',
                method: methodName,
              },
            });
          }
        }
      },

      // Check destructuring from globals: const { eval } = window
      VariableDeclarator: (node: any) => {
        if (node.init && node.init.type === 'Identifier') {
          const sourceName = node.init.name;

          // Check if destructuring from a blocked global
          if (this.blockedGlobals.has(sourceName)) {
            if (node.id.type === 'ObjectPattern') {
              const properties = node.id.properties
                .map((prop: any) => {
                  if (prop.type === 'Property' && prop.key.type === 'Identifier') {
                    return prop.key.name;
                  }
                  return '(unknown)';
                })
                .join(', ');

              report({
                code: 'NO_GLOBAL_DESTRUCTURE',
                message: `Destructuring from ${sourceName} is not allowed: { ${properties} }`,
                location: node.init.loc
                  ? {
                      line: node.init.loc.start.line,
                      column: node.init.loc.start.column,
                    }
                  : undefined,
                data: {
                  global: sourceName,
                  properties,
                },
              });
            }
          }
        }
      },

      // Check for Reflect API usage
      CallExpression: (node: any) => {
        if (
          node.callee &&
          node.callee.type === 'MemberExpression' &&
          node.callee.object.type === 'Identifier' &&
          node.callee.object.name === 'Reflect'
        ) {
          const methodName = node.callee.property.type === 'Identifier' ? node.callee.property.name : '(unknown)';

          report({
            code: 'NO_REFLECT_API',
            message: `Use of Reflect.${methodName}() is not allowed`,
            location: node.callee.loc
              ? {
                  line: node.callee.loc.start.line,
                  column: node.callee.loc.start.column,
                }
              : undefined,
            data: {
              api: 'Reflect',
              method: methodName,
            },
          });
        }
      },
    });
  }

  /**
   * Refuse every use of the global `Object` other than a direct one (see `requireDirectObjectUse`).
   */
  private checkDirectObjectUse(context: ValidationContext): void {
    // Only a reference that reaches the global is the Object constructor. A variable of the
    // script with that name can only hold it through a free reference, which is refused here.
    const free = new Set<AnyNode>();
    for (const ref of analyzeScopes(context.ast).freeReferences) {
      if (ref.name === 'Object') free.add(ref.node);
    }
    if (free.size === 0) return;

    walkAll(context.ast, (node, ancestors, key) => {
      if (node.type !== 'Identifier' || node.name !== 'Object' || !free.has(node)) return;

      const parent: AnyNode | undefined = ancestors[ancestors.length - 1];

      // Object.name / Object['name']: a static whose name is written in the source. The one
      // exception is `valueOf`, which returns its receiver: the object under another name.
      if (parent?.type === 'MemberExpression' && key === 'object') {
        const name = staticPropertyName(parent.property, parent.computed === true);
        if (name !== undefined && name !== 'valueOf') return;
      }

      // Object(x), new Object()
      if ((parent?.type === 'CallExpression' || parent?.type === 'NewExpression') && key === 'callee') return;

      // typeof Object, x instanceof Object: neither hands the object to anything
      if (parent?.type === 'UnaryExpression' && parent.operator === 'typeof') return;
      if (parent?.type === 'BinaryExpression' && parent.operator === 'instanceof' && key === 'right') return;

      context.report({
        code: 'OBJECT_INDIRECT_USE',
        message:
          'Object can only be used directly, as Object.keys(...), Object.entries(...) and so on. ' +
          'Aliasing Object, passing or storing it as a value, destructuring from it, or reading a ' +
          'member whose name is computed at run time is not allowed.',
        location: node.loc ? { line: node.loc.start.line, column: node.loc.start.column } : undefined,
        data: { parentType: parent?.type },
      });
    });
  }
}
