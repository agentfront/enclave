import type * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import type { ValidationRule, ValidationContext } from '../interfaces';
import { ValidationSeverity } from '../interfaces';
import { analyzeScopes } from '../utils/scope-analysis';
import { walkAll } from '../utils/ast-walk';
import { tryGetStaticComputedKeys } from './coercion-utils';

/**
 * Configuration options for ReservedPrefixRule
 */
export interface ReservedPrefixOptions {
  /**
   * List of reserved prefixes that identifiers cannot use
   * Default: ['__ag_', '__safe_']
   */
  reservedPrefixes?: string[];

  /**
   * List of allowed identifiers that can use reserved prefixes
   * (for internal/compiler use)
   * Default: ['__ag_main']
   */
  allowedIdentifiers?: string[];

  /**
   * Custom error message
   */
  message?: string;
}

/**
 * ReservedPrefixRule - Blocks identifiers starting with reserved prefixes
 *
 * This rule prevents user code from using internal runtime/compiler prefixes,
 * ensuring no collision with:
 * - `__ag_*` - AgentScript compiler/runtime internals
 * - `__safe_*` - Safe runtime wrappers
 *
 * **Purpose:**
 * - Protect internal implementation details from user access
 * - Prevent namespace pollution
 * - Ensure clear separation between user code and runtime
 *
 * **Example violations:**
 * ```javascript
 * const __ag_main = 42;              // ❌ BLOCKED: __ag_ prefix reserved
 * const __safe_callTool = () => {};  // ❌ BLOCKED: __safe_ prefix reserved
 * function __ag_helper() {}          // ❌ BLOCKED: __ag_ prefix reserved
 * ```
 *
 * **Valid code:**
 * ```javascript
 * const main = 42;                   // ✅ OK
 * const safeTool = () => {};         // ✅ OK
 * function helper() {}               // ✅ OK
 * ```
 *
 * @example
 * ```typescript
 * const rule = new ReservedPrefixRule({
 *   reservedPrefixes: ['__ag_', '__safe_', '__internal_'],
 * });
 * ```
 */
export class ReservedPrefixRule implements ValidationRule {
  readonly name = 'reserved-prefix';
  readonly description = 'Blocks identifiers starting with reserved prefixes';
  readonly defaultSeverity = ValidationSeverity.ERROR;
  readonly enabledByDefault = true;

  private readonly reservedPrefixes: string[];
  private readonly allowedIdentifiers: Set<string>;
  private readonly customMessage?: string;
  /** Nodes already reported in the current run, so the passes below never report one twice. */
  private reported = new WeakSet<object>();

  constructor(options: ReservedPrefixOptions = {}) {
    this.reservedPrefixes = options.reservedPrefixes || ['__ag_', '__safe_'];
    this.allowedIdentifiers = new Set(options.allowedIdentifiers || ['__ag_main']);
    this.customMessage = options.message;
  }

