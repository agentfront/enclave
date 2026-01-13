/**
 * Enum handler.
 * Transpiles TypeScript enums to JavaScript objects.
 *
 * @module ts-stripper/handlers/enum-handler
 */

import {
  readIdentifier,
  skipWhitespace,
  skipWhitespaceAndComments,
  isIdentifierStart,
  isDigit,
} from '../utils/token-utils';

/**
 * Enum member representation.
 */
interface EnumMember {
  name: string;
  value: string | number | null; // null means auto-increment
}

/**
 * Check if position starts an enum declaration.
 * Returns info needed to transpile it, or null if not an enum.
 */
export function checkEnumDeclaration(
  source: string,
  position: number,
): { length: number; replacement: string } | null {
  // Check for optional `const` before enum
  let pos = position;
  let isConst = false;

  const firstWord = readIdentifier(source, pos);

  if (firstWord.identifier === 'const') {
    isConst = true;
    pos = skipWhitespace(source, firstWord.end);
    const enumKeyword = readIdentifier(source, pos);
    if (enumKeyword.identifier !== 'enum') {
      return null;
    }
    pos = enumKeyword.end;
  } else if (firstWord.identifier === 'enum') {
    pos = firstWord.end;
  } else {
    return null;
  }

  // Get enum name
  pos = skipWhitespace(source, pos);
  if (!isIdentifierStart(source[pos])) {
    return null;
  }

  const enumName = readIdentifier(source, pos);
  pos = enumName.end;

  // Find opening brace
  pos = skipWhitespaceAndComments(source, pos);
  if (source[pos] !== '{') {
    return null;
  }

  // Parse enum body
  const bodyStart = pos;
  pos++; // Skip {

  const members: EnumMember[] = [];
  let autoValue = 0;

  while (pos < source.length) {
    pos = skipWhitespaceAndComments(source, pos);

    // End of enum
    if (source[pos] === '}') {
      pos++;
      break;
    }

    // Skip comma
    if (source[pos] === ',') {
      pos++;
      continue;
    }

    // Parse member
    if (!isIdentifierStart(source[pos])) {
      // Unexpected character
      return null;
    }

    const memberName = readIdentifier(source, pos);
    pos = memberName.end;

    pos = skipWhitespaceAndComments(source, pos);

    // Check for explicit value
    if (source[pos] === '=') {
      pos++; // Skip =
      pos = skipWhitespaceAndComments(source, pos);

      // Parse the value
      const valueResult = parseEnumValue(source, pos);
      if (valueResult === null) {
        return null; // Unsupported value
      }

      members.push({
        name: memberName.identifier,
        value: valueResult.value,
      });

      // Update auto value if numeric
      if (typeof valueResult.value === 'number') {
        autoValue = valueResult.value + 1;
      }

      pos = valueResult.end;
    } else {
      // Auto-increment value
      members.push({
        name: memberName.identifier,
        value: autoValue,
      });
      autoValue++;
    }

    pos = skipWhitespaceAndComments(source, pos);

    // Comma is optional before }
    if (source[pos] === ',') {
      pos++;
    }
  }

  // Generate JavaScript object
  const replacement = generateEnumReplacement(enumName.identifier, members, isConst);

  return {
    length: pos - position,
    replacement,
  };
}

/**
 * Parse an enum value (number or string literal).
 */
function parseEnumValue(
  source: string,
  position: number,
): { value: string | number; end: number } | null {
  const char = source[position];

  // String literal
  if (char === '"' || char === "'") {
    const quote = char;
    let pos = position + 1;
    let value = '';

    while (pos < source.length && source[pos] !== quote) {
      if (source[pos] === '\\') {
        // Include escape sequence
        value += source[pos] + source[pos + 1];
        pos += 2;
        continue;
      }
      value += source[pos];
      pos++;
    }

    if (source[pos] !== quote) {
      return null; // Unclosed string
    }

    return {
      value: `${quote}${value}${quote}`,
      end: pos + 1,
    };
  }

  // Number (including negative)
  if (isDigit(char) || (char === '-' && isDigit(source[position + 1]))) {
    let pos = position;
    if (char === '-') pos++;

    // Handle hex, octal, binary
    if (source[pos] === '0' && /[xXoObB]/.test(source[pos + 1])) {
      pos += 2;
      while (pos < source.length && /[0-9a-fA-F]/.test(source[pos])) {
        pos++;
      }
    } else {
      // Decimal
      while (pos < source.length && /[0-9.]/.test(source[pos])) {
        pos++;
      }
      // Exponent
      if (source[pos] === 'e' || source[pos] === 'E') {
        pos++;
        if (source[pos] === '+' || source[pos] === '-') pos++;
        while (pos < source.length && isDigit(source[pos])) {
          pos++;
        }
      }
    }

    const numStr = source.slice(position, pos);
    const value = parseFloat(numStr);

    if (isNaN(value)) {
      return null;
    }

    return { value, end: pos };
  }

  // Computed value (reference to another member or expression)
  // For simplicity, we'll handle simple identifier references
  if (isIdentifierStart(char)) {
    const ident = readIdentifier(source, position);

    // Check for EnumName.MemberName pattern
    let pos = ident.end;
    if (source[pos] === '.') {
      pos++;
      const member = readIdentifier(source, pos);
      pos = member.end;
      // Return as string to preserve the reference
      return {
        value: `${ident.identifier}.${member.identifier}`,
        end: pos,
      };
    }

    // Simple identifier - might be a reference, keep as string
    return {
      value: ident.identifier,
      end: ident.end,
    };
  }

  // Unsupported value type
  return null;
}

/**
 * Generate JavaScript object replacement for enum.
 */
function generateEnumReplacement(
  name: string,
  members: EnumMember[],
  _isConst: boolean,
): string {
  // For const enums, we still generate the object (inlining would require more context)
  // In a full TypeScript compiler, const enum values would be inlined at usage sites

  const memberStrings = members.map((member) => {
    const value = typeof member.value === 'string'
      ? member.value
      : String(member.value);
    return `${member.name}: ${value}`;
  });

  return `const ${name} = { ${memberStrings.join(', ')} };`;
}

/**
 * Calculate the whitespace padding needed to preserve line count.
 */
export function calculateEnumPadding(original: string, replacement: string): string {
  // Count newlines in original
  let originalNewlines = 0;
  for (const char of original) {
    if (char === '\n') originalNewlines++;
  }

  // Count newlines in replacement
  let replacementNewlines = 0;
  for (const char of replacement) {
    if (char === '\n') replacementNewlines++;
  }

  // Add newlines to match
  const neededNewlines = originalNewlines - replacementNewlines;
  if (neededNewlines > 0) {
    return replacement + '\n'.repeat(neededNewlines);
  }

  return replacement;
}
