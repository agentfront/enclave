/**
 * Scans of text a script controls
 *
 * The Babel path reads three things out of text it did not write: which modules a source file
 * names in its imports (to order the files and report their dependencies), where the import
 * paths are in the code Babel produced (to give a local import the extension of the file it will
 * find), and where the stack locations are in the message of a failed transform (Babel quotes
 * the source in it). That text is a script's, and this work runs in the host outside every
 * timeout, so each scan here takes time linear in the length of the text, whatever the text is:
 *
 * - the text is read from left to right, one occurrence of a keyword after the other;
 * - every search for "the next character of some kind" remembers its answer (`forwardSearch`)
 *   and is asked with starts that never decrease, and every check of the text around such an
 *   answer remembers its result, so no stretch of text is examined again for a later occurrence
 *   of the keyword.
 *
 * No regular expression is applied to the text. What is recognised is what the expressions
 * these scans replace recognised, character for character; the comment of each scan states it.
 *
 * @packageDocumentation
 */

const KEYWORD = 'import';
const FROM = 'from';

const DOUBLE_QUOTE = 34;
const SINGLE_QUOTE = 39;
const OPEN_PAREN = 40;
const CLOSE_PAREN = 41;
const ASTERISK = 42;
const COMMA = 44;
const DOT = 46;
const OPEN_BRACE = 123;
const CLOSE_BRACE = 125;

function isQuote(code: number): boolean {
  return code === SINGLE_QUOTE || code === DOUBLE_QUOTE;
}

