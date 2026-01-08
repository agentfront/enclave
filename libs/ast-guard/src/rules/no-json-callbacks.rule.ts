import * as walk from 'acorn-walk';
import { ValidationRule, ValidationContext, ValidationSeverity } from '../interfaces';

/**
 * Options for the NoJsonCallbacksRule
 */
export interface NoJsonCallbacksOptions {
  /**
   * Block JSON.stringify with replacer function argument.
   * Default: true
   */
  blockStringifyReplacer?: boolean;

  /**
   * Block JSON.parse with reviver function argument.
   * Default: true
   */
  blockParseReviver?: boolean;

  /**
   * Custom error message template.
   * Placeholders: {method}
   */
  messageTemplate?: string;
}

/**
 * Rule that blocks JSON.stringify and JSON.parse with callback functions.
 *
 * This prevents information leakage attacks where a replacer/reviver function
 * is used to walk and enumerate properties of objects, potentially exposing
 * internal sandbox globals or sensitive data.
 *
 * **Attack Vector (Vector 960 - "Native Walker" Replacer Leak):**
 * ```javascript
 * const walker = (key, value) => {
 *   keysFound.push(key);  // Leaks property names
 *   return value;
 * };
 * JSON.stringify(this, walker);  // Walks global scope
 * ```
 *
 * **Blocked patterns:**
 * - `JSON.stringify(value, replacerFunction)` - replacer can enumerate properties
 * - `JSON.stringify(value, replacerFunction, space)` - same with space argument
 * - `JSON.parse(text, reviverFunction)` - reviver can intercept all values
 *
 * **Allowed patterns:**
 * - `JSON.stringify(value)` - no replacer, safe
 * - `JSON.stringify(value, null)` - null replacer, safe
 * - `JSON.stringify(value, null, 2)` - null replacer with space, safe
 * - `JSON.stringify(value, ['key1', 'key2'])` - array allowlist replacer, safe
 * - `JSON.parse(text)` - no reviver, safe
 *
 * @example
 * ```typescript
 * // Block all JSON callbacks (default)
 * new NoJsonCallbacksRule()
 *
 * // Block only stringify replacer
 * new NoJsonCallbacksRule({ blockParseReviver: false })
 *
 * // Block only parse reviver
 * new NoJsonCallbacksRule({ blockStringifyReplacer: false })
 * ```
 */
export class NoJsonCallbacksRule implements ValidationRule {
  readonly name = 'no-json-callbacks';
  readonly description = 'Blocks JSON.stringify/parse with callback functions to prevent property enumeration attacks';
  readonly defaultSeverity = ValidationSeverity.ERROR;
  readonly enabledByDefault = false; // Enabled via presets

  private readonly blockStringifyReplacer: boolean;
  private readonly blockParseReviver: boolean;
  private readonly messageTemplate: string;

  constructor(options: NoJsonCallbacksOptions = {}) {
    this.blockStringifyReplacer = options.blockStringifyReplacer ?? true;
    this.blockParseReviver = options.blockParseReviver ?? true;
    this.messageTemplate =
      options.messageTemplate ?? 'JSON.{method}() with callback function is not allowed (property enumeration risk)';
  }

  validate(context: ValidationContext): void {
    walk.simple(context.ast as any, {
      CallExpression: (node: any) => {
        this.checkJsonCall(node, context);
      },
    });
  }

  private checkJsonCall(node: any, context: ValidationContext): void {
    const callee = node.callee;

    // Normalize callee: handle both MemberExpression and ChainExpression (optional chaining)
    // For JSON?.stringify(...), callee.type is 'ChainExpression' with callee.expression being the MemberExpression
    let memberExpr: any;
    if (callee.type === 'MemberExpression') {
      memberExpr = callee;
    } else if (callee.type === 'ChainExpression' && callee.expression?.type === 'MemberExpression') {
      // Extract the inner MemberExpression from optional chaining: JSON?.stringify(...)
      memberExpr = callee.expression;
    } else {
      return;
    }

    // Check if it's a JSON method call
    if (!this.isJsonObject(memberExpr.object)) {
      return;
    }

    const methodName = this.getMethodName(memberExpr);
    if (!methodName) {
      return;
    }

    // Check JSON.stringify with replacer
    if (this.blockStringifyReplacer && methodName === 'stringify') {
      this.checkStringifyReplacer(node, context);
    }

    // Check JSON.parse with reviver
    if (this.blockParseReviver && methodName === 'parse') {
      this.checkParseReviver(node, context);
    }
  }

