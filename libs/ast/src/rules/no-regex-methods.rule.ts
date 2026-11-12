import * as walk from 'acorn-walk';
import { ValidationRule, ValidationContext, ValidationSeverity } from '../interfaces';
import { analyzeScopes } from '../utils/scope-analysis';
import { staticPropertyName } from '../utils/ast-walk';

/**
 * Options for the NoRegexMethodsRule
 */
export interface NoRegexMethodsOptions {
  /**
   * Methods to block on strings.
   * These methods accept regex as arguments.
   * Default: ['match', 'matchAll', 'search', 'replace', 'replaceAll', 'split']
   */
  blockedStringMethods?: string[];

  /**
   * Methods to block on regex objects.
   * These methods execute regex matching.
   * Default: ['test', 'exec']
   */
  blockedRegexMethods?: string[];

  /**
   * Allow methods when the first argument is a string literal (not regex).
   * For example: "hello".split(",") is safe.
   * Default: true
   */
  allowStringArguments?: boolean;

  /**
   * Custom error message template.
   * Placeholders: {method}
   */
  messageTemplate?: string;
}

/**
 * Default methods that accept regex on strings
 */
const DEFAULT_STRING_METHODS = [
  'match', // str.match(regex)
  'matchAll', // str.matchAll(regex)
  'search', // str.search(regex)
  'replace', // str.replace(regex, replacement)
  'replaceAll', // str.replaceAll(regex, replacement)
  'split', // str.split(regex)
];

/**
 * String methods that COMPILE a string argument into a regular expression.
 * `'text'.match('(a+)+$')` builds and runs the regex `/(a+)+$/`: a string is not a way around the
 * regex ban for these three. (`split`, `replace` and `replaceAll` treat a string literally.)
 */
const PATTERN_COMPILING_STRING_METHODS = new Set(['match', 'matchAll', 'search']);

/** Members with which an object decides what it is as a text */
const CONVERSION_KEYS = new Set(['toString', 'valueOf']);

/**
 * Default methods on regex objects
 */
const DEFAULT_REGEX_METHODS = [
  'test', // regex.test(str)
  'exec', // regex.exec(str)
];

/**
 * Rule that blocks regex method calls to prevent ReDoS attacks.
 *
 * Even if regex literals are blocked, an attacker could potentially
 * construct regex through other means and use these methods. This rule
 * provides defense-in-depth by blocking the execution paths.
 *
 * **Blocked patterns:**
 * - `string.match(regex)`
 * - `string.matchAll(regex)`
 * - `string.search(regex)`
 * - `string.replace(regex, ...)`
 * - `string.replaceAll(regex, ...)`
 * - `string.split(regex)`
 * - `regex.test(string)`
 * - `regex.exec(string)`
 *
 * **Allowed (when allowStringArguments is true):**
 * - `"hello".split(",")` - string argument, not regex
 * - `"hello".replace("l", "x")` - string argument
 *
 * @example
 * ```typescript
 * // Block all regex methods (AgentScript preset)
 * new NoRegexMethodsRule()
 *
 * // Allow string arguments
 * new NoRegexMethodsRule({ allowStringArguments: true })
 *
 * // Custom blocked methods
 * new NoRegexMethodsRule({
 *   blockedStringMethods: ['match', 'replace'],
 *   blockedRegexMethods: ['test'],
 * })
 * ```
 */
export class NoRegexMethodsRule implements ValidationRule {
  readonly name = 'no-regex-methods';
  readonly description = 'Blocks regex method calls to prevent ReDoS attacks';
  readonly defaultSeverity = ValidationSeverity.ERROR;
  readonly enabledByDefault = false; // Enabled via presets

  private readonly blockedStringMethods: Set<string>;
  private readonly blockedRegexMethods: Set<string>;
  private readonly allowStringArguments: boolean;
  private readonly messageTemplate: string;

  constructor(options: NoRegexMethodsOptions = {}) {
    this.blockedStringMethods = new Set(options.blockedStringMethods ?? DEFAULT_STRING_METHODS);
    this.blockedRegexMethods = new Set(options.blockedRegexMethods ?? DEFAULT_REGEX_METHODS);
    this.allowStringArguments = options.allowStringArguments ?? true;
    this.messageTemplate = options.messageTemplate ?? 'Use of .{method}() with regex is not allowed (ReDoS risk)';
  }

