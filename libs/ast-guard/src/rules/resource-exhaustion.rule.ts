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
  /** Maximum allowed string repeat count (default: 100000) */
  maxStringRepeat?: number;
  /** Block constructor property access patterns (default: true) */
  blockConstructorAccess?: boolean;
  /** Block BigInt exponentiation entirely (default: false, only blocks large exponents) */
  blockBigIntExponentiation?: boolean;
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
      maxStringRepeat = 100000,
      blockConstructorAccess = true,
      blockBigIntExponentiation = false,
    } = this.options;

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
