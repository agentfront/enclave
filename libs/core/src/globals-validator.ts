/**
 * Globals Validator - Custom Globals Security Validation
 *
 * Validates custom globals passed to the enclave to prevent:
 * - Function injection (closures can leak host scope)
 * - Getter/Setter traps (can execute arbitrary code on access)
 * - Symbol properties (can be used for prototype manipulation)
 * - Deeply nested objects (DoS via recursion)
 * - Dangerous patterns in function source
 * - Host functions hidden in collections: the built-in methods of arrays, Maps and Sets
 *   (forEach, iteration, get) run on the raw host collection and hand its elements straight to
 *   the script, bypassing the global-function gate, so only plain data may live inside them
 * - Opaque containers (promises, WeakMaps, iterators, generators): their contents cannot be
 *   validated, and their built-in methods hand those contents to the script directly
 *
 * @packageDocumentation
 */

import { types } from 'util';

/**
 * Options for globals validation
 */
export interface GlobalsValidationOptions {
  /**
   * Maximum depth of nested objects
   * @default 10
   */
  maxDepth?: number;

  /**
   * Whether to allow functions in globals
   * @default false
   */
  allowFunctions?: boolean;

  /**
   * Whether to allow getter/setter properties
   * @default false
   */
  allowGettersSetters?: boolean;

  /**
   * List of specifically allowed function names (if allowFunctions is false)
   */
  allowedFunctionNames?: string[];
}

/**
 * Patterns that indicate dangerous functions
 * These patterns in function source code suggest the function could be used for attacks
 */
const DANGEROUS_FUNCTION_PATTERNS = [
  /\beval\b/, // eval() calls
  /\bFunction\b/, // Function constructor
  /\brequire\b/, // CommonJS require
  /\bimport\b/, // ES imports
  /\bprocess\b/, // Node.js process
  /\bglobal\b/, // Global object
  /\bglobalThis\b/, // Global this reference
  /\b__dirname\b/, // Directory name
  /\b__filename\b/, // File name
  /\bchild_process\b/, // Child process module
  /\bexecSync\b/, // Synchronous exec
  /\bspawnSync\b/, // Synchronous spawn
];

/**
 * Keys that are dangerous in global objects
 */
const DANGEROUS_GLOBAL_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const MapEntries = Map.prototype.entries;
const SetValues = Set.prototype.values;
const ReflectApply = Reflect.apply;
const ObjectGetPrototypeOf = Object.getPrototypeOf;

/** %IteratorPrototype% and %AsyncIteratorPrototype%: every built-in iterator inherits one of them. */
const IteratorPrototype: object = ObjectGetPrototypeOf(ObjectGetPrototypeOf([][Symbol.iterator]()));
const AsyncIteratorPrototype: object = ObjectGetPrototypeOf(
  ObjectGetPrototypeOf(
    async function* () {
      /* only used to reach %AsyncIteratorPrototype% */
    }.prototype,
  ),
);

/**
 * Containers whose contents cannot be validated and whose built-in methods hand those contents
 * to the script directly (`then`, `next`, `get`). Refused anywhere in globals.
 */
function describeOpaqueContainer(obj: object): string | undefined {
  if (types.isPromise(obj)) return 'a Promise';
  if (types.isWeakMap(obj)) return 'a WeakMap';
  if (types.isGeneratorObject(obj)) return 'a generator';
  if (
    types.isMapIterator(obj) ||
    types.isSetIterator(obj) ||
    Object.prototype.isPrototypeOf.call(IteratorPrototype, obj) ||
    Object.prototype.isPrototypeOf.call(AsyncIteratorPrototype, obj)
  ) {
    return 'an iterator';
  }
  return undefined;
}

/**
 * Objects allowed inside a collection besides arrays, Maps and Sets: plain data only.
 * Anything else carries methods (on its prototype) that the script could call on the raw object.
 */
function isPlainDataObject(obj: object): boolean {
  const proto = ObjectGetPrototypeOf(obj);
  return (
    proto === null ||
    proto === Object.prototype ||
    types.isDate(obj) ||
    types.isRegExp(obj) ||
    types.isArrayBufferView(obj) ||
    types.isAnyArrayBuffer(obj)
  );
}

function describeInstance(obj: object): string {
  try {
    const name = (ObjectGetPrototypeOf(obj) as { constructor?: { name?: unknown } } | null)?.constructor?.name;
    if (typeof name === 'string' && name) return `a ${name} instance`;
  } catch {
    // A hostile prototype keeps the generic description.
  }
  return 'a non-plain object';
}

