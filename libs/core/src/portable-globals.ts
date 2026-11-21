/** A bounded copy of host globals for the portable interpreter. */

const MAX_GLOBAL_DEPTH = 10;
const MAX_GLOBAL_PROPERTIES = 10_000;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export function copyPortableGlobals(
  globals: Record<string, unknown> | undefined,
  allowFunctions: boolean,
  maxBytes: number,
): Record<string, unknown> {
  const result = Object.create(null) as Record<string, unknown>;
  if (globals === undefined) return result;
  if (globals === null || typeof globals !== 'object' || Array.isArray(globals)) {
    throw new TypeError('globals must be a record');
  }

  let properties = 0;
  let bytes = 0;
  const active = new Set<object>();
  const charge = (value: string): void => {
    // A JSON escape may use six ASCII bytes for one input code unit.
    bytes += value.length * 6 + 8;
    if (bytes > maxBytes) throw new TypeError('globals exceed the portable bridge size limit');
  };
  const copy = (value: unknown, depth: number): unknown => {
    if (depth > MAX_GLOBAL_DEPTH) throw new TypeError('globals exceed the portable depth limit');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      charge(value);
      return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'object') throw new TypeError('portable globals must contain JSON data only');
    if (active.has(value)) throw new TypeError('portable globals cannot contain cycles');
    const array = Array.isArray(value);
    if (array && (value as unknown[]).length > MAX_GLOBAL_PROPERTIES) {
      throw new TypeError('portable globals exceed the array length limit');
    }
    const prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('portable globals must contain plain records or arrays');
    }
    active.add(value);
    try {
      const destination: unknown = array ? [] : Object.create(null);
      const keys = Reflect.ownKeys(value);
      if (array && keys.length - 1 !== (value as unknown[]).length) {
        throw new TypeError('portable globals cannot contain sparse arrays');
      }
      for (const key of keys) {
        if (typeof key !== 'string') throw new TypeError('portable globals cannot contain symbol properties');
        if (array && key === 'length') continue;
        if (BLOCKED_KEYS.has(key)) throw new TypeError('portable globals contain a blocked property');
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
          throw new TypeError('portable globals cannot contain accessors');
        }
        if (++properties > MAX_GLOBAL_PROPERTIES) throw new TypeError('globals exceed the portable property limit');
        charge(key);
        if (array) {
          const index = Number(key);
          if (!Number.isSafeInteger(index) || index < 0 || String(index) !== key) {
            throw new TypeError('portable global arrays cannot contain named properties');
          }
          (destination as unknown[])[index] = copy(descriptor.value, depth + 1);
        } else {
          (destination as Record<string, unknown>)[key] = copy(descriptor.value, depth + 1);
        }
      }
      return destination;
    } finally {
      active.delete(value);
    }
  };

  for (const key of Reflect.ownKeys(globals)) {
    if (typeof key !== 'string' || !IDENTIFIER.test(key) || BLOCKED_KEYS.has(key) || key.startsWith('__')) {
      throw new TypeError('portable globals contain an invalid name');
    }
    const descriptor = Object.getOwnPropertyDescriptor(globals, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('portable globals cannot contain accessors');
    }
    if (++properties > MAX_GLOBAL_PROPERTIES) throw new TypeError('globals exceed the portable property limit');
    charge(key);
    if (typeof descriptor.value === 'function') {
      if (!allowFunctions) throw new TypeError('portable host functions require allowFunctionsInGlobals');
      result[key] = descriptor.value;
    } else {
      result[key] = copy(descriptor.value, 0);
    }
  }
  return result;
}
