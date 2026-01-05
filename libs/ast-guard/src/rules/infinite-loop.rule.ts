import * as walk from 'acorn-walk';
import { ValidationRule, ValidationContext, ValidationSeverity } from '../interfaces';

/**
 * Options for InfiniteLoopRule
 */
export interface InfiniteLoopOptions {
  /** Whether to check for loops (default: true) */
  checkForLoops?: boolean;
  /** Whether to check while loops (default: true) */
  checkWhileLoops?: boolean;
  /** Whether to check do-while loops (default: true) */
  checkDoWhile?: boolean;
  /** Custom message */
  message?: string;
}

/**
 * Rule that detects obvious infinite loop patterns
 *
 * Catches patterns like:
 * - for(;;) { } - missing test condition
 * - for(;true;) { } - always-true test
 * - while(true) { }
 * - while(1) { }
 * - do {} while(true)
 *
 * This is a defense-in-depth measure. Runtime protection (iteration limits)
 * should also be in place, but catching obvious infinite loops at static
 * analysis time provides better error messages and faster failure.
 */
export class InfiniteLoopRule implements ValidationRule {
  readonly name = 'infinite-loop';
  readonly description = 'Detects obvious infinite loop patterns';
  readonly defaultSeverity = ValidationSeverity.ERROR;
  readonly enabledByDefault = true;

  constructor(private options: InfiniteLoopOptions = {}) {}

  validate(context: ValidationContext): void {
    const {
      checkForLoops = true,
      checkWhileLoops = true,
      checkDoWhile = true,
      message = 'Infinite loop detected',
    } = this.options;

    const handlers: Record<string, (node: any) => void> = {};

    if (checkForLoops) {
      handlers['ForStatement'] = (node: any) => {
        // for(;;) - missing test is always infinite
        if (node.test === null || node.test === undefined) {
          this.reportInfiniteLoop(context, node, 'for', message, 'missing test condition');
          return;
        }

        // for(;true;) - always-true test
        if (this.isAlwaysTruthy(node.test)) {
          this.reportInfiniteLoop(context, node, 'for', message, 'test condition is always truthy');
        }
      };
    }

    if (checkWhileLoops) {
      handlers['WhileStatement'] = (node: any) => {
        if (this.isAlwaysTruthy(node.test)) {
          this.reportInfiniteLoop(context, node, 'while', message, 'test condition is always truthy');
        }
      };
    }

    if (checkDoWhile) {
      handlers['DoWhileStatement'] = (node: any) => {
        if (this.isAlwaysTruthy(node.test)) {
          this.reportInfiniteLoop(context, node, 'do-while', message, 'test condition is always truthy');
        }
      };
    }

    walk.simple(context.ast as any, handlers);
  }

  /**
   * Check if an expression is always truthy (can be determined at static analysis)
   */
  private isAlwaysTruthy(node: any): boolean {
    if (!node) return false;

    switch (node.type) {
      case 'Literal':
        // true, 1, "string", 2.5, etc.
        return Boolean(node.value);

      case 'UnaryExpression':
        if (node.operator === '!') {
          // !false -> true, !!true -> true
          return this.isAlwaysFalsy(node.argument);
        }
        if (node.operator === '!!') {
          return this.isAlwaysTruthy(node.argument);
        }
        return false;

      case 'Identifier':
        // Special case: undefined is falsy, but we can't know other variables
        if (node.name === 'undefined') return false;
        if (node.name === 'Infinity') return true;
        if (node.name === 'NaN') return false;
        return false; // Unknown identifier - conservatively assume not always truthy

      case 'ArrayExpression':
        // [] is truthy (empty array is truthy in JS)
        return true;

      case 'ObjectExpression':
        // {} is truthy (empty object is truthy in JS)
        return true;

      default:
        return false;
    }
  }

  /**
   * Check if an expression is always falsy
   */
  private isAlwaysFalsy(node: any): boolean {
    if (!node) return true;

    switch (node.type) {
      case 'Literal':
        // false, 0, "", null, undefined
        return !node.value && node.value !== undefined;

      case 'UnaryExpression':
        if (node.operator === '!') {
          return this.isAlwaysTruthy(node.argument);
        }
        return false;

      case 'Identifier':
        if (node.name === 'undefined') return true;
        if (node.name === 'NaN') return true;
        return false;

      default:
        return false;
    }
  }

  private reportInfiniteLoop(
    context: ValidationContext,
    node: any,
    loopType: string,
    message: string,
    reason: string,
  ): void {
    context.report({
      code: 'INFINITE_LOOP',
      message: `${message}: ${loopType} loop with ${reason}`,
      location: node.loc
        ? {
            line: node.loc.start.line,
            column: node.loc.start.column,
          }
        : undefined,
      data: { loopType, reason },
    });
  }
}
