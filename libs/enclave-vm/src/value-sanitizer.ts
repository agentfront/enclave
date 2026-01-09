/**
 * Value Sanitizer - Tool Handler Return Value Security
 *
 * Sanitizes values returned from tool handlers to prevent:
 * - Function injection (return values containing executable functions)
 * - Symbol injection (symbols can be used for prototype manipulation)
 * - Prototype pollution (__proto__, constructor keys)
 * - Deeply nested objects (DoS via recursion)
 * - Large object graphs (DoS via memory exhaustion)
 *
 * @packageDocumentation
 */

/**
 * Options for value sanitization
 */
export interface SanitizeOptions {
  /**
   * Maximum depth of nested objects/arrays
   * @default 20
   */
  maxDepth?: number;

  /**
   * Maximum total number of properties across all nested objects
   * @default 10000
   */
  maxProperties?: number;

  /**
   * Whether to allow Date objects (converted to ISO strings if false)
   * @default true
   */
  allowDates?: boolean;

  /**
   * Whether to allow Error objects (converted to plain objects)
   * @default true
   */
  allowErrors?: boolean;
}

/**
 * Keys that are stripped from sanitized objects for security
 * - __proto__: Prototype pollution vector
 * - constructor: Constructor chain escape vector
 */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor']);

/**
 * Property counter for tracking total properties across recursive calls
 */
interface PropertyCounter {
  count: number;
}

/**
 * Internal context for tracking visited objects (circular reference detection)
 */
interface SanitizeContext {
  propCount: PropertyCounter;
  visited: WeakSet<object>;
}

/**
 * Sanitize a value returned from a tool handler
 *
 * Security features:
 * - Strips functions (prevent code injection)
 * - Strips symbols (prevent prototype manipulation)
 * - Removes __proto__ and constructor keys (prevent prototype pollution)
 * - Creates null-prototype objects (prevent prototype chain attacks)
 * - Enforces max depth (prevent DoS via deep recursion)
 * - Enforces max properties (prevent DoS via memory exhaustion)
 *
 * @param value The value to sanitize
 * @param options Sanitization options
 * @param depth Current recursion depth (internal)
 * @param propCount Property counter (internal)
 * @returns Sanitized value safe for sandbox use
 * @throws Error if value contains functions, symbols, or exceeds limits
 *
 * @example
 * ```typescript
 * const toolResult = await toolHandler('getData', {});
 * const safeResult = sanitizeValue(toolResult);
 * ```
 */
export function sanitizeValue(
  value: unknown,
  options: SanitizeOptions = {},
  depth = 0,
  context: SanitizeContext = { propCount: { count: 0 }, visited: new WeakSet() },
): unknown {
  const maxDepth = options.maxDepth ?? 20;
  const maxProperties = options.maxProperties ?? 10000;
  const allowDates = options.allowDates ?? true;
  const allowErrors = options.allowErrors ?? true;

  // Check depth limit
  if (depth > maxDepth) {
    throw new Error(
      `Tool handler return value exceeds maximum depth (${maxDepth}). ` +
        `This limit prevents deeply nested objects that could cause stack overflow.`,
    );
  }

  // Check property count limit
  if (context.propCount.count > maxProperties) {
    throw new Error(
      `Tool handler return value exceeds maximum properties (${maxProperties}). ` +
        `This limit prevents memory exhaustion from large object graphs.`,
    );
  }

  // Handle null/undefined
  if (value === null || value === undefined) {
    return value;
  }

  const type = typeof value;

  // Primitives are safe (including BigInt - caller is responsible for serialization)
  if (type === 'string' || type === 'number' || type === 'boolean' || type === 'bigint') {
    return value;
  }

  // Functions are NOT safe - prevent code injection
  if (type === 'function') {
    throw new Error(
      'Tool handler returned a function. Functions cannot be returned to sandbox code ' +
        'as they could be used for code injection or host scope access.',
    );
  }

  // Symbols are NOT safe - prevent prototype manipulation
  if (type === 'symbol') {
    throw new Error(
      'Tool handler returned a symbol. Symbols cannot be returned to sandbox code ' +
        'as they could be used for prototype manipulation.',
    );
  }

  // Check for circular references (only for objects)
  if (type === 'object' && value !== null) {
    if (context.visited.has(value as object)) {
      // Return a marker for circular references instead of infinite recursion
      return '[Circular]';
    }
    context.visited.add(value as object);
  }

  // Handle arrays
  if (Array.isArray(value)) {
    context.propCount.count += value.length;
    if (context.propCount.count > maxProperties) {
      throw new Error(`Tool handler return value exceeds maximum properties (${maxProperties}).`);
    }
    return value.map((item) => sanitizeValue(item, options, depth + 1, context));
  }

  // Handle Date objects
  if (value instanceof Date) {
    if (allowDates) {
      // Return a new Date to prevent reference sharing
      return new Date(value.getTime());
    }
    // Convert to ISO string if dates not allowed
    return value.toISOString();
  }

  // Handle Error objects
  if (value instanceof Error) {
    if (allowErrors) {
      // Convert to plain object with safe properties only
      return {
        name: value.name,
        message: value.message,
        // Do NOT include stack trace - could leak host information
      };
    }
    return { error: value.message };
  }

  // Handle RegExp objects (convert to string)
  if (value instanceof RegExp) {
    return value.toString();
  }

  // Handle Map objects
  if (value instanceof Map) {
    const sanitizedMap: Record<string, unknown> = Object.create(null);
    for (const [key, val] of value.entries()) {
      if (typeof key !== 'string') continue; // Only string keys
      if (DANGEROUS_KEYS.has(key)) continue; // Skip dangerous keys
      context.propCount.count++;
      sanitizedMap[key] = sanitizeValue(val, options, depth + 1, context);
    }
    return sanitizedMap;
  }

  // Handle Set objects (convert to array)
  if (value instanceof Set) {
    const arr = Array.from(value);
    context.propCount.count += arr.length;
    return arr.map((item) => sanitizeValue(item, options, depth + 1, context));
  }

  // Handle plain objects
  if (type === 'object') {
    // Create null-prototype object to prevent prototype chain attacks
    const sanitized: Record<string, unknown> = Object.create(null);

    // Get own enumerable string keys only
    const keys = Object.keys(value as Record<string, unknown>);
    context.propCount.count += keys.length;

    if (context.propCount.count > maxProperties) {
      throw new Error(`Tool handler return value exceeds maximum properties (${maxProperties}).`);
    }

    for (const key of keys) {
      // Skip dangerous keys
      if (DANGEROUS_KEYS.has(key)) {
        continue;
      }

      // Try to access the property (may throw if getter trap)
      let propValue: unknown;
      try {
        propValue = (value as Record<string, unknown>)[key];
      } catch {
        // Skip properties that throw on access (likely getter traps)
        continue;
      }

      // Recursively sanitize - DO NOT catch these errors, let them propagate
      sanitized[key] = sanitizeValue(propValue, options, depth + 1, context);
    }

    return sanitized;
  }

  // Unknown type - convert to string
  return String(value);
}

