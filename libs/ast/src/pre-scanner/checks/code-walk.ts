/**
 * The walk the string, nesting and operator checks of the pre-scanner share: which characters are
 * code, and where each string literal starts and how long it is.
 *
 * A template literal is text with code in it: what stands between `${` and its closing `}` is code
 * like any other, with its own strings, brackets, operators and templates. A check that skipped it
 * would not see what is written there.
 *
 * The walk is a heuristic like the checks that use it: a `/` is code (a regular-expression literal
 * is the regex check's), and comments are skipped.
 *
 * @module pre-scanner/checks/code-walk
 */

import { findRegexLiterals } from './regex-check';

function lineBreakWidth(source: string, index: number): number {
  const char = source[index];
  if (char === '\r') return source[index + 1] === '\n' ? 2 : 1;
  return char === '\n' || char === '\u2028' || char === '\u2029' ? 1 : 0;
}

export interface CodeWalkHandlers {
  /** A character of code. Return `true` to stop the walk. */
  code?(index: number, char: string): boolean | void;
  /**
   * The end of a string literal: a quoted string, or the text of a template literal (all its
   * parts, without the code of its interpolations). Return `true` to stop the walk.
   */
  string?(start: number, line: number, length: number): boolean | void;
}

interface TemplateFrame {
  kind: 'template';
  start: number;
  line: number;
  length: number;
}

interface InterpolationFrame {
  kind: 'interpolation';
  /** Braces opened inside the interpolation and not closed yet */
  braces: number;
}

/**
 * Walks `source` and reports each character of code and each string literal to `handlers`.
 */
export function walkCode(source: string, handlers: CodeWalkHandlers): void {
  const stack: Array<TemplateFrame | InterpolationFrame> = [];
  const regexEnds = new Map(findRegexLiterals(source).map((regex) => [regex.position, regex.end]));
  let line = 1;
  let i = 0;

  while (i < source.length) {
    const char = source[i];
    const top = stack.length > 0 ? stack[stack.length - 1] : undefined;

    // The text of a template literal
    if (top && top.kind === 'template') {
      if (char === '\\' && i + 1 < source.length) {
        const escapedBreak = lineBreakWidth(source, i + 1);
        if (escapedBreak) line++;
        top.length++;
        i += 1 + (escapedBreak || 1);
        continue;
      }
      const breakWidth = lineBreakWidth(source, i);
      if (breakWidth) {
        line++;
        top.length += breakWidth;
        i += breakWidth;
        continue;
      }
      if (char === '`') {
        stack.pop();
        i++;
        if (handlers.string?.(top.start, top.line, top.length) === true) return;
        continue;
      }
      if (char === '$' && source[i + 1] === '{') {
        stack.push({ kind: 'interpolation', braces: 0 });
        // The `${` opens a level of code, as a brace does
        if (handlers.code?.(i + 1, '{') === true) return;
        i += 2;
        continue;
      }
      top.length++;
      i++;
      continue;
    }

    // Code: at the top level or inside an interpolation
    const breakWidth = lineBreakWidth(source, i);
    if (breakWidth) {
      line++;
      if (handlers.code?.(i, char) === true) return;
      i += breakWidth;
      continue;
    }

    // Comments
    if (char === '/' && source[i + 1] === '/') {
      while (i < source.length && !lineBreakWidth(source, i)) i++;
      continue;
    }
    if (char === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        const commentBreak = lineBreakWidth(source, i);
        if (commentBreak) line++;
        i += commentBreak || 1;
      }
      i += 2;
      continue;
    }

    // A regex is an opaque value. Its pattern characters are not source-code operators or braces.
    const regexEnd = regexEnds.get(i);
    if (regexEnd !== undefined) {
      if (handlers.code?.(i, 'r') === true) return;
      i = regexEnd + 1;
      continue;
    }

    // A quoted string
    if (char === '"' || char === "'") {
      const start = i;
      const startLine = line;
      let length = 0;
      i++;
      while (i < source.length && source[i] !== char) {
        if (source[i] === '\\' && i + 1 < source.length) {
          const escapedBreak = lineBreakWidth(source, i + 1);
          if (escapedBreak) line++;
          i += 1 + (escapedBreak || 1);
          length++;
          continue;
        }
        const stringBreak = lineBreakWidth(source, i);
        if (stringBreak) line++;
        length += stringBreak || 1;
        i += stringBreak || 1;
      }
      i++;
      if (handlers.string?.(start, startLine, length) === true) return;
      continue;
    }

    // A template literal
    if (char === '`') {
      stack.push({ kind: 'template', start: i, line, length: 0 });
      i++;
      continue;
    }

    // The braces of an interpolation: the one that closes it goes back to the template's text
    if (top && top.kind === 'interpolation') {
      if (char === '{') {
        top.braces++;
      } else if (char === '}') {
        if (top.braces === 0) {
          stack.pop();
          if (handlers.code?.(i, char) === true) return;
          i++;
          continue;
        }
        top.braces--;
      }
    }

    if (handlers.code?.(i, char) === true) return;
    i++;
  }
}