function collectionError(key: string, what: string, path: string[]): Error {
  return new Error(
    `Custom global "${key}" contains ${what} inside a collection at ${path.join('.') || 'root'}. ` +
      `Only plain data (primitives, plain objects, arrays, Maps, Sets, Dates, RegExps, typed arrays) ` +
      `is allowed inside arrays, Maps and Sets: their built-in methods (forEach, iteration, get) hand ` +
      `elements to the script directly, so a function there would be called without the enclave's ` +
      `global-function gate. Expose functions as properties of a plain object, or as tools.`,
  );
}

/** Path segment for a Map entry's value: `get("key")` for primitive keys, else by position. */
function mapValueSegment(mapKey: unknown, index: number): string {
  if (typeof mapKey === 'string' || typeof mapKey === 'number' || typeof mapKey === 'boolean') {
    return `get(${JSON.stringify(mapKey)})`;
  }
  return `values()[${index}]`;
}

/**
 * Validate a single global value recursively
 *
 * @param key The global key name
 * @param value The value to validate
 * @param options Validation options
 * @param path Current path for error messages
 * @param visited WeakSet to track visited objects (circular reference detection)
 * @param collectionVisited Objects already validated under the collection rule
 * @param inCollection Whether `value` sits inside an array, Map or Set (plain data only)
 * @throws Error if validation fails
 */
export function validateGlobalValue(
  key: string,
  value: unknown,
  options: GlobalsValidationOptions = {},
  path: string[] = [],
  visited: WeakSet<object> = new WeakSet(),
  collectionVisited: WeakSet<object> = new WeakSet(),
  inCollection = false,
): void {
  const maxDepth = options.maxDepth ?? 10;
  const allowFunctions = options.allowFunctions ?? false;
  const allowGettersSetters = options.allowGettersSetters ?? false;
  const allowedFunctionNames = options.allowedFunctionNames ?? [];

  // Check depth limit
  if (path.length > maxDepth) {
    throw new Error(
      `Custom global "${key}" exceeds maximum depth (${maxDepth}). ` +
        `Path: ${path.join('.')}. ` +
        `This limit prevents deeply nested objects that could cause stack overflow.`,
    );
  }

  // Handle null/undefined
  if (value === null || value === undefined) {
    return;
  }

  const type = typeof value;

  // Primitives are always safe
  if (type === 'string' || type === 'number' || type === 'boolean' || type === 'bigint') {
    return;
  }

  // Symbols are not allowed (can be used for prototype manipulation)
  if (type === 'symbol') {
    throw new Error(
      `Custom global "${key}" contains a symbol at ${path.join('.') || 'root'}. ` +
        `Symbols are not allowed in custom globals as they can be used for prototype manipulation.`,
    );
  }

  // Functions need special handling
  if (type === 'function') {
    // Check if this specific function is allowed by name
    const funcName = (value as Function).name || 'anonymous';

    // Never inside a collection: it would reach the script without the global-function gate.
    // (When functions are not allowed at all, the default message below applies.)
    if (inCollection && (allowFunctions || allowedFunctionNames.includes(funcName))) {
      throw collectionError(key, 'a function', path);
    }

    if (allowedFunctionNames.includes(funcName)) {
      return;
    }

    if (!allowFunctions) {
      throw new Error(
        `Custom global "${key}" contains a function at ${path.join('.') || 'root'}. ` +
          `Functions are not allowed by default in custom globals because they can leak host scope via closures. ` +
          `Use allowFunctions: true if you understand the security implications.`,
      );
    }

    // If functions are allowed, check for dangerous patterns
    try {
      const fnSource = String(value);
      for (const pattern of DANGEROUS_FUNCTION_PATTERNS) {
        if (pattern.test(fnSource)) {
          throw new Error(
            `Custom global "${key}" contains a function with dangerous pattern "${pattern.source}" ` +
              `at ${path.join('.') || 'root'}. ` +
              `This function may be able to access host resources.`,
          );
        }
      }
    } catch (e) {
      // If we can't convert to string, that's suspicious
      if ((e as Error).message.includes('dangerous pattern')) {
        throw e;
      }
      // Otherwise allow (some functions can't be stringified)
    }

    return;
  }

  // Handle objects
  if (type === 'object') {
    const obj = value as object;

    // Check for circular references. An object reachable both directly and from inside a
    // collection is validated under both rules, so it is tracked per rule.
    const seen = inCollection ? collectionVisited : visited;
    if (seen.has(obj)) {
      return; // Already validated this object
    }
    seen.add(obj);

    const opaque = describeOpaqueContainer(obj);
    if (opaque) {
      throw new Error(
        `Custom global "${key}" contains ${opaque} at ${path.join('.') || 'root'}. ` +
          `Promises, WeakMaps, iterators and generators are not allowed in custom globals: their ` +
          `contents cannot be validated, and their built-in methods hand those contents to the script directly.`,
      );
    }

    const isArray = Array.isArray(obj);
    const isMap = types.isMap(obj);
    const isSet = types.isSet(obj);

    if (inCollection) {
      if (types.isProxy(obj)) {
        throw collectionError(key, 'a Proxy', path);
      }
      if (!isArray && !isMap && !isSet && !isPlainDataObject(obj)) {
        throw collectionError(key, describeInstance(obj), path);
      }
    }

    // Check for getters/setters
    if (!allowGettersSetters) {
      const descriptors = Object.getOwnPropertyDescriptors(obj);
      for (const [prop, desc] of Object.entries(descriptors)) {
        if (desc.get || desc.set) {
          throw new Error(
            `Custom global "${key}" has a getter/setter at ${[...path, prop].join('.')}. ` +
              `Getters and setters are not allowed because they can execute arbitrary code on property access. ` +
              `Use allowGettersSetters: true if you understand the security implications.`,
          );
        }
      }
    }

    // Maps and Sets: every key, value and element is inside a collection
    if (isMap) {
      let index = 0;
      for (const [mapKey, mapValue] of ReflectApply(MapEntries, obj, []) as IterableIterator<[unknown, unknown]>) {
        validateGlobalValue(key, mapKey, options, [...path, `keys()[${index}]`], visited, collectionVisited, true);
        validateGlobalValue(
          key,
          mapValue,
          options,
          [...path, mapValueSegment(mapKey, index)],
          visited,
          collectionVisited,
          true,
        );
        index++;
      }
    } else if (isSet) {
      let index = 0;
      for (const element of ReflectApply(SetValues, obj, []) as IterableIterator<unknown>) {
        validateGlobalValue(key, element, options, [...path, `values()[${index}]`], visited, collectionVisited, true);
        index++;
      }
    }

    // Own properties: array elements (and any extra array properties) are inside a collection
    const keys = Object.keys(obj);
    for (const prop of keys) {
      // Check for dangerous keys
      if (DANGEROUS_GLOBAL_KEYS.has(prop)) {
        throw new Error(
          `Custom global "${key}" contains dangerous key "${prop}" at ${path.join('.') || 'root'}. ` +
            `Keys like "__proto__", "constructor", and "prototype" are not allowed.`,
        );
      }

      const propValue = (obj as Record<string, unknown>)[prop];
      validateGlobalValue(
        key,
        propValue,
        options,
        [...path, prop],
        visited,
        collectionVisited,
        inCollection || isArray,
      );
    }

    return;
  }

  // Unknown type - probably okay but log warning
  console.warn(`Custom global "${key}" has unknown type "${type}" at ${path.join('.') || 'root'}`);
}

