import * as walk from 'acorn-walk';
import { ValidationRule, ValidationContext, ValidationSeverity } from '../interfaces';
import { walkAll, type AnyNode } from '../utils/ast-walk';

/**
 * Options for StaticCallTargetRule
 */
export interface StaticCallTargetOptions {
  /**
   * List of function names to validate
   * Default: ['callTool', '__safe_callTool']
   */
  targetFunctions?: string[];

  /**
   * Optional whitelist of allowed tool names
   * Supports exact strings or RegExp patterns
   * If provided, only these tool names are allowed
   */
  allowedToolNames?: (string | RegExp)[];

  /**
   * Which argument position to validate (0-indexed)
   * Default: 0 (first argument)
   */
  argumentPosition?: number;

  /**
   * Require every use of a target function to be a direct call: `callTool('name', args)`.
   *
   * The static-argument check only sees `CallExpression`s whose callee is the target by name. Any
   * other use of the function value takes the call out of its sight, so with this option they are
   * all refused: an alias (`const c = callTool`), passing it as a value (`names.map(callTool)`),
   * `callTool.call(...)` / `.apply` / `.bind`, `new callTool(...)`, a tagged template, a
   * parenthesized or sequence callee (`(0, callTool)(name)`), and re-declaring the name.
   * `typeof callTool` stays allowed.
   *
   * Default: false
   */
  requireDirectCall?: boolean;
}

/**
 * Rule that enforces static string literals for call targets
 *
 * This rule ensures that certain functions (like `callTool`) are called
 * with static string literals as their first argument. This prevents
 * dynamic tool name injection and enables static analysis of tool usage.
 *
 * @example
 * ```typescript
 * // These will FAIL validation:
 * callTool(toolName, args);           // Variable reference
 * callTool("tool" + suffix, args);    // Concatenation
 * callTool(`tool_${id}`, args);       // Template with expressions
 * callTool(cond ? "a" : "b", args);   // Ternary expression
 *
 * // These will PASS validation:
 * callTool("users:list", args);       // Static string literal
 * callTool('billing:invoice', args);  // Static string literal
 * ```
 */
export class StaticCallTargetRule implements ValidationRule {
  readonly name = 'static-call-target';
  readonly description = 'Enforces static string literals for call targets';
  readonly defaultSeverity = ValidationSeverity.ERROR;
  readonly enabledByDefault = true;

  private readonly targetFunctions: Set<string>;
  private readonly allowedToolNames: (string | RegExp)[] | undefined;
  private readonly argumentPosition: number;
  private readonly requireDirectCall: boolean;

  constructor(private options: StaticCallTargetOptions = {}) {
    this.targetFunctions = new Set(options.targetFunctions ?? ['callTool', '__safe_callTool']);
    this.allowedToolNames = options.allowedToolNames;
    this.argumentPosition = options.argumentPosition ?? 0;
    this.requireDirectCall = options.requireDirectCall === true;
  }

