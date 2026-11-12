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

import {
  assertArrayTextWithinLimit,
  assertStorable,
  chargedBeforeCall,
  checkArrayWrite,
  convertsArguments,
  convertsBeforeCall,
  createScriptError,
  isBlockedKey,
  isScriptData,
  isScriptError,
  MAX_ARRAY_LENGTH,
  MAX_JOIN_LENGTH,
  takesArraysAsData,
} from './interpreter';
import { checkSerializedSize } from '../value-sanitizer';

/** The longest text `JSON.stringify` may produce */
const MAX_JSON_TEXT_BYTES = 32 * 1024 * 1024;

/** `JSON.stringify` indents by at most this many spaces or chars per level, whatever `space` says */
const MAX_JSON_INDENT = 10;

/**
 * The bytes an indentation of `indent` bytes per level adds to the JSON text of `value`: for every array item and
 * object member a line break and its indent, for a member the space after its colon, and for
 * every array or object that is not empty the line of its closing bracket. Counted the way the
 * text is written (a value that is reached twice is written twice); stops once past `limit`.
 */
function indentationSize(value: unknown, indent: number, limit: number, depth: number, path: Set<object>): number {
  if (value === null || typeof value !== 'object' || path.has(value)) return 0;
  const isArray = Array.isArray(value);
  const keys = isArray ? undefined : Object.keys(value);
  const count = isArray ? (value as unknown[]).length : (keys as string[]).length;
  if (count === 0) return 0;

  let size = count * (1 + indent * (depth + 1) + (isArray ? 0 : 1)) + 1 + indent * depth;
  path.add(value);
  for (let index = 0; index < count && size <= limit; index++) {
    const item: unknown = isArray
      ? (value as unknown[])[index]
      : (value as Record<string, unknown>)[(keys as string[])[index]];
    size += indentationSize(item, indent, limit - size, depth + 1, path);
  }
  path.delete(value);
  return size;
}

/** The length of a text in UTF-8 bytes, the unit the size limit of a JSON text is in. */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * How many bytes `JSON.stringify` indents by, per level, for this `space` argument: that many
 * spaces for a number, the first ten chars of a text. A text need not be spaces, and a char of
 * it can take up to three bytes.
 */
function indentOf(space: unknown): number {
  if (typeof space === 'number') return Math.max(0, Math.min(MAX_JSON_INDENT, Math.floor(space) || 0));
  if (typeof space === 'string') return utf8Length(space.slice(0, MAX_JSON_INDENT));
  return 0;
}

/**
 * What the values `JSON.parse` makes of `text` cost, in the interpreter's units (two bytes a
 * char, eight an array item, sixteen an object member): every item and member takes at least one
 * of the chars counted here. A char inside a string is counted too, which only adds.
 */
function parsedJsonCost(text: string): number {
  let structural = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    // , : [ {
    if (code === 44 || code === 58 || code === 91 || code === 123) structural++;
  }
  return text.length * 2 + structural * 16;
}

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
    // What the text becomes is charged to the budget before this runs (parsedJsonCost).
    return JSON.parse(String(text));
  },
  stringify(value: unknown, replacer?: unknown, space?: unknown): string | undefined {
    if (typeof replacer === 'function') {
      throw new TypeError('JSON.stringify does not take a replacer function in the sandbox');
    }
    // A value that holds one large string many times is small in memory and huge as text.
    const size = checkSerializedSize(value, MAX_JSON_TEXT_BYTES);
    if (!size.ok) throw new RangeError(`JSON.stringify: the text would be too large (${size.error})`);
    // With `space` every item and member gets a line of its own, indented by its depth: text
    // the estimate above does not count. Only a number or a text is an indentation here: the
    // engine is given what was measured, and nothing else it would read an indentation from.
    const indentation = typeof space === 'number' || typeof space === 'string' ? space : undefined;
    const indent = indentOf(indentation);
    if (indent > 0) {
      const budget = MAX_JSON_TEXT_BYTES - size.estimatedBytes;
      if (indentationSize(value, indent, budget, 0, new Set()) > budget) {
        throw new RangeError('JSON.stringify: the text would be too large with this indentation');
      }
    }
    return JSON.stringify(
      value,
      Array.isArray(replacer) ? (replacer as Array<string | number>) : undefined,
      indentation,
    );
  },
});

// The engine builds the whole value in one step: the budget is asked first, from the text. The
// text is converted once, so that the text the budget was asked for is the text that is parsed.
convertsBeforeCall(SafeJSON['parse'] as object, (args) =>
  args.length === 0 ? args : [String(args[0]), ...args.slice(1)],
);
chargedBeforeCall(SafeJSON['parse'] as object, (args) => parsedJsonCost(String(args[0])));
// The value is data to `stringify` (measured above); it never converts an array to text itself.
takesArraysAsData(SafeJSON['stringify'] as object);

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
      assertArrayTextWithinLimit((entry as Record<number, unknown>)[0]);
      const key = String((entry as Record<number, unknown>)[0]);
      if (isBlockedKey(key)) continue;
      const value = (entry as Record<number, unknown>)[1];
      assertStorable(result, key, value);
      result[key] = value;
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
        let value = (source as Record<string, unknown>)[key];
        assertStorable(target, key, value);
        // An index or a length is held to the longest array a script may make, as in an assignment
        if (Array.isArray(target)) value = checkArrayWrite(target, key, value).value;
        (target as Record<string, unknown>)[key] = value;
      }
    }
    return target;
  },
  freeze: (value: unknown): unknown => (isScriptData(value) ? Object.freeze(value) : value),
  isFrozen: (value: unknown): boolean => Object.isFrozen(value),
  is: (left: unknown, right: unknown): boolean => Object.is(left, right),
  hasOwn(value: unknown, key: unknown): boolean {
    assertArrayTextWithinLimit(key);
    const name = String(key);
    return !isBlockedKey(name) && Object.prototype.hasOwnProperty.call(Object(value), name);
  },
});

