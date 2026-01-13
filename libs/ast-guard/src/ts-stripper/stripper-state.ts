/**
 * State machine for TypeScript stripping.
 *
 * @module ts-stripper/stripper-state
 */

/**
 * Parsing context - what kind of code construct we're currently inside.
 */
export enum StripperContext {
  /** Normal code */
  Normal = 'normal',
  /** Inside single-line comment // */
  SingleLineComment = 'single_line_comment',
  /** Inside multi-line comment /* */
  MultiLineComment = 'multi_line_comment',
  /** Inside single-quoted string '' */
  SingleQuoteString = 'single_quote_string',
  /** Inside double-quoted string "" */
  DoubleQuoteString = 'double_quote_string',
  /** Inside template string `` */
  TemplateString = 'template_string',
  /** Inside template string interpolation ${} */
  TemplateInterpolation = 'template_interpolation',
  /** Inside regex literal /.../ */
  RegexLiteral = 'regex_literal',
}

/**
 * Depth tracking for nested structures.
 */
export interface DepthTracker {
  /** Brace depth {} */
  braces: number;
  /** Bracket depth [] */
  brackets: number;
  /** Parenthesis depth () */
  parens: number;
  /** Angle bracket depth <> (for generics) */
  angles: number;
  /** Template literal interpolation depth */
  template: number;
}

/**
 * State of the TypeScript stripper at any point.
 */
export interface StripperState {
  /** Current position in source */
  position: number;
  /** Current line number (1-indexed) */
  line: number;
  /** Current column number (0-indexed) */
  column: number;
  /** Current parsing context */
  context: StripperContext;
  /** Depth tracking for nested structures */
  depth: DepthTracker;
  /** Output characters being built */
  output: string[];
  /** Statistics counters */
  stats: {
    typesStripped: number;
    interfacesStripped: number;
    enumsTranspiled: number;
  };
}

/**
 * Create initial stripper state.
 */
export function createStripperState(): StripperState {
  return {
    position: 0,
    line: 1,
    column: 0,
    context: StripperContext.Normal,
    depth: {
      braces: 0,
      brackets: 0,
      parens: 0,
      angles: 0,
      template: 0,
    },
    output: [],
    stats: {
      typesStripped: 0,
      interfacesStripped: 0,
      enumsTranspiled: 0,
    },
  };
}

/**
 * Clone the current depth tracker.
 */
export function cloneDepth(depth: DepthTracker): DepthTracker {
  return { ...depth };
}

/**
 * Check if we're at the top level (no nesting).
 */
export function isTopLevel(depth: DepthTracker): boolean {
  return depth.braces === 0 && depth.brackets === 0 && depth.parens === 0;
}

/**
 * Check if we're in a string or comment context.
 */
export function isInStringOrComment(context: StripperContext): boolean {
  return (
    context === StripperContext.SingleLineComment ||
    context === StripperContext.MultiLineComment ||
    context === StripperContext.SingleQuoteString ||
    context === StripperContext.DoubleQuoteString ||
    context === StripperContext.TemplateString ||
    context === StripperContext.RegexLiteral
  );
}
