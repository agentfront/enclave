// file: libs/core/src/interpreter/safe-globals.ts
//
// The standard globals AgentScript may name (`Math`, `JSON`, `Object`, `Array`, `String`,
// `Number`, `Date`, ...) as the interpreter provides them.
//
// The interpreter runs a script on objects of the HOST realm, so the real `Object` or `Array`
// cannot be handed out: `Object.getOwnPropertyDescriptor`, `Object.getPrototypeOf` or
// `Object.defineProperty` reach, in one call, everything the interpreter's key rules keep away.
// Each global here is a frozen stand-in that has only the members listed below, each of them a
// function that returns data and changes nothing but data the script owns.

import { createScriptError, isBlockedKey, isScriptData, isScriptError, MAX_ARRAY_LENGTH } from './interpreter';
import { checkSerializedSize } from '../value-sanitizer';

/** The longest text `JSON.stringify` may produce */
const MAX_JSON_TEXT_BYTES = 32 * 1024 * 1024;

/** What {@link createSafeGlobals} returns: the three tables the interpreter is configured with. */
export interface SafeGlobals {
  /** Name to value, for the interpreter's `globals` */
  globals: Record<string, unknown>;
  /** What `new` may be applied to */
  constructors: Map<unknown, (args: unknown[]) => unknown>;
  /** What may stand on the right of `instanceof` */
  instanceChecks: Map<unknown, (value: unknown) => boolean>;
}

function frozenRecord(members: Record<string, unknown>): Record<string, unknown> {
  const record = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(members)) record[key] = members[key];
  return Object.freeze(record);
}

/** A function with static members, frozen: `Number(x)` and `Number.isInteger(x)`. */
function frozenFunction<F extends (...args: never[]) => unknown>(fn: F, members: Record<string, unknown>): F {
  for (const key of Object.keys(members)) {
    Object.defineProperty(fn, key, { value: members[key], enumerable: true });
  }
  return Object.freeze(fn);
}

function tooLong(): never {
  throw new RangeError(`An array cannot be longer than ${MAX_ARRAY_LENGTH} items`);
}

function checkedLength(value: unknown): number {
  const length = Number(value);
  if (!Number.isInteger(length) || length < 0) throw new RangeError('Invalid array length');
  if (length > MAX_ARRAY_LENGTH) tooLong();
  return length;
}

/** The own enumerable string keys of a value a script may use. */
function dataKeys(value: unknown): string[] {
  return Object.keys(value as object).filter((key) => !isBlockedKey(key));
}

// ── Math ─────────────────────────────────────────────────────────────────────
// A copy: `Math` itself is a plain object of the host, which a script could otherwise assign to.
const SafeMath = (() => {
  const members: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(Math)) {
    members[key] = (Math as unknown as Record<string, unknown>)[key];
  }
  return frozenRecord(members);
})();

// ── JSON ─────────────────────────────────────────────────────────────────────
const SafeJSON = frozenRecord({
  parse(text: unknown, reviver?: unknown): unknown {
    // The engine would call a reviver for every value and use what it returns: a promise.
    if (reviver !== undefined) throw new TypeError('JSON.parse does not take a reviver in the sandbox');
    return JSON.parse(String(text));
  },
  stringify(value: unknown, replacer?: unknown, space?: unknown): string | undefined {
    if (typeof replacer === 'function') {
      throw new TypeError('JSON.stringify does not take a replacer function in the sandbox');
    }
    // A value that holds one large string many times is small in memory and huge as text.
    const size = checkSerializedSize(value, MAX_JSON_TEXT_BYTES);
    if (!size.ok) throw new RangeError(`JSON.stringify: the text would be too large (${size.error})`);
    return JSON.stringify(
      value,
      Array.isArray(replacer) ? (replacer as Array<string | number>) : undefined,
      space as string | number | undefined,
    );
  },
});

