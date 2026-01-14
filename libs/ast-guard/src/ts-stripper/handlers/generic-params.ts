/**
 * Generic parameters handler.
 * Strips `<T>` generic type parameters from TypeScript code.
 *
 * @module ts-stripper/handlers/generic-params
 */

import {
  readIdentifier,
  skipWhitespace,
  isIdentifierChar,
  isIdentifierStart,
  replaceWithSpaces,
  getPreviousToken,
} from '../utils/token-utils';

/**
 * Keywords that can be followed by generic parameters.
 */
const GENERIC_KEYWORDS = new Set(['function', 'class', 'interface', 'type', 'extends', 'implements', 'new']);

/**
 * Check if position starts generic type parameters that should be stripped.
 * Returns the length to strip, or 0 if not generic parameters.
 *
 * Generic parameters appear after:
 * - `function foo<T>`
 * - `class Foo<T>`
 * - `interface Foo<T>`
 * - `type Foo<T>`
 * - Method names: `foo<T>()`
 * - Arrow functions: `<T>(x: T) => x`
 *
 * NOT generic parameters:
 * - Comparison: `a < b && c > d`
 * - JSX: `<div>` (not supported in this context anyway)
 */
export function checkGenericParams(source: string, position: number): number {
  if (source[position] !== '<') {
    return 0;
  }

  // Check context - what precedes the <
  const { token: prevToken } = getPreviousToken(source, position);

  // After keywords that take generics
  if (GENERIC_KEYWORDS.has(prevToken)) {
    return findGenericEnd(source, position);
  }

  // After identifier (function/method/class name)
  if (prevToken && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(prevToken)) {
    // Check if this looks like a generic call or definition
    const result = analyzeGenericContext(source, position);
    if (result.isGeneric) {
      return result.length;
    }
  }

  // Arrow function generics: `<T>(x: T) => x`
  // At start of expression or after = ( [ ,
  const prevPos = findPrevNonWhitespace(source, position - 1);
  if (prevPos < 0) {
    // Start of input - could be arrow function generic
    return checkArrowFunctionGeneric(source, position);
  }

  const prevChar = source[prevPos];
  if (
    prevChar === '=' ||
    prevChar === '(' ||
    prevChar === '[' ||
    prevChar === ',' ||
    prevChar === ':' ||
    prevChar === '?'
  ) {
    return checkArrowFunctionGeneric(source, position);
  }

  return 0;
}

/**
 * Find the position of previous non-whitespace character.
 */
function findPrevNonWhitespace(source: string, start: number): number {
  let pos = start;
  while (pos >= 0 && /\s/.test(source[pos])) {
    pos--;
  }
  return pos;
}

/**
 * Analyze if < starts generic parameters in an ambiguous context.
 */
function analyzeGenericContext(source: string, position: number): { isGeneric: boolean; length: number } {
  // Try to find matching >
  const endResult = findGenericEnd(source, position);

  if (endResult === 0) {
    return { isGeneric: false, length: 0 };
  }

  // Check what follows the >
  const afterAngle = position + endResult;
  const afterPos = skipWhitespace(source, afterAngle);

  if (afterPos >= source.length) {
    // End of input after > - ambiguous, assume not generic
    return { isGeneric: false, length: 0 };
  }

  const afterChar = source[afterPos];

  // Strong indicators of generic:
  // - `>(`  - generic function call
  // - `> {` - generic followed by body
  // - `> =>`  - generic arrow function
  // - `> extends` - generic constraint continuation
  // - `>,` - generic in list
  // - `>)` - generic as type argument

  if (afterChar === '(' || afterChar === '{' || afterChar === ',' || afterChar === ')' || afterChar === '>') {
    return { isGeneric: true, length: endResult };
  }

  // Check for `=>`
  if (afterChar === '=' && source[afterPos + 1] === '>') {
    return { isGeneric: true, length: endResult };
  }

  // Check for keywords
  if (isIdentifierStart(afterChar)) {
    const nextWord = readIdentifier(source, afterPos);
    if (nextWord.identifier === 'extends' || nextWord.identifier === 'implements') {
      return { isGeneric: true, length: endResult };
    }
  }

  // Look at content inside < > for type indicators
  const content = source.slice(position + 1, position + endResult - 1);

  // If content contains `extends`, it's definitely generic
  if (/\bextends\b/.test(content)) {
    return { isGeneric: true, length: endResult };
  }

  // If content is just identifiers separated by commas, likely generic
  if (/^[\s\w$,]+$/.test(content)) {
    return { isGeneric: true, length: endResult };
  }

  // If content contains type operators, likely generic
  if (/[|&]/.test(content)) {
    return { isGeneric: true, length: endResult };
  }

  // Conservative: assume comparison
  return { isGeneric: false, length: 0 };
}