  validate(context: ValidationContext): void {
    // The identifiers that name a global (what the host provides), not a variable of the script
    const freeReferences = new Set<unknown>();
    if (!this.allowStringArguments) {
      for (const ref of analyzeScopes(context.ast).freeReferences) freeReferences.add(ref.node);
    }

    walk.simple(context.ast as any, {
      CallExpression: (node: any) => {
        this.checkMethodCall(node, context, freeReferences);
      },
      // str.match`pattern` calls the method with the template strings: the same regex path as a
      // call, written without a CallExpression.
      TaggedTemplateExpression: (node: any) => {
        const tag = node.tag;
        if (tag?.type !== 'MemberExpression') return;
        const methodName = this.getMethodName(tag);
        if (methodName && (this.blockedStringMethods.has(methodName) || this.blockedRegexMethods.has(methodName))) {
          context.report({
            code: 'NO_REGEX_METHOD',
            message: `Use of .${methodName}() as a template tag is not allowed (the template is used as a regex, ReDoS risk)`,
            location: this.getLocation(tag),
            data: { method: methodName, form: 'tagged-template' },
          });
        }
      },
    });
  }

  private checkMethodCall(node: any, context: ValidationContext, freeReferences: ReadonlySet<unknown>): void {
    const callee = node.callee;

    // Only check member expressions: obj.method()
    if (callee.type !== 'MemberExpression') {
      return;
    }

    // Get method name
    const methodName = this.getMethodName(callee);
    if (!methodName) {
      return;
    }

    // Check string methods (e.g., str.match, str.replace)
    if (this.blockedStringMethods.has(methodName)) {
      // If allowing string arguments, check the first argument
      if (this.allowStringArguments && this.hasStringArgument(node)) {
        return; // Safe - using string, not regex
      }

      // Check if argument is a regex literal or RegExp constructor
      if (this.hasRegexArgument(node)) {
        this.report(node, methodName, context);
        return;
      }

      // match / matchAll / search turn a string argument into a regex, so when string arguments
      // are not accepted as proof of safety, a string here is a regex by another spelling.
      if (
        !this.allowStringArguments &&
        PATTERN_COMPILING_STRING_METHODS.has(methodName) &&
        this.hasStringArgument(node)
      ) {
        context.report({
          code: 'NO_REGEX_METHOD',
          message:
            `Use of .${methodName}() with a string is not allowed: the string is compiled into a regular ` +
            `expression (ReDoS risk). Use .includes(), .indexOf(), .startsWith() or .endsWith() instead.`,
          location: this.getLocation(callee),
          data: { method: methodName, form: 'string-pattern' },
        });
        return;
      }

      // The same three methods with an argument that is not a literal: on a string, whatever it
      // evaluates to (a string, a regular expression) is run as a regular expression. A method of
      // that name on an object of the host (`docs.search(args)`, a tool namespace) is not a
      // string method, and neither is a call whose argument is an object literal: those stay
      // with the warning below.
      if (
        !this.allowStringArguments &&
        PATTERN_COMPILING_STRING_METHODS.has(methodName) &&
        node.arguments.length > 0 &&
        this.couldCompilePattern(node, freeReferences)
      ) {
        context.report({
          code: 'NO_REGEX_METHOD',
          message:
            `Use of .${methodName}() with a non-literal argument is not allowed: the argument is used as a ` +
            `regular expression (ReDoS risk). Use .includes(), .indexOf(), .startsWith() or .endsWith() instead.`,
          location: this.getLocation(callee),
          data: { method: methodName, form: 'dynamic-pattern' },
        });
        return;
      }

      // For dynamic arguments, we need to be cautious
      // If we can't prove it's safe, report a warning
      if (!this.hasStringArgument(node) && node.arguments.length > 0) {
        context.report({
          code: 'REGEX_METHOD_DYNAMIC',
          severity: ValidationSeverity.WARNING,
          message: `Call to .${methodName}() with dynamic argument - ensure argument is not a regex (ReDoS risk)`,
          location: this.getLocation(callee),
          data: { method: methodName },
        });
      }
    }

    // Check regex object methods (e.g., /pattern/.test, regex.exec)
    if (this.blockedRegexMethods.has(methodName)) {
      // Check if caller is a regex literal
      if (this.isRegexLiteral(callee.object)) {
        this.report(node, methodName, context);
        return;
      }

      // Check if caller might be a regex (we can't always tell statically)
      // Report a warning for dynamic cases
      if (!this.isStringLiteral(callee.object)) {
        context.report({
          code: 'REGEX_METHOD_DYNAMIC',
          severity: ValidationSeverity.WARNING,
          message: `Call to .${methodName}() - ensure object is not a regex (ReDoS risk)`,
          location: this.getLocation(callee),
          data: { method: methodName },
        });
      }
    }
  }

