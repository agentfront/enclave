import * as walk from 'acorn-walk';
import { ValidationRule, ValidationContext, ValidationSeverity } from '../interfaces';

/**
 * Options for ResourceExhaustionRule
 */
export interface ResourceExhaustionOptions {
  /** Maximum allowed BigInt exponent (default: 10000) */
  maxBigIntExponent?: number;
  /** Maximum allowed array size literal (default: 1000000) */
  maxArraySize?: number;
  /** Maximum allowed array size for .fill() operations (default: 100000) - lower because fill() immediately allocates */
  maxArrayFillSize?: number;
  /** Maximum allowed string repeat count (default: 100000) */
  maxStringRepeat?: number;
  /** Block constructor property access patterns (default: true) */
  blockConstructorAccess?: boolean;
  /** Block BigInt exponentiation entirely (default: false, only blocks large exponents) */
  blockBigIntExponentiation?: boolean;
  /**
   * Allow dynamic (computed) array size for .fill() operations (default: false)
   *
   * When true, Array(dynamicSize).fill() is allowed because runtime memory
   * patching will enforce the limit. Only enable this when memoryLimit is
   * configured at runtime.
   *
   * When false (default), only literal sizes are allowed for .fill() to
   * prevent memory exhaustion in environments without runtime protection.
   */
  allowDynamicArrayFill?: boolean;
}

/**
 * Rule that detects patterns that could cause CPU or memory exhaustion
 *
 * Catches patterns like:
 * - BigInt exponentiation with large exponents: 2n ** 1000000n
 * - Large array allocations: new Array(10000000)
 * - String repeat with large counts: 'x'.repeat(10000000)
 * - Constructor property access chains (sandbox escape vector)
 * - String concatenation building 'constructor' (obfuscation attempt)
 *
 * These patterns can bypass VM timeout because they execute in native code.
 */
export class ResourceExhaustionRule implements ValidationRule {
  readonly name = 'resource-exhaustion';
  readonly description = 'Detects patterns that could cause CPU or memory exhaustion';
  readonly defaultSeverity = ValidationSeverity.ERROR;
  readonly enabledByDefault = true;

  constructor(private options: ResourceExhaustionOptions = {}) {}

