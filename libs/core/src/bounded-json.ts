/**
 * JSON text measured as it is written, for the host side of a tool call.
 *
 * A value referenced many times is written as many times, so the JSON text of a small value can
 * be far longer than the value is large, and writing it calls every getter and `toJSON` on the
 * way each time. {@link stringifyWithin} writes the text with `JSON.stringify` and gives up as soon
 * as it would be longer than a limit, so the work done on a value that does not fit is in
 * proportion to the limit. The realms of the sandbox have their own copy of the same rule (the
 * tool bridges and the console).
 *
 * @packageDocumentation
 */

const JSONStringify = JSON.stringify;
const ReflectApply = Reflect.apply;
const ArrayIsArray = Array.isArray;
const StringValueOf = String.prototype.valueOf;
const NumberValueOf = Number.prototype.valueOf;

/** Thrown by {@link stringifyWithin} when the text would be longer than its limit. */
export class JsonTooLargeError extends Error {
  constructor(limit: number) {
    super(`JSON text exceeds ${limit} bytes`);
    this.name = 'JsonTooLargeError';
  }
}

/** Whether a value has the internal slot that a built-in's valueOf reads. */
function hasSlot(valueOf: () => unknown, value: unknown): boolean {
  try {
    ReflectApply(valueOf, value, []);
    return true;
  } catch {
    return false;
  }
}

/**
 * The JSON text of `value`, as `JSON.stringify` writes it, or a {@link JsonTooLargeError} as soon
 * as it would be longer than `limit` bytes. What each member adds is counted as it is written,
 * and the count is a lower bound of its UTF-8 bytes (a code unit is at least one byte, an escape
 * only adds), so a value whose text is within the limit is never given up. Any other error of
 * `JSON.stringify` (a cycle, a BigInt, a getter that throws) is thrown as it is.
 */
export function stringifyWithin(value: unknown, limit: number): string | undefined {
  let bytes = 0;
  let root = true;
  return JSONStringify(value, function (this: unknown, key: string, member: unknown): unknown {
    // A String or Number object is written as what it converts to; converted here, the way
    // JSON.stringify converts it and once, so the count is of what is written.
    if (member !== null && typeof member === 'object') {
      if (hasSlot(StringValueOf, member)) member = String(member);
      else if (hasSlot(NumberValueOf, member)) member = Number(member);
    }
    let added: number;
    switch (typeof member) {
      case 'string':
        added = member.length + 2;
        break;
      case 'number':
        added = Number.isFinite(member) ? String(member).length : 4;
        break;
      case 'boolean':
        added = member ? 4 : 5;
        break;
      case 'object':
      case 'bigint':
        added = member === null ? 4 : 2;
        break;
      default:
        added = 0;
    }
    if (!root) {
      // An element of an array is written, as null if nothing else; a member of an object that
      // is written has its key in front of it.
      if (ArrayIsArray(this)) added = added || 4;
      else if (added > 0) added += key.length + 3;
    }
    root = false;
    bytes += added;
    if (bytes > limit) throw new JsonTooLargeError(limit);
    return member;
  });
}

/** The number of bytes `value` takes in UTF-8. */
export function utf8Length(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}
