import type * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import type { ValidationRule, ValidationContext } from '../interfaces';
import { ValidationSeverity } from '../interfaces';
import { analyzeScopes, type BindingKind } from '../utils/scope-analysis';

/**
 * Configuration options for NoCallTargetAssignmentRule
 */
/**
 * Error types for NoCallTargetAssignmentRule
 */
export type NoCallTargetAssignmentErrorType =
  | 'assignment'
  | 'declaration'
  | 'function-declaration'
  | 'function-expression'
  | 'class-declaration'
  | 'destructuring'
  | 'destructuring-rest'
  | 'parameter'
  | 'catch-parameter'
  | 'import';

/**
 * How a declaration that the per-shape checks did not see is reported. A plain `const` / `let` /
 * `var` name is seen by those checks, so one that reaches this table sits in a pattern.
 */
const BINDING_ERROR_TYPES: Record<BindingKind, NoCallTargetAssignmentErrorType> = {
  var: 'destructuring',
  let: 'destructuring',
  const: 'destructuring',
  function: 'function-declaration',
  class: 'class-declaration',
  param: 'parameter',
  catch: 'catch-parameter',
  import: 'import',
};

export interface NoCallTargetAssignmentOptions {
  /**
   * List of protected call targets that cannot be assigned or shadowed
   * Default: ['callTool']
   */
  protectedTargets?: string[];

  /**
   * Custom error message
   */
  message?: string;
}

/**
 * NoCallTargetAssignmentRule - Blocks assignment and shadowing of protected call targets
 *
 * This rule prevents user code from:
 * - Reassigning protected identifiers like `callTool`, in every position a variable can be
 *   written in: `=` and the compound operators, a destructuring assignment, the head of a
 *   `for…of` / `for…in` loop, `++` and `--`
 * - Shadowing protected identifiers via declarations, in every position a variable can be
 *   declared in: declarations, parameters, catch clauses, function and class names, and the
 *   patterns inside any of them
 *
 * **Purpose:**
 * - Protect the integrity of core API functions
 * - Prevent users from overriding tool call behavior
 * - Ensure sandbox security by preserving call targets
 *
 * **Example violations:**
 * ```javascript
 * callTool = () => 'pwned';              // ❌ BLOCKED: Assignment to protected target
 * const callTool = () => {};             // ❌ BLOCKED: Declaration shadows protected target
 * const { callTool } = obj;              // ❌ BLOCKED: Destructuring shadows protected target
 * function callTool() {}                 // ❌ BLOCKED: Function declaration shadows
 * ```
 *
 * **Valid code:**
 * ```javascript
 * await callTool('test', {});            // ✅ OK: Using callTool
 * const result = await callTool('x', {}); // ✅ OK: Using return value
 * ```
 *
 * @example
 * ```typescript
 * const rule = new NoCallTargetAssignmentRule({
 *   protectedTargets: ['callTool', 'myCustomAPI'],
 * });
 * ```
 */
export class NoCallTargetAssignmentRule implements ValidationRule {
  readonly name = 'no-call-target-assignment';
  readonly description = 'Blocks assignment and shadowing of protected call targets';
  readonly defaultSeverity = ValidationSeverity.ERROR;
  readonly enabledByDefault = true;

  private readonly protectedTargets: Set<string>;
  private readonly customMessage?: string;
  /** Per validation: the identifiers already reported */
  private readonly reportedNodes = new WeakMap<ValidationContext, Set<unknown>>();

  constructor(options: NoCallTargetAssignmentOptions = {}) {
    this.protectedTargets = new Set(options.protectedTargets || ['callTool']);
    this.customMessage = options.message;
  }