/** White space as `\s` of a regular expression defines it */
function isWhiteSpace(code: number): boolean {
  return (
    code === 32 ||
    (code >= 9 && code <= 13) ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

/** A word character as `\w` of a regular expression defines it */
function isWordChar(code: number): boolean {
  return isAsciiLetter(code) || (code >= 48 && code <= 57) || code === 95;
}

/** What an import clause without braces is made of: names, `*`, commas and white space */
function isClauseChar(code: number): boolean {
  return isWordChar(code) || isWhiteSpace(code) || code === ASTERISK || code === COMMA;
}

/** The first index at or after `from` that is not white space (the length of the text if none) */
function skipWhiteSpace(text: string, from: number): number {
  let i = from;
  while (i < text.length && isWhiteSpace(text.charCodeAt(i))) i++;
  return i;
}

/** The first index at or after `from` that is white space (the length of the text if none) */
function skipNonWhiteSpace(text: string, from: number): number {
  let i = from;
  while (i < text.length && !isWhiteSpace(text.charCodeAt(i))) i++;
  return i;
}

/**
 * A search for the first index at or after a start whose character satisfies `matches`; the
 * length of the text when there is none.
 *
 * An answer is kept together with the start it was computed for, and serves every start between
 * the two. A caller whose starts never decrease therefore makes the search examine each character
 * of the text at most once in total, however many times it asks. Every use below is of that kind.
 */
function forwardSearch(text: string, matches: (code: number) => boolean): (from: number) => number {
  let knownFrom = 0;
  let knownAt = -1;
  return (from: number): number => {
    if (knownAt >= 0 && from >= knownFrom && from <= knownAt) {
      return knownAt;
    }
    let i = from;
    while (i < text.length && !matches(text.charCodeAt(i))) i++;
    knownFrom = from;
    knownAt = i;
    return i;
  };
}

/**
 * The quoted strings that follow the keyword: for each occurrence of `import` that ends a word,
 * the text between the next quote and the quote after it, when that text is not empty. The scan
 * goes on after the closing quote.
 */
function collectQuotedAfterKeyword(text: string, sources: string[]): void {
  const openingQuote = forwardSearch(text, isQuote);
  const closingQuote = forwardSearch(text, isQuote);

  let from = 0;
  for (;;) {
    const at = text.indexOf(KEYWORD, from);
    if (at === -1) return;
    from = at + 1;

    const after = at + KEYWORD.length;
    if (after < text.length && isWordChar(text.charCodeAt(after))) continue;

    const open = openingQuote(after);
    if (open >= text.length) continue;
    const close = closingQuote(open + 1);
    if (close >= text.length || close === open + 1) continue;

    sources.push(text.slice(open + 1, close));
    from = close + 1;
  }
}

/**
 * The specifiers of dynamic imports written with a string: `import`, `(`, a quoted string that
 * is not empty, `)`, with any white space between them.
 */
function collectDynamicImports(text: string, sources: string[]): void {
  const closingQuote = forwardSearch(text, isQuote);

  let from = 0;
  for (;;) {
    const at = text.indexOf(KEYWORD, from);
    if (at === -1) return;
    from = at + 1;

    const paren = skipWhiteSpace(text, at + KEYWORD.length);
    if (text.charCodeAt(paren) !== OPEN_PAREN) continue;
    const open = skipWhiteSpace(text, paren + 1);
    if (!isQuote(text.charCodeAt(open))) continue;
    const close = closingQuote(open + 1);
    if (close >= text.length || close === open + 1) continue;
    const end = skipWhiteSpace(text, close + 1);
    if (text.charCodeAt(end) !== CLOSE_PAREN) continue;

    sources.push(text.slice(open + 1, close));
    from = end + 1;
  }
}

/**
 * The module specifiers a source file names: first what follows each `import` keyword, then the
 * dynamic imports written with a string (which the first pass has seen as well).
 *
 * This reads TypeScript and JSX as text, before Babel has parsed them, so it is an
 * approximation: a keyword inside a comment or a string counts. It decides the order in which
 * files are transformed and what the dependency report says, nothing else.
 */
export function findImportSources(text: string): string[] {
  const sources: string[] = [];
  collectQuotedAfterKeyword(text, sources);
  collectDynamicImports(text, sources);
  return sources;
}

/**
 * Apply `map` to the specifier of every static import statement of `text` and return the text
 * with the specifiers `map` changed.
 *
 * An import statement is the keyword followed by one of
 *
 * - white space and a quoted string: `import './a'`
 * - white space, a clause in braces, `from` and a quoted string: `import { a, b } from './a'`
 * - a clause of names, `*` and commas, `from` and a quoted string: `import a from './a'`,
 *   `import * as a from './a'`
 *
 * where the quoted string is not empty. Re-exports and dynamic imports are not import
 * statements in this sense and are left as they are.
 */
export function mapStaticImportSources(text: string, map: (source: string) => string): string {
  const clauseEnd = forwardSearch(text, (code) => !isClauseChar(code));
  const closingBrace = forwardSearch(text, (code) => code === CLOSE_BRACE);
  const closingQuote = forwardSearch(text, isQuote);
  const closingQuoteAfterBrace = forwardSearch(text, isQuote);

  // The specifier found by `findSpecifier`: the indexes of its two quotes
  let open = -1;
  let close = -1;

  // Where the white space that ends at a position starts. Many occurrences of the keyword can
  // share that position (the end of one run of clause characters), so the answer is kept.
  let spaceKnownFor = -1;
  let spaceKnownStart = -1;
  const spaceStartBefore = (end: number): number => {
    if (end !== spaceKnownFor) {
      let i = end;
      while (i > 0 && isWhiteSpace(text.charCodeAt(i - 1))) i--;
      spaceKnownFor = end;
      spaceKnownStart = i;
    }
    return spaceKnownStart;
  };

  // The specifier after a closing brace: white space, `from`, white space, a quoted string that
  // is not empty. Many occurrences of the keyword can share the brace, so the answer is kept
  // (-1 for both quotes when there is no specifier).
  let braceKnownFor = -1;
  let braceKnownOpen = -1;
  let braceKnownClose = -1;
  const specifierAfterBrace = (brace: number): void => {
    if (brace === braceKnownFor) return;
    braceKnownFor = brace;
    braceKnownOpen = -1;
    braceKnownClose = -1;

    const word = skipWhiteSpace(text, brace + 1);
    if (word === brace + 1 || !text.startsWith(FROM, word)) return;
    const quote = skipWhiteSpace(text, word + FROM.length);
    if (quote === word + FROM.length || !isQuote(text.charCodeAt(quote))) return;
    const end = closingQuoteAfterBrace(quote + 1);
    if (end >= text.length || end === quote + 1) return;
    braceKnownOpen = quote;
    braceKnownClose = end;
  };

  /** Sets `open` and `close` for the import whose keyword ends at `after`; false if it is no import */
  const findSpecifier = (after: number): boolean => {
    const first = skipWhiteSpace(text, after);
    if (first === after) return false;

    const code = text.charCodeAt(first);
    if (code === OPEN_BRACE) {
      const brace = closingBrace(first + 1);
      if (brace >= text.length) return false;
      specifierAfterBrace(brace);
      open = braceKnownOpen;
      close = braceKnownClose;
      return open !== -1;
    }

    if (isQuote(code)) {
      open = first;
    } else {
      // Names, `*` and commas up to the quote. The run ends in white space, `from`, white
      // space, and holds at least one character between the white space after the keyword and
      // the white space before `from`.
      const end = clauseEnd(after);
      if (end >= text.length || !isQuote(text.charCodeAt(end))) return false;
      const spaceStart = spaceStartBefore(end);
      const fromAt = spaceStart - FROM.length;
      if (spaceStart === end || fromAt < after + 3) return false;
      if (!text.startsWith(FROM, fromAt) || !isWhiteSpace(text.charCodeAt(fromAt - 1))) return false;
      open = end;
    }

    close = closingQuote(open + 1);
    return close < text.length && close !== open + 1;
  };

  const pieces: string[] = [];
  let copied = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(KEYWORD, from);
    if (at === -1) break;
    from = at + 1;

    if (!findSpecifier(at + KEYWORD.length)) continue;

    const source = text.slice(open + 1, close);
    const mapped = map(source);
    if (mapped !== source) {
      pieces.push(text.slice(copied, open + 1), mapped);
      copied = close;
    }
    from = close + 1;
  }

  if (pieces.length === 0) {
    return text;
  }
  pieces.push(text.slice(copied));
  return pieces.join('');
}

/**
 * Whether a specifier ends in a file extension: a dot followed by ASCII letters, at the end.
 */
export function hasFileExtension(source: string): boolean {
  let i = source.length;
  while (i > 0 && isAsciiLetter(source.charCodeAt(i - 1))) i--;
  return i < source.length && i > 0 && source.charCodeAt(i - 1) === DOT;
}

/**
 * Remove what looks like a stack location from a message: `at`, white space, a name without
 * white space, white space, and a parenthesis that is not empty, as in `at parse (file:1:2)`.
 */
export function removeStackLocations(text: string): string {
  const closingParen = forwardSearch(text, (code) => code === CLOSE_PAREN);

  const pieces: string[] = [];
  let copied = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf('at', from);
    if (at === -1) break;
    from = at + 1;

    const name = skipWhiteSpace(text, at + 2);
    if (name === at + 2) continue;
    const space = skipNonWhiteSpace(text, name);
    if (space === name) continue;
    const paren = skipWhiteSpace(text, space);
    if (paren === space || text.charCodeAt(paren) !== OPEN_PAREN) continue;
    const close = closingParen(paren + 1);
    if (close >= text.length || close === paren + 1) continue;

    pieces.push(text.slice(copied, at));
    copied = close + 1;
    from = close + 1;
  }

  if (pieces.length === 0) {
    return text;
  }
  pieces.push(text.slice(copied));
  return pieces.join('');
}
