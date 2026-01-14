/**
 * Type annotation handler.
 * Strips `: Type` annotations from TypeScript code.
 *
 * @module ts-stripper/handlers/type-annotation
 */

import { isIdentifierChar, isWhitespace, replaceWithSpaces, getPreviousToken, JS_KEYWORDS } from '../utils/token-utils';
import type { DepthTracker } from '../stripper-state';

/**
 * Context for determining if a colon is a type annotation.
 */
export interface TypeAnnotationContext {
  /** Are we inside a ternary expression? */
  inTernary: boolean;
  /** Are we inside an object literal? */
  inObjectLiteral: boolean;
  /** Depth tracker */
  depth: DepthTracker;
  /** The source code */
  source: string;
}

/**
 * Check if position has a type annotation that should be stripped.
 * Returns the length of the type annotation (including `:` and type), or 0 if not.
 *
 * Type annotations appear:
 * - After parameter names: `function foo(x: number)`
 * - After variable names: `const x: number = 1`
 * - After function names (return type): `function foo(): number`
 * - After property names in classes: `class Foo { x: number }`
 * - After arrow function params: `(x: number) => x`
 *
 * NOT type annotations:
 * - Object literal values: `{ key: value }`
 * - Ternary else: `cond ? a : b`
 * - Case labels: `case 'foo':`
 * - Labels: `loop:`
 */
export function checkTypeAnnotation(source: string, position: number, context: TypeAnnotationContext): number {
  if (source[position] !== ':') {
    return 0;
  }

  // Quick check: if followed by another colon, not a type annotation (::)
  if (source[position + 1] === ':') {
    return 0;
  }

  // Check what precedes the colon
  const { token: prevToken, start: prevStart } = getPreviousToken(source, position);

  // Ternary operator check: look backwards for `?`
  if (isInTernaryElse(source, position)) {
    return 0;
  }

  // Case label check
  if (prevToken === 'case' || prevToken === 'default') {
    return 0;
  }

  // Check if we're in an object literal context
  if (isObjectLiteralValue(source, position, prevStart)) {
    return 0;
  }

  // Check for valid type annotation contexts
  if (!isValidTypeAnnotationContext(source, position, prevToken)) {
    return 0;
  }

  // This is a type annotation - find its end
  return findTypeAnnotationEnd(source, position);
}

/**
 * Check if we're in the else branch of a ternary operator.
 */
function isInTernaryElse(source: string, colonPos: number): boolean {
  // Look backwards for a matching `?` that isn't part of optional chaining
  let pos = colonPos - 1;
  let depth = 0;

  while (pos >= 0) {
    const char = source[pos];

    // Track depth
    if (char === ')' || char === ']' || char === '}') depth++;
    if (char === '(' || char === '[' || char === '{') depth--;

    // Found potential ternary `?` at same depth
    if (char === '?' && depth === 0) {
      // Make sure it's not optional chaining `?.`
      if (source[pos + 1] !== '.') {
        return true;
      }
    }

    // Stop at statement boundaries
    if (char === ';' || (char === '{' && depth === 0)) {
      break;
    }

    pos--;
  }

  return false;
}

/**
 * Check if colon is for an object literal value.
 */