  validate(context: ValidationContext): void {
    const {
      maxBigIntExponent = 10000,
      maxArraySize = 1000000,
      maxArrayFillSize = 100000, // Lower threshold for .fill() - immediately allocates memory
      maxStringRepeat = 100000,
      blockConstructorAccess = true,
      blockBigIntExponentiation = false,
      allowDynamicArrayFill = false, // Allow dynamic sizes when runtime protection is enabled
    } = this.options;

    // Pre-pass: collect variables initialized to a dangerous property name that was built via a
    // coercion (e.g. `const c = String.fromCharCode(99,111,110,...)`). Static analysis cannot see
    // such a laundered key at the `obj[c]` use-site, so we track the binding and flag its use as a
    // computed key below. (The runtime guard is the exhaustive backstop; this fails fast with a
    // clear validation error for the common obfuscation forms.)
    const dangerousKeyVars = blockConstructorAccess
      ? this.collectDangerousKeyVars(context.ast)
      : new Map<string, string>();

    walk.simple(context.ast as any, {
      // Detect BigInt exponentiation: 2n ** 1000000n
      BinaryExpression: (node: any) => {
        if (node.operator === '**') {
          // Check if this is BigInt exponentiation
          const isBigIntLeft = node.left.type === 'Literal' && typeof node.left.bigint === 'string';
          const isBigIntRight = node.right.type === 'Literal' && typeof node.right.bigint === 'string';

          if (isBigIntLeft || isBigIntRight) {
            if (blockBigIntExponentiation) {
              context.report({
                code: 'RESOURCE_EXHAUSTION',
                message: 'BigInt exponentiation is not allowed (can cause CPU exhaustion)',
                location: this.getLocation(node),
              });
              return;
            }

            // Check for large exponent
            if (node.right.type === 'Literal') {
              const exponent = node.right.bigint ? BigInt(node.right.bigint) : BigInt(node.right.value || 0);
              if (exponent > maxBigIntExponent) {
                context.report({
                  code: 'RESOURCE_EXHAUSTION',
                  message: `BigInt exponent ${exponent} exceeds maximum allowed (${maxBigIntExponent}). Large exponents can cause CPU exhaustion.`,
                  location: this.getLocation(node),
                });
              }
            }
          }
        }
      },

      // Detect large array allocations: new Array(10000000)
      NewExpression: (node: any) => {
        if (node.callee.type === 'Identifier' && node.callee.name === 'Array' && node.arguments.length === 1) {
          const arg = node.arguments[0];
          if (arg.type === 'Literal' && typeof arg.value === 'number') {
            if (arg.value > maxArraySize) {
              context.report({
                code: 'RESOURCE_EXHAUSTION',
                message: `Array size ${arg.value} exceeds maximum allowed (${maxArraySize}). Large arrays can cause memory exhaustion.`,
                location: this.getLocation(node),
              });
            }
          }
        }
      },

      // Detect string.repeat() with large counts
      CallExpression: (node: any) => {
        if (
          node.callee.type === 'MemberExpression' &&
          node.callee.property.type === 'Identifier' &&
          node.callee.property.name === 'repeat' &&
          node.arguments.length >= 1
        ) {
          const arg = node.arguments[0];
          if (arg.type === 'Literal' && typeof arg.value === 'number') {
            if (arg.value > maxStringRepeat) {
              context.report({
                code: 'RESOURCE_EXHAUSTION',
                message: `String repeat count ${arg.value} exceeds maximum allowed (${maxStringRepeat}). Large repeats can cause memory exhaustion.`,
                location: this.getLocation(node),
              });
            }
          }
        }

        // Also check Array().join() with large arrays
        if (
          node.callee.type === 'MemberExpression' &&
          node.callee.property.type === 'Identifier' &&
          node.callee.property.name === 'join'
        ) {
          // Check if this is new Array(n).join() or Array(n).join()
          const object = node.callee.object;
          if (object.type === 'NewExpression' || object.type === 'CallExpression') {
            if (
              object.callee.type === 'Identifier' &&
              object.callee.name === 'Array' &&
              object.arguments.length === 1
            ) {
              const arg = object.arguments[0];
              if (arg.type === 'Literal' && typeof arg.value === 'number') {
                if (arg.value > maxArraySize) {
                  context.report({
                    code: 'RESOURCE_EXHAUSTION',
                    message: `Array.join with ${arg.value} elements exceeds maximum (${maxArraySize}). This can cause memory exhaustion.`,
                    location: this.getLocation(node),
                  });
                }
              }
            }
          }
        }

        // Detect Array(n).fill() pattern - CPU/memory exhaustion via large array fill
        // This is particularly dangerous because .fill() immediately allocates and initializes memory
        // Attack vector (Vector 1110): Array(500000).fill(0.12345).reduce((acc, val) => acc + Math.sin(val), 0)
        if (
          node.callee.type === 'MemberExpression' &&
          node.callee.property.type === 'Identifier' &&
          node.callee.property.name === 'fill'
        ) {
          const object = node.callee.object;
          // Check if this is new Array(n).fill() or Array(n).fill()
          if (object.type === 'NewExpression' || object.type === 'CallExpression') {
            if (
              object.callee.type === 'Identifier' &&
              object.callee.name === 'Array' &&
              object.arguments.length === 1
            ) {
              const arg = object.arguments[0];
              if (arg.type === 'Literal' && typeof arg.value === 'number') {
                if (arg.value > maxArrayFillSize) {
                  context.report({
                    code: 'RESOURCE_EXHAUSTION',
                    message: `Array.fill with ${arg.value} elements exceeds maximum (${maxArrayFillSize}). Large array fill operations can cause CPU/memory exhaustion.`,
                    location: this.getLocation(node),
                  });
                }
              } else if (arg.type !== 'Literal' && !allowDynamicArrayFill) {
                // Variable-based or computed size - block as error since .fill() immediately allocates
                // and we cannot verify the size statically. This prevents Vector 1110 attacks.
                // When allowDynamicArrayFill is true, runtime memory patching handles protection.
                context.report({
                  code: 'RESOURCE_EXHAUSTION',
                  message: `Array.fill with dynamic size is not allowed. Use a literal size <= ${maxArrayFillSize} to prevent CPU/memory exhaustion.`,
                  location: this.getLocation(node),
                });
              }
            }
          }
        }

        // Detect direct Array(n) call without new keyword with large size
        // This creates a sparse array which can still be used for attacks
        if (node.callee.type === 'Identifier' && node.callee.name === 'Array' && node.arguments.length === 1) {
          const arg = node.arguments[0];
          if (arg.type === 'Literal' && typeof arg.value === 'number') {
            if (arg.value > maxArraySize) {
              context.report({
                code: 'RESOURCE_EXHAUSTION',
                message: `Array size ${arg.value} exceeds maximum allowed (${maxArraySize}). Large arrays can cause memory exhaustion.`,
                location: this.getLocation(node),
              });
            }
          }
        }
      },

      // Detect constructor property access patterns
      MemberExpression: (node: any) => {
        if (!blockConstructorAccess) return;

        // Direct .constructor access
        if (node.property.type === 'Identifier' && node.property.name === 'constructor') {
          context.report({
            code: 'CONSTRUCTOR_ACCESS',
            message: 'Direct .constructor access is not allowed (potential sandbox escape vector)',
            location: this.getLocation(node),
          });
          return;
        }

        // Computed access with string literal ["constructor"]
        if (node.computed && node.property.type === 'Literal' && node.property.value === 'constructor') {
          context.report({
            code: 'CONSTRUCTOR_ACCESS',
            message: 'Computed ["constructor"] access is not allowed (potential sandbox escape vector)',
            location: this.getLocation(node),
          });
          return;
        }

        // Detect obfuscated constructor access via string concatenation
        // e.g., obj['con' + 'struc' + 'tor'] or obj[c] where c = 'con' + 'struc' + 'tor'
        if (node.computed && node.property.type === 'BinaryExpression') {
          if (this.isSuspiciousStringConcat(node.property)) {
            context.report({
              code: 'CONSTRUCTOR_ACCESS',
              message:
                'Suspicious computed property access detected. String concatenation to access "constructor" is not allowed.',
              location: this.getLocation(node),
            });
          }
        }

        // Detect computed access via function calls that could produce dangerous strings
        // e.g., obj[String(['constructor'])] or obj[['proto'].toString()]
        // CVE-2023-29017 style bypass: String(['constructor']) coerces array to 'constructor'
        if (node.computed && node.property.type === 'CallExpression') {
          if (this.isSuspiciousCoercionCall(node.property)) {
            context.report({
              code: 'CONSTRUCTOR_ACCESS',
              message:
                'Computed property access via coercion function is not allowed (potential sandbox escape vector)',
              location: this.getLocation(node),
            });
          }
        }

        // Detect computed access via a variable that was built from a coercion resolving to a
        // dangerous property name, e.g. `const c = String.fromCharCode(...); obj[c]`.
        if (node.computed && node.property.type === 'Identifier' && dangerousKeyVars.has(node.property.name)) {
          const resolvedKey = dangerousKeyVars.get(node.property.name);
          context.report({
            code: 'CONSTRUCTOR_ACCESS',
            message:
              `Computed property access to "${resolvedKey}" via a variable ` +
              `(built with String.fromCharCode, concatenation, or array coercion) is not allowed ` +
              `(potential sandbox escape vector)`,
            location: this.getLocation(node),
          });
        }
      },

      // Detect suspicious variable assignments that build "constructor"
      VariableDeclarator: (node: any) => {
        if (!blockConstructorAccess) return;

        if (node.init && node.init.type === 'BinaryExpression') {
          const result = this.evaluateStringConcat(node.init);
          if (result === 'constructor' || result === 'prototype') {
            context.report({
              code: 'CONSTRUCTOR_ACCESS',
              message: `Variable assigned to "${result}" via string concatenation. This is a potential sandbox escape vector.`,
              location: this.getLocation(node),
            });
          }
        }
      },
    });
  }