/**
 * Check if a value can be safely sanitized without throwing
 *
 * @param value Value to check
 * @param options Sanitization options
 * @returns true if sanitization will succeed, false otherwise
 */
export function canSanitize(value: unknown, options: SanitizeOptions = {}): boolean {
  try {
    sanitizeValue(value, options);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sanitize value with fallback on error
 *
 * @param value Value to sanitize
 * @param fallback Fallback value if sanitization fails
 * @param options Sanitization options
 * @returns Sanitized value or fallback
 */
export function sanitizeValueOrFallback<T>(value: unknown, fallback: T, options: SanitizeOptions = {}): unknown | T {
  try {
    return sanitizeValue(value, options);
  } catch {
    return fallback;
  }
}

/**
 * Estimate the serialized (JSON) size of a string in bytes.
 * Accounts for quotes and proper JSON escaping.
 *
 * @param str The string to estimate
 * @returns Size in bytes when serialized as JSON string
 */
function estimateStringSize(str: string): number {
  let bytes = 2; // quotes
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 128) {
      // ASCII: check if needs escaping
      if (code === 34 || code === 92) {
        // Quote and backslash: 2-byte escape (\" or \\)
        bytes += 2;
      } else if (code < 32) {
        // Control characters: 6-byte \uXXXX escape
        bytes += 6;
      } else {
        bytes += 1;
      }
    } else if (code < 2048) {
      bytes += 2; // 2-byte UTF-8
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      // High surrogate - check for low surrogate pair (emoji, supplementary chars)
      const nextCode = str.charCodeAt(i + 1);
      if (nextCode >= 0xdc00 && nextCode <= 0xdfff) {
        bytes += 4; // 4-byte UTF-8 for surrogate pair
        i++; // Skip the low surrogate
      } else {
        bytes += 3; // Unpaired high surrogate (3-byte UTF-8)
      }
    } else {
      bytes += 3; // 3-byte UTF-8 (BMP characters U+0800 to U+FFFF)
    }
  }
  return bytes;
}

/**
 * Estimates the serialized (JSON) size of a value in bytes.
 *
 * Security feature: Prevents memory exhaustion attacks (Vector 340) where:
 * - Attacker creates a structure with many references to the same large string
 * - In-VM memory is small (strings are shared by reference)
 * - But JSON serialization expands each reference to full string copy
 * - Example: 500 refs × 5 copies × 10KB string = 25MB serialized from ~20KB in-memory
 *
 * This function counts EVERY string occurrence, not unique strings,
 * to accurately estimate the serialized output size.
 *
 * IMPORTANT: Circular reference handling:
 * - Uses a "current path" Set to detect circular references (ancestor chain)
 * - Repeated (non-circular) references to the same object are counted fully each time
 * - This matches JSON.stringify behavior where repeated refs are serialized multiple times
 *
 * @param value The value to estimate
 * @param maxBytes Maximum allowed serialized bytes (0 = no limit)
 * @param depth Current recursion depth (internal)
 * @param maxDepth Maximum recursion depth (default 2000 to handle deep structures)
 * @param currentPath Set tracking the current ancestor path (for circular detection only)
 * @returns Estimated serialized size in bytes
 * @throws Error if estimated size exceeds maxBytes or depth limit
 */