  validate(context: ValidationContext): void {
    const { ast } = context;
    this.reported = new WeakSet<object>();

    // Walk the AST and check all identifier declarations AND assignments
    walk.simple(ast, {
      // Variable declarations (const, let, var)
      VariableDeclarator: (node: any) => {
        if (node.id.type === 'Identifier') {
          this.checkIdentifier(node.id, context);
        } else if (node.id.type === 'ObjectPattern' || node.id.type === 'ArrayPattern') {
          // Handle destructuring: const { __ag_foo } = obj
          this.checkPattern(node.id, context);
        }
      },

      // Assignment expressions (x = y, x += y, etc.)
      // Security: Block runtime reassignment of protected identifiers
      AssignmentExpression: (node: any) => {
        // Check direct identifier assignment: __safe_callTool = malicious
        if (node.left.type === 'Identifier') {
          this.checkAssignmentTarget(node.left, context);
        }
        // Check member expression assignment: obj.__safe_foo = malicious or obj['__safe_foo'] = malicious
        if (node.left.type === 'MemberExpression') {
          this.checkMemberAssignment(node.left, context);
        }
      },

      // Update expressions (++x, x++, --x, x--)
      // Security: Block increment/decrement of protected identifiers
      UpdateExpression: (node: any) => {
        if (node.argument.type === 'Identifier') {
          this.checkAssignmentTarget(node.argument, context);
        }
      },

      // Function declarations
      FunctionDeclaration: (node: any) => {
        if (node.id && node.id.type === 'Identifier') {
          this.checkIdentifier(node.id, context);
        }
        // Check parameter names
        if (node.params) {
          node.params.forEach((param: any) => {
            if (param.type === 'Identifier') {
              this.checkIdentifier(param, context);
            } else {
              this.checkPattern(param, context);
            }
          });
        }
      },

      // Function expressions
      FunctionExpression: (node: any) => {
        if (node.id && node.id.type === 'Identifier') {
          this.checkIdentifier(node.id, context);
        }
        if (node.params) {
          node.params.forEach((param: any) => {
            if (param.type === 'Identifier') {
              this.checkIdentifier(param, context);
            } else {
              this.checkPattern(param, context);
            }
          });
        }
      },

      // Arrow functions
      ArrowFunctionExpression: (node: any) => {
        if (node.params) {
          node.params.forEach((param: any) => {
            if (param.type === 'Identifier') {
              this.checkIdentifier(param, context);
            } else {
              this.checkPattern(param, context);
            }
          });
        }
      },

      // Class declarations
      ClassDeclaration: (node: any) => {
        if (node.id && node.id.type === 'Identifier') {
          this.checkIdentifier(node.id, context);
        }
      },

      // Import/Export specifiers
      ImportSpecifier: (node: any) => {
        if (node.local) {
          this.checkIdentifier(node.local, context);
        }
      },

      ImportDefaultSpecifier: (node: any) => {
        if (node.local) {
          this.checkIdentifier(node.local, context);
        }
      },

      // Catch clause (catch (error) {})
      CatchClause: (node: any) => {
        if (node.param && node.param.type === 'Identifier') {
          this.checkIdentifier(node.param, context);
        }
      },
    });

    // The visitors above cover the common forms. These two passes cover the rest, in every
    // position: bindings inside any pattern (catch ({ __safe_x }), class names, nested defaults),
    // and identifiers written through destructuring, a for-in/of head or `delete`
    // ([__safe_callTool] = y, ({ a: __safe_callTool } = y), for (__safe_callTool of z)).
    const { bindings, references } = analyzeScopes(ast);
    for (const binding of bindings) {
      this.checkIdentifier(binding.node, context);
    }
    for (const ref of references) {
      if (ref.write) this.checkAssignmentTarget(ref.node, context);
    }

    // Member targets in the same positions: [obj.__safe_x] = y, for (obj.__safe_x of z), obj.__safe_x++
    walkAll(ast, (node, ancestors, key) => {
      if (node.type !== 'MemberExpression') return;
      const parent = ancestors[ancestors.length - 1];
      if (!parent) return;
      const isWriteTarget =
        (parent.type === 'AssignmentExpression' && key === 'left') ||
        (parent.type === 'UpdateExpression' && key === 'argument') ||
        (parent.type === 'UnaryExpression' && parent.operator === 'delete') ||
        ((parent.type === 'ForInStatement' || parent.type === 'ForOfStatement') && key === 'left') ||
        parent.type === 'ArrayPattern' ||
        parent.type === 'RestElement' ||
        (parent.type === 'AssignmentPattern' && key === 'left') ||
        (parent.type === 'Property' && key === 'value' && ancestors[ancestors.length - 2]?.type === 'ObjectPattern');
      if (isWriteTarget) this.checkMemberAssignment(node, context);
    });
  }

  /**
   * Check if an identifier starts with a reserved prefix
   */
  private checkIdentifier(node: acorn.Node & { name: string }, context: ValidationContext): void {
    const identifierName = node.name;

    // Check if this identifier is explicitly allowed
    if (this.allowedIdentifiers.has(identifierName)) {
      return; // Allow internal identifiers like __ag_main
    }

    for (const prefix of this.reservedPrefixes) {
      if (identifierName.startsWith(prefix)) {
        if (this.reported.has(node)) return;
        this.reported.add(node);
        context.report({
          code: 'RESERVED_PREFIX',
          message:
            this.customMessage ||
            `Identifier "${identifierName}" uses reserved prefix "${prefix}". ` +
              `Identifiers starting with ${this.reservedPrefixes.map((p) => `"${p}"`).join(', ')} ` +
              `are reserved for internal use.`,
          location: node.loc
            ? {
                line: node.loc.start.line,
                column: node.loc.start.column,
                endLine: node.loc.end.line,
                endColumn: node.loc.end.column,
              }
            : undefined,
          data: {
            identifier: identifierName,
            prefix,
            reservedPrefixes: this.reservedPrefixes,
          },
        });
        return; // Only report once per identifier
      }
    }
  }