/**
 * Check for arrow function generic: `<T>(x: T) => x`
 */
function checkArrowFunctionGeneric(source: string, position: number): number {
  const endResult = findGenericEnd(source, position);

  if (endResult === 0) {
    return 0;
  }

  // After > must come (
  const afterAngle = position + endResult;
  const afterPos = skipWhitespace(source, afterAngle);

  if (afterPos >= source.length || source[afterPos] !== '(') {
    return 0;
  }

  // Verify this is followed eventually by =>
  // Find the closing paren
  let parenDepth = 1;
  let pos = afterPos + 1;

  while (pos < source.length && parenDepth > 0) {
    if (source[pos] === '(') parenDepth++;
    if (source[pos] === ')') parenDepth--;

    // Handle strings
    if (source[pos] === '"' || source[pos] === "'" || source[pos] === '`') {
      const quote = source[pos];
      pos++;
      while (pos < source.length && source[pos] !== quote) {
        if (source[pos] === '\\') pos++;
        pos++;
      }
    }

    pos++;
  }

  // Check for optional return type annotation and then =>
  pos = skipWhitespace(source, pos);

  // Skip return type if present
  if (source[pos] === ':') {
    pos++;
    // Skip the type
    while (pos < source.length) {
      const char = source[pos];
      if (char === '=' && source[pos + 1] === '>') {
        break;
      }
      if (char === '{' || char === ';') {
        break;
      }
      pos++;
    }
  }

  pos = skipWhitespace(source, pos);

  // Must have =>
  if (source[pos] === '=' && source[pos + 1] === '>') {
    return endResult;
  }

  return 0;
}

/**
 * Find the end of generic parameters starting at <.
 * Returns the length including < and >, or 0 if invalid.
 */
function findGenericEnd(source: string, position: number): number {
  if (source[position] !== '<') {
    return 0;
  }

  let pos = position + 1;
  let angleDepth = 1;

  while (pos < source.length && angleDepth > 0) {
    const char = source[pos];

    // Handle strings
    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      pos++;
      while (pos < source.length && source[pos] !== quote) {
        if (source[pos] === '\\') pos++;
        pos++;
      }
      pos++;
      continue;
    }

    // Track angle brackets
    if (char === '<') {
      angleDepth++;
    } else if (char === '>') {
      angleDepth--;
    }

    // Invalid characters inside generics indicate this is not a generic
    if (char === ';' || (char === '{' && angleDepth > 0)) {
      return 0;
    }

    // Check for >> or >>> which might be shift operators, not closing
    // In generics context, > > should close two levels
    if (char === '>' && angleDepth === 0 && source[pos + 1] === '>') {
      // This might be >> operator - be conservative
      // Actually in modern TS, >> in generics is fine: Map<string, Array<number>>
      // The angleDepth tracking handles this
    }

    pos++;
  }

  if (angleDepth !== 0) {
    return 0; // Unclosed
  }

  return pos - position;
}

/**
 * Create replacement for generic params (preserve newlines).
 */
export function createGenericReplacement(source: string, start: number, length: number): string {
  return replaceWithSpaces(source.slice(start, start + length));
}
