/**
 * Context tracking utilities for the TypeScript stripper.
 * Tracks whether we're inside strings, comments, etc.
 *
 * @module ts-stripper/utils/context-tracker
 */

import { StripperContext, type StripperState } from '../stripper-state';

/**
 * Process a character and update context state.
 * Returns true if the character should be included in output (not stripped).
 */
export function updateContext(
  source: string,
  state: StripperState,
): { newContext: StripperContext; skip: number } {
  const char = source[state.position];
  const nextChar = source[state.position + 1];
  const context = state.context;

  // Handle context exits first
  switch (context) {
    case StripperContext.SingleLineComment:
      if (char === '\n') {
        return { newContext: StripperContext.Normal, skip: 0 };
      }
      return { newContext: context, skip: 0 };

    case StripperContext.MultiLineComment:
      if (char === '*' && nextChar === '/') {
        return { newContext: StripperContext.Normal, skip: 2 };
      }
      return { newContext: context, skip: 0 };

    case StripperContext.SingleQuoteString:
      if (char === '\\') {
        return { newContext: context, skip: 2 }; // Skip escape sequence
      }
      if (char === "'") {
        return { newContext: StripperContext.Normal, skip: 1 };
      }
      return { newContext: context, skip: 0 };

    case StripperContext.DoubleQuoteString:
      if (char === '\\') {
        return { newContext: context, skip: 2 }; // Skip escape sequence
      }
      if (char === '"') {
        return { newContext: StripperContext.Normal, skip: 1 };
      }
      return { newContext: context, skip: 0 };

    case StripperContext.TemplateString:
      if (char === '\\') {
        return { newContext: context, skip: 2 }; // Skip escape sequence
      }
      if (char === '$' && nextChar === '{') {
        state.depth.template++;
        return { newContext: StripperContext.TemplateInterpolation, skip: 2 };
      }
      if (char === '`') {
        return { newContext: StripperContext.Normal, skip: 1 };
      }
      return { newContext: context, skip: 0 };

    case StripperContext.TemplateInterpolation:
      // Track brace depth within interpolation
      if (char === '{') {
        state.depth.template++;
      } else if (char === '}') {
        state.depth.template--;
        if (state.depth.template === 0) {
          return { newContext: StripperContext.TemplateString, skip: 1 };
        }
      }
      // Recursively handle nested strings in interpolation
      if (char === '"') {
        return { newContext: StripperContext.DoubleQuoteString, skip: 1 };
      }
      if (char === "'") {
        return { newContext: StripperContext.SingleQuoteString, skip: 1 };
      }
      if (char === '`') {
        return { newContext: StripperContext.TemplateString, skip: 1 };
      }
      return { newContext: context, skip: 0 };

    case StripperContext.RegexLiteral:
      if (char === '\\') {
        return { newContext: context, skip: 2 }; // Skip escape sequence
      }
      if (char === '/') {
        // Skip regex flags
        let flagEnd = state.position + 1;
        while (flagEnd < source.length && /[gimsuvy]/.test(source[flagEnd])) {
          flagEnd++;
        }
        return { newContext: StripperContext.Normal, skip: flagEnd - state.position };
      }
      return { newContext: context, skip: 0 };

    case StripperContext.Normal:
      // Handle context entries
      if (char === '/' && nextChar === '/') {
        return { newContext: StripperContext.SingleLineComment, skip: 2 };
      }
      if (char === '/' && nextChar === '*') {
        return { newContext: StripperContext.MultiLineComment, skip: 2 };
      }
      if (char === '"') {
        return { newContext: StripperContext.DoubleQuoteString, skip: 1 };
      }
      if (char === "'") {
        return { newContext: StripperContext.SingleQuoteString, skip: 1 };
      }
      if (char === '`') {
        return { newContext: StripperContext.TemplateString, skip: 1 };
      }
      // Regex detection is complex - handled separately
      return { newContext: context, skip: 0 };
  }

  return { newContext: context, skip: 0 };
}

/**
 * Check if current position could be the start of a regex literal.
 * This is heuristic-based since regex vs division is context-dependent.
 */
export function couldBeRegexStart(source: string, position: number): boolean {
  // Look backwards to see what precedes the /
  let pos = position - 1;

  // Skip whitespace
  while (pos >= 0 && /\s/.test(source[pos])) {
    pos--;
  }

  if (pos < 0) return true; // Start of file

  const prevChar = source[pos];

  // After these, / is likely division
  if (/[)\]}\w$]/.test(prevChar)) {
    // But check for keywords that can precede regex
    if (/[a-zA-Z_$]/.test(prevChar)) {
      // Read the word backwards
      const wordEnd = pos + 1;
      let wordStart = pos;
      while (wordStart > 0 && /[a-zA-Z_$0-9]/.test(source[wordStart - 1])) {
        wordStart--;
      }
      const word = source.slice(wordStart, wordEnd);

      // These keywords can precede regex
      if (['return', 'case', 'throw', 'in', 'of', 'typeof', 'instanceof', 'void', 'delete', 'new'].includes(word)) {
        return true;
      }
    }
    return false;
  }

  // After operators, ( [ { , ; etc., / is likely regex
  return true;
}

/**
 * Update depth tracking based on character.
 */
export function updateDepth(char: string, state: StripperState): void {
  if (state.context !== StripperContext.Normal) return;

  switch (char) {
    case '{':
      state.depth.braces++;
      break;
    case '}':
      state.depth.braces--;
      break;
    case '[':
      state.depth.brackets++;
      break;
    case ']':
      state.depth.brackets--;
      break;
    case '(':
      state.depth.parens++;
      break;
    case ')':
      state.depth.parens--;
      break;
  }
}

/**
 * Update line and column tracking.
 */
export function updatePosition(char: string, state: StripperState): void {
  if (char === '\n') {
    state.line++;
    state.column = 0;
  } else {
    state.column++;
  }
}
