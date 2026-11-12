import * as walk from 'acorn-walk';
import { ValidationRule, ValidationContext, ValidationSeverity } from '../interfaces';
import { analyzeScopes } from '../utils/scope-analysis';
import { staticPropertyName, walkAll, type AnyNode } from '../utils/ast-walk';
import { tryGetStaticComputedKeys } from './coercion-utils';

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
   * Names of globals that are objects of the host and not strings: tool namespaces, custom
   * globals that hold an object or a function. A method called `match`, `matchAll` or `search`
   * on one of them (`docs.search(args)`) is not a string method, so with
   * `allowStringArguments: false` a call with a non-literal argument keeps the warning instead
   * of being refused. A global that is not listed is treated like any other value: it may be a
   * string the host passed in.
   * Default: []
   */
  hostObjectNames?: string[];

  /**
   * Refuse every use of a property named `match`, `matchAll` or `search` that is not a direct
   * call (`value.search(...)`, which is checked as before): reading it (`const find = text.match`),
   * passing or storing it, a member of it, and taking it by destructuring (`const { match } = text`).
   *
   * Every way to run one of these methods on a receiver the rule cannot see starts from the method
   * as a value. The rule always refuses the spellings nobody needs (`.call`, `.apply`, `.bind`, a
   * template tag); with this option the value itself cannot be had. The price is that a field of
   * ordinary data with one of these names (`params.search`) cannot be read either, which is why
   * it is an option: turn it on where this rule is the only thing between a script and the
   * regular-expression engine. Writing the property (`o.search = x`), an object literal with such
   * a key, `typeof`, and every use of a method of a global listed in `hostObjectNames` stay
   * allowed.
   *
   * Default: false
   */
  requireDirectCall?: boolean;

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

/** Function members that call a function with a receiver and arguments of the caller's choice */
const INVOKERS = new Set(['call', 'apply', 'bind']);

