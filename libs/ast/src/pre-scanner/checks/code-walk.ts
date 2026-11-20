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
  let line = 1;
  let i = 0;

  while (i < source.length) {
    const char = source[i];
    const top = stack.length > 0 ? stack[stack.length - 1] : undefined;

    // The text of a template literal
    if (top && top.kind === 'template') {
      if (char === '\n') line++;
      if (char === '\\' && i + 1 < source.length) {
        if (source[i + 1] === '\n') line++;
        top.length++;
        i += 2;
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
    if (char === '\n') {
      line++;
      if (handlers.code?.(i, char) === true) return;
      i++;
      continue;
    }

    // Comments
    if (char === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (char === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') line++;
        i++;
      }
      i += 2;
      continue;
    }

    // A quoted string
    if (char === '"' || char === "'") {
      const start = i;
      const startLine = line;
      let length = 0;
      i++;
      while (i < source.length && source[i] !== char) {
        if (source[i] === '\n') line++;
        if (source[i] === '\\' && i + 1 < source.length) {
          i += 2;
          length++;
          continue;
        }
        length++;
        i++;
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