// ── Object ───────────────────────────────────────────────────────────────────
const SafeObject = frozenRecord({
  keys: (value: unknown): string[] => dataKeys(value),
  values: (value: unknown): unknown[] => dataKeys(value).map((key) => (value as Record<string, unknown>)[key]),
  entries: (value: unknown): Array<[string, unknown]> =>
    dataKeys(value).map((key) => [key, (value as Record<string, unknown>)[key]]),
  fromEntries(entries: unknown): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    let count = 0;
    for (const entry of entries as Iterable<unknown>) {
      if (++count > MAX_ARRAY_LENGTH) tooLong();
      if (entry === null || typeof entry !== 'object') throw new TypeError('Each entry must be a [key, value] pair');
      const key = String((entry as Record<number, unknown>)[0]);
      if (!isBlockedKey(key)) result[key] = (entry as Record<number, unknown>)[1];
    }
    return result;
  },
  assign(target: unknown, ...sources: unknown[]): unknown {
    // Only data the script owns is written to; a global, a function or a date is not.
    if (!isScriptData(target) || Object.isFrozen(target)) {
      throw new TypeError('Object.assign needs an object or array the script created as its target');
    }
    for (const source of sources) {
      if (source === null || source === undefined) continue;
      for (const key of dataKeys(source)) {
        (target as Record<string, unknown>)[key] = (source as Record<string, unknown>)[key];
      }
    }
    return target;
  },
  freeze: (value: unknown): unknown => (isScriptData(value) ? Object.freeze(value) : value),
  isFrozen: (value: unknown): boolean => Object.isFrozen(value),
  is: (left: unknown, right: unknown): boolean => Object.is(left, right),
  hasOwn(value: unknown, key: unknown): boolean {
    const name = String(key);
    return !isBlockedKey(name) && Object.prototype.hasOwnProperty.call(Object(value), name);
  },
});

// ── Array ────────────────────────────────────────────────────────────────────
function makeArray(args: unknown[]): unknown[] {
  // `Array(3)` is three holes; `Array(1, 2)` is `[1, 2]`.
  if (args.length === 1 && typeof args[0] === 'number') return new Array(checkedLength(args[0]));
  return [...args];
}

