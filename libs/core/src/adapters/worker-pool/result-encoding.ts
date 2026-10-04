/**
 * Worker Result Encoding
 *
 * Worker messages are JSON (see safe-deserialize), which has no Date, NaN, Infinity or
 * undefined. The worker sends the sanitized script result as JSON plus the list of values JSON
 * would lose, each with its path; the pool puts them back, so a worker result matches what the
 * in-process adapters return.
 *
 * @packageDocumentation
 */

import { MessageValidationError } from './errors';
import { isDangerousKey } from './safe-deserialize';

/** Keys and indices from the result's root to a value. */
export type ResultPath = Array<string | number>;

const SPECIAL_KINDS = new Set(['date', 'nan', 'infinity', '-infinity', 'undefined']);

/** A value JSON cannot carry, sent next to the result and restored on the main thread. */
export interface SpecialResultValue {
  path: ResultPath;
  kind: 'date' | 'nan' | 'infinity' | '-infinity' | 'undefined';
  /** Milliseconds since the epoch for a Date; null for an invalid Date. */
  time?: number | null;
}

/**
 * Split a sanitized result (plain data, no cycles) into JSON data, with `null` in place of each
 * special value, and the list of special values. Keys the transport strips are left out.
 */
export function encodeResult(value: unknown): { value: unknown; specialValues: SpecialResultValue[] } {
  const specialValues: SpecialResultValue[] = [];
  return { value: encodeValue(value, [], specialValues), specialValues };
}

function encodeValue(value: unknown, path: ResultPath, specialValues: SpecialResultValue[]): unknown {
  if (value === undefined) {
    specialValues.push({ path, kind: 'undefined' });
    return null;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    const kind = Number.isNaN(value) ? 'nan' : value > 0 ? 'infinity' : '-infinity';
    specialValues.push({ path, kind });
    return null;
  }
  if (value instanceof Date) {
    const time = value.getTime();
    specialValues.push({ path, kind: 'date', time: Number.isNaN(time) ? null : time });
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => encodeValue(item, [...path, index], specialValues));
  }
  if (value !== null && typeof value === 'object') {
    const encoded: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value)) {
      if (isDangerousKey(key)) continue;
      encoded[key] = encodeValue((value as Record<string, unknown>)[key], [...path, key], specialValues);
    }
    return encoded;
  }
  return value;
}

/**
 * Put the special values back into a deserialized result. Every entry must point at a `null`
 * placeholder inside the result's arrays and plain objects; anything else means the message was
 * not produced by `encodeResult`, and the result is refused.
 */
export function decodeResult(value: unknown, specialValues: unknown): unknown {
  if (specialValues === undefined) {
    return value;
  }
  if (!Array.isArray(specialValues)) {
    throw new MessageValidationError('Worker result special values must be an array');
  }

  let decoded = value;
  for (const special of specialValues) {
    assertSpecialValue(special);
    const restored = restoreSpecialValue(special);
    if (special.path.length === 0) {
      decoded = restored;
      continue;
    }
    const container = resolveContainer(decoded, special.path.slice(0, -1)) as Record<string | number, unknown>;
    const key = special.path[special.path.length - 1];
    if (!container || !Object.hasOwn(container, key) || container[key] !== null) {
      throw new MessageValidationError('Worker result refers to a value it does not contain');
    }
    container[key] = restored;
  }
  return decoded;
}

function assertSpecialValue(special: unknown): asserts special is SpecialResultValue {
  const candidate = special as Partial<SpecialResultValue> | null;
  const validPath =
    Array.isArray(candidate?.path) &&
    candidate.path.every((key) => typeof key === 'string' || (Number.isInteger(key) && key >= 0));
  if (!validPath || !SPECIAL_KINDS.has(candidate?.kind as string)) {
    throw new MessageValidationError('Worker result has an invalid special value');
  }
}

function resolveContainer(root: unknown, path: ResultPath): object | undefined {
  let current = root;
  for (const key of path) {
    if (!isDataContainer(current) || isDangerousKey(String(key)) || !Object.hasOwn(current, key)) {
      return undefined;
    }
    current = (current as Record<string | number, unknown>)[key];
  }
  return isDataContainer(current) ? current : undefined;
}

/** An array or a null-prototype object, the only containers safeDeserialize produces. */
function isDataContainer(value: unknown): value is object {
  return Array.isArray(value) || (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === null);
}

function restoreSpecialValue(special: SpecialResultValue): unknown {
  switch (special.kind) {
    case 'date':
      return new Date(typeof special.time === 'number' ? special.time : NaN);
    case 'nan':
      return NaN;
    case 'infinity':
      return Infinity;
    case '-infinity':
      return -Infinity;
    case 'undefined':
      return undefined;
  }
}
