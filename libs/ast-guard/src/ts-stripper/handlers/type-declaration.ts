/**
 * Type declaration handler.
 * Strips `interface` and `type` declarations.
 *
 * @module ts-stripper/handlers/type-declaration
 */

import { readIdentifier, skipWhitespace, replaceWithSpaces, isIdentifierStart } from '../utils/token-utils';

/**
 * Check if position starts an `interface` declaration.
 * Returns the length of the entire declaration to strip, or 0 if not an interface.
 */
export function checkInterfaceDeclaration(source: string, position: number): number {
  const { identifier, end } = readIdentifier(source, position);

  if (identifier !== 'interface') {
    return 0;
  }

  // Verify followed by identifier (interface name)
  const afterInterface = skipWhitespace(source, end);
  if (!isIdentifierStart(source[afterInterface])) {
    return 0;
  }

  // Find the interface body { ... }
  let pos = afterInterface;

  // Skip interface name
  while (pos < source.length && isIdentifierStart(source[pos])) {
    pos++;
  }
  while (pos < source.length && /[a-zA-Z0-9_$]/.test(source[pos])) {
    pos++;
  }

  // Skip optional generic parameters <T, U>
  pos = skipWhitespace(source, pos);
  if (source[pos] === '<') {
    let angleDepth = 1;
    pos++;
    while (pos < source.length && angleDepth > 0) {
      if (source[pos] === '<') angleDepth++;
      if (source[pos] === '>') angleDepth--;
      pos++;
    }
  }

  // Skip optional `extends` clause
  pos = skipWhitespace(source, pos);
  const extendsCheck = readIdentifier(source, pos);
  if (extendsCheck.identifier === 'extends') {
    pos = extendsCheck.end;
    // Skip the extended types (comma-separated until {)
    while (pos < source.length && source[pos] !== '{') {
      if (source[pos] === '<') {
        // Skip generic params in extends
        let angleDepth = 1;
        pos++;
        while (pos < source.length && angleDepth > 0) {
          if (source[pos] === '<') angleDepth++;
          if (source[pos] === '>') angleDepth--;
          pos++;
        }
      } else {
        pos++;
      }
    }
  }

  // Find opening brace
  pos = skipWhitespace(source, pos);
  if (source[pos] !== '{') {
    return 0; // Invalid interface
  }

  // Find matching closing brace
  let braceDepth = 1;
  pos++;
  while (pos < source.length && braceDepth > 0) {
    const char = source[pos];

    if (char === '{') braceDepth++;
    if (char === '}') braceDepth--;

    // Handle strings
    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      pos++;
      while (pos < source.length) {
        if (source[pos] === '\\') {
          pos += 2;
          continue;
        }
        if (source[pos] === quote) {
          if (quote !== '`' || source[pos - 1] !== '$') {
            break;
          }
        }
        // Template interpolation
        if (quote === '`' && source[pos] === '$' && source[pos + 1] === '{') {
          let templateDepth = 1;
          pos += 2;
          while (pos < source.length && templateDepth > 0) {
            if (source[pos] === '{') templateDepth++;
            if (source[pos] === '}') templateDepth--;
            pos++;
          }
          continue;
        }
        pos++;
      }
    }

    pos++;
  }

  return pos - position;
}

/**
 * Check if position starts a `type` alias declaration.
 * Returns the length of the entire declaration to strip, or 0 if not a type alias.
 */
export function checkTypeAliasDeclaration(source: string, position: number): number {
  const { identifier, end } = readIdentifier(source, position);

  if (identifier !== 'type') {
    return 0;
  }

  // Verify followed by identifier (type name)
  const afterType = skipWhitespace(source, end);
  if (!isIdentifierStart(source[afterType])) {
    return 0;
  }

  // Skip type name
  let pos = afterType;
  while (pos < source.length && /[a-zA-Z0-9_$]/.test(source[pos])) {
    pos++;
  }

  // Skip optional generic parameters <T, U>
  pos = skipWhitespace(source, pos);
  if (source[pos] === '<') {
    let angleDepth = 1;
    pos++;
    while (pos < source.length && angleDepth > 0) {
      if (source[pos] === '<') angleDepth++;
      if (source[pos] === '>') angleDepth--;
      pos++;
    }
  }

  // Must have = sign
  pos = skipWhitespace(source, pos);
  if (source[pos] !== '=') {
    return 0; // Not a type alias
  }

  pos++; // Skip =

  // Find the end of the type expression
  // Type expressions can be complex with nested braces, angles, etc.
  let braceDepth = 0;
  let angleDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;

  while (pos < source.length) {
    const char = source[pos];

    if (char === '{') braceDepth++;
    if (char === '}') braceDepth--;
    if (char === '<') angleDepth++;
    if (char === '>') angleDepth--;
    if (char === '(') parenDepth++;
    if (char === ')') parenDepth--;
    if (char === '[') bracketDepth++;
    if (char === ']') bracketDepth--;

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

    // End of type alias
    if (char === ';' && braceDepth === 0 && angleDepth === 0 && parenDepth === 0 && bracketDepth === 0) {
      pos++; // Include semicolon
      break;
    }

    // Newline could end type alias (ASI)
    if (char === '\n' && braceDepth === 0 && angleDepth === 0 && parenDepth === 0 && bracketDepth === 0) {
      // Peek ahead to see if next line continues the type
      const nextNonWhitespace = skipWhitespace(source, pos + 1);
      const nextChar = source[nextNonWhitespace];

      // These could continue the type
      if (nextChar === '|' || nextChar === '&' || nextChar === '?') {
        pos++;
        continue;
      }

      break;
    }

    pos++;
  }

  return pos - position;
}

/**
 * Check if position starts a `declare` statement.
 * Returns the length of the entire statement to strip, or 0 if not a declare.
 */
export function checkDeclareStatement(source: string, position: number): number {
  const { identifier, end } = readIdentifier(source, position);

  if (identifier !== 'declare') {
    return 0;
  }

  // Find the end of the declare statement
  // This could be `declare const`, `declare function`, `declare class`, etc.
  let pos = end;
  let braceDepth = 0;

  while (pos < source.length) {
    const char = source[pos];

    if (char === '{') braceDepth++;
    if (char === '}') {
      braceDepth--;
      if (braceDepth === 0) {
        pos++;
        break;
      }
    }

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

    // End on semicolon at depth 0
    if (char === ';' && braceDepth === 0) {
      pos++;
      break;
    }

    pos++;
  }

  return pos - position;
}

/**
 * Create replacement for declaration (preserve newlines).
 */
export function createDeclarationReplacement(source: string, start: number, length: number): string {
  return replaceWithSpaces(source.slice(start, start + length));
}