  validate(context: ValidationContext): void {
    const { ast } = context;

    // The identifiers reported by the per-shape checks, so that the pass over every binding and
    // every write below adds only what those checks did not see
    const reported = new Set<unknown>();
    this.reportedNodes.set(context, reported);

    walk.simple(ast, {
      // Block: callTool = malicious
      AssignmentExpression: (node: any) => {
        if (node.left.type === 'Identifier' && this.protectedTargets.has(node.left.name)) {
          this.reportError(node.left, 'assignment', context);
        }
      },

      // Block: const callTool = ...
      VariableDeclarator: (node: any) => {
        if (node.id.type === 'Identifier' && this.protectedTargets.has(node.id.name)) {
          this.reportError(node.id, 'declaration', context);
        } else if (node.id.type === 'ObjectPattern') {
          // Block: const { callTool } = obj
          this.checkObjectPattern(node.id, context);
        } else if (node.id.type === 'ArrayPattern') {
          // Block: const [callTool] = arr
          this.checkArrayPattern(node.id, context);
        }
      },

      // Block: function callTool() {}
      FunctionDeclaration: (node: any) => {
        if (node.id && this.protectedTargets.has(node.id.name)) {
          this.reportError(node.id, 'function-declaration', context);
        }
        // Also check function parameters
        if (node.params) {
          this.checkParameters(node.params, context);
        }
      },

      // Block: const f = function callTool() {}
      FunctionExpression: (node: any) => {
        if (node.id && this.protectedTargets.has(node.id.name)) {
          this.reportError(node.id, 'function-expression', context);
        }
        if (node.params) {
          this.checkParameters(node.params, context);
        }
      },

      // Block: (callTool) => {}
      ArrowFunctionExpression: (node: any) => {
        if (node.params) {
          this.checkParameters(node.params, context);
        }
      },

      // Block: class callTool {}
      ClassDeclaration: (node: any) => {
        if (node.id && this.protectedTargets.has(node.id.name)) {
          this.reportError(node.id, 'class-declaration', context);
        }
      },

      // Block: catch (callTool) {}
      CatchClause: (node: any) => {
        if (node.param && node.param.type === 'Identifier' && this.protectedTargets.has(node.param.name)) {
          this.reportError(node.param, 'catch-parameter', context);
        }
      },

      // Block: import callTool from 'module'
      ImportDefaultSpecifier: (node: any) => {
        if (node.local && this.protectedTargets.has(node.local.name)) {
          this.reportError(node.local, 'import', context);
        }
      },

      // Block: import { x as callTool } from 'module'
      ImportSpecifier: (node: any) => {
        if (node.local && this.protectedTargets.has(node.local.name)) {
          this.reportError(node.local, 'import', context);
        }
      },
    });

    // The checks above each name a shape. This pass names none: every identifier that declares a
    // variable and every identifier that is written, wherever it stands (a pattern inside a catch
    // clause or behind a default value, a destructuring assignment, a loop head, `++`).
    const { bindings, references } = analyzeScopes(ast);
    for (const binding of bindings) {
      if (this.protectedTargets.has(binding.name) && !reported.has(binding.node)) {
        this.reportError(binding.node, BINDING_ERROR_TYPES[binding.kind], context);
      }
    }
    for (const reference of references) {
      if (reference.write && this.protectedTargets.has(reference.name) && !reported.has(reference.node)) {
        this.reportError(reference.node, 'assignment', context);
      }
    }
  }

  /**
   * Check object pattern for protected identifiers
   */
  private checkObjectPattern(pattern: any, context: ValidationContext): void {
    for (const prop of pattern.properties) {
      if (prop.type === 'Property') {
        // Handle: const { callTool } = obj
        // Handle: const { x: callTool } = obj
        const value = prop.value;
        if (value.type === 'Identifier' && this.protectedTargets.has(value.name)) {
          this.reportError(value, 'destructuring', context);
        } else if (value.type === 'ObjectPattern') {
          this.checkObjectPattern(value, context);
        } else if (value.type === 'ArrayPattern') {
          this.checkArrayPattern(value, context);
        } else if (value.type === 'AssignmentPattern') {
          // Handle: const { callTool = default } = obj
          if (value.left.type === 'Identifier' && this.protectedTargets.has(value.left.name)) {
            this.reportError(value.left, 'destructuring', context);
          }
        }
      } else if (prop.type === 'RestElement') {
        // Handle: const { ...callTool } = obj
        if (prop.argument.type === 'Identifier' && this.protectedTargets.has(prop.argument.name)) {
          this.reportError(prop.argument, 'destructuring-rest', context);
        }
      }
    }
  }

