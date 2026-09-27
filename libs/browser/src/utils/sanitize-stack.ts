/**
 * Stack Trace Sanitization
 *
 * Browser counterpart of `sanitizeStackTrace` in @enclave-vm/core (duplicated because the browser
 * package does not depend on core). With `sanitizeStackTraces` on, an error `run()` returns keeps
 * its message lines, with URLs, paths and file locations redacted, and every stack frame becomes
 * `at [REDACTED]`, so no page URL, bundle path, line or column number survives.
 *
 * @packageDocumentation
 */

/** A stack frame line: `at fn (url:1:2)` (V8) or `fn@url:1:2` (Firefox/Safari). */
const FRAME_LINE = /^\s*at\s|@\S*:\d+(?::\d+)?\s*$/;

/** The replacement for every stack frame. */
const REDACTED_FRAME = '    at [REDACTED]';

/** Location-shaped text redacted from the remaining lines. */
const SENSITIVE_PATTERNS: readonly RegExp[] = [
  /[a-z][a-z0-9+.-]*:\/\/[^\s)]+/gi, // URLs (http://host/bundle.mjs:1:2, blob:, file://)
  /\\\\[^\s):]*/g, // UNC paths
  /[A-Z]:\\[^\s):]+/gi, // Windows drive paths
  /(?:\/[\w.@%+-]+){2,}\/?/g, // Absolute paths
  /[\w.@-]+\.(?:[cm]?[jt]sx?|json|wasm|html?)(?::\d+){1,2}/gi, // file.ext:line[:column]
];

/** Bounds on the text the patterns run over, so sanitization stays cheap for any input. */
const MAX_STACK_LENGTH = 16 * 1024;
const MAX_LINE_LENGTH = 1000;

function redactLine(line: string): string {
  let out = line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line;
  for (const pattern of SENSITIVE_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, '[REDACTED]');
  }
  return out;
}

/**
 * Sanitize a stack trace for the enclave's caller.
 *
 * @param stack Original stack trace
 * @param sanitize Whether to sanitize
 * @returns The sanitized stack (or the original if `sanitize` is false)
 */
export function sanitizeStackTrace(stack: string | undefined, sanitize: boolean): string | undefined {
  if (typeof stack !== 'string' || !stack || !sanitize) return stack;

  const bounded = stack.length > MAX_STACK_LENGTH ? stack.slice(0, MAX_STACK_LENGTH) : stack;
  return bounded
    .split('\n')
    .map((line) => (FRAME_LINE.test(line) ? REDACTED_FRAME : redactLine(line)))
    .join('\n');
}