  validate(context: ValidationContext): void {
    if (this.requireDirectCall) {
      this.checkDirectCalls(context);
    }

    walk.simple(context.ast as any, {
      CallExpression: (node: any) => {
        const callee = node.callee;
        let funcName: string | null = null;

        // Get function name from different call patterns
        if (callee.type === 'Identifier') {
          funcName = callee.name;
        } else if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') {
          funcName = callee.property.name;
        }

        // Skip if not a target function
        if (!funcName || !this.targetFunctions.has(funcName)) {
          return;
        }

        const args = node.arguments;
        const targetArg = args[this.argumentPosition];

        // Check if argument exists
        if (!targetArg) {
          context.report({
            code: 'MISSING_CALL_TARGET',
            message: `Function "${funcName}" requires a target argument at position ${this.argumentPosition + 1}`,
            location: node.loc
              ? {
                  line: node.loc.start.line,
                  column: node.loc.start.column,
                }
              : undefined,
            data: {
              function: funcName,
              argumentPosition: this.argumentPosition,
            },
          });
          return;
        }

        // Check if argument is a static string literal
        const staticStringValue = this.extractStaticString(targetArg);

        if (staticStringValue === null) {
          const dynamicType = this.describeDynamicType(targetArg);
          context.report({
            code: 'DYNAMIC_CALL_TARGET',
            message:
              `Function "${funcName}" requires argument ${this.argumentPosition + 1} to be a static string literal. ` +
              `${dynamicType} are not allowed as they prevent static analysis and could enable injection attacks.`,
            location: targetArg.loc
              ? {
                  line: targetArg.loc.start.line,
                  column: targetArg.loc.start.column,
                }
              : undefined,
            data: {
              function: funcName,
              argumentPosition: this.argumentPosition,
              argumentType: targetArg.type,
              dynamicType,
            },
          });
          return;
        }

        // If allowedToolNames is specified, validate against it
        if (this.allowedToolNames && this.allowedToolNames.length > 0) {
          const isAllowed = this.allowedToolNames.some((pattern) => {
            if (typeof pattern === 'string') {
              return pattern === staticStringValue;
            }
            return pattern.test(staticStringValue);
          });

          if (!isAllowed) {
            context.report({
              code: 'UNKNOWN_TOOL_NAME',
              message: `Tool "${staticStringValue}" is not in the allowed tools list for function "${funcName}"`,
              location: targetArg.loc
                ? {
                    line: targetArg.loc.start.line,
                    column: targetArg.loc.start.column,
                  }
                : undefined,
              data: {
                function: funcName,
                toolName: staticStringValue,
                allowedTools: this.allowedToolNames.map((p) => (p instanceof RegExp ? p.source : p)),
              },
            });
          }
        }
      },
    });
  }

  /**
   * Refuse every occurrence of a target function name that is not the callee of a direct call.
   * Property names (`obj.callTool`, `{ callTool: 1 }`) are not the function and are left alone.
   */
  private checkDirectCalls(context: ValidationContext): void {
    walkAll(context.ast, (node, ancestors, key) => {
      if (node.type !== 'Identifier' || !this.targetFunctions.has(node.name)) return;

      const parent: AnyNode | undefined = ancestors[ancestors.length - 1];
      if (parent && isPropertyNamePosition(parent, key)) return;
      if (parent?.type === 'CallExpression' && key === 'callee') return;
      // `typeof callTool` only yields a string; it cannot hand the function to anything.
      if (parent?.type === 'UnaryExpression' && parent.operator === 'typeof') return;

      context.report({
        code: 'INDIRECT_CALL_TARGET',
        message:
          `"${node.name}" can only be called directly, as ${node.name}('tool-name', args). ` +
          `Storing it in a variable, passing it as a value, or calling it through call/apply/bind, ` +
          `new or a tagged template is not allowed, because the tool name could no longer be checked.`,
        location: node.loc ? { line: node.loc.start.line, column: node.loc.start.column } : undefined,
        data: { function: node.name, parentType: parent?.type },
      });
    });
  }

  /**
   * Extract a static string value from an AST node
   * Returns null if the node is not a static string
   */
  private extractStaticString(node: any): string | null {
    // Simple string literal: "foo" or 'foo'
    if (node.type === 'Literal' && typeof node.value === 'string') {
      return node.value;
    }

    // Template literal with no expressions: `foo`
    if (node.type === 'TemplateLiteral') {
      // Only allow template literals with zero expressions (fully static)
      if (node.expressions.length === 0 && node.quasis.length === 1) {
        return node.quasis[0].value.cooked;
      }
      // Template with expressions is dynamic
      return null;
    }

    // All other node types are considered dynamic
    return null;
  }

  /**
   * Describe why a node type is considered dynamic (for error messages)
   */
  private describeDynamicType(node: any): string {
    switch (node.type) {
      case 'Identifier':
        return `Variable references (like "${node.name}")`;
      case 'BinaryExpression':
        if (node.operator === '+') {
          return 'String concatenation expressions';
        }
        return 'Binary expressions';
      case 'TemplateLiteral':
        return 'Template literals with embedded expressions';
      case 'ConditionalExpression':
        return 'Conditional (ternary) expressions';
      case 'CallExpression':
        return 'Function call results';
      case 'MemberExpression':
        return 'Property access expressions';
      case 'LogicalExpression':
        return 'Logical expressions';
      case 'AssignmentExpression':
        return 'Assignment expressions';
      case 'SequenceExpression':
        return 'Sequence expressions';
      case 'AwaitExpression':
        return 'Await expressions';
      default:
        return `Dynamic expressions (${node.type})`;
    }
  }
}

/** Whether `key` of `parent` holds a property NAME rather than a value reference. */
function isPropertyNamePosition(parent: AnyNode, key: string): boolean {
  if (parent.computed) return false;
  if (parent.type === 'MemberExpression') return key === 'property';
  if (parent.type === 'Property' || parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition') {
    // The key is a name. (`{ callTool }` also has a separate value node, which IS a reference.)
    return key === 'key';
  }
  return false;
}
