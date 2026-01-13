/**
 * Type assertion handler.
 * Strips `as Type` and `<Type>` prefix assertions.
 *
 * @module ts-stripper/handlers/type-assertion
 */

import {
  readIdentifier,
  skipWhitespace,
  isIdentifierChar,
  isIdentifierStart,
  replaceWithSpaces,
} from '../utils/token-utils';

/**
 * Check if position starts an `as` type assertion.
 * Returns the length to strip, or 0 if not an assertion.
 *
 * `as` assertions:
 * - `expr as Type`
 * - `expr as const`
 *
 * NOT type assertions (import/export aliases):
 * - `import { x as y }`
 * - `export { x as y }`
 */
export function checkAsAssertion(source: string, position: number): number {
  const { identifier, end } = readIdentifier(source, position);

  if (identifier !== 'as') {
    return 0;
  }

  // Check what precedes `as` - should be after an expression
  let prevPos = position - 1;
  while (prevPos >= 0 && /\s/.test(source[prevPos])) {
    prevPos--;
  }

  if (prevPos < 0) {
    return 0; // Nothing before
  }

  const prevChar = source[prevPos];

  // `as` should come after expression end
  if (
    !isIdentifierChar(prevChar) &&
    prevChar !== ')' &&
    prevChar !== ']' &&
    prevChar !== '}' &&
    prevChar !== '"' &&
    prevChar !== "'" &&
    prevChar !== '`'
  ) {
    return 0;
  }

  // Check if this is an import/export alias (not a type assertion)
  // Look for pattern: identifier `as` identifier inside { }
  if (isImportExportAlias(source, position)) {
    return 0;
  }

  // Skip whitespace after `as`
  const afterAs = skipWhitespace(source, end);

  if (afterAs >= source.length) {
    return 0;
  }

  // Check for `as const`
  const nextWord = readIdentifier(source, afterAs);
  if (nextWord.identifier === 'const') {
    // `as const` - strip the whole thing
    return nextWord.end - position;
  }

  // Find the end of the type
  return findAsAssertionEnd(source, position, afterAs);
}

/**
 * Check if `as` at position is part of an import/export alias.
 * Returns true for patterns like `import { x as y }` or `export { x as y }`.
 */
function isImportExportAlias(source: string, asPosition: number): boolean {
  // Look backwards to find the context
  let pos = asPosition - 1;
  let braceDepth = 0;
  let foundOpenBrace = false;

  // Skip whitespace
  while (pos >= 0 && /\s/.test(source[pos])) {
    pos--;
  }

  // Should be after an identifier
  if (pos < 0 || !isIdentifierChar(source[pos])) {
    return false;
  }

  // Skip the identifier
  while (pos >= 0 && isIdentifierChar(source[pos])) {
    pos--;
  }

  // Look for opening { or , before the identifier
  while (pos >= 0) {
    const char = source[pos];

    // Skip whitespace
    if (/\s/.test(char)) {
      pos--;
      continue;
    }

    if (char === '}') {
      braceDepth++;
    } else if (char === '{') {
      if (braceDepth > 0) {
        braceDepth--;
      } else {
        foundOpenBrace = true;
        break;
      }
    } else if (char === ',') {
      // Could be in a list of imports/exports
      if (braceDepth === 0) {
        // Continue looking for the opening brace
        pos--;
        continue;
      }
    } else if (isIdentifierChar(char)) {
      // Found another word - check if it's import/export
      const wordEnd = pos + 1;
      while (pos >= 0 && isIdentifierChar(source[pos])) {
        pos--;
      }
      const word = source.slice(pos + 1, wordEnd);
      if (word === 'import' || word === 'export') {
        return true;
      }
      // Not import/export - continue
    } else {
      // Other character - stop searching
      break;
    }

    pos--;
  }

  // If we found an opening brace, check what comes before it
  if (foundOpenBrace) {
    pos--; // Move past the {

    // Skip whitespace
    while (pos >= 0 && /\s/.test(source[pos])) {
      pos--;
    }

    // Check for import/export keyword
    if (pos >= 0 && isIdentifierChar(source[pos])) {
      const wordEnd = pos + 1;
      while (pos >= 0 && isIdentifierChar(source[pos])) {
        pos--;
      }
      const word = source.slice(pos + 1, wordEnd);
      if (word === 'import' || word === 'export' || word === 'type') {
        return true;
      }
    }
  }

  return false;
}