  private checkStringifyReplacer(node: any, context: ValidationContext): void {
    // JSON.stringify(value, replacer?, space?)
    // We need to check the second argument (replacer)
    if (node.arguments.length < 2) {
      return; // No replacer argument, safe
    }

    const replacerArg = node.arguments[1];

    // Allow null or undefined replacer
    if (this.isNullOrUndefined(replacerArg)) {
      return;
    }

    // Allow array replacer (allowlist of property names)
    if (replacerArg.type === 'ArrayExpression') {
      return;
    }

    // Block function replacer (arrow function, function expression, or identifier)
    if (this.isFunctionOrPotentialFunction(replacerArg)) {
      this.report(node, 'stringify', 'replacer', context);
    }
  }

  private checkParseReviver(node: any, context: ValidationContext): void {
    // JSON.parse(text, reviver?)
    // We need to check the second argument (reviver)
    if (node.arguments.length < 2) {
      return; // No reviver argument, safe
    }

    const reviverArg = node.arguments[1];

    // Allow null or undefined reviver
    if (this.isNullOrUndefined(reviverArg)) {
      return;
    }

    // Block function reviver (arrow function, function expression, or identifier)
    if (this.isFunctionOrPotentialFunction(reviverArg)) {
      this.report(node, 'parse', 'reviver', context);
    }
  }

  private isJsonObject(node: any): boolean {
    // Check for direct JSON identifier
    if (node.type === 'Identifier' && node.name === 'JSON') {
      return true;
    }
    return false;
  }

  private getMethodName(callee: any): string | null {
    // JSON.method() - identifier property
    if (callee.property?.type === 'Identifier') {
      return callee.property.name;
    }

    // JSON['method']() - literal property
    if (callee.property?.type === 'Literal' && typeof callee.property.value === 'string') {
      return callee.property.value;
    }

    return null;
  }

  private isNullOrUndefined(node: any): boolean {
    // null literal
    if (node.type === 'Literal' && node.value === null) {
      return true;
    }

    // undefined identifier
    if (node.type === 'Identifier' && node.name === 'undefined') {
      return true;
    }

    return false;
  }

  private isFunctionOrPotentialFunction(node: any): boolean {
    // Direct function expressions
    if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
      return true;
    }

    // Identifier could be a function reference
    // We must be conservative and block this to prevent:
    // const walker = (k, v) => { ... };
    // JSON.stringify(obj, walker);
    if (node.type === 'Identifier') {
      return true;
    }

    // Member expression could be a function reference
    // e.g., obj.method, this.replacer
    if (node.type === 'MemberExpression') {
      return true;
    }

    // Call expression result could be a function
    // e.g., JSON.stringify(obj, getReplacer())
    if (node.type === 'CallExpression') {
      return true;
    }

    // Conditional expression could return a function
    // e.g., JSON.stringify(obj, condition ? fn1 : fn2)
    if (node.type === 'ConditionalExpression') {
      return true;
    }

    // Logical expression could return a function
    // e.g., JSON.stringify(obj, fn || defaultFn)
    if (node.type === 'LogicalExpression') {
      return true;
    }

    return false;
  }

  private report(node: any, method: string, argType: string, context: ValidationContext): void {
    const message = this.messageTemplate.replace('{method}', method);

    context.report({
      code: 'JSON_CALLBACK_NOT_ALLOWED',
      message,
      location: node.loc
        ? {
            line: node.loc.start.line,
            column: node.loc.start.column,
          }
        : undefined,
      data: {
        method,
        argumentType: argType,
      },
    });
  }
}