/**
 * Validate all custom globals
 *
 * @param globals Object containing all custom globals
 * @param options Validation options
 * @throws Error if any global fails validation
 *
 * @example
 * ```typescript
 * validateGlobals({
 *   count: 42,
 *   name: 'test',
 *   // data: { fn: () => {} }, // Would throw!
 * });
 * ```
 */
export function validateGlobals(globals: Record<string, unknown>, options: GlobalsValidationOptions = {}): void {
  for (const [key, value] of Object.entries(globals)) {
    validateGlobalValue(key, value, options);
  }
}

/**
 * Check if globals can be safely validated without throwing
 *
 * @param globals Object containing all custom globals
 * @param options Validation options
 * @returns true if validation will succeed, false otherwise
 */
export function canValidateGlobals(globals: Record<string, unknown>, options: GlobalsValidationOptions = {}): boolean {
  try {
    validateGlobals(globals, options);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get validation errors for globals without throwing
 *
 * @param globals Object containing all custom globals
 * @param options Validation options
 * @returns Array of validation error messages, empty if valid
 */
export function getGlobalsValidationErrors(
  globals: Record<string, unknown>,
  options: GlobalsValidationOptions = {},
): string[] {
  const errors: string[] = [];

  for (const [key, value] of Object.entries(globals)) {
    try {
      validateGlobalValue(key, value, options);
    } catch (e) {
      errors.push((e as Error).message);
    }
  }

  return errors;
}
