/**
 * Token identification utilities for TypeScript stripping.
 *
 * @module ts-stripper/utils/token-utils
 */

/**
 * Check if character is a valid identifier start character.
 */
export function isIdentifierStart(char: string): boolean {
  return /[a-zA-Z_$]/.test(char);
}

/**
 * Check if character is a valid identifier character.
 */
export function isIdentifierChar(char: string): boolean {
  return /[a-zA-Z0-9_$]/.test(char);
}

/**
 * Check if character is whitespace.
 */
export function isWhitespace(char: string): boolean {
  return /\s/.test(char);
}

/**
 * Check if character is a digit.
 */
export function isDigit(char: string): boolean {
  return /[0-9]/.test(char);
}

/**
 * TypeScript keywords that introduce type-only constructs.
 */
export const TYPE_KEYWORDS = new Set(['interface', 'type', 'enum', 'declare', 'namespace', 'module']);

/**
 * TypeScript access modifiers.
 */
export const ACCESS_MODIFIERS = new Set(['public', 'private', 'protected', 'readonly', 'abstract', 'override']);

/**
 * JavaScript reserved keywords (should not be treated as identifiers to transform).
 */
export const JS_KEYWORDS = new Set([
  'break',
  'case',
  'catch',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'finally',
  'for',
  'function',
  'if',
  'in',
  'instanceof',
  'new',
  'return',
  'switch',
  'this',
  'throw',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'class',
  'const',
  'let',
  'export',
  'import',
  'extends',
  'super',
  'yield',
  'static',
  'await',
  'async',
  'of',
  'get',
  'set',
]);

/**
 * Read an identifier from source starting at position.
 * Returns the identifier and the position after it.
 */
export function readIdentifier(source: string, start: number): { identifier: string; end: number } {
  let end = start;
  while (end < source.length && isIdentifierChar(source[end])) {
    end++;
  }
  return {
    identifier: source.slice(start, end),
    end,
  };
}

/**
 * Skip whitespace and return the new position.
 */
export function skipWhitespace(source: string, start: number): number {
  let pos = start;
  while (pos < source.length && isWhitespace(source[pos])) {
    pos++;
  }
  return pos;
}

/**
 * Skip whitespace and comments, return the new position.
 */
export function skipWhitespaceAndComments(source: string, start: number): number {
  let pos = start;

  while (pos < source.length) {
    // Skip whitespace
    if (isWhitespace(source[pos])) {
      pos++;
      continue;
    }

    // Skip single-line comment
    if (source[pos] === '/' && source[pos + 1] === '/') {
      pos += 2;
      while (pos < source.length && source[pos] !== '\n') {
        pos++;
      }
      continue;
    }

    // Skip multi-line comment
    if (source[pos] === '/' && source[pos + 1] === '*') {
      pos += 2;
      while (pos < source.length - 1) {
        if (source[pos] === '*' && source[pos + 1] === '/') {
          pos += 2;
          break;
        }
        pos++;
      }
      continue;
    }

    break;
  }

  return pos;
}

/**
 * Look back from position to find the previous token.
 * Used for context detection (e.g., what precedes a colon).
 */
export function getPreviousToken(source: string, position: number): { token: string; start: number } {
  let end = position;

  // Skip whitespace backwards
  while (end > 0 && isWhitespace(source[end - 1])) {
    end--;
  }

  if (end === 0) {
    return { token: '', start: 0 };
  }

  // If previous char is an identifier char, read the identifier backwards
  if (isIdentifierChar(source[end - 1])) {
    let start = end - 1;
    while (start > 0 && isIdentifierChar(source[start - 1])) {
      start--;
    }
    return { token: source.slice(start, end), start };
  }

  // Otherwise return the single character
  return { token: source[end - 1], start: end - 1 };
}

/**
 * Check if we're at a statement boundary.
 */
export function isStatementBoundary(char: string): boolean {
  return char === ';' || char === '{' || char === '}' || char === '\n';
}

/**
 * Check if a position is at the start of a line (ignoring whitespace).
 */
export function isAtLineStart(source: string, position: number): boolean {
  let pos = position - 1;
  while (pos >= 0) {
    const char = source[pos];
    if (char === '\n') return true;
    if (!isWhitespace(char)) return false;
    pos--;
  }
  return true; // Start of file
}

/**
 * Count lines in a string.
 */
export function countLines(str: string): number {
  let count = 0;
  for (const char of str) {
    if (char === '\n') count++;
  }
  return count;
}

/**
 * Replace a range with spaces (preserving newlines for position preservation).
 */
export function replaceWithSpaces(str: string): string {
  let result = '';
  for (const char of str) {
    result += char === '\n' ? '\n' : ' ';
  }
  return result;
}