/**
 * Find the end of an `as Type` assertion.
 */
function findAsAssertionEnd(source: string, asPos: number, typeStart: number): number {
  let pos = typeStart;

  // Track nested structures
  let angleDepth = 0;
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;

  while (pos < source.length) {
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

    // Track depths
    if (char === '<') angleDepth++;
    if (char === '>' && angleDepth > 0) angleDepth--;
    if (char === '{') braceDepth++;
    if (char === '}') {
      if (braceDepth > 0) {
        braceDepth--;
      } else {
        break;
      }
    }
    if (char === '(') parenDepth++;
    if (char === ')') {
      if (parenDepth > 0) {
        parenDepth--;
      } else {
        break;
      }
    }
    if (char === '[') bracketDepth++;
    if (char === ']') {
      if (bracketDepth > 0) {
        bracketDepth--;
      } else {
        break;
      }
    }

    // At depth 0, these end the assertion
    if (angleDepth === 0 && braceDepth === 0 && parenDepth === 0 && bracketDepth === 0) {
      // Common expression continuations that end the type
      if (
        char === ',' ||
        char === ';' ||
        char === ':' ||
        char === '?' ||
        char === '&' && source[pos + 1] === '&' ||
        char === '|' && source[pos + 1] === '|' ||
        char === '!' && source[pos + 1] === '='
      ) {
        break;
      }

      // Operators that can follow assertion
      if (char === '.' || char === '(' || char === '[') {
        break;
      }

      // Another `as` (chained assertions)
      if (isIdentifierStart(char)) {
        const word = readIdentifier(source, pos);
        if (word.identifier === 'as') {
          break;
        }
        // Type continues with identifier
        pos = word.end;
        continue;
      }

      // Binary operators that end the assertion
      if (/[+\-*/%]/.test(char) && source[pos + 1] !== '=') {
        break;
      }
    }

    pos++;
  }

  return pos - asPos;
}

/**
 * Check if position starts a `<Type>` prefix assertion (legacy syntax).
 * Returns the length to strip, or 0 if not an assertion.
 *
 * This is tricky because `<` can also be:
 * - Comparison operator: `a < b`
 * - JSX element: `<div>`
 * - Generic call: `foo<T>()`
 */
export function checkAngleBracketAssertion(source: string, position: number): number {
  if (source[position] !== '<') {
    return 0;
  }

  // Look backwards to determine context
  let prevPos = position - 1;
  while (prevPos >= 0 && /\s/.test(source[prevPos])) {
    prevPos--;
  }

  // If preceded by expression-end, it's likely comparison not assertion
  if (prevPos >= 0) {
    const prevChar = source[prevPos];
    if (
      isIdentifierChar(prevChar) ||
      prevChar === ')' ||
      prevChar === ']' ||
      prevChar === '}' ||
      prevChar === '"' ||
      prevChar === "'" ||
      prevChar === '`'
    ) {
      // Preceded by expression - this is comparison or generic call, not assertion
      return 0;
    }
  }

  // Find the closing >
  let pos = position + 1;
  let angleDepth = 1;

  while (pos < source.length && angleDepth > 0) {
    const char = source[pos];

    if (char === '<') angleDepth++;
    if (char === '>') angleDepth--;

    // If we hit certain characters before closing, not an assertion
    if (char === ';' || char === '{' || char === '}') {
      return 0; // Not an assertion
    }

    pos++;
  }

  if (angleDepth !== 0) {
    return 0; // Unclosed
  }

  // Check what follows - should be an expression
  const afterAngle = skipWhitespace(source, pos);
  if (afterAngle >= source.length) {
    return 0;
  }

  const afterChar = source[afterAngle];

  // Valid assertion targets: identifier, (, [, literal
  if (
    isIdentifierStart(afterChar) ||
    afterChar === '(' ||
    afterChar === '[' ||
    afterChar === '{' ||
    afterChar === '"' ||
    afterChar === "'" ||
    afterChar === '`' ||
    /[0-9]/.test(afterChar)
  ) {
    // This looks like an assertion
    return pos - position;
  }

  return 0;
}

/**
 * Create replacement for type assertion (preserve newlines).
 */
export function createAssertionReplacement(source: string, start: number, length: number): string {
  return replaceWithSpaces(source.slice(start, start + length));
}
