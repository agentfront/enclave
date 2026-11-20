/**
 * Nesting depth validation for the pre-scanner.
 * Detects excessive bracket nesting that could overflow parser stack.
 *
 * @module pre-scanner/checks/nesting-check
 */

import type { PreScannerConfig } from '../config';
import type { ScanState } from '../scan-state';
import { PRESCANNER_ERROR_CODES } from '../errors';
import { walkCode } from './code-walk';

/**
 * Opening brackets and their matching closers
 */
const BRACKET_PAIRS: Record<string, string> = {
  '(': ')',
  '[': ']',
  '{': '}',
};

const OPENING_BRACKETS = new Set(Object.keys(BRACKET_PAIRS));
const CLOSING_BRACKETS = new Set(Object.values(BRACKET_PAIRS));

/**
 * Check bracket nesting depth.
 * This is a fast O(n) scan that tracks nesting without full parsing.
 *
 * Note: This is a heuristic check. It doesn't handle brackets in strings
 * or comments perfectly, but it catches malicious deep nesting attacks
 * which wouldn't be valid code anyway.
 *
 * @param source - The source code to check
 * @param config - Pre-scanner configuration
 * @param state - Scan state for recording issues
 */
export function checkNestingDepth(source: string, config: PreScannerConfig, state: ScanState): void {
  let depth = 0;
  let maxDepth = 0;
  let stopped = false;

  // The brackets of the code, also of the code in a template's interpolations (see walkCode)
  walkCode(source, {
    code: (i, char) => {
      if (OPENING_BRACKETS.has(char)) {
        depth++;
        if (depth > maxDepth) {
          maxDepth = depth;
        }

        // Check limit immediately for early termination
        if (depth > config.maxNestingDepth) {
          state.reportFatalError({
            code: PRESCANNER_ERROR_CODES.EXCESSIVE_NESTING,
            message: `Bracket nesting depth (${depth}) exceeds maximum allowed (${config.maxNestingDepth})`,
            position: i,
            data: { actual: depth, limit: config.maxNestingDepth },
          });
          stopped = true;
          return true;
        }
      } else if (CLOSING_BRACKETS.has(char)) {
        depth = Math.max(0, depth - 1); // Avoid negative depth on malformed input
      }
      return false;
    },
  });

  if (!stopped) state.updateMaxNestingDepth(maxDepth);
}

/**
 * Check for excessive consecutive operators.
 * Catches patterns like "a++++++b" that could confuse parsers.
 *
 * @param source - The source code to check
 * @param config - Pre-scanner configuration
 * @param state - Scan state for recording issues
 */
export function checkConsecutiveOperators(source: string, config: PreScannerConfig, state: ScanState): void {
  // Operators that can appear consecutively in attack patterns
  const operatorChars = new Set(['+', '-', '!', '~', '*', '/', '%', '&', '|', '^', '<', '>', '=']);

  let consecutiveCount = 0;
  let consecutiveStart = 0;

  // The operators of the code, also of the code in a template's interpolations (see walkCode); a
  // string between two operators ends a run
  walkCode(source, {
    string: () => {
      consecutiveCount = 0;
      return false;
    },
    code: (i, char) => {
      if (operatorChars.has(char)) {
        if (consecutiveCount === 0) {
          consecutiveStart = i;
        }
        consecutiveCount++;

        if (consecutiveCount > config.maxConsecutiveOperators) {
          state.reportFatalError({
            code: PRESCANNER_ERROR_CODES.EXCESSIVE_OPERATORS,
            message: `Consecutive operators (${consecutiveCount}) exceed maximum allowed (${config.maxConsecutiveOperators})`,
            position: consecutiveStart,
            data: { actual: consecutiveCount, limit: config.maxConsecutiveOperators },
          });
          return true;
        }
      } else if (!isWhitespace(char)) {
        // Reset on non-operator, non-whitespace
        consecutiveCount = 0;
      }
      return false;
    },
  });
}

/**
 * Perform all nesting-related checks.
 *
 * @param source - The source code to check
 * @param config - Pre-scanner configuration
 * @param state - Scan state for recording issues
 */
export function performNestingChecks(source: string, config: PreScannerConfig, state: ScanState): void {
  checkNestingDepth(source, config, state);
  if (state.shouldStop()) return;

  checkConsecutiveOperators(source, config, state);
}

function isWhitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}
