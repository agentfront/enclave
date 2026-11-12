import * as walk from 'acorn-walk';
import { ValidationRule, ValidationContext, ValidationSeverity } from '../interfaces';
import { walkAll, staticPropertyName, type AnyNode } from '../utils/ast-walk';
import { analyzeScopes, type ScopeReference } from '../utils/scope-analysis';

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
   * Require `JSON` to be used only as `JSON.parse(...)` / `JSON.stringify(...)`, called directly.
   *
   * The callback check only sees calls written exactly that way. With this option every other use
   * of the global `JSON` object is refused, since it would move the call out of sight: an alias
   * (`const J = JSON`), `JSON.stringify.call(...)`, a method read without a call
   * (`const s = JSON.stringify`), a runtime-computed method name (`JSON[name](...)`), a call of any
   * other method (`JSON.valueOf()` returns the object), passing `JSON` as a value, and destructuring
   * from it. `typeof JSON` and `typeof JSON.parse` stay allowed.
   *
   * Default: false
   */
  requireDirectUse?: boolean;

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
  private readonly requireDirectUse: boolean;
  private readonly messageTemplate: string;

  constructor(options: NoJsonCallbacksOptions = {}) {
    this.blockStringifyReplacer = options.blockStringifyReplacer ?? true;
    this.blockParseReviver = options.blockParseReviver ?? true;
    this.requireDirectUse = options.requireDirectUse === true;
    this.messageTemplate =
      options.messageTemplate ?? 'JSON.{method}() with callback function is not allowed (property enumeration risk)';
  }

  validate(context: ValidationContext): void {
    const { freeReferences } = analyzeScopes(context.ast);

    // "No callback" is the value `undefined`, which only the global of that name is sure to hold.
    // A variable of the script may be called `undefined` and hold a function.
    const globalUndefined = new Set<AnyNode>();
    for (const ref of freeReferences) {
      if (ref.name === 'undefined') globalUndefined.add(ref.node);
    }

    walk.simple(context.ast as any, {
      CallExpression: (node: any) => {
        this.checkJsonCall(node, context, globalUndefined);
      },
    });

    if (this.requireDirectUse) {
      this.checkDirectUse(context, freeReferences);
    }
  }

  /**
   * Refuse every use of the `JSON` object other than a direct `JSON.parse(...)` or
   * `JSON.stringify(...)` call with a statically-known method name.
   */
  private checkDirectUse(context: ValidationContext, freeReferences: readonly ScopeReference[]): void {
    // Only a reference that reaches the global is the JSON object. A local variable of that name
    // (`const JSON = {...}`) is the script's own value: it can only hold the JSON object through a
    // free reference, and that reference is refused here.
    const free = new Set<AnyNode>();
    for (const ref of freeReferences) {
      if (ref.name === 'JSON') free.add(ref.node);
    }

    walkAll(context.ast, (node, ancestors, key) => {
      if (node.type !== 'Identifier' || node.name !== 'JSON' || !free.has(node)) return;

      const parent: AnyNode | undefined = ancestors[ancestors.length - 1];
      const grandparent: AnyNode | undefined = ancestors[ancestors.length - 2];

      // `x.JSON`, `{ JSON: 1 }`: a property called JSON is not the JSON object.
      if (parent && !parent.computed) {
        if (parent.type === 'MemberExpression' && key === 'property') return;
        if ((parent.type === 'Property' || parent.type === 'MethodDefinition') && key === 'key') return;
      }

      // `typeof JSON`: yields a string, cannot alias the object.
      if (parent?.type === 'UnaryExpression' && parent.operator === 'typeof') return;

      const isStaticMember =
        parent?.type === 'MemberExpression' &&
        key === 'object' &&
        staticPropertyName(parent.property, parent.computed) !== undefined;
      if (isStaticMember) {
        // JSON.parse(...) / JSON.stringify(...): the two methods whose arguments are checked. Any
        // other method is refused; `JSON.valueOf()` for one returns the JSON object itself.
        const method = staticPropertyName(parent.property, parent.computed);
        if (
          grandparent?.type === 'CallExpression' &&
          grandparent.callee === parent &&
          (method === 'parse' || method === 'stringify')
        ) {
          return;
        }
        // `typeof JSON.stringify`
        if (grandparent?.type === 'UnaryExpression' && grandparent.operator === 'typeof') return;
      }

      context.report({
        code: 'JSON_INDIRECT_USE',
        message:
          'JSON can only be used as JSON.parse(...) or JSON.stringify(...), called directly. ' +
          'Aliasing JSON, reading its methods without calling them, or calling them through ' +
          'call/apply/bind or a computed name is not allowed.',
        location: node.loc ? { line: node.loc.start.line, column: node.loc.start.column } : undefined,
        data: { parentType: parent?.type },
      });
    });
  }

  private checkJsonCall(node: any, context: ValidationContext, globalUndefined: ReadonlySet<AnyNode>): void {
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
      this.checkStringifyReplacer(node, context, globalUndefined);
    }

    // Check JSON.parse with reviver
    if (this.blockParseReviver && methodName === 'parse') {
      this.checkParseReviver(node, context, globalUndefined);
    }
  }

  private checkStringifyReplacer(node: any, context: ValidationContext, globalUndefined: ReadonlySet<AnyNode>): void {
    // JSON.stringify(value, replacer?, space?)
    // A spread hides which argument lands in the replacer position: JSON.stringify(...[v, fn]).
    if (this.hasSpreadArgument(node, 2)) {
      this.report(node, 'stringify', 'replacer', context);
      return;
    }

    // We need to check the second argument (replacer)
    if (node.arguments.length < 2) {
      return; // No replacer argument, safe
    }

    const replacerArg = node.arguments[1];

    // Allow null or undefined replacer
    if (this.isNullOrUndefined(replacerArg, globalUndefined)) {
      return;
    }

    // Allow array replacer (allowlist of property names)
    if (replacerArg.type === 'ArrayExpression') {
      return;
    }

    // Anything that is not provably a non-function is refused.
    if (!this.isProvablyNotAFunction(replacerArg, globalUndefined)) {
      this.report(node, 'stringify', 'replacer', context);
    }
  }

  private checkParseReviver(node: any, context: ValidationContext, globalUndefined: ReadonlySet<AnyNode>): void {
    // JSON.parse(text, reviver?)
    // A spread hides which argument lands in the reviver position: JSON.parse(...[text, fn]).
    if (this.hasSpreadArgument(node, 2)) {
      this.report(node, 'parse', 'reviver', context);
      return;
    }

    // We need to check the second argument (reviver)
    if (node.arguments.length < 2) {
      return; // No reviver argument, safe
    }

    const reviverArg = node.arguments[1];

    // Allow null or undefined reviver
    if (this.isNullOrUndefined(reviverArg, globalUndefined)) {
      return;
    }

    // Anything that is not provably a non-function is refused.
    if (!this.isProvablyNotAFunction(reviverArg, globalUndefined)) {
      this.report(node, 'parse', 'reviver', context);
    }
  }

  /** Whether a spread element appears among the first `count` arguments. */
  private hasSpreadArgument(node: any, count: number): boolean {
    for (let i = 0; i < node.arguments.length && i < count; i++) {
      if (node.arguments[i]?.type === 'SpreadElement') return true;
    }
    return false;
  }

  /**
   * Whether an argument can be seen, without running the script, to be something other than a
   * function. JSON ignores a replacer/reviver that is not callable (and not an array), so these
   * shapes are harmless. Every other expression (a variable, a call, `(0, fn)`, `await fn`,
   * `a = fn`, ...) could evaluate to a function and is refused.
   */
  private isProvablyNotAFunction(node: any, globalUndefined: ReadonlySet<AnyNode>): boolean {
    if (node.type === 'Literal') return true; // string, number, boolean, null, bigint
    if (node.type === 'TemplateLiteral') return true; // always a string
    if (node.type === 'ObjectExpression' || node.type === 'ArrayExpression') return true;
    return this.isNullOrUndefined(node, globalUndefined);
  }

  private isJsonObject(node: any): boolean {
    // Check for direct JSON identifier
    if (node.type === 'Identifier' && node.name === 'JSON') {
      return true;
    }
    return false;
  }

  private getMethodName(callee: any): string | null {
    // Every static spelling the direct-use check accepts, so that both passes agree on the method:
    // JSON.method(), JSON['method'](), JSON[`method`]()
    const staticName = staticPropertyName(callee.property, callee.computed === true);
    if (staticName !== undefined) {
      return staticName;
    }

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

  private isNullOrUndefined(node: any, globalUndefined: ReadonlySet<AnyNode>): boolean {
    // null literal
    if (node.type === 'Literal' && node.value === null) {
      return true;
    }

    // The global `undefined`. The same word naming a variable of the script (a declaration, a
    // parameter, a catch binding) is that variable, with whatever value the script gave it.
    if (node.type === 'Identifier' && node.name === 'undefined' && globalUndefined.has(node)) {
      return true;
    }

    // void expression (e.g., void 0) evaluates to undefined
    if (node.type === 'UnaryExpression' && node.operator === 'void') {
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