  /**
   * Check if a binary expression looks like suspicious string concatenation
   */
  private isSuspiciousStringConcat(node: any): boolean {
    const result = this.evaluateStringConcat(node);
    return result === 'constructor' || result === 'prototype' || result === '__proto__';
  }

  /**
   * Check if a call expression could be coercing a dangerous string
   * Detects patterns like:
   * - String(['constructor']) - array coercion
   * - String.fromCharCode(...) - character code building
   * - ['constructor'].toString() - array method coercion
   * - ['constructor'].join('') - array join coercion
   */
  private isSuspiciousCoercionCall(node: any): boolean {
    const dangerousStrings = ['constructor', '__proto__', 'prototype'];

    // String(['constructor']) - String() called with array containing dangerous string
    if (node.callee.type === 'Identifier' && node.callee.name === 'String') {
      if (node.arguments.length === 1) {
        const arg = node.arguments[0];
        if (arg.type === 'ArrayExpression' && arg.elements.length === 1) {
          const element = arg.elements[0];
          if (element?.type === 'Literal' && typeof element.value === 'string') {
            const value = element.value.toLowerCase();
            if (dangerousStrings.includes(value)) {
              return true;
            }
          }
        }
      }
    }

    // String.fromCharCode(...) or String['fromCharCode'](...) - always suspicious in computed property context
    if (
      node.callee.type === 'MemberExpression' &&
      node.callee.object.type === 'Identifier' &&
      node.callee.object.name === 'String'
    ) {
      const property = node.callee.property;
      const isFromCharCode =
        (property.type === 'Identifier' && property.name === 'fromCharCode') ||
        ((property.type === 'Literal' || property.type === 'StringLiteral') && property.value === 'fromCharCode');
      if (isFromCharCode) {
        return true;
      }
    }

    // ['constructor'].toString() or ['constructor'].join('')
    if (node.callee.type === 'MemberExpression' && node.callee.object.type === 'ArrayExpression') {
      const arr = node.callee.object;
      if (arr.elements.length === 1 && arr.elements[0]?.type === 'Literal') {
        const value = String(arr.elements[0].value).toLowerCase();
        if (dangerousStrings.includes(value)) {
          // Only flag actual coercion methods that convert array to string
          if (
            node.callee.property.type === 'Identifier' &&
            (node.callee.property.name === 'toString' || node.callee.property.name === 'join')
          ) {
            return true;
          }
        }
      }
    }

    return false;
  }