/** The expression inside the wrappers that do not change what it evaluates to: `(a?.b)`, `(a)`. */
function unwrap(node: AnyNode): AnyNode {
  let inner = node;
  while (inner && (inner.type === 'ChainExpression' || inner.type === 'ParenthesizedExpression')) {
    inner = inner.expression;
  }
  return inner;
}

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
 * - `string.match.call(...)`, `.apply(...)`, `.bind(...)`, for every method above: a call whose
 *   receiver and arguments are not where this rule looks for them
 *
 * The method name is recognised in every spelling that can be resolved without running the
 * script: `s.match`, `s['match']`, `` s[`match`] ``, `s[['match']]`, `s['mat' + 'ch']`.
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
  private readonly hostObjectNames: ReadonlySet<string>;
  private readonly requireDirectCall: boolean;
  private readonly messageTemplate: string;

  constructor(options: NoRegexMethodsOptions = {}) {
    this.requireDirectCall = options.requireDirectCall === true;
    this.hostObjectNames = new Set(options.hostObjectNames ?? []);
    this.blockedStringMethods = new Set(options.blockedStringMethods ?? DEFAULT_STRING_METHODS);
    this.blockedRegexMethods = new Set(options.blockedRegexMethods ?? DEFAULT_REGEX_METHODS);
    this.allowStringArguments = options.allowStringArguments ?? true;
    this.messageTemplate = options.messageTemplate ?? 'Use of .{method}() with regex is not allowed (ReDoS risk)';
  }

  validate(context: ValidationContext): void {
    // The identifiers that name a global the host declared as an object (a tool namespace, say),
    // not a variable of the script that happens to have the same name
    const freeReferences = new Set<unknown>();
    if (this.hostObjectNames.size > 0) {
      for (const ref of analyzeScopes(context.ast).freeReferences) {
        if (this.hostObjectNames.has(ref.name)) freeReferences.add(ref.node);
      }
    }

    walk.simple(context.ast as any, {
      CallExpression: (node: any) => {
        this.checkMethodCall(node, context, freeReferences);
      },
      // str.match`pattern` calls the method with the template strings: the same regex path as a
      // call, written without a CallExpression.
      TaggedTemplateExpression: (node: any) => {
        const tag = unwrap(node.tag);
        if (tag?.type !== 'MemberExpression') return;
        const methodName = this.blockedMethodName(tag);
        if (methodName) {
          context.report({
            code: 'NO_REGEX_METHOD',
            message: `Use of .${methodName}() as a template tag is not allowed (the template is used as a regex, ReDoS risk)`,
            location: this.getLocation(tag),
            data: { method: methodName, form: 'tagged-template' },
          });
        }
      },
    });

    // The uses of a method that are not a call of it. Every node is visited, so a member in an
    // assignment target or a pattern is seen like any other.
    walkAll(context.ast, (node, ancestors) => {
      if (node.type === 'MemberExpression') {
        this.checkIndirectCall(node, context, freeReferences);
        if (this.requireDirectCall) this.checkValueRead(node, ancestors, context, freeReferences);
      } else if (this.requireDirectCall && node.type === 'ObjectPattern') {
        this.checkDestructuredMethod(node, context);
      }
    });
  }

  /**
   * `receiver.method.call(...)`, `.apply(...)`, `.bind(...)`: the method is run with a receiver and
   * arguments that are not where the call check looks for them. Refused for every blocked method:
   * nothing needs to call a method of these names this way.
   */
  private checkIndirectCall(node: AnyNode, context: ValidationContext, freeReferences: ReadonlySet<unknown>): void {
    if (!this.memberNames(node).some((name) => INVOKERS.has(name))) return;

    const method = unwrap(node.object);
    if (method?.type !== 'MemberExpression') return;
    if (method.object?.type === 'Identifier' && freeReferences.has(method.object)) return;

    const methodName = this.blockedMethodName(method);
    if (!methodName) return;

    context.report({
      code: 'NO_REGEX_METHOD',
      message:
        `Use of .${methodName}() through call, apply or bind is not allowed: the receiver and the ` +
        `arguments of such a call cannot be checked (ReDoS risk). Call the method directly.`,
      location: this.getLocation(method),
      data: { method: methodName, form: 'indirect-call' },
    });
  }

  /**
   * With `requireDirectCall`: a property named like a pattern-compiling method, used as anything
   * but the callee of a call. A direct call, a template tag and a call through call/apply/bind
   * have their own checks; `typeof` and a plain assignment to the property do not read the method.
   */
  private checkValueRead(
    node: AnyNode,
    ancestors: readonly AnyNode[],
    context: ValidationContext,
    freeReferences: ReadonlySet<unknown>,
  ): void {
    const methodName = this.patternCompilingName(this.memberNames(node));
    if (!methodName) return;
    if (node.object?.type === 'Identifier' && freeReferences.has(node.object)) return;

    // The node that decides what happens to the value, past the wrappers that change nothing
    let child = node;
    let index = ancestors.length - 1;
    while (
      index >= 0 &&
      (ancestors[index].type === 'ChainExpression' || ancestors[index].type === 'ParenthesizedExpression')
    ) {
      child = ancestors[index];
      index--;
    }
    const parent: AnyNode | undefined = ancestors[index];

    if (parent) {
      if (parent.type === 'CallExpression' && parent.callee === child) return;
      if (parent.type === 'TaggedTemplateExpression' && parent.tag === child) return;
      if (parent.type === 'UnaryExpression' && parent.operator === 'typeof') return;
      if (parent.type === 'AssignmentExpression' && parent.operator === '=' && parent.left === child) return;
      if (
        parent.type === 'MemberExpression' &&
        parent.object === child &&
        this.memberNames(parent).some((name) => INVOKERS.has(name))
      ) {
        return;
      }
    }

    context.report({
      code: 'NO_REGEX_METHOD',
      message:
        `Use of .${methodName} other than as a direct call is not allowed: on a string it is the method ` +
        `that runs a regular expression, and as a value it can be called where it cannot be checked.`,
      location: this.getLocation(node),
      data: { method: methodName, form: 'value' },
    });
  }

  /** With `requireDirectCall`: `const { match } = text` takes the method as a value. */
  private checkDestructuredMethod(pattern: AnyNode, context: ValidationContext): void {
    for (const property of pattern.properties ?? []) {
      if (property.type !== 'Property') continue;

      const literal = staticPropertyName(property.key, property.computed === true);
      const names =
        literal !== undefined
          ? [literal]
          : property.computed
            ? tryGetStaticComputedKeys(property.key, { foldConstants: true })
            : [];
      const methodName = this.patternCompilingName(names);
      if (!methodName) continue;

      context.report({
        code: 'NO_REGEX_METHOD',
        message:
          `Taking .${methodName} by destructuring is not allowed: on a string it is the method that runs a ` +
          `regular expression, and as a value it can be called where it cannot be checked.`,
        location: this.getLocation(property.key),
        data: { method: methodName, form: 'destructured' },
      });
    }
  }

  private checkMethodCall(node: any, context: ValidationContext, freeReferences: ReadonlySet<unknown>): void {
    // The callee, past an optional chain or parentheses around it: `(text?.match)(pattern)`
    const callee = unwrap(node.callee);

    // Only check member expressions: obj.method()
    if (callee?.type !== 'MemberExpression') {
      return;
    }

    // Get method name
    const names = this.calledMethodNames(callee);
    const methodName =
      this.patternCompilingName(names) ??
      names.find((name) => this.blockedStringMethods.has(name)) ??
      names.find((name) => this.blockedRegexMethods.has(name));
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
        this.report(callee, methodName, context);
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

      // The same three methods with anything else. What is accepted is what can be seen not to be
      // a string running a pattern: a method of that name on a global the host declared as an
      // object (`docs.search(args)`, a tool namespace), and a call whose argument is an object
      // literal of data or a number, boolean or null literal. Those stay with the warning below.
      // Everything else is refused: an argument that is not a literal (whatever it evaluates to
      // is run as a regular expression), a spread, and no argument at all (the empty pattern).
      if (
        !this.allowStringArguments &&
        PATTERN_COMPILING_STRING_METHODS.has(methodName) &&
        this.couldCompilePattern(node, callee, freeReferences)
      ) {
        const withoutArgument = node.arguments.length === 0;
        context.report({
          code: 'NO_REGEX_METHOD',
          message: withoutArgument
            ? `Use of .${methodName}() without an argument is not allowed: on a string it runs a regular ` +
              `expression. Use .includes(), .indexOf(), .startsWith() or .endsWith() instead.`
            : `Use of .${methodName}() with a non-literal argument is not allowed: the argument is used as a ` +
              `regular expression (ReDoS risk). Use .includes(), .indexOf(), .startsWith() or .endsWith() instead.`,
          location: this.getLocation(callee),
          data: { method: methodName, form: withoutArgument ? 'no-pattern' : 'dynamic-pattern' },
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
        this.report(callee, methodName, context);
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
   * - the receiver names a global that `hostObjectNames` lists: an object of the host (a tool
   *   namespace), not a string;
   * - the argument is an object literal that defines no conversion of its own: as a pattern it
   *   is the text `[object Object]`;
   * - the argument is a number, boolean or null literal.
   * Without an argument it could: the pattern is then the empty one.
   */
  private couldCompilePattern(node: any, callee: AnyNode, freeReferences: ReadonlySet<unknown>): boolean {
    const receiver = callee.object;
    if (receiver?.type === 'Identifier' && freeReferences.has(receiver)) {
      return false;
    }

    const argument = node.arguments[0];
    if (!argument) {
      return true;
    }
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

  /**
   * Every name a member access may have, as far as it can be known without running the script:
   * `obj.method`, `obj['method']`, `` obj[`method`] ``, and a computed key that resolves to known
   * strings (`obj[['method']]`, `obj[c ? 'a' : 'b']`, `obj['met' + 'hod']`).
   */
  private memberNames(member: AnyNode): string[] {
    const property = member.property;
    if (!property) return [];
    if (!member.computed) return property.type === 'Identifier' ? [property.name] : [];

    const literal = staticPropertyName(property, true);
    if (literal !== undefined) return [literal];

    return tryGetStaticComputedKeys(property, { foldConstants: true });
  }

  /**
   * The names of the method a call is made on. As {@link memberNames}, and for `obj[method](...)`
   * the name of the variable: a variable that carries the name of a method is taken for it.
   */
  private calledMethodNames(member: AnyNode): string[] {
    if (member.computed && member.property?.type === 'Identifier') return [member.property.name];
    return this.memberNames(member);
  }

  /** The blocked method a call is made on, if any. */
  private blockedMethodName(member: AnyNode): string | undefined {
    return this.calledMethodNames(member).find(
      (name) => this.blockedStringMethods.has(name) || this.blockedRegexMethods.has(name),
    );
  }

  /** The blocked method among `names` that compiles its argument into a pattern, if any. */
  private patternCompilingName(names: readonly string[]): string | undefined {
    return names.find((name) => PATTERN_COMPILING_STRING_METHODS.has(name) && this.blockedStringMethods.has(name));
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

  private report(callee: AnyNode, methodName: string, context: ValidationContext): void {
    context.report({
      code: 'NO_REGEX_METHOD',
      message: this.messageTemplate.replace('{method}', methodName),
      location: this.getLocation(callee),
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
