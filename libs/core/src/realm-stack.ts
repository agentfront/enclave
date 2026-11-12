/**
 * No stack traces for errors made in a sandbox realm
 *
 * The engine captures a stack trace when an error is made and formats it the first time `stack`
 * is read. Node.js formats with a function of its own that is installed for the whole process,
 * JavaScript of the host realm, and a sandbox realm has no way to put another one in its place.
 * Whatever that function throws (it reads the error's `name` and `message`, and it needs stack to
 * run at all) is an error of the host realm, raised in the middle of the script.
 *
 * So a sandbox realm does not capture stack traces. `Error.stackTraceLimit` of the realm is
 * defined as a value that is not a number, read-only: the engine then captures nothing, an error
 * has no `stack`, and the formatter is never called for an error of that realm. The property
 * cannot be changed back by a script.
 *
 * What it costs: an error made inside the sandbox has no `stack`, for the script and in
 * `result.error`. Errors the host makes (a tool handler's, a validation error) keep theirs and
 * are subject to `sanitizeStackTraces` as before.
 *
 * @packageDocumentation
 */

/**
 * Source to run in a sandbox realm, before anything else runs there and while `Error` is still
 * the realm's own intrinsic. Idempotent.
 */
export const STACK_CAPTURE_OFF_SOURCE = `
(function () {
  'use strict';
  try {
    Object.defineProperty(Error, 'stackTraceLimit', {
      value: undefined,
      writable: false,
      configurable: false,
      enumerable: false
    });
  } catch (e) { /* defined already */ }
})();
`.trim();
