/**
 * Import/export type handler.
 * Strips `import type` and `export type` declarations.
 *
 * @module ts-stripper/handlers/import-export-type
 */

import { readIdentifier, skipWhitespace, skipWhitespaceAndComments, replaceWithSpaces } from '../utils/token-utils';

/**
 * Check if position starts an `import type` statement.
 * Returns the length of the entire statement to strip, or 0 if not import type.
 */
export function checkImportType(source: string, position: number): number {
  const { identifier, end } = readIdentifier(source, position);

  if (identifier !== 'import') {
    return 0;
  }

  const afterImport = skipWhitespace(source, end);
  const next = readIdentifier(source, afterImport);

  if (next.identifier !== 'type') {
    return 0;
  }

  // This is `import type` - find the end of the statement
  let pos = next.end;

  // Find the semicolon or newline that ends this statement
  while (pos < source.length) {
    const char = source[pos];

    // Handle string literals (module specifiers)
    if (char === '"' || char === "'") {
      const quote = char;
      pos++;
      while (pos < source.length && source[pos] !== quote) {
        if (source[pos] === '\\') pos++; // Skip escape
        pos++;
      }
      pos++; // Skip closing quote
      continue;
    }

    // End of statement
    if (char === ';') {
      pos++; // Include the semicolon
      break;
    }

    // Newline without semicolon (ASI)
    if (char === '\n') {
      // Check if next non-whitespace looks like a new statement
      const nextPos = skipWhitespaceAndComments(source, pos + 1);
      if (nextPos >= source.length) break;

      const nextChar = source[nextPos];
      // If next line starts with something that's clearly a new statement, end here
      if (/[a-zA-Z_$({[]/.test(nextChar) && source.slice(nextPos, nextPos + 4) !== 'from') {
        break;
      }
    }

    pos++;
  }

  return pos - position;
}

/**
 * Check if position starts an `export type` statement.
 * Returns the length of the entire statement to strip, or 0 if not export type.
 */
export function checkExportType(source: string, position: number): number {
  const { identifier, end } = readIdentifier(source, position);

  if (identifier !== 'export') {
    return 0;
  }

  const afterExport = skipWhitespace(source, end);
  const next = readIdentifier(source, afterExport);

  if (next.identifier !== 'type') {
    return 0;
  }

  // Check if this is `export type { ... }` or `export type Foo = ...`
  const afterType = skipWhitespace(source, next.end);

  // `export type { ... }` - type-only re-export
  if (source[afterType] === '{') {
    // Find the end of the export statement
    let pos = afterType;
    let braceDepth = 0;

    while (pos < source.length) {
      const char = source[pos];

      if (char === '{') braceDepth++;
      if (char === '}') {
        braceDepth--;
        if (braceDepth === 0) {
          pos++;
          // Look for `from 'module'`
          const afterBrace = skipWhitespace(source, pos);
          const fromKeyword = readIdentifier(source, afterBrace);
          if (fromKeyword.identifier === 'from') {
            pos = fromKeyword.end;
            // Find module specifier
            const afterFrom = skipWhitespace(source, pos);
            if (source[afterFrom] === '"' || source[afterFrom] === "'") {
              const quote = source[afterFrom];
              pos = afterFrom + 1;
              while (pos < source.length && source[pos] !== quote) {
                if (source[pos] === '\\') pos++;
                pos++;
              }
              pos++; // Skip closing quote
            }
          }
          break;
        }
      }

      // Handle strings inside braces
      if (char === '"' || char === "'") {
        const quote = char;
        pos++;
        while (pos < source.length && source[pos] !== quote) {
          if (source[pos] === '\\') pos++;
          pos++;
        }
      }

      pos++;
    }

    // Skip trailing semicolon
    const afterStatement = skipWhitespace(source, pos);
    if (source[afterStatement] === ';') {
      pos = afterStatement + 1;
    }

    return pos - position;
  }

  // `export type Foo = ...` - type alias export
  // Find the end of the type alias
  let pos = afterType;
  let braceDepth = 0;
  let angleDepth = 0;

  while (pos < source.length) {
    const char = source[pos];

    if (char === '{') braceDepth++;
    if (char === '}') braceDepth--;
    if (char === '<') angleDepth++;
    if (char === '>') angleDepth--;

    // End of statement
    if (char === ';' && braceDepth === 0 && angleDepth === 0) {
      pos++; // Include the semicolon
      break;
    }

    // Handle strings
    if (char === '"' || char === "'") {
      const quote = char;
      pos++;
      while (pos < source.length && source[pos] !== quote) {
        if (source[pos] === '\\') pos++;
        pos++;
      }
    }

    pos++;
  }

  return pos - position;
}

/**
 * Create replacement for import/export type (preserve newlines).
 */
export function createImportExportReplacement(source: string, start: number, length: number): string {
  return replaceWithSpaces(source.slice(start, start + length));
}