  /**
   * Property names this static pass hard-fails on when a laundered variable resolves to them.
   * Scoped to `constructor`/`prototype` to match the existing declarator-level detection; other
   * prototype-chain keys (notably `__proto__`) are intentionally left to the runtime membrane and
   * key guard, which soft-handle them per security level (e.g. PERMISSIVE returns undefined rather
   * than failing the whole run).
   */
  private static readonly DANGEROUS_KEYS = new Set(['constructor', 'prototype']);

  /**
   * Collect the names of variables that are initialized (or assigned) to a dangerous property
   * name produced by a static coercion. These are the laundered keys that evade use-site static
   * detection.
   */
  private collectDangerousKeyVars(ast: any): Map<string, string> {
    const tainted = new Map<string, string>();

    const consider = (name: unknown, valueNode: any): void => {
      if (typeof name !== 'string' || !valueNode) return;
      const resolved = this.staticStringValue(valueNode);
      if (resolved !== null && ResourceExhaustionRule.DANGEROUS_KEYS.has(resolved)) {
        tainted.set(name, resolved);
      }
    };

    walk.simple(ast, {
      VariableDeclarator: (node: any) => {
        if (node.id?.type === 'Identifier') {
          consider(node.id.name, node.init);
        }
      },
      AssignmentExpression: (node: any) => {
        if (node.operator === '=' && node.left?.type === 'Identifier') {
          consider(node.left.name, node.right);
        }
      },
    });

    return tainted;
  }