export function estimateSerializedSize(
  value: unknown,
  maxBytes = 0,
  depth = 0,
  maxDepth = 2000,
  currentPath: Set<object> = new Set(),
): number {
  // Depth limit to prevent stack overflow
  if (depth > maxDepth) {
    // For very deep structures, we estimate conservatively rather than failing
    return 20; // Estimate a small object placeholder
  }

  // Handle null/undefined
  if (value === null) return 4; // "null"
  if (value === undefined) return 0; // undefined is omitted in JSON

  const type = typeof value;

  // String: count actual bytes (each occurrence, not unique!)
  if (type === 'string') {
    const bytes = estimateStringSize(value as string);
    if (maxBytes > 0 && bytes > maxBytes) {
      throw new Error(`String serialization would exceed limit: ${bytes} > ${maxBytes} bytes`);
    }
    return bytes;
  }

  // Number: estimate digit count
  if (type === 'number') {
    const num = value as number;
    if (!Number.isFinite(num)) return 4; // "null" for Infinity/NaN
    return String(num).length;
  }

  // Boolean
  if (type === 'boolean') {
    return value ? 4 : 5; // "true" or "false"
  }

  // BigInt: Cannot be JSON.stringify'd directly, but estimate as string for size purposes
  // (caller is responsible for actual serialization, e.g., converting to string first)
  if (type === 'bigint') {
    return String(value).length + 2; // Estimate as quoted string
  }

  // Function/Symbol: shouldn't be serialized
  if (type === 'function' || type === 'symbol') {
    return 0; // omitted in JSON
  }

  // Arrays
  if (Array.isArray(value)) {
    // Check for circular reference (is this object an ancestor of itself?)
    if (currentPath.has(value)) {
      // Circular reference detected - JSON.stringify would throw, but we estimate small
      return 4;
    }

    // Add to current path for descendant checks
    currentPath.add(value);

    let size = 2; // brackets []
    for (let i = 0; i < value.length; i++) {
      if (i > 0) size += 1; // comma
      const elementSize = estimateSerializedSize(value[i], 0, depth + 1, maxDepth, currentPath);
      size += elementSize;

      // Check limit incrementally to fail fast
      if (maxBytes > 0 && size > maxBytes) {
        currentPath.delete(value); // Clean up before throwing
        throw new Error(
          `Array serialization would exceed limit: estimated ${size}+ > ${maxBytes} bytes. ` +
            `This often indicates repeated references to large strings that expand during JSON serialization.`,
        );
      }
    }

    // Remove from current path (we're done with this branch)
    currentPath.delete(value);
    return size;
  }

  // Objects
  if (type === 'object' && value !== null) {
    // Check for circular reference (is this object an ancestor of itself?)
    if (currentPath.has(value as object)) {
      // Circular reference detected
      return 4;
    }

    // Add to current path for descendant checks
    currentPath.add(value as object);

    // Handle special objects
    if (value instanceof Date) {
      currentPath.delete(value as object);
      return 26; // ISO date string with quotes: "2024-01-01T00:00:00.000Z"
    }
    if (value instanceof RegExp) {
      // RegExp serializes to "{}" in JSON.stringify
      currentPath.delete(value as object);
      return 2; // "{}"
    }

    let size = 2; // braces {}
    const keys = Object.keys(value as Record<string, unknown>);
    let first = true;

    for (const key of keys) {
      // Skip dangerous keys (they're stripped)
      if (key === '__proto__' || key === 'constructor') continue;

      if (!first) size += 1; // comma
      first = false;

      // Key: quoted string + colon (accounting for JSON escaping)
      size += estimateStringSize(key) + 1; // "key":

      // Value
      let propValue: unknown;
      try {
        propValue = (value as Record<string, unknown>)[key];
      } catch {
        continue; // Skip throwing properties
      }

      const valueSize = estimateSerializedSize(propValue, 0, depth + 1, maxDepth, currentPath);
      size += valueSize;

      // Check limit incrementally to fail fast
      if (maxBytes > 0 && size > maxBytes) {
        currentPath.delete(value as object); // Clean up before throwing
        throw new Error(
          `Object serialization would exceed limit: estimated ${size}+ > ${maxBytes} bytes. ` +
            `This often indicates repeated references to large strings that expand during JSON serialization.`,
        );
      }
    }

    // Remove from current path (we're done with this branch)
    currentPath.delete(value as object);
    return size;
  }

  return 0;
}

/**
 * Check if a value's serialized size is within limits
 *
 * @param value Value to check
 * @param maxBytes Maximum allowed serialized bytes
 * @returns Object with ok status and estimated size or error message
 */
export function checkSerializedSize(
  value: unknown,
  maxBytes: number,
): { ok: true; estimatedBytes: number } | { ok: false; error: string } {
  try {
    const estimatedBytes = estimateSerializedSize(value, maxBytes);
    return { ok: true, estimatedBytes };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}
