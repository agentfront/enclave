/**
 * Names of custom globals and tool namespaces
 *
 * A script runs in a document, inside the function that sets the sandbox up. A name the host
 * configured must mean the host's value there and nothing else, and must not take the place of
 * a name the runtime uses itself.
 *
 * @packageDocumentation
 */

/** Prefixes of the names the runtime and the code transformer own */
const RUNTIME_PREFIXES = ['__safe_', '__ag_', '__iter_'];

/** Names the runtime owns that carry no such prefix */
const RUNTIME_NAMES: ReadonlySet<string> = new Set(['__maxIterations']);

/**
 * Whether `name` is one the runtime owns: the helpers transformed code calls, the loop counters
 * and the iteration limit. A custom global with such a name would stand in for the runtime.
 */
export function isRuntimeName(name: string): boolean {
  return RUNTIME_NAMES.has(name) || RUNTIME_PREFIXES.some((prefix) => name.startsWith(prefix));
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Words that cannot be the name of a parameter in strict code, or that name a value of the
 * language (a script that reads `undefined` must get it).
 */
const UNBINDABLE_WORDS: ReadonlySet<string> = new Set(
  (
    'break case catch class const continue debugger default delete do else enum export extends false finally ' +
    'for function if import in instanceof new null return super switch this throw true try typeof var void ' +
    'while with yield let static implements interface package private protected public await eval arguments ' +
    'undefined NaN Infinity'
  ).split(' '),
);

/**
 * Whether a configured name can be bound as a parameter of the function a script runs in. The
 * names that pass are written into the source of the inner frame, so the test is strict: ASCII
 * identifiers only. Any other name cannot be written by a script as an identifier either.
 */
export function isBindableName(name: string): boolean {
  return IDENTIFIER.test(name) && !UNBINDABLE_WORDS.has(name);
}