  /**
   * Statically resolve an expression to its string value when it is built from constant parts.
   * Handles string literals, `+` concatenation, `String.fromCharCode(...numbers)`, and
   * `[...literals].join(sep)` / `[literal].toString()`. Returns null when it cannot be resolved
   * statically.
   */
  private staticStringValue(node: any): string | null {
    if (!node) return null;

    if (node.type === 'Literal' && typeof node.value === 'string') {
      return node.value;
    }

    if (node.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length === 1) {
      return node.quasis[0].value.cooked ?? node.quasis[0].value.raw ?? null;
    }

    if (node.type === 'BinaryExpression' && node.operator === '+') {
      const left = this.staticStringValue(node.left);
      const right = this.staticStringValue(node.right);
      if (left !== null && right !== null) return left + right;
      return null;
    }

    if (node.type === 'CallExpression') {
      const fromCharCode = this.evaluateFromCharCode(node);
      if (fromCharCode !== null) return fromCharCode;
      return this.evaluateArrayJoin(node);
    }

    return null;
  }

  /**
   * Evaluate `String.fromCharCode(...)` when every argument is a numeric literal.
   */
  private evaluateFromCharCode(node: any): string | null {
    const callee = node.callee;
    if (!callee || callee.type !== 'MemberExpression') return null;
    if (callee.object.type !== 'Identifier' || callee.object.name !== 'String') return null;
    const prop = callee.property;
    const isFromCharCode =
      (prop.type === 'Identifier' && prop.name === 'fromCharCode') ||
      ((prop.type === 'Literal' || prop.type === 'StringLiteral') && prop.value === 'fromCharCode');
    if (!isFromCharCode) return null;

    let result = '';
    for (const arg of node.arguments) {
      if (arg.type === 'Literal' && typeof arg.value === 'number') {
        result += String.fromCharCode(arg.value);
      } else {
        return null;
      }
    }
    return result;
  }

  /**
   * Evaluate `[...literals].join(sep)` and `[literal].toString()` array coercions.
   */
  private evaluateArrayJoin(node: any): string | null {
    const callee = node.callee;
    if (!callee || callee.type !== 'MemberExpression' || callee.object.type !== 'ArrayExpression') return null;
    if (callee.property.type !== 'Identifier') return null;
    const method = callee.property.name;
    if (method !== 'join' && method !== 'toString') return null;

    const parts: string[] = [];
    for (const element of callee.object.elements) {
      if (
        element &&
        element.type === 'Literal' &&
        (typeof element.value === 'string' || typeof element.value === 'number')
      ) {
        parts.push(String(element.value));
      } else {
        return null;
      }
    }

    // Array.prototype.toString() and Array.prototype.join() with no argument both join with a
    // comma at runtime; only an explicit join(sep) argument overrides it.
    let separator = ',';
    if (method === 'join') {
      const sepArg = node.arguments[0];
      if (sepArg === undefined) {
        separator = ',';
      } else if (sepArg.type === 'Literal' && (typeof sepArg.value === 'string' || typeof sepArg.value === 'number')) {
        separator = String(sepArg.value);
      } else {
        return null;
      }
    }
    return parts.join(separator);
  }

  /**
   * Try to evaluate a string concatenation expression
   * Returns the result if it's a simple string concat, or null if too complex
   */
  private evaluateStringConcat(node: any): string | null {
    if (node.type === 'Literal' && typeof node.value === 'string') {
      return node.value;
    }

    if (node.type === 'BinaryExpression' && node.operator === '+') {
      const left = this.evaluateStringConcat(node.left);
      const right = this.evaluateStringConcat(node.right);
      if (left !== null && right !== null) {
        return left + right;
      }
    }

    return null;
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