// Arrays are data to every member of `Object` (a key that is an array is measured where it is
// converted, above).
for (const key of Object.keys(SafeObject)) takesArraysAsData(SafeObject[key] as object);

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

// `Array(a, b)`, `Array.of`, `Array.from` and `Array.isArray` keep the arrays they are given.
takesArraysAsData(SafeArray);
for (const key of Object.keys(SafeArray)) {
  takesArraysAsData((SafeArray as unknown as Record<string, object>)[key]);
}

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

// ── URI encoding ─────────────────────────────────────────────────────────────
/**
 * Encode a text for a URI, unless that could make it longer than a script's longest text: a
 * char becomes up to nine (`%XX` for each of its three bytes), in one step of the engine. A
 * letter or a digit of the basic Latin range stays as it is.
 */
function encodedText(encode: (text: string) => string, value: unknown): string {
  const text = String(value);
  if (text.length * 9 > MAX_JOIN_LENGTH) {
    let produced = 0;
    for (let index = 0; index < text.length && produced <= MAX_JOIN_LENGTH; index++) {
      const code = text.charCodeAt(index);
      if (code >= 0x800) produced += 9;
      else if (code >= 0x80) produced += 6;
      else if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) produced += 1;
      else produced += 3;
    }
    if (produced > MAX_JOIN_LENGTH) {
      throw new RangeError(`The encoded text would be too long (more than ${MAX_JOIN_LENGTH} chars)`);
    }
  }
  return encode(text);
}

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
  encodeURI: Object.freeze((value: unknown): string => encodedText(encodeURI, value)),
  encodeURIComponent: Object.freeze((value: unknown): string => encodedText(encodeURIComponent, value)),
  decodeURI: Object.freeze((value: unknown): string => decodeURI(String(value))),
  decodeURIComponent: Object.freeze((value: unknown): string => decodeURIComponent(String(value))),
});

// How many arguments each of these converts. Used as the callback of `map` they are handed the
// item, its index and the array: the array is not theirs to read, so it is not measured for them.
convertsArguments(SafeString, 1);
convertsArguments(SafeNumber, 1);
convertsArguments(SafeDate, 0);
for (const [name, count] of [
  ['isFinite', 0],
  ['isInteger', 0],
  ['isNaN', 0],
  ['isSafeInteger', 0],
  ['parseFloat', 1],
  ['parseInt', 2],
] as const) {
  convertsArguments((SafeNumber as unknown as Record<string, object>)[name], count);
}
convertsArguments((SafeDate as unknown as Record<string, object>)['now'], 0);
convertsArguments((SafeDate as unknown as Record<string, object>)['parse'], 1);
for (const [name, count] of [
  ['isNaN', 1],
  ['isFinite', 1],
  ['parseFloat', 1],
  ['parseInt', 2],
  ['encodeURI', 1],
  ['encodeURIComponent', 1],
  ['decodeURI', 1],
  ['decodeURIComponent', 1],
] as const) {
  convertsArguments(SAFE_GLOBALS[name] as object, count);
}
for (const [, type] of SAFE_ERRORS) convertsArguments(type.facade, 1);

// The Math functions with a fixed number of parameters read only those: `numbers.map(Math.floor)`
// hands `floor` the array as its third argument, which it never looks at. `max`, `min` and
// `hypot` take any number of arguments and convert every one of them, so they are not listed.
const MATH_PARAMETERS: Readonly<Record<string, number>> = {
  abs: 1,
  acos: 1,
  acosh: 1,
  asin: 1,
  asinh: 1,
  atan: 1,
  atanh: 1,
  atan2: 2,
  cbrt: 1,
  ceil: 1,
  clz32: 1,
  cos: 1,
  cosh: 1,
  exp: 1,
  expm1: 1,
  floor: 1,
  fround: 1,
  imul: 2,
  log: 1,
  log1p: 1,
  log10: 1,
  log2: 1,
  pow: 2,
  random: 0,
  round: 1,
  sign: 1,
  sin: 1,
  sinh: 1,
  sqrt: 1,
  tan: 1,
  tanh: 1,
  trunc: 1,
};
for (const name of Object.keys(MATH_PARAMETERS)) {
  const fn: unknown = SafeMath[name];
  if (typeof fn === 'function') convertsArguments(fn, MATH_PARAMETERS[name]);
}

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
