/**
 * Safe JSON Deserialization
 *
 * Provides prototype-pollution-safe JSON parsing for worker messages.
 * All messages are JSON-serialized (not structured clone) to prevent attacks.
 *
 * @packageDocumentation
 */

import { MessageValidationError, MessageSizeError } from './errors';

/**
 * Captured host intrinsics.
 *
 * SECURITY (same class as GHSA-6mpw-63xj-mghh): `sanitizeObject` runs on values crossing the
 * worker/sandbox boundary (e.g. `worker-script` sanitizes the live execution result with it).
 * That value may be an attacker-controlled `Proxy`, so we must never invoke a method *looked
 * up on it* — `value.map(cb)` would hand our host callback to a `.map` trap, which can reach
 * `cb.constructor` (host `Function`) for RCE. Enumerate arrays by index via `Reflect.get`
 * instead, using the genuine builtins captured once here in the trusted realm.
 */
const ReflectGet = Reflect.get;
const ArrayIsArray = Array.isArray;
const NumberIsFinite = Number.isFinite;
const MathFloor = Math.floor;

/**
 * Hard cap on the number of elements copied from a single untrusted array. An attacker Proxy
 * can report an enormous `length` (e.g. 1e9) with cheap index traps; without this bound the
 * copy loop below would iterate/allocate unboundedly (DoS). Legitimate deserialized data is
 * far below this limit (and further bounded by the message size limit).
 */
const MAX_ARRAY_LENGTH = 1_000_000;

/**
 * Copy an array-like untrusted value into a fresh host array without invoking any method on
 * it. Length is read once via Reflect.get; a non-numeric/negative length yields an empty
 * array (never coerced, which could run attacker code). Lengths exceeding MAX_ARRAY_LENGTH
 * are rejected before any allocation.
 */
function mapArraySafely(value: unknown, sanitizeItem: (item: unknown) => unknown): unknown[] {
  const rawLen = ReflectGet(value as object, 'length');
  const len = typeof rawLen === 'number' && NumberIsFinite(rawLen) && rawLen >= 0 ? MathFloor(rawLen) : 0;
  if (len > MAX_ARRAY_LENGTH) {
    throw new MessageValidationError(`Array exceeds maximum length of ${MAX_ARRAY_LENGTH}`);
  }
  const out: unknown[] = [];
  for (let i = 0; i < len; i++) {
    let item: unknown;
    try {
      item = ReflectGet(value as object, i);
    } catch {
      item = undefined;
    }
    out[i] = sanitizeItem(item);
  }
  return out;
}

/**
 * Keys that are dangerous to include in deserialized objects
 */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Maximum nesting depth for deserialized objects
 */
const MAX_DEPTH = 50;

/**
 * Safely deserialize a JSON string
 *
 * Security measures:
 * - Strips __proto__, constructor, prototype keys
 * - Creates null-prototype objects to prevent prototype chain attacks
 * - Enforces maximum nesting depth
 * - Enforces maximum message size
 *
 * Note: We parse first, then sanitize recursively. This ensures proper depth
 * tracking (the JSON.parse reviver processes bottom-up which makes depth
 * tracking unreliable).
 *
 * @param raw - Raw JSON string
 * @param maxSizeBytes - Maximum allowed message size (optional)
 * @returns Deserialized value
 * @throws MessageSizeError if message exceeds size limit
 * @throws MessageValidationError if JSON is invalid
 */
export function safeDeserialize(raw: string, maxSizeBytes?: number): unknown {
  // Check size limit (use actual byte length, not character count)
  if (maxSizeBytes !== undefined) {
    const byteLength = Buffer.byteLength(raw, 'utf-8');
    if (byteLength > maxSizeBytes) {
      throw new MessageSizeError(byteLength, maxSizeBytes);
    }
  }

  try {
    const parsed = JSON.parse(raw);
    // Use sanitizeObject for proper recursive depth tracking
    return sanitizeObjectWithDepthCheck(parsed, 0);
  } catch (error) {
    if (error instanceof MessageValidationError || error instanceof MessageSizeError) {
      throw error;
    }
    throw new MessageValidationError('Invalid JSON');
  }
}

/**
 * Internal sanitization with depth checking that throws on exceeded depth
 */
function sanitizeObjectWithDepthCheck(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) {
    throw new MessageValidationError(`Message exceeds maximum depth of ${MAX_DEPTH}`);
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (ArrayIsArray(value)) {
    return mapArraySafely(value, (item) => sanitizeObjectWithDepthCheck(item, depth + 1));
  }

  // Create a null-prototype object
  const result = Object.create(null);

  for (const key of Object.keys(value as object)) {
    if (!DANGEROUS_KEYS.has(key)) {
      result[key] = sanitizeObjectWithDepthCheck((value as Record<string, unknown>)[key], depth + 1);
    }
  }

  return result;
}

/**
 * Safely serialize a value to JSON
 *
 * Strips dangerous keys before serialization.
 *
 * @param value - Value to serialize
 * @returns JSON string
 */
export function safeSerialize(value: unknown): string {
  return JSON.stringify(value, (key, val) => {
    // Strip dangerous keys
    if (DANGEROUS_KEYS.has(key)) {
      return undefined;
    }
    return val;
  });
}

/**
 * Check if a key is dangerous (would cause prototype pollution)
 */
export function isDangerousKey(key: string): boolean {
  return DANGEROUS_KEYS.has(key);
}

/**
 * Sanitize an object by removing dangerous keys recursively
 * Used for tool call arguments and results
 *
 * @param value - Value to sanitize
 * @param depth - Current recursion depth (internal)
 * @returns Sanitized value
 */
export function sanitizeObject(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) {
    return undefined;
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (ArrayIsArray(value)) {
    return mapArraySafely(value, (item) => sanitizeObject(item, depth + 1));
  }

  // Create a null-prototype object
  const result = Object.create(null);

  for (const key of Object.keys(value as object)) {
    if (!DANGEROUS_KEYS.has(key)) {
      result[key] = sanitizeObject((value as Record<string, unknown>)[key], depth + 1);
    }
  }

  return result;
}