  /**
   * Check array pattern for protected identifiers
   */
  private checkArrayPattern(pattern: any, context: ValidationContext): void {
    for (const element of pattern.elements) {
      if (!element) continue;

      if (element.type === 'Identifier' && this.protectedTargets.has(element.name)) {
        this.reportError(element, 'destructuring', context);
      } else if (element.type === 'ObjectPattern') {
        this.checkObjectPattern(element, context);
      } else if (element.type === 'ArrayPattern') {
        this.checkArrayPattern(element, context);
      } else if (element.type === 'AssignmentPattern') {
        // Handle: const [callTool = default] = arr
        if (element.left.type === 'Identifier' && this.protectedTargets.has(element.left.name)) {
          this.reportError(element.left, 'destructuring', context);
        }
      } else if (element.type === 'RestElement') {
        // Handle: const [...callTool] = arr
        if (element.argument.type === 'Identifier' && this.protectedTargets.has(element.argument.name)) {
          this.reportError(element.argument, 'destructuring-rest', context);
        }
      }
    }
  }

  /**
   * Check function parameters for protected identifiers
   */
  private checkParameters(params: any[], context: ValidationContext): void {
    for (const param of params) {
      if (param.type === 'Identifier' && this.protectedTargets.has(param.name)) {
        this.reportError(param, 'parameter', context);
      } else if (param.type === 'ObjectPattern') {
        this.checkObjectPattern(param, context);
      } else if (param.type === 'ArrayPattern') {
        this.checkArrayPattern(param, context);
      } else if (param.type === 'AssignmentPattern') {
        // Handle: function f(callTool = default) {}
        if (param.left.type === 'Identifier' && this.protectedTargets.has(param.left.name)) {
          this.reportError(param.left, 'parameter', context);
        }
      } else if (param.type === 'RestElement') {
        // Handle: function f(...callTool) {}
        if (param.argument.type === 'Identifier' && this.protectedTargets.has(param.argument.name)) {
          this.reportError(param.argument, 'parameter', context);
        }
      }
    }
  }

  /**
   * Report a validation error
   */
  private reportError(
    node: acorn.Node & { name: string },
    type: NoCallTargetAssignmentErrorType,
    context: ValidationContext,
  ): void {
    const targetName = node.name;
    this.reportedNodes.get(context)?.add(node);

    const typeMessages: Record<string, string> = {
      assignment: `Cannot assign to protected identifier "${targetName}"`,
      declaration: `Cannot declare variable named "${targetName}"`,
      'function-declaration': `Cannot declare function named "${targetName}"`,
      'function-expression': `Cannot name function expression "${targetName}"`,
      'class-declaration': `Cannot declare class named "${targetName}"`,
      destructuring: `Cannot destructure into "${targetName}"`,
      'destructuring-rest': `Cannot use rest element named "${targetName}"`,
      parameter: `Cannot use "${targetName}" as parameter name`,
      'catch-parameter': `Cannot use "${targetName}" as catch parameter`,
      import: `Cannot import as "${targetName}"`,
    };

    context.report({
      code: 'NO_CALL_TARGET_ASSIGNMENT',
      message:
        this.customMessage ||
        `${typeMessages[type] || `Cannot use protected identifier "${targetName}"`}. ` +
          `"${targetName}" is a protected call target and cannot be shadowed or reassigned.`,
      location: node.loc
        ? {
            line: node.loc.start.line,
            column: node.loc.start.column,
            endLine: node.loc.end.line,
            endColumn: node.loc.end.column,
          }
        : undefined,
      data: {
        target: targetName,
        type,
        protectedTargets: Array.from(this.protectedTargets),
      },
    });
  }
}
