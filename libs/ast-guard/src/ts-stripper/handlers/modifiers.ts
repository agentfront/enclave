/**
 * Access modifier handler.
 * Strips TypeScript access modifiers from code.
 *
 * @module ts-stripper/handlers/modifiers
 */

import { ACCESS_MODIFIERS, readIdentifier, skipWhitespace, isIdentifierStart } from '../utils';

/**
 * Check if position starts an access modifier that should be stripped.
 * Returns the length to strip (including trailing whitespace), or 0 if not a modifier.
 *
 * Access modifiers: public, private, protected, readonly, abstract, override
 */
export function checkAccessModifier(source: string, position: number): number {
  if (!isIdentifierStart(source[position])) {
    return 0;
  }

  const { identifier, end } = readIdentifier(source, position);

  if (!ACCESS_MODIFIERS.has(identifier)) {
    return 0;
  }

  // Verify this is used as a modifier (followed by another identifier or modifier)
  const afterModifier = skipWhitespace(source, end);

  if (afterModifier >= source.length) {
    return 0;
  }

  const nextChar = source[afterModifier];

  // Modifiers should be followed by:
  // - Another identifier (property name, method name, parameter name)
  // - Another modifier
  // - constructor keyword
  // - [ for index signature
  // - ( for constructor parameter
  // - * for generator
  // - get/set accessor
  if (isIdentifierStart(nextChar) || nextChar === '[' || nextChar === '(' || nextChar === '*') {
    // Check if next word is another modifier or a valid follow-up
    if (isIdentifierStart(nextChar)) {
      // Any identifier (property/method name, modifier, constructor, get, set, etc.) is valid
      return afterModifier - position;
    } else {
      // [ or ( or * - strip modifier
      return afterModifier - position;
    }
  }

  return 0;
}

/**
 * Create replacement string (spaces to preserve positions).
 */
export function createModifierReplacement(length: number): string {
  return ' '.repeat(length);
}

/**
 * Check if position starts the 'static' keyword in a class context.
 * Static is valid JavaScript so we don't strip it.
 */
export function isStaticKeyword(source: string, position: number): boolean {
  const { identifier } = readIdentifier(source, position);
  return identifier === 'static';
}