  /**
   * Check destructuring patterns for reserved prefixes
   */
  private checkPattern(pattern: any, context: ValidationContext): void {
    if (pattern.type === 'Identifier') {
      this.checkIdentifier(pattern, context);
    } else if (pattern.type === 'ObjectPattern') {
      pattern.properties.forEach((prop: any) => {
        if (prop.type === 'Property') {
          this.checkPattern(prop.value, context);
        } else if (prop.type === 'RestElement') {
          this.checkPattern(prop.argument, context);
        }
      });
    } else if (pattern.type === 'ArrayPattern') {
      pattern.elements.forEach((elem: any) => {
        if (elem) {
          this.checkPattern(elem, context);
        }
      });
    } else if (pattern.type === 'AssignmentPattern') {
      this.checkPattern(pattern.left, context);
    } else if (pattern.type === 'RestElement') {
      this.checkPattern(pattern.argument, context);
    }
  }

  /**
   * Check assignment targets for reserved prefixes
   * Security: Blocks runtime reassignment of protected identifiers
   *
   * @example
   * __safe_callTool = () => 'pwned';  // ❌ BLOCKED
   * __ag_counter = 0;                  // ❌ BLOCKED
   */
  private checkAssignmentTarget(node: acorn.Node & { name: string }, context: ValidationContext): void {
    const identifierName = node.name;

    // Check if this identifier is explicitly allowed
    if (this.allowedIdentifiers.has(identifierName)) {
      return;
    }

    for (const prefix of this.reservedPrefixes) {
      if (identifierName.startsWith(prefix)) {
        if (this.reported.has(node)) return;
        this.reported.add(node);
        context.report({
          code: 'RESERVED_PREFIX_ASSIGNMENT',
          message:
            this.customMessage ||
            `Cannot assign to reserved identifier "${identifierName}". ` +
              `Identifiers starting with ${this.reservedPrefixes.map((p) => `"${p}"`).join(', ')} ` +
              `are protected runtime functions and cannot be reassigned.`,
          location: node.loc
            ? {
                line: node.loc.start.line,
                column: node.loc.start.column,
                endLine: node.loc.end.line,
                endColumn: node.loc.end.column,
              }
            : undefined,
          data: {
            identifier: identifierName,
            prefix,
            type: 'assignment',
            reservedPrefixes: this.reservedPrefixes,
          },
        });
        return;
      }
    }
  }

  /**
   * Check member expression assignments for reserved prefixes
   * Security: Blocks assignment to properties with reserved prefixes
   *
   * @example
   * obj.__safe_callTool = malicious;       // ❌ BLOCKED
   * obj['__safe_callTool'] = malicious;    // ❌ BLOCKED
   * this.__ag_internal = 42;               // ❌ BLOCKED
   */
  private checkMemberAssignment(node: any, context: ValidationContext): void {
    // Get property name from member expression
    let propName: string | null = null;

    if (node.computed && node.property.type === 'Literal') {
      // obj['__safe_foo'] = ...
      propName = String(node.property.value);
    } else if (node.computed) {
      // obj[`__safe_foo`] = ..., obj[['__safe_foo']] = ...: every statically resolvable key form
      const staticKeys = tryGetStaticComputedKeys(node.property);
      propName = staticKeys.find((k) => this.reservedPrefixes.some((prefix) => k.startsWith(prefix))) ?? null;
    } else if (node.property.type === 'Identifier') {
      // obj.__safe_foo = ...
      propName = node.property.name;
    }

    if (!propName) return;

    for (const prefix of this.reservedPrefixes) {
      if (propName.startsWith(prefix)) {
        if (this.reported.has(node)) return;
        this.reported.add(node);
        context.report({
          code: 'RESERVED_PREFIX_MEMBER_ASSIGNMENT',
          message:
            this.customMessage ||
            `Cannot assign to property "${propName}". ` +
              `Properties starting with ${this.reservedPrefixes.map((p) => `"${p}"`).join(', ')} ` +
              `are protected and cannot be modified.`,
          location: node.property.loc
            ? {
                line: node.property.loc.start.line,
                column: node.property.loc.start.column,
                endLine: node.property.loc.end.line,
                endColumn: node.property.loc.end.column,
              }
            : undefined,
          data: {
            property: propName,
            prefix,
            type: 'member-assignment',
            reservedPrefixes: this.reservedPrefixes,
          },
        });
        return;
      }
    }
  }
}
