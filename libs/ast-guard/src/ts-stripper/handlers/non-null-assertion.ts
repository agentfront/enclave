/**
 * Non-null assertion handler.
 * Strips `x!` non-null assertions from TypeScript code.
 *
 * @module ts-stripper/handlers/non-null-assertion
 */

import { isIdentifierChar } from '../utils/token-utils';

/**
 * Check if position has a non-null assertion that should be stripped.
 * Returns the number of characters to strip (0 if not a non-null assertion).
 *
 * Non-null assertion: `!` after an expression that's not:
 * - Part of `!==` or `!=`
 * - A logical NOT `!expr`
 */
export function checkNonNullAssertion(source: string, position: number): number {
  if (source[position] !== '!') {
    return 0;
  }

  // Check if followed by = (not a non-null assertion)
  const nextChar = source[position + 1];
  if (nextChar === '=' || nextChar === '!') {
    return 0;
  }

  // Check if preceded by expression end (identifier, ), ], })
  let prevPos = position - 1;
  while (prevPos >= 0 && /\s/.test(source[prevPos])) {
    prevPos--;
  }

  if (prevPos < 0) {
    return 0; // Nothing before, can't be non-null assertion
  }

  const prevChar = source[prevPos];

  // Non-null assertion comes after expression ends
  if (isIdentifierChar(prevChar) || prevChar === ')' || prevChar === ']' || prevChar === '}') {
    // This is likely a non-null assertion - strip it
    return 1;
  }

  return 0;
}

/**
 * Strip non-null assertion at position.
 * Returns space to preserve position.
 */
export function stripNonNullAssertion(): string {
  return ' ';
}