const SafeArray = frozenFunction((...args: unknown[]): unknown[] => makeArray(args), {
  isArray: (value: unknown): boolean => Array.isArray(value),
  of: (...items: unknown[]): unknown[] => [...items],
  from(source: unknown, map?: unknown): unknown[] {
    // The engine would call the function for every item and keep the promise it returns.
    if (map !== undefined) throw new TypeError('Array.from does not take a function in the sandbox');
    if (source === null || source === undefined) throw new TypeError('Array.from needs a value');
    const result: unknown[] = [];
    if (typeof (source as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function') {
      for (const item of source as Iterable<unknown>) {
        if (result.length >= MAX_ARRAY_LENGTH) tooLong();
        result.push(item);
      }
      return result;
    }
    // An array-like: `{ length: n }`
    const length = checkedLength((source as { length?: unknown }).length ?? 0);
    for (let index = 0; index < length; index++) result.push((source as Record<number, unknown>)[index]);
    return result;
  },
});

// ── String ───────────────────────────────────────────────────────────────────
function toStringValue(value: unknown): string {
  // The text of a function is the interpreter's own code, not the script's.
  return typeof value === 'function' ? 'function () { [sandboxed code] }' : String(value);
}

const SafeString = frozenFunction((...args: unknown[]): string => (args.length === 0 ? '' : toStringValue(args[0])), {
  fromCharCode: (...codes: unknown[]): string => String.fromCharCode(...(codes as number[])),
  fromCodePoint: (...codes: unknown[]): string => String.fromCodePoint(...(codes as number[])),
});

// ── Number ───────────────────────────────────────────────────────────────────
const SafeNumber = frozenFunction((...args: unknown[]): number => (args.length === 0 ? 0 : Number(args[0])), {
  isFinite: (value: unknown): boolean => Number.isFinite(value),
  isInteger: (value: unknown): boolean => Number.isInteger(value),
  isNaN: (value: unknown): boolean => Number.isNaN(value),
  isSafeInteger: (value: unknown): boolean => Number.isSafeInteger(value),
  parseFloat: (value: unknown): number => Number.parseFloat(String(value)),
  parseInt: (value: unknown, radix?: unknown): number => Number.parseInt(String(value), radix as number | undefined),
  EPSILON: Number.EPSILON,
  MAX_SAFE_INTEGER: Number.MAX_SAFE_INTEGER,
  MIN_SAFE_INTEGER: Number.MIN_SAFE_INTEGER,
  MAX_VALUE: Number.MAX_VALUE,
  MIN_VALUE: Number.MIN_VALUE,
  POSITIVE_INFINITY: Number.POSITIVE_INFINITY,
  NEGATIVE_INFINITY: Number.NEGATIVE_INFINITY,
  NaN: Number.NaN,
});

// ── Date ─────────────────────────────────────────────────────────────────────
function makeDate(args: unknown[]): Date {
  // A `Date` object is the host's, which is fine: its methods read and set its own time value.
  if (args.length === 0) return new Date();
  if (args.length === 1) return new Date(args[0] as number | string);
  return new Date(...(args as [number, number]));
}

const SafeDate = frozenFunction((): string => new Date().toString(), {
  now: (): number => Date.now(),
  parse: (text: unknown): number => Date.parse(String(text)),
  UTC: (...parts: unknown[]): number => Date.UTC(...(parts as [number])),
});

// ── Errors ───────────────────────────────────────────────────────────────────
// `new Error('x')` makes the frozen error object of the interpreter, never a host Error (which
// would carry a host stack). The transformer renames the error types it does not know, so each
// is provided under its own name and under its `__safe_` name.
const ERROR_TYPES = ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError'];

interface ErrorType {
  facade: (...args: unknown[]) => object;
  make: (args: unknown[]) => object;
  isInstance: (value: unknown) => boolean;
}

function errorType(name: string): ErrorType {
  const make = (args: unknown[]): object =>
    createScriptError(name, args.length === 0 || args[0] === undefined ? '' : toStringValue(args[0]));
  return {
    facade: frozenFunction((...args: unknown[]): object => make(args), {}),
    make,
    // Every error is an `Error`; the other types are told apart by their name.
    isInstance: (value) => isScriptError(value) && (name === 'Error' || (value as { name?: unknown }).name === name),
  };
}

const SAFE_ERRORS: ReadonlyArray<[string, ErrorType]> = ERROR_TYPES.map((name) => [name, errorType(name)]);

const SAFE_GLOBALS: Readonly<Record<string, unknown>> = Object.freeze({
  Math: SafeMath,
  JSON: SafeJSON,
  Object: SafeObject,
  Array: SafeArray,
  String: SafeString,
  Number: SafeNumber,
  Date: SafeDate,
  ...Object.fromEntries(SAFE_ERRORS.map(([name, type]) => [name, type.facade])),
  ...Object.fromEntries(SAFE_ERRORS.map(([name, type]) => [`__safe_${name}`, type.facade])),
  NaN: Number.NaN,
  Infinity: Number.POSITIVE_INFINITY,
  undefined: undefined,
  isNaN: Object.freeze((value: unknown): boolean => Number.isNaN(Number(value))),
  isFinite: Object.freeze((value: unknown): boolean => Number.isFinite(Number(value))),
  parseFloat: Object.freeze((value: unknown): number => Number.parseFloat(String(value))),
  parseInt: Object.freeze((value: unknown, radix?: unknown): number =>
    Number.parseInt(String(value), radix as number | undefined),
  ),
  encodeURI: Object.freeze((value: unknown): string => encodeURI(String(value))),
  encodeURIComponent: Object.freeze((value: unknown): string => encodeURIComponent(String(value))),
  decodeURI: Object.freeze((value: unknown): string => decodeURI(String(value))),
  decodeURIComponent: Object.freeze((value: unknown): string => decodeURIComponent(String(value))),
});

/**
 * The standard globals for one interpreter. The values are shared between interpreters: all of
 * them are frozen and none of them keeps state.
 */
export function createSafeGlobals(): SafeGlobals {
  return {
    globals: { ...SAFE_GLOBALS },
    constructors: new Map<unknown, (args: unknown[]) => unknown>([
      [SafeDate, makeDate],
      [SafeArray, makeArray],
      ...SAFE_ERRORS.map(([, type]): [unknown, (args: unknown[]) => unknown] => [type.facade, type.make]),
    ]),
    instanceChecks: new Map<unknown, (value: unknown) => boolean>([
      [SafeDate, (value) => value instanceof Date],
      [SafeArray, (value) => Array.isArray(value)],
      [SafeObject, (value) => (typeof value === 'object' && value !== null) || typeof value === 'function'],
      ...SAFE_ERRORS.map(([, type]): [unknown, (value: unknown) => boolean] => [type.facade, type.isInstance]),
    ]),
  };
}