function isObjectLiteralValue(source: string, colonPos: number, prevTokenStart: number): boolean {
  // Look backwards for opening brace that would indicate object literal
  let pos = prevTokenStart - 1;
  let parenDepth = 0;
  let bracketDepth = 0;

  // Skip whitespace
  while (pos >= 0 && isWhitespace(source[pos])) {
    pos--;
  }

  // If preceded by comma or opening brace at same depth, likely object literal
  while (pos >= 0) {
    const char = source[pos];

    if (char === ')') parenDepth++;
    if (char === '(') parenDepth--;
    if (char === ']') bracketDepth++;
    if (char === '[') bracketDepth--;

    // At depth 0
    if (parenDepth === 0 && bracketDepth === 0) {
      // Comma before key - object literal
      if (char === ',') {
        return true;
      }

      // Opening brace before key - object literal
      if (char === '{') {
        // Check if this { is after = or ( or , or : or [ or return
        let beforeBrace = pos - 1;
        while (beforeBrace >= 0 && isWhitespace(source[beforeBrace])) {
          beforeBrace--;
        }

        if (beforeBrace >= 0) {
          const charBeforeBrace = source[beforeBrace];
          // Object literal contexts
          if (
            charBeforeBrace === '=' ||
            charBeforeBrace === '(' ||
            charBeforeBrace === ',' ||
            charBeforeBrace === ':' ||
            charBeforeBrace === '[' ||
            charBeforeBrace === '?'
          ) {
            return true;
          }

          // Check for `return {`
          if (isIdentifierChar(charBeforeBrace)) {
            const wordEnd = beforeBrace + 1;
            let wordStart = beforeBrace;
            while (wordStart > 0 && isIdentifierChar(source[wordStart - 1])) {
              wordStart--;
            }
            const word = source.slice(wordStart, wordEnd);
            if (word === 'return' || word === 'yield' || word === 'throw' || word === 'case') {
              return true;
            }
          }
        }

        // Otherwise it's likely a block/class body, not object literal
        return false;
      }

      // Found statement boundary before finding object context
      if (char === ';' || char === '}') {
        break;
      }
    }

    pos--;
  }

  return false;
}

/**
 * Check if context is valid for a type annotation.
 */
function isValidTypeAnnotationContext(source: string, colonPos: number, prevToken: string): boolean {
  // After identifier (parameter, variable, property)
  if (prevToken && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(prevToken)) {
    // Not after certain keywords
    if (JS_KEYWORDS.has(prevToken) && prevToken !== 'this') {
      return false;
    }
    return true;
  }

  // After closing paren (return type): function foo(): Type
  if (prevToken === ')') {
    return true;
  }

  // After `?` for optional parameter: (x?: number)
  if (prevToken === '?') {
    return true;
  }

  // After destructuring patterns
  if (prevToken === '}' || prevToken === ']') {
    return true;
  }

  return false;
}

/**
 * Find the end of a type annotation starting at the colon.
 * Returns the total length including the colon.
 */
function findTypeAnnotationEnd(source: string, colonPos: number): number {
  let pos = colonPos + 1; // Skip the colon

  // Skip whitespace after colon
  while (pos < source.length && isWhitespace(source[pos])) {
    pos++;
  }

  // Track nested structures
  let angleDepth = 0;
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;

  while (pos < source.length) {
    const char = source[pos];

    // Handle strings within types (template literal types)
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

    // Check for end markers BEFORE updating depths
    // At depth 0, these end the type annotation
    if (angleDepth === 0 && braceDepth === 0 && parenDepth === 0 && bracketDepth === 0) {
      // End markers
      if (char === ',' || char === ';' || char === '=' || char === '>') {
        break;
      }

      // Opening brace at depth 0 (function body)
      if (char === '{') {
        break;
      }

      // Closing tokens at depth 0 end the annotation
      if (char === ')' || char === ']' || char === '}') {
        break;
      }
    }

    // Track depths (after checking for end markers)
    if (char === '<') angleDepth++;
    if (char === '>' && angleDepth > 0) angleDepth--;
    if (char === '{') braceDepth++;
    if (char === '}' && braceDepth > 0) braceDepth--;
    if (char === '(') parenDepth++;
    if (char === ')' && parenDepth > 0) parenDepth--;
    if (char === '[') bracketDepth++;
    if (char === ']' && bracketDepth > 0) bracketDepth--;

    // Arrow function at depth 0
    if (angleDepth === 0 && braceDepth === 0 && parenDepth === 0 && bracketDepth === 0) {
      if (char === '=' && source[pos + 1] === '>') {
        break;
      }
    }

    pos++;
  }

  return pos - colonPos;
}

/**
 * Create replacement for type annotation (preserve newlines).
 */
export function createTypeAnnotationReplacement(source: string, start: number, length: number): string {
  return replaceWithSpaces(source.slice(start, start + length));
}