  /**
   * Whether `receiver.match(arg)` / `matchAll` / `search` with a non-literal argument could be a
   * string turning that argument into a regular expression. It could not when:
   * - the receiver names a global: a value of the host (a tool namespace, a custom global), not
   *   a string the script made;
   * - the argument is an object literal that defines no conversion of its own: as a pattern it
   *   is the text `[object Object]`;
   * - the argument is a number, boolean or null literal.
   */
  private couldCompilePattern(node: any, freeReferences: ReadonlySet<unknown>): boolean {
    const receiver = node.callee.object;
    if (receiver?.type === 'Identifier' && freeReferences.has(receiver)) {
      return false;
    }

    const argument = node.arguments[0];
    if (argument.type === 'Literal' && !argument.regex && typeof argument.value !== 'string') {
      return false;
    }
    if (argument.type === 'ObjectExpression') {
      return !argument.properties.every(
        (property: any) =>
          property.type === 'Property' &&
          !property.computed &&
          !CONVERSION_KEYS.has(property.key.type === 'Identifier' ? property.key.name : String(property.key.value)),
      );
    }
    return true;
  }

  private getMethodName(callee: any): string | null {
    // Every static spelling of a method name: obj.method(), obj['method'](), obj[`method`]()
    const staticName = staticPropertyName(callee.property, callee.computed === true);
    if (staticName !== undefined) {
      return staticName;
    }

    // obj.method() - identifier property
    if (callee.property?.type === 'Identifier') {
      return callee.property.name;
    }

    // obj['method']() - literal property
    if (callee.property?.type === 'Literal' && typeof callee.property.value === 'string') {
      return callee.property.value;
    }

    return null;
  }

  private hasStringArgument(node: any): boolean {
    const firstArg = node.arguments[0];
    if (!firstArg) return false;

    // Direct string literal
    if (firstArg.type === 'Literal' && typeof firstArg.value === 'string') {
      return true;
    }

    // Template literal without expressions
    if (firstArg.type === 'TemplateLiteral' && firstArg.expressions.length === 0) {
      return true;
    }

    return false;
  }

  private hasRegexArgument(node: any): boolean {
    const firstArg = node.arguments[0];
    if (!firstArg) return false;

    // Regex literal: /pattern/
    if (firstArg.type === 'Literal' && firstArg.regex) {
      return true;
    }

    // new RegExp() or RegExp()
    if (
      (firstArg.type === 'NewExpression' || firstArg.type === 'CallExpression') &&
      firstArg.callee?.type === 'Identifier' &&
      firstArg.callee?.name === 'RegExp'
    ) {
      return true;
    }

    return false;
  }

  private isRegexLiteral(node: any): boolean {
    return node?.type === 'Literal' && node.regex;
  }

  private isStringLiteral(node: any): boolean {
    if (node?.type === 'Literal' && typeof node.value === 'string') {
      return true;
    }
    if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) {
      return true;
    }
    return false;
  }

  private report(node: any, methodName: string, context: ValidationContext): void {
    context.report({
      code: 'NO_REGEX_METHOD',
      message: this.messageTemplate.replace('{method}', methodName),
      location: this.getLocation(node.callee),
      data: { method: methodName },
    });
  }

  private getLocation(node: any): { line: number; column: number } | undefined {
    return node.loc
      ? {
          line: node.loc.start.line,
          column: node.loc.start.column,
        }
      : undefined;
  }
}
