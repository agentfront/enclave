/**
 * What a thrown value says about itself, as text of the host
 *
 * A script can throw anything: an object whose `message` is another object, a function, a Proxy,
 * `null`. Whatever it is, the caller of `run()` gets `result.error` with `name`, `message` and
 * `stack` as the strings they are declared to be, of bounded length: an application logs them,
 * concatenates them and serializes the result, and none of that may run code of the script or
 * depend on the size of what was thrown.
 *
 * A member of the thrown value is read once and used only if it is a string. Nothing is called
 * on the value and nothing is converted: an object in the place of a string is not asked for its
 * text, it is left out.
 *
 * @packageDocumentation
 */

/** The longest `name` reported for a thrown value. */
export const MAX_THROWN_NAME_LENGTH = 256;

/** The longest `message` reported for a thrown value. */
export const MAX_THROWN_MESSAGE_LENGTH = 16 * 1024;

/** The longest `stack` taken from a thrown value (the stack-trace policy cuts further). */
export const MAX_THROWN_STACK_LENGTH = 64 * 1024;

const ReflectGet = Reflect.get;

/** What {@link describeThrown} could read. A member that was not a string is absent. */
export interface ThrownDescription {
  name?: string;
  message?: string;
  stack?: string;
}

function bounded(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/** The member `key` of `value` if it is a string, read once; whatever the read throws is ignored. */
function stringMember(value: object, key: string, max: number): string | undefined {
  try {
    const member: unknown = ReflectGet(value, key);
    return typeof member === 'string' ? bounded(member, max) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The name, message and stack of a thrown value, each only if the value holds it as a string.
 *
 * - A thrown string is the message.
 * - `null`, `undefined` and the other primitives are named in the message.
 * - An object or function is asked for `name`, `message` and `stack`; what is not a string there
 *   is absent from the result, and the caller puts its own default in its place.
 */
export function describeThrown(thrown: unknown): ThrownDescription {
  if (typeof thrown === 'string') {
    return { message: bounded(thrown, MAX_THROWN_MESSAGE_LENGTH) };
  }
  if (thrown === null || thrown === undefined) {
    return { message: `The script threw ${String(thrown)}` };
  }
  if (typeof thrown === 'symbol') {
    return { message: 'The script threw a symbol' };
  }
  if (typeof thrown !== 'object' && typeof thrown !== 'function') {
    // A number, a boolean or a bigint: its text is the engine's own
    return { message: bounded(`The script threw the ${typeof thrown} ${String(thrown)}`, MAX_THROWN_MESSAGE_LENGTH) };
  }
  const name = stringMember(thrown, 'name', MAX_THROWN_NAME_LENGTH);
  const message = stringMember(thrown, 'message', MAX_THROWN_MESSAGE_LENGTH);
  const stack = stringMember(thrown, 'stack', MAX_THROWN_STACK_LENGTH);
  return {
    ...(name !== undefined ? { name } : {}),
    ...(message !== undefined ? { message } : {}),
    ...(stack !== undefined ? { stack } : {}),
  };
}

/**
 * Whether a thrown value carries the code of the memory-limit error (read once, nothing called).
 * That alone does not make it one: the caller also asks its memory tracker.
 */
export function isMemoryLimitPayload(thrown: unknown): boolean {
  if (thrown === null || (typeof thrown !== 'object' && typeof thrown !== 'function')) return false;
  try {
    return ReflectGet(thrown, 'code') === 'MEMORY_LIMIT_EXCEEDED';
  } catch {
    return false;
  }
}

/** The message for a thrown object or function that has no message of its own. */
export const THROWN_WITHOUT_MESSAGE = 'The script threw a value that is not an error';

/**
 * `result.error` as plain text, whoever built it: `name` and `message` are strings of bounded
 * length, `stack` and `code` are strings or absent. An adapter that is not one of the built-in
 * ones (`sandboxAdapter`) hands back what it likes; this is applied to every result.
 */
export function normalizeErrorText<T extends { name?: unknown; message?: unknown; stack?: unknown; code?: unknown }>(
  error: T,
): T & { name: string; message: string; stack?: string; code?: string } {
  const { name, message, stack, code, ...rest } = error;
  return {
    ...rest,
    name: typeof name === 'string' && name ? bounded(name, MAX_THROWN_NAME_LENGTH) : 'Error',
    message: typeof message === 'string' ? bounded(message, MAX_THROWN_MESSAGE_LENGTH) : THROWN_WITHOUT_MESSAGE,
    ...(typeof stack === 'string' ? { stack: bounded(stack, MAX_THROWN_STACK_LENGTH) } : {}),
    ...(typeof code === 'string' ? { code: bounded(code, MAX_THROWN_NAME_LENGTH) } : {}),
  } as T & { name: string; message: string; stack?: string; code?: string };
}
