/**
 * Static evaluation: the value of an expression that is made of constants.
 *
 * A rule that refuses a property name has to recognise the name however it is written. The name
 * can be spelled as a literal (`o['x']`), in pieces (`o['a' + 'b']`), through a method of a
 * constant (`o['AB'.toLowerCase()]`), through an array or an object that is converted to a string,
 * through a function written in place, or through a `const` that holds any of these. Listing
 * spellings does not end: this module computes the value instead.
 *
 * An expression is one of three things:
 *
 * - **Resolved.** It is made of constants and its value was computed. The value is compared with
 *   the names a rule refuses.
 * - **Unresolved.** It is made of constants, so it has one fixed value, and that value could not
 *   be computed (a construct that is not evaluated here, or one that costs too much). A rule
 *   refuses such a key: a name the validator cannot read is not accepted unread.
 * - **Dynamic.** It depends on something that is only known when the script runs. That is not a
 *   question a static rule can answer; the key guard (`guardComputedMemberKeys`) checks the key
 *   where the script runs.
 *
 * What counts as a constant: a literal, an operator applied to constants, a built-in function of
 * the language called with constants (`String`, `JSON`, `Math`, the methods of strings, arrays
 * and numbers, ...) and a function expression called in place.
 *
 * What is a run-time value: a function parameter, the result of calling a function of the host, a
 * global the language does not define, what the random number generator gives, and a date (the
 * clock, and what a date is in the time zone of the host).
 *
 * A variable of the script is one or the other, as the caller asks (`variables`):
 *
 * - Not followed (the default): a variable is a run-time value. The expression is read as it is
 *   written where it stands, and what a variable holds is checked where the script runs.
 * - Followed: a `const` whose initializer is a constant primitive is that constant. Every other
 *   variable, and a parameter, stays a run-time value (it can be assigned again; an object or an
 *   array it holds can change; a function it holds can be called with anything), and the
 *   evaluation reports, next to that, the constants it can see being given to it: by a
 *   declaration, an assignment, a pattern, a loop, a call of its function that can be seen, or by
 *   being stored into the array it holds.
 *
 * An expression that has a run-time part is evaluated a second time for the names it may still be
 * seen having (`candidates`): a list is read although a call that is not followed came before, a
 * variable although it was assigned. Both of these are a search for a refused name, not a proof
 * that there is none: a name a script assembles over several statements is a run-time value. What
 * the search finds is only ever added to "dynamic"; it never stands in for the value of an
 * expression that is made of constants.
 *
 * ## What keeps a computed value right
 *
 * A value this module reports for an expression made of constants is the one the engine computes.
 * Where the two could differ, the expression is unresolved, never "probably this":
 *
 * - **Effects.** After an assignment, a method that changes its array, or a call that is not
 *   followed, a variable or an array that could have changed is not read (`(k = 'a', k)`,
 *   `(a.push('x'), a[0])`). Expressions are evaluated in the order the language evaluates them,
 *   and a part that is not evaluated counts as an effect.
 * - **No value is inferred from an error.** An operation that throws where the script runs (a
 *   call of something that is not a function, a conversion that fails) is unresolved here.
 * - **Built-ins are what the language says only while the script cannot have changed them.** A
 *   script can change one when it assigns to a built-in (`Math.max = f`), when it hands on a
 *   built-in that holds functions (`const M = Math`) and writes to an object that may be it, when
 *   it names a property that leads to a prototype (`constructor`, `prototype`, `__proto__`, ...),
 *   or when it makes code from text. In such a script, what goes through a built-in is computed
 *   for the names it may give, never as the value. (A script that only passes `Number` to `map`,
 *   or keeps `Object.keys` under another name, cannot change a built-in.)
 * - **What depends on the engine, the realm or on how a function is called is not assumed.**
 *   `typeof` of a global, whether a platform function or a newer method exists, a function of
 *   `Math` whose last digit the language leaves open, a variable declared twice, `this` of a
 *   function called without an object, `arguments`.
 * - **A limit that is reached is an unresolved value.** Never a shorter list of values.
 *
 * And one rule on top of these, so that none of them is the only thing between a script and a
 * wrong value: an expression in which anything assigned, or anything was not evaluated, has no
 * computed value at all. What was computed for it is reported as names to compare, next to
 * "unresolved" (an expression made of constants) or "dynamic" (any other).
 *
 * The evaluation runs in the host, on text the host did not write, before any limit of a runtime
 * applies. It never runs code of the script: a function written in a key is read and its result
 * worked out here, statement by statement, and no function object is ever made from it. The
 * built-in functions it calls on the script's behalf are given primitives, or plain data this
 * module built itself. It never runs a regular expression, and it is bounded in steps (for one
 * expression and for a whole program), in depth, and in the size of every value it builds.
 *
 * @packageDocumentation
 */

import { sharedScopes, type ScopeBinding } from './scope-analysis';
import { isAstNode, type AnyNode } from './ast-walk';

/**
 * Static keys are compared with short property names. A larger key cannot match one of them,
 * and materializing it during validation would spend host memory before execution limits apply.
 */
export const MAX_STATIC_KEY_LENGTH = 4096;

/** A statically folded key would require an unsafe host allocation during validation. */
export class StaticKeyExpansionError extends Error {
  readonly location?: { line: number; column: number };

  constructor(node: { loc?: { start?: { line: number; column: number } } } | undefined) {
    super(`Static computed property key exceeds ${MAX_STATIC_KEY_LENGTH} characters`);
    this.name = 'StaticKeyExpansionError';
    this.location = node?.loc?.start ? { line: node.loc.start.line, column: node.loc.start.column } : undefined;
  }
}

/** A primitive value of the language. */
export type StaticPrimitive = string | number | boolean | null | undefined | bigint;

/** One value an expression may have. */
export interface StaticAlternative {
  /**
   * - `primitive`: `value` is the value.
   * - `symbol`, `function`: a value that is never a string property name.
   * - `object`: an array, an object or a regular expression.
   * - `unresolved`: made of constants, and not computed.
   * - `dynamic`: only known at run time.
   */
  type: 'primitive' | 'symbol' | 'function' | 'object' | 'unresolved' | 'dynamic';
  /** With `type: 'primitive'`: the value. */
  value?: StaticPrimitive;
  /** The property name this value is when it is used as a key, where it is one and is known. */
  key?: string;
}

/** How an expression is evaluated. */
export interface StaticEvaluationOptions {
  /**
   * Follow the variables of the script (see the description of this module).
   * Default: false (a variable is a run-time value).
   */
  variables?: boolean;
}

/** What is known about a property key without running the script. */
export interface StaticKey {
  /** Every name the key may be, as far as it is known. */
  names: string[];
  /** The key is made of constants and its value could not be computed. */
  unresolved: boolean;
}

// ---------------------------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------------------------

/**
 * Nodes visited and operations done for one expression, and for what one variable is given. A
 * step is also charged for every 64 characters of a string that is built, and for every element
 * that is copied.
 */
const MAX_STEPS = 250_000;
/** The same, for every expression of one program together. */
const MAX_TOTAL_STEPS = 4_000_000;
/**
 * What a script adds to both limits for each node it is made of: reading a table that is written
 * out in the script costs what the table is long.
 */
const STEPS_PER_NODE = 8;
/** Nesting of evaluations (expressions inside expressions, calls inside calls, values in values). */
const MAX_DEPTH = 200;
/** Values one expression may have (`c ? 'a' : 'b'` has two). */
const MAX_ALTERNATIVES = 131_072;
/** Elements of an array that is built here. */
const MAX_ITEMS = MAX_STATIC_KEY_LENGTH;
/** Size of a BigInt that is built here, in bits. */
const MAX_BIGINT_BITS = 1024;
/** Digits of a BigInt literal that is read. */
const MAX_BIGINT_DIGITS = 320;
/** The largest array index: a key above it is an ordinary name, also in the order of an object's keys. */
const MAX_ARRAY_INDEX = 4294967294;
/** Times the assignments that build on what a variable holds (`k += 'x'`) are applied in turn. */
const MAX_PASSES = 4;
/** Steps that search may take. */
const PASS_STEPS = 5_000;
/** Length of a constant string whose pieces are listed when it is cut at a run-time position. */
const MAX_CUT_LENGTH = 32;

/** The value would be larger than a key can usefully be. */
class TooLong {
  constructor(readonly node: AnyNode) {}
}

/** The expression costs more than one evaluation may. */
class OutOfBudget {}

/** One of the ways an evaluation ends early: the value is then unresolved. */
function isSignal(error: unknown): boolean {
  return (
    error instanceof TooLong ||
    error instanceof OutOfBudget ||
    // The host ran out of stack: the expression nests deeper than it can be followed
    (error instanceof RangeError && /call stack/i.test(error.message))
  );
}

// ---------------------------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------------------------

interface PrimitiveValue {
  readonly kind: 'primitive';
  readonly value: StaticPrimitive;
  /** `new String('x')`, `Object(1)`: an object that converts to the primitive */
  readonly boxed?: true;
}
interface SymbolValue {
  readonly kind: 'symbol';
  /** Its description: a string, `null` when it has none (`Symbol()`), absent when it is not known */
  readonly description?: string | null;
  /** `Symbol.toPrimitive` is `toPrimitive` */
  readonly wellKnown?: string;
}
/** When an array or an object was made: it is read only while nothing can have changed it. */
interface Stamp {
  readonly epoch: number;
  readonly born: number;
}
interface ArrayValue extends Stamp {
  readonly kind: 'array';
  readonly items: readonly Value[];
  /**
   * Not an array of the script: the values the script can be seen storing into what a variable
   * holds, in the order they are written. Any element of it may be read at any index.
   */
  readonly bag?: true;
}
interface ObjectValue extends Stamp {
  readonly kind: 'object';
  readonly properties: Map<string, Slot>;
  /** Properties whose key is a well-known symbol, by its name */
  readonly symbols: Map<string, Slot>;
  /** `undefined`: the default prototype. `null`: none. */
  readonly proto: ObjectValue | null | undefined;
}
interface FunctionValue {
  readonly kind: 'function';
  readonly node: AnyNode;
  readonly env: Env | undefined;
  /** Its `name`, where the place it is written in gives it one that is known */
  readonly name: string | undefined;
}
interface RegExpValue {
  readonly kind: 'regexp';
  readonly source: string;
  readonly flags: string;
}
/** A built-in of the language, by its path: `String`, `String.fromCharCode`, `Math.max`. */
interface BuiltinValue {
  readonly kind: 'builtin';
  readonly path: string;
  /** Whether it exists depends on where the script runs (a platform function, a member of the global object) */
  readonly uncertain?: true;
}
/** A method taken from a value without calling it: `[].join`, `''.concat`. */
interface MethodValue {
  readonly kind: 'method';
  readonly receiver: Value;
  readonly name: string;
}
interface UnresolvedValue {
  readonly kind: 'unresolved';
  /** It is an object (an array, a collection, an instance): not a primitive constant */
  readonly object?: true;
  /** A variable holds it: what is read from it, or what a call on it gives, is a run-time value */
  readonly held?: true;
}
interface DynamicValue {
  readonly kind: 'dynamic';
}

type Value =
  | PrimitiveValue
  | SymbolValue
  | ArrayValue
  | ObjectValue
  | FunctionValue
  | RegExpValue
  | BuiltinValue
  | MethodValue
  | UnresolvedValue
  | DynamicValue;

/**
 * A property of an object literal. A data property holds its values; an accessor has a getter, a
 * setter or both (one with a setter only reads as `undefined`).
 */
interface Slot {
  readonly values?: Value[];
  readonly getter?: FunctionValue;
  readonly setter?: true;
}

/** The variables of a function that is being applied. Keyed by the declaring identifier node. */
interface Env {
  readonly parent: Env | undefined;
  readonly bindings: Map<AnyNode, Value[]>;
  /** The function that is applied */
  readonly fn: AnyNode;
  /** `this` inside a function that is not an arrow function: absent when it was called without an object */
  readonly self: Value | undefined;
  readonly ownsSelf: boolean;
  /** How many assignments had been seen when these variables were given their values */
  readonly createdAt: number;
}

const DYNAMIC: DynamicValue = { kind: 'dynamic' };
const UNRESOLVED: UnresolvedValue = { kind: 'unresolved' };
const UNRESOLVED_OBJECT: UnresolvedValue = { kind: 'unresolved', object: true };
const HELD_OBJECT: UnresolvedValue = { kind: 'unresolved', object: true, held: true };

function primitive(value: StaticPrimitive): PrimitiveValue {
  return { kind: 'primitive', value };
}
const UNDEFINED = primitive(undefined);
/**
 * An empty slot of an array (`[1, , 3]`, `Array(3)`). It reads as `undefined`, and most methods
 * that walk an array skip it, each in its own way: where a method tells a hole from an element,
 * an array that has one is not evaluated.
 */
const HOLE = primitive(undefined);
/**
 * The value of an optional chain that stopped (`a?.b.c` where `a` is `null`): the rest of the
 * chain is not evaluated, and the chain as a whole is `undefined`.
 */
const STOPPED = primitive(undefined);

function hasHole(items: readonly Value[]): boolean {
  return items.includes(HOLE);
}

/** The elements as they are read one by one: an empty slot reads as `undefined`. */
function dense(items: readonly Value[]): Value[] {
  return items.map((item) => (item === HOLE ? UNDEFINED : item));
}

function isResolved(value: Value): boolean {
  return value.kind !== 'dynamic' && value.kind !== 'unresolved';
}

function isNullish(value: Value): boolean {
  return value.kind === 'primitive' && !value.boxed && value.value == null;
}

function isUndefined(value: Value | undefined): boolean {
  return value === undefined || (value.kind === 'primitive' && !value.boxed && value.value === undefined);
}

/** A value a `const` holds unchanged for as long as it exists. */
function isScalar(value: Value): boolean {
  return (
    (value.kind === 'primitive' && !value.boxed) ||
    value.kind === 'symbol' ||
    value.kind === 'dynamic' ||
    (value.kind === 'unresolved' && !value.object)
  );
}

function isCallable(value: Value): value is FunctionValue | BuiltinValue | MethodValue {
  return value.kind === 'function' || value.kind === 'builtin' || value.kind === 'method';
}

/** What reading a member of a value that is not known gives, or calling it. */
function through(value: Value): Value {
  return value.kind === 'unresolved' && !value.held ? UNRESOLVED : DYNAMIC;
}

/** What an operator gives on a value that is not known. */
function plain(value: Value): Value {
  return value.kind === 'unresolved' ? UNRESOLVED : value;
}

// ---------------------------------------------------------------------------------------------
// The language's own globals
// ---------------------------------------------------------------------------------------------

/**
 * Free names whose value is fixed by the language. An expression that uses nothing else is made
 * of constants. A free name that is not listed is the host's: its value is only known at run
 * time.
 */
const LANGUAGE_GLOBALS: ReadonlySet<string> = new Set([
  'undefined',
  'NaN',
  'Infinity',
  'Object',
  'Function',
  'Array',
  'String',
  'Number',
  'Boolean',
  'BigInt',
  'Symbol',
  'Math',
  'JSON',
  'Date',
  'RegExp',
  'Intl',
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
  'AggregateError',
  'SuppressedError',
  'Promise',
  'Proxy',
  'Reflect',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'WeakRef',
  'FinalizationRegistry',
  'DisposableStack',
  'AsyncDisposableStack',
  'ArrayBuffer',
  'SharedArrayBuffer',
  'DataView',
  'Atomics',
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float16Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
  'Iterator',
  'AsyncIterator',
  'eval',
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
  'encodeURI',
  'encodeURIComponent',
  'decodeURI',
  'decodeURIComponent',
  'escape',
  'unescape',
]);

/**
 * Free names of functions and objects every usual platform has and the language does not define.
 * What they compute is fixed, so an expression that uses them is made of constants; whether they
 * exist depends on where the script runs, so nothing is concluded from that.
 */
const PLATFORM_GLOBALS: ReadonlySet<string> = new Set([
  'atob',
  'btoa',
  'structuredClone',
  'TextEncoder',
  'TextDecoder',
  'URL',
  'URLSearchParams',
  'Buffer',
  'WebAssembly',
  'Temporal',
]);

function isClosedGlobal(name: string): boolean {
  return LANGUAGE_GLOBALS.has(name) || PLATFORM_GLOBALS.has(name);
}

/** Globals that cannot be assigned to. */
const CONSTANT_GLOBALS: ReadonlySet<string> = new Set(['undefined', 'NaN', 'Infinity']);

/** Names of the global object: `globalThis.String` is `String`. */
const GLOBAL_OBJECT_NAMES: ReadonlySet<string> = new Set(['globalThis', 'window', 'self', 'global']);

/** Functions that make code from a text they are given (a timer does, when its argument is a string). */
const CODE_FROM_TEXT: ReadonlySet<string> = new Set(['eval', 'Function', 'setTimeout', 'setInterval', 'execScript']);

/** Constructors of the language that make a new object every time they are called. */
const FRESH_CONSTRUCTORS: ReadonlySet<string> = new Set([
  'Array',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'Date',
  'RegExp',
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
  'AggregateError',
  'Promise',
  'ArrayBuffer',
  'DataView',
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
  'String',
  'Number',
  'Boolean',
  'URL',
  'URLSearchParams',
  'TextEncoder',
  'TextDecoder',
]);

/** Built-ins that read and write any property of any object by a name that is only a string. */
const REFLECTION: ReadonlySet<string> = new Set(['Reflect', 'Proxy']);

/** A member of the global object that is the global object, or a method every object has. */
function isGlobalObjectMember(name: string): boolean {
  return GLOBAL_OBJECT_NAMES.has(name) || OBJECT_PROTOTYPE_NAMES.has(name);
}

/** A name the evaluation gives a fixed meaning: a built-in, or the object that holds them. */
function isBuiltinName(name: string): boolean {
  return (isClosedGlobal(name) && !CONSTANT_GLOBALS.has(name)) || GLOBAL_OBJECT_NAMES.has(name);
}

/**
 * Property names that lead from a value to a prototype, or that define a property on one. A script
 * that names one of them can change what a method of a string or an array does.
 */
const PROTOTYPE_NAMES: ReadonlySet<string> = new Set([
  'constructor',
  'prototype',
  '__proto__',
  'getPrototypeOf',
  'setPrototypeOf',
  'defineProperty',
  'defineProperties',
  'getOwnPropertyDescriptor',
  'getOwnPropertyDescriptors',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
]);

/** Built-ins whose own data properties are read from the host (`Math.PI`, `Symbol.iterator`). */
const HOST_OBJECTS: ReadonlyMap<string, object> = new Map<string, object>([
  ['String', String],
  ['Number', Number],
  ['Boolean', Boolean],
  ['BigInt', BigInt],
  ['Symbol', Symbol],
  ['Object', Object],
  ['Array', Array],
  ['JSON', JSON],
  ['Math', Math],
]);

/**
 * A built-in that holds functions or constants the evaluation computes with (`Math.max`,
 * `String.fromCharCode`), or the global object, which holds them all. Replacing one of those
 * needs this object; a function taken off it (`Object.keys`) is not it.
 */
function isHolder(name: string): boolean {
  return HOST_OBJECTS.has(name) || GLOBAL_OBJECT_NAMES.has(name);
}

/**
 * Methods of a text, a number or a list that every engine a script may run in has: those of
 * ES2019 and before. A newer one (`at`, `replaceAll`, `toSorted`, ...) may be missing.
 */
const BASELINE_METHODS: ReadonlySet<string> = new Set([
  // String.prototype
  'charAt',
  'charCodeAt',
  'codePointAt',
  'concat',
  'endsWith',
  'includes',
  'indexOf',
  'lastIndexOf',
  'localeCompare',
  'match',
  'normalize',
  'padEnd',
  'padStart',
  'repeat',
  'replace',
  'search',
  'slice',
  'split',
  'startsWith',
  'substr',
  'substring',
  'toLocaleLowerCase',
  'toLocaleUpperCase',
  'toLowerCase',
  'toString',
  'toUpperCase',
  'trim',
  'trimEnd',
  'trimStart',
  'valueOf',
  // Number.prototype
  'toExponential',
  'toFixed',
  'toLocaleString',
  'toPrecision',
  // Array.prototype
  'copyWithin',
  'entries',
  'every',
  'fill',
  'filter',
  'find',
  'findIndex',
  'flat',
  'flatMap',
  'forEach',
  'join',
  'keys',
  'map',
  'pop',
  'push',
  'reduce',
  'reduceRight',
  'reverse',
  'shift',
  'some',
  'sort',
  'splice',
  'unshift',
  'values',
]);

/** Methods of a string that take and return plain values and compile no pattern. */
const STRING_METHODS: ReadonlySet<string> = new Set([
  'at',
  'charAt',
  'charCodeAt',
  'codePointAt',
  'concat',
  'endsWith',
  'includes',
  'indexOf',
  'isWellFormed',
  'lastIndexOf',
  'normalize',
  'padEnd',
  'padStart',
  'repeat',
  'replace',
  'replaceAll',
  'slice',
  'split',
  'startsWith',
  'substr',
  'substring',
  'toLocaleLowerCase',
  'toLocaleUpperCase',
  'toLowerCase',
  'toString',
  'toUpperCase',
  'toWellFormed',
  'trim',
  'trimEnd',
  'trimLeft',
  'trimRight',
  'trimStart',
  'valueOf',
]);

/**
 * Methods of a string whose result is made of the string itself: it is as large as the text it
 * comes from, which the script holds already, and not larger.
 */
const BOUNDED_STRING_METHODS: ReadonlySet<string> = new Set([
  'at',
  'charAt',
  'charCodeAt',
  'codePointAt',
  'endsWith',
  'includes',
  'indexOf',
  'isWellFormed',
  'lastIndexOf',
  'slice',
  'split',
  'startsWith',
  'substr',
  'substring',
  'toLocaleLowerCase',
  'toLocaleUpperCase',
  'toLowerCase',
  'toString',
  'toUpperCase',
  'toWellFormed',
  'trim',
  'trimEnd',
  'trimLeft',
  'trimRight',
  'trimStart',
  'valueOf',
]);

/** Methods of a string whose result is an array (or nothing). */
const STRING_ARRAY_METHODS: ReadonlySet<string> = new Set(['split', 'match', 'matchAll']);

const NUMBER_METHODS: ReadonlySet<string> = new Set(['toExponential', 'toFixed', 'toPrecision', 'toString', 'valueOf']);

/** Methods of an array that give the same answer whether a slot is empty or holds `undefined`. */
const HOLE_NEUTRAL_METHODS: ReadonlySet<string> = new Set([
  'at',
  'concat',
  'fill',
  'join',
  'pop',
  'push',
  'reverse',
  'shift',
  'slice',
  'toReversed',
  'toString',
  'unshift',
  'valueOf',
]);

/** Methods of an array that change it. */
const MUTATING_ARRAY_METHODS: ReadonlySet<string> = new Set([
  'copyWithin',
  'fill',
  'pop',
  'push',
  'reverse',
  'shift',
  'sort',
  'splice',
  'unshift',
]);

/** Those of them that write the elements a list has, and neither add one nor take one away. */
const SHAPE_KEEPING_METHODS: ReadonlySet<string> = new Set(['copyWithin', 'fill', 'reverse', 'sort']);

/** Methods of an array whose result is an array. */
const ARRAY_RETURNING_METHODS: ReadonlySet<string> = new Set([
  'concat',
  'copyWithin',
  'fill',
  'filter',
  'flat',
  'flatMap',
  'map',
  'reverse',
  'slice',
  'sort',
  'splice',
  'toReversed',
  'toSorted',
  'toSpliced',
  'with',
]);

const ARRAY_METHODS: ReadonlySet<string> = new Set([
  'at',
  'concat',
  'every',
  'fill',
  'filter',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'flat',
  'flatMap',
  'forEach',
  'includes',
  'indexOf',
  'join',
  'lastIndexOf',
  'map',
  'pop',
  'push',
  'reduce',
  'reduceRight',
  'reverse',
  'shift',
  'slice',
  'some',
  'sort',
  'toReversed',
  'toSorted',
  'toString',
  'unshift',
  'valueOf',
]);

/** Methods of an array that call their first argument with the elements of the array. */
const WALKING_METHODS: ReadonlySet<string> = new Set([
  'every',
  'filter',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'flatMap',
  'forEach',
  'map',
  'reduce',
  'reduceRight',
  'some',
  'sort',
  'toSorted',
]);

/** Methods that store their arguments into the object they are called on. */
const STORING_METHODS: ReadonlySet<string> = new Set(['push', 'unshift', 'splice', 'fill', 'add', 'set']);

/**
 * Functions of `Math` whose result the language fixes exactly. (The others, `sin`, `exp`, `log`,
 * `pow` and the like, may differ in the last digit from one engine to the next, and the script
 * does not have to run in the engine that validates it.)
 */
const MATH_FUNCTIONS: ReadonlySet<string> = new Set([
  'abs',
  'ceil',
  'clz32',
  'floor',
  'fround',
  'imul',
  'max',
  'min',
  'round',
  'sign',
  'sqrt',
  'trunc',
]);

/** Global functions that take one primitive and return one. */
const TEXT_FUNCTIONS: ReadonlyMap<string, (text: string) => string> = new Map<string, (text: string) => string>([
  ['encodeURI', (text) => encodeURI(text)],
  ['encodeURIComponent', (text) => encodeURIComponent(text)],
  ['decodeURI', (text) => decodeURI(text)],
  ['decodeURIComponent', (text) => decodeURIComponent(text)],
  ['escape', (text) => escape(text)],
  ['unescape', (text) => unescape(text)],
  ['atob', (text) => atob(text)],
  ['btoa', (text) => btoa(text)],
]);

/** Properties every object has through `Object.prototype`. */
const OBJECT_PROTOTYPE_NAMES: ReadonlySet<string> = new Set(Object.getOwnPropertyNames(Object.prototype));

/** Assignments that keep or replace what a variable holds, as a whole. */
const LOGICAL_ASSIGNMENTS: ReadonlySet<string> = new Set(['||=', '&&=', '??=']);

/** Whether a text is made of ASCII characters only. */
function isAscii(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) > 0x7f) return false;
  }
  return true;
}

function isArrayIndex(name: string): boolean {
  return /^(?:0|[1-9]\d{0,9})$/.test(name) && Number(name) <= MAX_ARRAY_INDEX;
}

/** The name a member is read by, where it is written out: `o.name`, `o['name']`. */
function staticName(member: AnyNode): string | undefined {
  const property = member?.property;
  if (!member?.computed) return property?.type === 'Identifier' ? String(property.name) : undefined;
  return property?.type === 'Literal' && typeof property.value === 'string' ? property.value : undefined;
}

// ---------------------------------------------------------------------------------------------
// The evaluator
// ---------------------------------------------------------------------------------------------

/** Where a variable gets a value: its declaration, or a place that assigns to it. */
type Source =
  | { kind: 'simple'; init: AnyNode | null | undefined; loop?: AnyNode; defaultNode?: AnyNode }
  | { kind: 'pattern'; init: AnyNode | null | undefined; loop?: AnyNode; path: PatternStep[]; defaultNode?: AnyNode }
  | {
      kind: 'param';
      fn: AnyNode;
      index: number;
      path: PatternStep[];
      defaultNode?: AnyNode;
      /** `(...rest)`: the list of the arguments from `index` on */
      rest?: true;
    }
  | { kind: 'function'; node: AnyNode }
  | { kind: 'class'; node: AnyNode }
  | { kind: 'catch'; block: AnyNode }
  | { kind: 'other'; defaultNode?: AnyNode };

type PatternStep =
  | { type: 'index'; index: number }
  | { type: 'rest'; index: number }
  | { type: 'objectRest' }
  | { type: 'key'; property: AnyNode }
  | { type: 'default'; node: AnyNode };

/** An assignment to a variable that is not its declaration. */
type Write = { operator: string; right: AnyNode } | { target: AnyNode };

/** What a key is: a name, a symbol, or not known */
type KeyName = { name: string } | { symbol: SymbolValue } | 'dynamic' | 'unresolved';

class StaticEvaluator {
  /** Each identifier that names a variable, with its declaration (`null`: a free name) */
  private readonly bindingOf = new Map<AnyNode, ScopeBinding | null>();
  /** The identifiers that only assign to their variable (`name = value`): its value is not used */
  private readonly writeOnly = new Set<AnyNode>();
  /** The places that assign to a variable, other than its declaration */
  private readonly writesTo = new Map<ScopeBinding, Write[]>();
  /** The expressions stored into what a variable holds: `list.push(x)`, `table[k] = x` */
  private readonly storesTo = new Map<ScopeBinding, AnyNode[]>();
  /** The declaration each declaring identifier makes, and the identifiers that read each variable */
  private readonly declared = new Map<AnyNode, ScopeBinding>();
  private readonly readsOf = new Map<ScopeBinding, AnyNode[]>();
  /** The assignments to a name the script does not declare, by name */
  private readonly globalWrites = new Map<string, Write[]>();
  private readonly globalMemo = new Map<string, Value[]>();
  /** The computed keys of the script */
  private readonly computedKeys: AnyNode[] = [];
  /** The objects the script writes a property of, and the calls that copy properties onto one */
  private readonly writeTargets: AnyNode[] = [];
  private readonly assignCalls: AnyNode[] = [];
  /** A built-in that holds functions the evaluation computes with is used as a value somewhere */
  private holderEscapes = false;
  /** Something in the script writes to an object that is not one the script can be seen making */
  private looseWrite = false;
  /** The class each object that stands for one was made from (see `classStatics`) */
  private readonly classOf = new WeakMap<ObjectValue, AnyNode>();
  /** Functions declared in a block, by name: outside the block the name may still reach them */
  private readonly blockFunctions = new Map<string, AnyNode[]>();
  private readonly parentOf = new Map<AnyNode, AnyNode>();
  /** What is written in the body of a `with`: a name there may be a property of its object */
  private readonly inWith = new WeakSet<AnyNode>();
  private readonly bindingMemo = new Map<ScopeBinding, Value[]>();
  private readonly computing = new Set<ScopeBinding>();
  private readonly dependencies = new Map<ScopeBinding, ScopeBinding[]>();
  /** Answers that do not depend on a function being applied, for each of the two ways to read a variable */
  private readonly closedMemo = { followed: new WeakMap<AnyNode, boolean>(), plain: new WeakMap<AnyNode, boolean>() };
  private readonly described = {
    followed: new WeakMap<AnyNode, StaticAlternative[]>(),
    plain: new WeakMap<AnyNode, StaticAlternative[]>(),
  };
  /**
   * The expressions that are too large to build, with the node that says where. One for each way
   * of reading, like `described`: a variable that is followed can decide a branch, and with it
   * whether the large one is built at all.
   */
  private readonly tooLong = {
    followed: new WeakMap<AnyNode, AnyNode>(),
    plain: new WeakMap<AnyNode, AnyNode>(),
  };
  /**
   * The arrays and objects `Object.freeze`, `seal` or `preventExtensions` was called on, by what
   * holds their content: every reference to the object shares it, a copy does not.
   */
  private readonly locked = new WeakMap<object, 'frozen' | 'sealed'>();
  /** Keys found unresolved, with the rank each was last reported at */
  private readonly reportedAt = new Map<AnyNode, number>();
  private pending = new Set<AnyNode>();

  /**
   * Whether the built-ins are what the language says: the script does not assign to one, does
   * not hand one on as a value, and names no property that leads to a prototype.
   */
  private trusted = true;
  /**
   * Looking for the constants an expression may be, next to "or anything else": for what a
   * variable may hold, and for an expression that has a run-time part. What the built-ins give
   * is taken as the language says, and an array or a variable is read although something may
   * have changed it. What is found this way is a name to compare, never the value.
   */
  private lenient = false;
  /** Whether the evaluation in progress follows the variables of the script */
  private variables = false;

  private steps = 0;
  private limit = MAX_STEPS;
  private total = 0;
  /** The two limits for this program: the base, and what its size adds */
  private stepLimit = MAX_STEPS;
  private totalLimit = MAX_TOTAL_STEPS;
  private depth = 0;
  /** Assignments to variables seen so far in the expression that is evaluated */
  private writes = 0;
  /** Changes to arrays and objects seen so far in it */
  private heap = 0;
  /**
   * Whether something in it assigned, or was not evaluated. What is computed after that is a
   * set of names to compare, not the value of the expression: the checks that keep a changed
   * variable or list from being read are then a second line, not the only one. (A method that
   * changes the list it is called on, `reverse` or `sort`, is evaluated: it does not count.)
   */
  private disturbed = false;
  /**
   * A variable was assigned, and nothing has been evaluated since. (The value of `k = 'a'` is
   * what was assigned; it is what comes after an assignment that may read what it changed.)
   */
  private effect = false;
  /** Whether something in it was computed on the assumption that a built-in is unchanged */
  private assumed = false;
  /** The number of the expression that is evaluated: each one evaluated on its own has one */
  private epoch = 0;
  private epochs = 0;

  constructor(ast: unknown) {
    if (!isAstNode(ast)) return;

    // One walk: the parent of every node, the functions declared in a block, and what in the
    // shape of the script lets it change a built-in (see `checkTrust`)
    const stack: AnyNode[] = [ast];
    let current: AnyNode = ast;
    const adopt = (child: AnyNode): void => {
      this.parentOf.set(child, current);
      if (this.inWith.has(current) || (current.type === 'WithStatement' && child === current.body)) {
        this.inWith.add(child);
      }
      stack.push(child);
    };
    let nodes = 0;
    while (stack.length > 0) {
      const node = stack.pop();
      nodes++;
      this.checkTrust(node);
      if (node.type === 'FunctionDeclaration' && node.id && this.isBlockLevel(node)) {
        const list = this.blockFunctions.get(node.id.name);
        if (list) list.push(node);
        else this.blockFunctions.set(node.id.name, [node]);
      }
      current = node;
      forEachChild(node, adopt);
    }
    this.stepLimit = MAX_STEPS + STEPS_PER_NODE * nodes;
    this.totalLimit = MAX_TOTAL_STEPS + 8 * STEPS_PER_NODE * nodes;

    const scopes = sharedScopes(ast);
    for (const binding of scopes.bindings) {
      if (!this.declared.has(binding.node)) this.declared.set(binding.node, binding);
    }
    for (const reference of scopes.references) {
      const binding = reference.binding ?? null;
      const parent = this.parentOf.get(reference.node);
      if (binding === null && reference.write && !isBuiltinName(reference.name)) {
        // `name = value` without a declaration makes a global the script reads back by name
        const write: Write =
          parent?.type === 'AssignmentExpression' && parent.left === reference.node
            ? { operator: String(parent.operator), right: parent.right }
            : { target: reference.node };
        const list = this.globalWrites.get(reference.name);
        if (list) list.push(write);
        else this.globalWrites.set(reference.name, [write]);
      }
      this.bindingOf.set(reference.node, binding);
      if (reference.write && !reference.read) this.writeOnly.add(reference.node);
      if (binding !== null && reference.read) {
        this.collectStore(binding, reference.node, parent);
        const reads = this.readsOf.get(binding);
        if (reads) reads.push(reference.node);
        else this.readsOf.set(binding, [reference.node]);
      }
      if (!reference.write) continue;

      if (binding === null) {
        // `parseInt = f`, `Math ||= x`: a built-in is replaced
        if (isBuiltinName(reference.name)) this.trusted = false;
        continue;
      }
      let write: Write | undefined;
      if (parent?.type === 'AssignmentExpression' && parent.left === reference.node) {
        write = { operator: String(parent.operator), right: parent.right };
      } else if (parent?.type !== 'UpdateExpression' && parent?.type !== 'UnaryExpression') {
        write = { target: reference.node }; // inside a pattern, or the head of a loop
      }
      if (write) {
        const list = this.writesTo.get(binding);
        if (list) list.push(write);
        else this.writesTo.set(binding, [write]);
      }
    }

    for (const binding of scopes.bindings) {
      // `catch (e) { var e = value; }`: the declaration gives its value to the catch parameter.
      // `function f(k = 1) { var k; }`: the body's variable starts with the value of the parameter.
      const [into, from] = binding.initializes
        ? [binding.initializes, binding.node]
        : binding.startsAs
          ? [binding, binding.startsAs.node]
          : [];
      if (!into) continue;
      const list = this.writesTo.get(into);
      if (list) list.push({ target: from });
      else this.writesTo.set(into, [{ target: from }]);
    }

    // The built-ins that are named: one that is assigned to is changed; one that holds the
    // functions the evaluation computes with (`Math`, `String`, the global object) and is handed
    // on as a value can be changed by whoever gets it. And what makes code from text, or reads
    // and writes any property by a name that is only a string, can change anything.
    for (const reference of scopes.freeReferences) {
      if (!this.trusted) break;
      const name = reference.name;
      if (CODE_FROM_TEXT.has(name) || REFLECTION.has(name)) this.trusted = false;
      else if (isHolder(name)) {
        const use = this.holderUse(reference.node);
        if (use === 'changed') this.trusted = false;
        else if (use === 'handed on') this.holderEscapes = true;
      }
    }
    this.checkKeys();

    // A built-in that was handed on is changed only by a write to something that may be it
    if (this.trusted && this.holderEscapes) {
      const loose =
        this.looseWrite ||
        this.writeTargets.some((target) => !this.isOwnObject(target)) ||
        this.assignCalls.some((call) => !this.isOwnObject(call.arguments?.[0]));
      if (loose) this.trusted = false;
    }
    // What was computed on the way assumed the built-ins: it is not kept where they are not trusted
    if (!this.trusted) {
      this.described.plain = new WeakMap();
      this.described.followed = new WeakMap();
    }
  }

  /**
   * The same questions as `checkTrust`, for a key that is computed: does it name a property that
   * leads to a prototype, or the function that copies properties onto an object? The key is
   * evaluated as if the built-ins were what the language says. That is right for the first such
   * key the script reaches when it runs, since nothing before it changed a built-in; and if that
   * key is one of these names, the script is not trusted. A key that is made of constants and is
   * not computed may be one of them.
   */
  private checkKeys(): void {
    for (const key of this.computedKeys) {
      if (!this.trusted) break;
      const names = this.peekNames(key);
      if (names === undefined || names.some((name) => PROTOTYPE_NAMES.has(name))) this.trusted = false;
      else if (names.includes('assign')) this.looseWrite = true;
    }
  }

  /** Whether an expression reads or writes a variable, or a global, by its name. */
  private namesAnything(root: AnyNode): boolean {
    const stack: AnyNode[] = [root];
    while (stack.length > 0) {
      const node = stack.pop() as AnyNode;
      if (node.type === 'Identifier' && this.bindingOf.get(node) !== undefined) return true;
      forEachChild(node, (child) => stack.push(child));
    }
    return false;
  }

  /** The names a computed key is, read as it is written; `undefined` where a constant is not computed. */
  private peekNames(key: AnyNode): string[] | undefined {
    let alternatives: StaticAlternative[];
    try {
      alternatives = this.describe(key, true, false);
    } catch (error) {
      // Too large to build: not a short name
      if (error instanceof StaticKeyExpansionError) return [];
      throw error;
    }
    if (alternatives.some((alternative) => alternative.type === 'unresolved')) return undefined;
    return alternatives.flatMap((alternative) => (alternative.key === undefined ? [] : [alternative.key]));
  }

  /**
   * Whether an expression is an object the script made itself, where it is written or in a
   * variable that holds nothing else: a write to it is not a write to a built-in.
   */
  private isOwnObject(node: AnyNode, hops = 0): boolean {
    switch (node?.type) {
      case 'ParenthesizedExpression':
        return this.isOwnObject(node.expression, hops);
      case 'ObjectExpression':
      case 'ArrayExpression':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
      case 'ClassExpression':
      case 'Literal':
      case 'TemplateLiteral':
        return true;
      case 'NewExpression':
        // An instance of a built-in that makes a new object each time. (A constructor of the
        // script may return whatever it was given, `Object` returns its argument, and a proxy
        // passes a write on to what it wraps.)
        return (
          node.callee?.type === 'Identifier' &&
          FRESH_CONSTRUCTORS.has(node.callee.name) &&
          this.bindingOf.get(node.callee) === null
        );
      case 'ThisExpression':
        return this.isOwnThis(node);
      case 'Identifier': {
        const init = this.localInit(node);
        return init !== undefined && hops < 4 && this.isOwnObject(init, hops + 1);
      }
      default:
        return false;
    }
  }

  /**
   * What gives `this` its value where a node stands: the nearest function that is not an arrow
   * function, a field or a static block of a class, or the program. A computed key of a class
   * member is evaluated where the class is written, not in the class: its `this` is the one
   * outside.
   */
  private thisScope(node: AnyNode): AnyNode | undefined {
    let child: AnyNode = node;
    let current = this.parentOf.get(node);
    while (current) {
      switch (current.type) {
        case 'PropertyDefinition':
        case 'MethodDefinition':
          if (current.key === child) {
            // Out of the class: on from the class itself
            const body = this.parentOf.get(current);
            current = body ? this.parentOf.get(body) : undefined;
            if (!current) return undefined;
            break;
          }
          if (current.type === 'PropertyDefinition') return current;
          break;
        case 'StaticBlock':
        case 'FunctionDeclaration':
        case 'FunctionExpression':
        case 'Program':
          return current;
        default:
          break;
      }
      child = current;
      current = this.parentOf.get(current);
    }
    return undefined;
  }

  /** The class a field or a method belongs to. */
  private classOfMember(member: AnyNode | undefined): AnyNode | undefined {
    const body = member ? this.parentOf.get(member) : undefined;
    return body?.type === 'ClassBody' ? this.parentOf.get(body) : undefined;
  }

  /**
   * Whether `this` is an object the class it is written in made: in the constructor or in a
   * field of a class that extends nothing (after `super(x)`, `this` is whatever the constructor
   * of the base returned), or in a static field or block (the class itself). In a method it is
   * whatever the method is called on, and a method can be called on anything.
   */
  private isOwnThis(node: AnyNode): boolean {
    const scope = this.thisScope(node);
    switch (scope?.type) {
      case 'StaticBlock':
        return true;
      case 'PropertyDefinition':
        return scope.static === true || !this.classOfMember(scope)?.superClass;
      case 'FunctionExpression': {
        const method = this.parentOf.get(scope);
        if (method?.type !== 'MethodDefinition' || method.kind !== 'constructor') return false;
        return !this.classOfMember(method)?.superClass;
      }
      default:
        return false;
    }
  }

  /** Whether `this` is given its value by a class it is written in: it is then never the global object. */
  private isInClass(node: AnyNode): boolean {
    const scope = this.thisScope(node);
    if (scope?.type === 'StaticBlock' || scope?.type === 'PropertyDefinition') return true;
    return scope?.type === 'FunctionExpression' && this.parentOf.get(scope)?.type === 'MethodDefinition';
  }

  /**
   * `name.push(value)`, `name[key] = value`, `name.list[0] = value`: what is stored into the
   * object a variable holds, or into something that object holds.
   */
  private collectStore(binding: ScopeBinding, node: AnyNode, parent: AnyNode | undefined): void {
    if (parent?.type !== 'MemberExpression' || parent.object !== node) return;
    let top: AnyNode = parent;
    let holder = this.parentOf.get(top);
    while (holder?.type === 'MemberExpression' && holder.object === top) {
      top = holder;
      holder = this.parentOf.get(top);
    }
    let nodes: AnyNode[] = [];
    if (holder?.type === 'AssignmentExpression' && holder.left === top) {
      nodes = [holder.right];
    } else if (holder?.type === 'CallExpression' && holder.callee === top) {
      const name = staticName(top);
      if (name !== undefined && STORING_METHODS.has(name)) {
        // (`splice(start, count, ...items)` and `set(key, value)` store what comes after)
        const skip = name === 'splice' ? 2 : name === 'set' ? 1 : 0;
        nodes = (holder.arguments ?? []).slice(skip);
      }
    }
    if (nodes.length === 0) return;
    const list = this.storesTo.get(binding);
    if (list) list.push(...nodes);
    else this.storesTo.set(binding, [...nodes]);
  }

  /** A function declared in a block, not directly in a function body or the program. */
  private isBlockLevel(node: AnyNode): boolean {
    const holder = this.parentOf.get(node);
    const outer = holder ? this.parentOf.get(holder) : undefined;
    const direct =
      holder?.type === 'Program' ||
      (holder?.type === 'BlockStatement' &&
        (outer?.type === 'FunctionDeclaration' ||
          outer?.type === 'FunctionExpression' ||
          outer?.type === 'ArrowFunctionExpression'));
    return !direct;
  }

  /**
   * Look, in the shape of the script, for what lets it change a built-in: a property name that
   * leads to a prototype, `with`, code that is loaded, a function declared in a block under the
   * name of a built-in (which the language may hoist over it), `this` where it may be the global
   * object. And note what the answer for a built-in that is handed on depends on: the objects
   * the script writes to.
   */
  private checkTrust(node: AnyNode): void {
    switch (node.type) {
      case 'WithStatement':
      case 'ImportExpression':
        this.trusted = false;
        break;

      case 'MemberExpression': {
        if (this.isTarget(node)) this.writeTargets.push(node.object);
        const name = staticName(node);
        if (name === undefined) {
          // A key that is computed: looked at once the rest of the script is known (`checkKeys`)
          if (node.computed && node.property?.type !== 'Literal') this.computedKeys.push(node.property);
          break;
        }
        if (PROTOTYPE_NAMES.has(name)) this.trusted = false;
        else if (name === 'assign') {
          // `Object.assign(target, ...)` writes to its first argument; the function under
          // another name writes to whatever it is given
          const parent = this.parentOf.get(node);
          if (parent?.type === 'CallExpression' && parent.callee === node) this.assignCalls.push(parent);
          else this.looseWrite = true;
        }
        break;
      }

      case 'Property': {
        if (this.parentOf.get(node)?.type !== 'ObjectPattern') break;
        if (node.computed) {
          if (node.key?.type !== 'Literal') this.computedKeys.push(node.key);
          break;
        }
        const key = node.key;
        const name = key?.type === 'Identifier' ? key.name : key?.type === 'Literal' ? String(key.value) : undefined;
        if (name === undefined) break;
        if (PROTOTYPE_NAMES.has(name)) this.trusted = false;
        else if (name === 'assign') this.looseWrite = true;
        break;
      }

      case 'FunctionDeclaration':
        // Directly in a function body or the program it is an ordinary declaration
        if (node.id && isBuiltinName(node.id.name) && this.isBlockLevel(node)) this.trusted = false;
        break;

      case 'PropertyDefinition': {
        // A field of a class that extends something is defined on what the constructor of the
        // base returned, which may be any object: a write without an assignment
        const owner = this.parentOf.get(this.parentOf.get(node));
        if (node.static !== true && owner?.superClass) this.looseWrite = true;
        break;
      }

      case 'ThisExpression': {
        // In a class, `this` is the instance. Anywhere else it may be the global object:
        // `this.name` reads a property of it, any other use hands it on.
        if (this.isInClass(node)) break;
        const parent = this.parentOf.get(node);
        const name = parent?.type === 'MemberExpression' && parent.object === node ? staticName(parent) : undefined;
        if (name === undefined) this.holderEscapes = true;
        else if (isBuiltinName(name)) this.trusted = false;
        break;
      }

      default:
        break;
    }
  }

  /** Whether an expression is assigned to, updated or deleted. */
  private isTarget(node: AnyNode): boolean {
    let top: AnyNode = node;
    let parent = this.parentOf.get(top);
    while (parent?.type === 'ChainExpression' || parent?.type === 'ParenthesizedExpression') {
      top = parent;
      parent = this.parentOf.get(top);
    }
    return parent !== undefined && this.isTargetAt(top, parent);
  }

  private isTargetAt(top: AnyNode, parent: AnyNode): boolean {
    return (
      (parent.type === 'AssignmentExpression' && parent.left === top) ||
      parent.type === 'UpdateExpression' ||
      (parent.type === 'UnaryExpression' && parent.operator === 'delete') ||
      parent.type === 'ArrayPattern' ||
      parent.type === 'RestElement' ||
      (parent.type === 'AssignmentPattern' && parent.left === top) ||
      (parent.type === 'Property' && parent.value === top && this.parentOf.get(parent)?.type === 'ObjectPattern') ||
      ((parent.type === 'ForOfStatement' || parent.type === 'ForInStatement') && parent.left === top)
    );
  }

  /**
   * How a free name of a built-in that holds the functions the evaluation computes with is used:
   *
   * - `changed`: a member of it is assigned, or is reached by a name that is not written out
   *   (which may be the one that hands the built-in back, or one that writes).
   * - `handed on`: it is used as a value. Whoever gets it can change it.
   * - `used`: it is called, a member of it is read or called (a function or a primitive it
   *   holds is not the built-in), or it is an operand.
   */
  private holderUse(node: AnyNode): 'used' | 'handed on' | 'changed' {
    const name: string = node.name;
    let top: AnyNode = node;
    let parent = this.parentOf.get(top);
    let depth = 0;
    let first: string | undefined;
    let plainChain = true;
    // The member chain the name is the root of: `Math.max`, `Object.prototype.toString`
    while (parent?.type === 'MemberExpression' && parent.object === top) {
      let member = staticName(parent);
      if (member === undefined && parent.computed) {
        const names = this.peekNames(parent.property);
        if (names?.length === 1) member = names[0];
      }
      if (depth === 0) first = member;
      // (`Number.valueOf()` is `Number`)
      if (member === undefined || member === 'valueOf') plainChain = false;
      top = parent;
      parent = this.parentOf.get(top);
      depth++;
    }
    while (parent?.type === 'ChainExpression' || parent?.type === 'ParenthesizedExpression') {
      top = parent;
      parent = this.parentOf.get(top);
    }
    if (!parent) return 'handed on';
    if (!plainChain || this.isTargetAt(top, parent)) return 'changed';

    if (depth > 0) {
      // A member of the global object that is itself such a built-in (`globalThis.Math`) is
      // that built-in; anything else read off one is a function or a primitive
      if (!GLOBAL_OBJECT_NAMES.has(name) || depth > 1 || first === undefined || !isHolder(first)) return 'used';
    }

    switch (parent.type) {
      case 'CallExpression':
      case 'NewExpression': {
        if (parent.callee === top) return 'used';
        // `Math.max.apply(Math, list)`: the object a function of a built-in is called on
        const callee: AnyNode = parent.callee;
        const method = callee?.type === 'MemberExpression' ? staticName(callee) : undefined;
        if (
          parent.arguments?.[0] === top &&
          (method === 'call' || method === 'apply') &&
          callee.object?.type === 'MemberExpression' &&
          this.isFreeHolder(callee.object.object)
        ) {
          return 'used';
        }
        break;
      }
      case 'TaggedTemplateExpression':
        if (parent.tag === top) return 'used';
        break;
      case 'MemberExpression':
        if (parent.property === top && parent.computed) return 'used'; // a key: it is converted
        break;
      case 'Property':
      case 'MethodDefinition':
      case 'PropertyDefinition':
        if (parent.key === top && parent.computed) return 'used';
        break;
      case 'BinaryExpression':
        // (`Math instanceof F` hands `Math` to a method of `F`)
        if (!(parent.operator === 'instanceof' && parent.left === top)) return 'used';
        break;
      case 'UnaryExpression':
      case 'ExpressionStatement':
        return 'used';
      case 'TemplateLiteral':
        // Converted to a string; in a tagged template it is handed to the tag as it is
        if (this.parentOf.get(parent)?.type !== 'TaggedTemplateExpression') return 'used';
        break;
      case 'IfStatement':
      case 'WhileStatement':
      case 'DoWhileStatement':
      case 'ForStatement':
      case 'ConditionalExpression':
        if (parent.test === top) return 'used';
        break;
      case 'ClassDeclaration':
      case 'ClassExpression':
        if (parent.superClass === top) return 'used';
        break;
      case 'VariableDeclarator': {
        // `const { min, max } = Math`: functions of it, under their own names
        const pattern: AnyNode = parent.id;
        if (parent.init === top && pattern?.type === 'ObjectPattern') {
          const leaves = (pattern.properties ?? []).every(
            (property: AnyNode) =>
              property.type === 'Property' &&
              !property.computed &&
              property.key?.type === 'Identifier' &&
              !isHolder(property.key.name),
          );
          if (leaves) return 'used';
        }
        break;
      }
      default:
        break;
    }
    return 'handed on';
  }

  private isFreeHolder(node: AnyNode): boolean {
    return node?.type === 'Identifier' && isHolder(node.name) && this.bindingOf.get(node) === null;
  }

  // --- entry points ---------------------------------------------------------------------------

  /** Remember a key that is unresolved, to be reported. */
  note(key: AnyNode): void {
    this.pending.add(key);
  }

  /**
   * The unresolved keys noted since the last call that have not been reported at `rank` or
   * above. A key several rules read is reported once, unless a rule that counts for more reads it
   * after one that counts for less.
   */
  take(rank: number): AnyNode[] {
    const keys: AnyNode[] = [];
    for (const key of this.pending) {
      const reported = this.reportedAt.get(key);
      if (reported !== undefined && reported >= rank) continue;
      this.reportedAt.set(key, rank);
      keys.push(key);
    }
    this.pending = new Set();
    return keys;
  }

  /**
   * Every value `node` may have.
   *
   * @param asKey The expression is a property key: a value too large to build is an error of the
   *   validation (`StaticKeyExpansionError`), as it has been. Elsewhere it is an unresolved value.
   * @param variables Follow the variables of the script
   */
  describe(node: AnyNode, asKey: boolean, variables: boolean): StaticAlternative[] {
    const memo = variables ? this.described.followed : this.described.plain;
    const cached = memo.get(node);
    if (cached) return cached;
    // (Known to be too large to build: an error for a key, an unresolved value elsewhere,
    // whichever way it was asked about first)
    const sized = variables ? this.tooLong.followed : this.tooLong.plain;
    const large = sized.get(node);
    if (large) {
      if (asKey) throw new StaticKeyExpansionError(large.loc ? large : node);
      return [{ type: 'unresolved' }];
    }
    // Inside `with`, a name may be a property of its object, whatever it is outside: an
    // expression that names anything is not computed
    if (this.inWith.has(node) && this.namesAnything(node)) {
      const unread: StaticAlternative[] = [{ type: 'unresolved' }];
      memo.set(node, unread);
      return unread;
    }

    this.variables = variables;
    this.lenient = false;
    this.steps = 0;
    this.limit = this.stepLimit;
    this.depth = 0;
    this.writes = 0;
    this.heap = 0;
    this.disturbed = false;
    this.effect = false;
    this.assumed = false;
    this.epoch = ++this.epochs;
    let result: StaticAlternative[];
    try {
      result = this.summarize(this.ev(node, undefined), node);
      // An expression has a value: none found is a value not found
      if (result.length === 0) result = [{ type: 'unresolved' }];
      else if (this.disturbed || this.assumed) {
        // Something in the expression assigned or was not evaluated, or rests on a built-in the
        // script can have changed. What was computed is then a set of names to compare, not the
        // value. The value of an expression made of constants is not known, which a rule
        // refuses. Any other is only known at run time.
        const missing = this.isClosed(node, undefined) ? 'unresolved' : 'dynamic';
        if (!result.some((alternative) => alternative.type === missing)) result = [...result, { type: missing }];
      }
      // The names such an expression may still be seen having are looked for, so that a refused
      // name in it is named. (Where the evaluation changed or skipped nothing, a second one
      // reads the same.)
      const open = result.some((alternative) => alternative.type === 'dynamic' || alternative.type === 'unresolved');
      if (open && this.writes + this.heap > 0) result = [...result, ...this.candidates(node, result)];
    } catch (signal) {
      if (!isSignal(signal)) throw signal;
      if (variables) {
        // Following the variables ends where it costs too much: the expression is then read as
        // it is written, which is a limit of its own
        try {
          result = this.describe(node, asKey, false);
        } finally {
          // (Too large as it is written: it is that for this way of reading as well)
          const written = this.tooLong.plain.get(node);
          if (written) sized.set(node, written);
        }
        if (sized.has(node)) return result;
        // As it is written, a variable is a run-time value. Here it is one that was not followed
        // to its end: what depends on it is not known, and a key that is not known is refused.
        // (A limit that is reached never makes a key one that is decided at run time.)
        if (result.some((alternative) => alternative.type === 'dynamic')) {
          result = result.filter((alternative) => alternative.type !== 'dynamic');
          if (!result.some((alternative) => alternative.type === 'unresolved')) result.push({ type: 'unresolved' });
        }
      } else if (signal instanceof TooLong) {
        const large: AnyNode = signal.node?.loc ? signal.node : node;
        sized.set(node, large);
        if (asKey) throw new StaticKeyExpansionError(large);
        return [{ type: 'unresolved' }];
      } else {
        result = [{ type: 'unresolved' }];
      }
    }
    memo.set(node, result);
    return result;
  }

  /**
   * The names an expression with a run-time part may still be seen having: it is evaluated once
   * more, reading what the first evaluation would not (an array after a call that is not
   * followed, a variable after an assignment). A search: it adds names, and it ends where it
   * costs too much.
   */
  private candidates(node: AnyNode, known: StaticAlternative[]): StaticAlternative[] {
    const have = new Set(known.map((alternative) => alternative.key));
    const saved = { steps: this.steps, limit: this.limit };
    this.lenient = true;
    this.limit = this.steps + this.stepLimit;
    this.depth = 0;
    this.writes = 0;
    this.heap = 0;
    const assumed = this.assumed;
    this.disturbed = false;
    this.effect = false;
    this.epoch = ++this.epochs;
    try {
      return this.summarize(this.ev(node, undefined), node).filter(
        (alternative) => alternative.key !== undefined && !have.has(alternative.key),
      );
    } catch (signal) {
      if (!isSignal(signal)) throw signal;
      // The search ended on a limit. Where the variables are followed, the names it would have
      // found are what decides the key: it is not known. (Where they are not, the key is one
      // for the check that follows the validator, with or without the names.)
      return this.variables ? [{ type: 'unresolved' }] : [];
    } finally {
      this.lenient = false;
      this.assumed = assumed;
      this.steps = saved.steps;
      this.limit = saved.limit;
    }
  }

  private summarize(values: Value[], node: AnyNode): StaticAlternative[] {
    const out: StaticAlternative[] = [];
    const seen = new Set<string>();
    const push = (alternative: StaticAlternative): void => {
      const id =
        `${alternative.type}|${alternative.key === undefined ? '' : `k${alternative.key}`}|` +
        `${typeof alternative.value}:${String(alternative.value)}`;
      if (seen.has(id)) return;
      seen.add(id);
      out.push(alternative);
    };

    for (const value of values) {
      switch (value.kind) {
        case 'primitive':
          if (value.boxed) {
            // An object: it is a key through its own conversion
            for (const converted of this.toPrimitive(value, 'string', node, undefined)) {
              if (converted.kind === 'primitive') push({ type: 'object', key: String(converted.value) });
              else push({ type: converted.kind === 'dynamic' ? 'dynamic' : 'unresolved' });
            }
          } else {
            push({ type: 'primitive', value: value.value, key: String(value.value) });
          }
          break;
        case 'symbol':
          push({ type: 'symbol' });
          break;
        case 'function':
        case 'builtin':
        case 'method':
          // As a key it is the text of the function: never an identifier
          push({ type: 'function' });
          break;
        case 'regexp':
          push({ type: 'object', key: `/${value.source}/${value.flags}` });
          break;
        case 'array':
        case 'object': {
          // (What was stored into a variable's list, taken together, is not a key of the script:
          // it is looked at for a name where it is short enough to be one)
          const conversions =
            value.kind === 'array' && value.bag
              ? this.attempt(() => this.toPrimitive(value, 'string', node, undefined)).filter(isResolved)
              : this.toPrimitive(value, 'string', node, undefined);
          // A key is converted with `toString` first. An object that also has a `valueOf` is
          // converted with that first wherever it is added to a string (`'' + object`), which
          // is one edit away: the name it would give there is reported here as well. (A refusal
          // the engine would not need, on purpose: see rules.spec, "valueOf arrow".)
          if (value.kind === 'object' && value.properties.has('valueOf')) {
            conversions.push(...this.toPrimitive(value, 'number', node, undefined));
          }
          for (const converted of conversions) {
            if (converted.kind === 'primitive') push({ type: 'object', key: String(converted.value) });
            else if (converted.kind === 'symbol') push({ type: 'symbol' });
            else push({ type: converted.kind === 'dynamic' ? 'dynamic' : 'unresolved' });
          }
          break;
        }
        case 'unresolved':
          push({ type: 'unresolved' });
          break;
        case 'dynamic':
          push({ type: 'dynamic' });
          break;
      }
    }
    return out;
  }

  // --- bookkeeping ----------------------------------------------------------------------------

  /**
   * Pay for `count` steps of work. Work that is paid for before it is done (a copy into many
   * lists) and that goes past what one key may cost is not done: the script as a whole is
   * charged for what the key could still spend, not for the work that did not happen, so that
   * one costly key is refused without the keys after it being refused for it.
   */
  private tick(count = 1): void {
    const room = Math.max(0, this.limit - this.steps);
    this.steps += count;
    this.total += Math.min(count, room + 1);
    if (this.steps > this.limit || this.total > this.totalLimit) throw new OutOfBudget();
  }

  /**
   * What a built-in gives is computed as the language says. In a script that can have changed a
   * built-in that is an assumption, and it is recorded: an expression that rests on it has no
   * computed value, only names to compare (see `describe`).
   */
  private get ok(): boolean {
    if (!this.trusted && !this.lenient) this.assumed = true;
    return true;
  }

  /** A string that is built here. */
  private text(value: string, node: AnyNode): PrimitiveValue {
    if (value.length > MAX_STATIC_KEY_LENGTH) throw new TooLong(node);
    this.tick(value.length >> 6);
    return primitive(value);
  }

  /**
   * What a native operation costs for the texts it reads: a step for every 16 characters, as a
   * method of a text costs. What the evaluation builds is short; a literal is as long as it is
   * written, and is read again by every operation it is handed to.
   */
  private read(...operands: StaticPrimitive[]): void {
    let length = 0;
    for (const operand of operands) {
      if (typeof operand === 'string') length += operand.length;
    }
    if (length >= 16) this.tick(length >> 4);
  }

  /** An array that is built here. */
  private arrayOf(items: readonly Value[], node: AnyNode): ArrayValue {
    if (items.length > MAX_ITEMS) throw new TooLong(node);
    this.tick(items.length >> 3);
    return this.rawArray(items);
  }

  /** An array whose size is that of something the script wrote out. */
  private rawArray(items: readonly Value[]): ArrayValue {
    return { kind: 'array', items, epoch: this.epoch, born: this.heap };
  }

  private objectOf(
    properties: Map<string, Slot>,
    symbols: Map<string, Slot>,
    proto: ObjectValue | null | undefined,
  ): ObjectValue {
    return { kind: 'object', properties, symbols, proto, epoch: this.epoch, born: this.heap };
  }

  /**
   * Whether what an array or an object holds is still what it was made with: nothing that could
   * change it has happened since. (One that a variable of the script holds is a different matter:
   * it comes with "or anything else", and is read for the names it can be seen holding.)
   */
  private fresh(value: ArrayValue | ObjectValue): boolean {
    return this.lenient || value.epoch !== this.epoch || value.born === this.heap;
  }

  /** A part of the expression is not evaluated: whatever it does is not known. */
  private skipped(): void {
    this.writes++;
    this.heap++;
    this.disturbed = true;
  }

  /**
   * An expression that is not evaluated: unresolved when it is made of constants.
   *
   * @param object What it gives is an object (an array, a collection, an instance)
   */
  private giveUp(node: AnyNode, env: Env | undefined, object = false): Value[] {
    this.skipped();
    if (!this.isClosed(node, env)) return [DYNAMIC];
    return [object ? UNRESOLVED_OBJECT : UNRESOLVED];
  }

  /** Drop duplicates. More alternatives than can be enumerated is a value that is not computed. */
  private settle(values: Value[]): Value[] {
    if (values.length <= 1) return values;
    this.tick(values.length >> 2);
    const out: Value[] = [];
    const seen = new Set<string>();
    for (const value of values) {
      let id: string | undefined;
      if (value.kind === 'dynamic') id = 'dynamic';
      else if (value.kind === 'unresolved') id = value.held ? 'held' : value.object ? 'object' : 'unresolved';
      else if (value.kind === 'primitive' && !value.boxed) {
        id = value === STOPPED ? 'stopped' : value === HOLE ? 'hole' : `${typeof value.value}:${String(value.value)}`;
      }
      if (id !== undefined) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      out.push(value);
    }
    if (out.length > MAX_ALTERNATIVES) throw new OutOfBudget();
    return out;
  }

  /** The values an evaluation gives; unresolved where it ends early. */
  private attempt(compute: () => Value[]): Value[] {
    try {
      return compute();
    } catch (signal) {
      if (!isSignal(signal)) throw signal;
      return [UNRESOLVED];
    }
  }

  // --- constants or not -----------------------------------------------------------------------

  /**
   * Whether `root` is made of constants: every name it uses is declared inside it, is a `const`
   * that holds a constant primitive, is a variable of a function being applied, or is a global
   * of the language.
   */
  private isClosed(root: AnyNode, env: Env | undefined): boolean {
    const memo = this.variables ? this.closedMemo.followed : this.closedMemo.plain;
    if (!env) {
      const cached = memo.get(root);
      if (cached !== undefined) return cached;
    }
    const closed = this.computeClosed(root, env);
    if (!env) memo.set(root, closed);
    return closed;
  }

  private computeClosed(root: AnyNode, env: Env | undefined): boolean {
    const inside = (node: AnyNode): boolean =>
      typeof node?.start === 'number' &&
      typeof root.start === 'number' &&
      node.start >= root.start &&
      node.end <= root.end;

    // `own`: inside a function that has its own `this`, `arguments` and `new.target`: one of the
    // expression, or the one that is being applied
    const stack: Array<{ node: AnyNode; own: boolean; generator: boolean }> = [
      { node: root, own: ownsSelf(env), generator: false },
    ];

    while (stack.length > 0) {
      const { node, own, generator } = stack.pop() as { node: AnyNode; own: boolean; generator: boolean };
      this.tick();

      switch (node.type) {
        case 'Identifier': {
          const binding = this.bindingOf.get(node);
          if (binding === undefined) break; // a property name, a label
          if (this.writeOnly.has(node)) break; // assigned, not read
          if (binding === null) {
            if (node.name === 'arguments' && own) break;
            if (!isClosedGlobal(node.name) && !GLOBAL_OBJECT_NAMES.has(node.name)) return false;
            break;
          }
          if (inside(binding.node)) break;
          const bound = lookupEnv(env, binding.node);
          if (bound) {
            if (bound.values.some((value) => value.kind === 'dynamic')) return false;
            break;
          }
          if (isLocalOf(env, binding.node)) break; // of the function being applied, and not followed
          if (!this.variables || !this.isSimpleConst(binding)) return false;
          if (this.bindingValues(binding).some((value) => value.kind === 'dynamic')) return false;
          break;
        }

        case 'ThisExpression':
          // (At the top of a script `this` is the global object, or nothing: not a run-time value)
          if (!own && !this.isTopLevel(node)) return false;
          break;

        case 'Super':
          if (!own) return false;
          break;

        case 'MetaProperty':
          // `new.target` belongs to a function; `import.meta` to the host
          if (!(own && node.meta?.name === 'new')) return false;
          break;

        case 'YieldExpression':
          if (!generator) return false;
          if (node.argument) stack.push({ node: node.argument, own, generator });
          break;

        case 'ImportExpression':
          return false;

        case 'FunctionExpression':
        case 'FunctionDeclaration':
          forEachChild(node, (child) => stack.push({ node: child, own: true, generator: node.generator === true }));
          break;

        case 'ArrowFunctionExpression':
          forEachChild(node, (child) => stack.push({ node: child, own, generator: false }));
          break;

        case 'PropertyDefinition':
        case 'StaticBlock':
          // A field initializer and a static block run with the instance or the class as `this`
          forEachChild(node, (child) => stack.push({ node: child, own: true, generator: false }));
          break;

        case 'MemberExpression': {
          const object = node.object;
          if (this.isGlobalObject(object)) {
            // `globalThis.name` is the global `name`, and `globalThis.globalThis` or
            // `globalThis.valueOf()` is the global object again; any other member of it is the host's
            const name = staticName(node);
            if (name === undefined || !(isClosedGlobal(name) || isGlobalObjectMember(name))) return false;
            break;
          }
          forEachChild(node, (child) => stack.push({ node: child, own, generator }));
          break;
        }

        case 'CallExpression':
        case 'NewExpression':
          if (this.isRuntimeCall(node)) return false;
          forEachChild(node, (child) => stack.push({ node: child, own, generator }));
          break;

        default:
          forEachChild(node, (child) => stack.push({ node: child, own, generator }));
      }
    }
    return true;
  }

  /** Whether a node is outside every function that has a `this` of its own. */
  private isTopLevel(node: AnyNode): boolean {
    for (let current = this.parentOf.get(node); current; current = this.parentOf.get(current)) {
      switch (current.type) {
        case 'FunctionDeclaration':
        case 'FunctionExpression':
        case 'ClassBody':
        case 'StaticBlock':
          return false;
        default:
          break;
      }
    }
    return true;
  }

  private isFreeName(node: AnyNode, name: string): boolean {
    return node?.type === 'Identifier' && node.name === name && this.bindingOf.get(node) === null;
  }

  private isGlobalObject(node: AnyNode): boolean {
    return node?.type === 'Identifier' && GLOBAL_OBJECT_NAMES.has(node.name) && this.bindingOf.get(node) === null;
  }

  /**
   * A call whose result is not in the script: the random number generator, the clock, and a
   * date (what a date gives depends on the time zone of the host): `Math.random()`, `Date.now()`,
   * `new Date(2024, 0, 1)`, `Date.UTC(...)`.
   * (The functions themselves are constants: `Math.random.name` is.)
   */
  private isRuntimeCall(node: AnyNode): boolean {
    const callee = node.callee;
    if (this.isFreeName(callee, 'Date')) return true;
    if (node.type !== 'CallExpression' || callee?.type !== 'MemberExpression') return false;
    if (this.isFreeName(callee.object, 'Date')) return true;
    return !callee.computed && this.isFreeName(callee.object, 'Math') && callee.property?.name === 'random';
  }

  // --- variables ------------------------------------------------------------------------------

  /** Where the variable an identifier stands for gets its value at that identifier. */
  private sourceOf(identifier: AnyNode): Source {
    let child: AnyNode = identifier;
    let parent = this.parentOf.get(child);
    let defaultNode: AnyNode | undefined;
    const path: PatternStep[] = [];

    if (parent?.type === 'AssignmentPattern' && parent.left === child) {
      defaultNode = parent.right;
      child = parent;
      parent = this.parentOf.get(child);
    }

    for (let guard = 0; parent && guard < 10_000; guard++) {
      switch (parent.type) {
        case 'VariableDeclarator': {
          if (parent.id !== child) return { kind: 'other', defaultNode };
          const declaration = this.parentOf.get(parent);
          const holder = declaration ? this.parentOf.get(declaration) : undefined;
          const loop =
            (holder?.type === 'ForOfStatement' || holder?.type === 'ForInStatement') && holder.left === declaration
              ? holder
              : undefined;
          return path.length === 0
            ? { kind: 'simple', init: parent.init, loop, defaultNode }
            : { kind: 'pattern', init: parent.init, loop, path, defaultNode };
        }
        case 'AssignmentExpression':
          // `[a, b] = value`, `({ a } = value)`: a pattern that assigns
          if (parent.left !== child || parent.operator !== '=' || path.length === 0) {
            return { kind: 'other', defaultNode };
          }
          return { kind: 'pattern', init: parent.right, path, defaultNode };
        case 'ForOfStatement':
        case 'ForInStatement':
          // `for (name of list)`, `for ([a, b] of list)` with variables that exist already
          if (parent.left !== child) return { kind: 'other', defaultNode };
          return path.length === 0
            ? { kind: 'simple', init: undefined, loop: parent, defaultNode }
            : { kind: 'pattern', init: undefined, loop: parent, path, defaultNode };
        case 'Property':
          if (parent.value !== child) return { kind: 'other', defaultNode };
          path.push({ type: 'key', property: parent });
          break;
        case 'ObjectPattern':
          break;
        case 'RestElement': {
          // `[first, ...rest]`: what is left of an array. `{ a, ...rest }`: what is left of an
          // object, which is read as the object (it holds no more than the object does).
          const holder = this.parentOf.get(parent);
          if (
            (holder?.type === 'FunctionExpression' ||
              holder?.type === 'ArrowFunctionExpression' ||
              holder?.type === 'FunctionDeclaration') &&
            (holder.params ?? []).includes(parent)
          ) {
            // `(...rest)`: the arguments of each call, from where it stands on, in a list
            return { kind: 'param', fn: holder, index: holder.params.indexOf(parent), path, defaultNode, rest: true };
          }
          if (holder?.type === 'ObjectPattern') {
            path.push({ type: 'objectRest' });
          } else {
            const index = holder?.type === 'ArrayPattern' ? (holder.elements ?? []).indexOf(parent) : -1;
            if (index < 0) return { kind: 'other', defaultNode };
            path.push({ type: 'rest', index });
          }
          child = holder;
          parent = this.parentOf.get(child);
          continue;
        }
        case 'CatchClause': {
          // `catch (name)`: what the `try` block can be seen throwing
          const statement = this.parentOf.get(parent);
          if (parent.param !== child || path.length > 0 || statement?.type !== 'TryStatement') {
            return { kind: 'other', defaultNode };
          }
          return { kind: 'catch', block: statement.block };
        }
        case 'ArrayPattern': {
          const index = (parent.elements ?? []).indexOf(child);
          if (index < 0) return { kind: 'other', defaultNode };
          path.push({ type: 'index', index });
          break;
        }
        case 'AssignmentPattern':
          if (parent.left !== child) return { kind: 'other', defaultNode };
          path.push({ type: 'default', node: parent.right });
          break;
        case 'FunctionExpression':
        case 'ArrowFunctionExpression':
        case 'FunctionDeclaration':
          if (parent.id === child) return { kind: 'function', node: parent };
          return { kind: 'param', fn: parent, index: (parent.params ?? []).indexOf(child), path, defaultNode };
        case 'ClassDeclaration':
        case 'ClassExpression':
          return parent.id === child ? { kind: 'class', node: parent } : { kind: 'other', defaultNode };
        default:
          return { kind: 'other', defaultNode };
      }
      child = parent;
      parent = this.parentOf.get(child);
    }
    return { kind: 'other', defaultNode };
  }

  /** `const name = <expression>`, declared once: one assignment, for as long as the variable exists. */
  private isSimpleConst(binding: ScopeBinding): boolean {
    if (binding.kind !== 'const' || binding.redeclarations) return false;
    const source = this.sourceOf(binding.node);
    return source.kind === 'simple' && !source.loop && isAstNode(source.init);
  }

  /** The `const` variables the initializer of a `const` uses. */
  private constDependencies(binding: ScopeBinding): ScopeBinding[] {
    const cached = this.dependencies.get(binding);
    if (cached) return cached;

    const found: ScopeBinding[] = [];
    const source = this.sourceOf(binding.node);
    if (source.kind === 'simple' && isAstNode(source.init)) {
      const stack: AnyNode[] = [source.init];
      while (stack.length > 0) {
        const node = stack.pop();
        this.tick();
        if (node.type === 'Identifier') {
          const used = this.bindingOf.get(node);
          if (used && used !== binding && !found.includes(used) && this.isSimpleConst(used)) found.push(used);
        } else {
          forEachChild(node, (child) => stack.push(child));
        }
      }
    }
    this.dependencies.set(binding, found);
    return found;
  }

  /** Whether an expression names a variable. */
  private mentions(root: AnyNode, binding: ScopeBinding): boolean {
    const stack: AnyNode[] = [root];
    while (stack.length > 0) {
      const node = stack.pop();
      this.tick();
      if (node.type === 'Identifier') {
        if (this.bindingOf.get(node) === binding) return true;
      } else {
        forEachChild(node, (child) => stack.push(child));
      }
    }
    return false;
  }

  /**
   * Every value a variable of the script may hold. For a `const` that holds a constant primitive
   * this is its value. For every other variable it is the constants the script can be seen
   * giving it, and `dynamic`.
   */
  private bindingValues(binding: ScopeBinding): Value[] {
    const cached = this.bindingMemo.get(binding);
    if (cached) return cached;
    if (this.computing.has(binding)) return [DYNAMIC];

    // A chain of constants (`const b = a + ''; const c = b + ''; ...`) is computed from its start,
    // one constant at a time, so that its length is not the depth of this evaluation.
    if (this.isSimpleConst(binding)) {
      const pending: ScopeBinding[] = [binding];
      const expanded = new Set<ScopeBinding>();
      while (pending.length > 0) {
        const current = pending[pending.length - 1];
        if (this.bindingMemo.has(current) || this.computing.has(current)) {
          pending.pop();
          continue;
        }
        if (!expanded.has(current)) {
          expanded.add(current);
          const waiting = this.constDependencies(current).filter(
            (used) => !this.bindingMemo.has(used) && !this.computing.has(used) && !expanded.has(used),
          );
          if (waiting.length > 0) {
            pending.push(...waiting);
            continue;
          }
        }
        pending.pop();
        this.computeBinding(current);
      }
      return this.bindingMemo.get(binding) ?? [DYNAMIC];
    }

    return this.computeBinding(binding);
  }

  private computeBinding(binding: ScopeBinding): Value[] {
    this.computing.add(binding);
    // What a variable is given is an expression of its own: what it changes, it changed where
    // the variable was declared, and it has a budget of its own
    const saved = {
      steps: this.steps,
      limit: this.limit,
      writes: this.writes,
      heap: this.heap,
      disturbed: this.disturbed,
      effect: this.effect,
      assumed: this.assumed,
      epoch: this.epoch,
      lenient: this.lenient,
    };
    this.steps = 0;
    this.limit = this.stepLimit;
    this.writes = 0;
    this.heap = 0;
    this.disturbed = false;
    this.effect = false;
    this.assumed = false;
    this.epoch = ++this.epochs;
    this.lenient = false;
    try {
      const values = this.readBinding(binding);
      this.bindingMemo.set(binding, values);
      return values;
    } finally {
      this.steps = saved.steps;
      this.limit = saved.limit;
      this.writes = saved.writes;
      this.heap = saved.heap;
      this.disturbed = saved.disturbed;
      this.effect = saved.effect;
      // (An expression that reads a variable whose value rests on a built-in rests on it too)
      this.assumed = saved.assumed || this.assumed;
      this.epoch = saved.epoch;
      this.lenient = saved.lenient;
      this.computing.delete(binding);
    }
  }

  private readBinding(binding: ScopeBinding): Value[] {
    const source = this.sourceOf(binding.node);

    if (this.isSimpleConst(binding) && source.kind === 'simple') {
      const init: AnyNode = source.init;
      const exact = this.attempt(() => this.ev(init, undefined));
      // (With a run-time part it is not a constant: what it may be is looked for below)
      if (exact.every(isScalar) && !exact.some((value) => value.kind === 'dynamic')) {
        if (!this.disturbed && !this.assumed) return exact;
        // Something in the initializer assigned or was not evaluated, or rests on a built-in the
        // script can have changed: what was computed is what the constant may be, not what it is
        const closed = this.attempt(() => (this.isClosed(init, undefined) ? [UNRESOLVED] : []));
        if (closed.length > 0)
          return exact.some((value) => value.kind === 'unresolved') ? exact : [...exact, UNRESOLVED];
      }
      // An array, an object or a function a variable holds can change while the script runs:
      // what is read through the variable is a run-time value, next to what it can be seen holding
    }

    // The constants the variable can be seen holding, and "or anything else"
    this.lenient = true;
    const known: Value[] = [];
    const seen = new Set<string>();
    let unresolved = false;
    const take = (values: Value[]): boolean => {
      let grew = false;
      for (const value of values) {
        if (value.kind === 'dynamic') continue;
        if (value.kind === 'unresolved') {
          // An object that is not read (a collection, an instance) is a run-time value where it
          // is read from. A constant that is not computed is a name that cannot be read.
          if (!value.object) unresolved = true;
          else if (!seen.has('held')) {
            seen.add('held');
            known.push(HELD_OBJECT);
          }
          continue;
        }
        if (value.kind === 'primitive' && !value.boxed) {
          const id = `${typeof value.value}:${String(value.value)}`;
          if (seen.has(id)) continue;
          seen.add(id);
        }
        known.push(value);
        grew = true;
      }
      return grew;
    };

    for (const declaration of [binding, ...(binding.redeclarations ?? [])]) {
      take(this.attempt(() => this.sourceValues(this.sourceOf(declaration.node), declaration)));
      // A variable declared with `var` exists, as `undefined`, before the line that gives it a value
      if (declaration.kind === 'var' || declaration.kind === 'function') take([UNDEFINED]);
    }

    // Assignments that build on what the variable holds are applied after the others
    const building: Array<() => Value[]> = [];
    for (const write of this.writesTo.get(binding) ?? []) {
      if ('target' in write) {
        take(this.attempt(() => this.sourceValues(this.sourceOf(write.target), undefined)));
        continue;
      }
      const { operator, right } = write;
      if (operator === '=' || LOGICAL_ASSIGNMENTS.has(operator)) {
        take(this.attempt(() => this.ev(right, undefined)));
        if (this.attempt(() => (this.mentions(right, binding) ? [DYNAMIC] : [])).length > 0) {
          building.push(() => this.ev(right, undefined));
        }
      } else {
        building.push(() =>
          this.binaryValues(
            operator.slice(0, -1),
            known.filter(isResolved),
            this.ev(right, undefined),
            right,
            undefined,
          ),
        );
      }
    }

    const bag = this.bagOf(binding, known, () => {
      unresolved = true;
    });

    if (building.length > 0) {
      // `k += 'b'`, `k = k + 'b'`: from what the variable is known to hold, a few times over.
      // This is a search: it ends where it costs too much.
      const limit = this.limit;
      this.limit = Math.min(limit, this.steps + PASS_STEPS);
      try {
        for (let pass = 0; pass < MAX_PASSES; pass++) {
          this.bindingMemo.set(binding, [...known, DYNAMIC]);
          let grew = false;
          for (const compute of building) {
            if (take(compute())) grew = true;
          }
          if (!grew) break;
        }
      } catch (signal) {
        if (!isSignal(signal)) throw signal;
        // (What it would have built is not known)
        unresolved = true;
      } finally {
        this.limit = limit;
        this.bindingMemo.delete(binding);
      }
    }

    return [...known, ...(bag ? [bag] : []), ...(unresolved ? [UNRESOLVED] : []), DYNAMIC];
  }

  /** What a name the script assigns without declaring it can be seen holding, and "or anything else". */
  private globalValues(name: string, writes: Write[]): Value[] {
    const cached = this.globalMemo.get(name);
    if (cached) return cached;
    this.globalMemo.set(name, [DYNAMIC]); // (while it is computed: a name that is assigned itself)
    const saved = { lenient: this.lenient, disturbed: this.disturbed, effect: this.effect, assumed: this.assumed };
    this.lenient = true;
    const known: Value[] = [];
    let missed = false;
    try {
      for (const write of writes) {
        const values =
          'target' in write
            ? this.attempt(() => this.sourceValues(this.sourceOf(write.target), undefined))
            : write.operator === '=' || LOGICAL_ASSIGNMENTS.has(write.operator)
              ? this.attempt(() => this.ev(write.right, undefined))
              : [];
        known.push(...values.filter(isResolved));
        if (values.some((value) => value.kind === 'unresolved' && !value.object)) missed = true;
      }
    } finally {
      this.lenient = saved.lenient;
      this.disturbed = saved.disturbed;
      this.effect = saved.effect;
      this.assumed = saved.assumed;
    }
    // (A constant it was given that is not computed is one of the things it may hold)
    const values = [...known, ...(missed ? [UNRESOLVED] : []), DYNAMIC];
    this.globalMemo.set(name, values);
    return values;
  }

  /** The values the script can be seen storing into the array or the collection a variable holds. */
  private bagOf(binding: ScopeBinding, known: Value[], missed: () => void): ArrayValue | undefined {
    const nodes = this.storesTo.get(binding);
    if (!nodes) return undefined;
    const items: Value[] = [];
    for (const value of known) {
      if (value.kind === 'array') items.push(...dense(value.items));
    }
    for (const node of nodes) {
      // (The variable of a loop stands for every element of what the loop walks, in order)
      const binding = node.type === 'Identifier' ? this.bindingOf.get(node) : undefined;
      const source = binding ? this.sourceOf(binding.node) : undefined;
      const loop = source?.kind === 'simple' ? source.loop : undefined;
      const values = loop
        ? this.attempt(() => this.loopElements(loop))
        : node.type === 'SpreadElement'
          ? this.attempt(() => this.ev(node.argument, undefined)).flatMap((value) =>
              value.kind === 'array' ? dense(value.items) : [],
            )
          : this.attempt(() => this.ev(node, undefined));
      items.push(...values.filter(isResolved));
      // (A constant that was stored and is not computed is one of the things it may hold)
      if (values.some((value) => value.kind === 'unresolved' && !value.object)) missed();
    }
    return { kind: 'array', items, bag: true, epoch: this.epoch, born: this.heap };
  }

  /** The constants a declaration or an assigning pattern gives a variable. */
  private sourceValues(source: Source, declaration: ScopeBinding | undefined): Value[] {
    const out: Value[] = [];
    switch (source.kind) {
      case 'simple':
        if (source.loop) out.push(...this.loopElements(source.loop));
        else if (isAstNode(source.init)) out.push(...this.ev(source.init, undefined));
        else if (declaration && declaration.kind !== 'param') out.push(UNDEFINED);
        break;
      case 'pattern':
        out.push(
          ...this.project(
            source.loop
              ? this.loopElements(source.loop)
              : isAstNode(source.init)
                ? this.ev(source.init, undefined)
                : [],
            source.path,
          ),
        );
        break;
      case 'param':
        // What the calls of the function that can be seen give the parameter
        if (source.index >= 0) {
          out.push(...this.project(this.argumentsSeen(source.fn, source.index, source.rest === true), source.path));
        }
        break;
      case 'function':
        out.push({ kind: 'function', node: source.node, env: undefined, name: source.node.id?.name });
        break;
      case 'class':
        out.push(this.classStatics(source.node));
        break;
      case 'catch':
        for (const thrown of this.statementsOf(source.block, 'ThrowStatement')) {
          out.push(...this.attempt(() => this.ev(thrown.argument, undefined)));
        }
        break;
      default:
        break;
    }
    if (source.kind !== 'function' && source.kind !== 'class' && source.kind !== 'catch' && source.defaultNode) {
      out.push(...this.ev(source.defaultNode, undefined));
    }
    return out;
  }

  /** The nodes of one type in a body, not counting those of the functions and classes inside it. */
  private statementsOf(body: AnyNode, type: string): AnyNode[] {
    const found: AnyNode[] = [];
    const stack: AnyNode[] = [body];
    while (stack.length > 0) {
      const node = stack.pop();
      this.tick();
      if (node.type === type) found.push(node);
      if (
        node.type === 'FunctionExpression' ||
        node.type === 'FunctionDeclaration' ||
        node.type === 'ArrowFunctionExpression' ||
        node.type === 'ClassExpression' ||
        node.type === 'ClassDeclaration'
      ) {
        if (node !== body) continue;
      }
      forEachChild(node, (child) => stack.push(child));
    }
    return found;
  }

  /** The constants a generator can be seen yielding: what a loop over it, or `next()`, may give. */
  private yieldsOf(definition: AnyNode): ArrayValue {
    const items: Value[] = [];
    for (const expression of this.statementsOf(definition.body, 'YieldExpression')) {
      const argument: AnyNode = expression.argument;
      if (!argument) continue;
      for (const value of this.attempt(() => this.ev(argument, undefined))) {
        // `yield* list` yields what the list holds
        if (expression.delegate === true && value.kind === 'array') items.push(...dense(value.items));
        else if (isResolved(value)) items.push(value);
      }
    }
    return { kind: 'array', items, bag: true, epoch: this.epoch, born: this.heap };
  }

  /** What a class holds itself: its static fields, methods and getters. */
  private classStatics(node: AnyNode): ObjectValue {
    const value = this.classMembers(node, true);
    this.classOf.set(value, node);
    return value;
  }

  /**
   * What an instance of a class holds: its fields, its methods and getters, and what its
   * constructor can be seen assigning to `this`.
   */
  private classInstance(node: AnyNode): ObjectValue {
    const value = this.classMembers(node, false);
    for (const member of node.body?.body ?? []) {
      if (member.type !== 'MethodDefinition' || member.kind !== 'constructor') continue;
      if (!isAstNode(member.value?.body)) continue;
      for (const assignment of this.statementsOf(member.value?.body, 'AssignmentExpression')) {
        const target: AnyNode = assignment.left;
        const name =
          target?.type === 'MemberExpression' && target.object?.type === 'ThisExpression'
            ? staticName(target)
            : undefined;
        if (name === undefined) continue;
        const right: AnyNode = assignment.right;
        const held = value.properties.get(name)?.values ?? [];
        value.properties.set(name, { values: [...held, ...this.attempt(() => this.ev(right, undefined))] });
      }
    }
    return value;
  }

  private classMembers(node: AnyNode, statics: boolean): ObjectValue {
    const properties = new Map<string, Slot>();
    for (const member of node.body?.body ?? []) {
      this.tick();
      if ((member.static === true) !== statics || member.computed) continue;
      const key = member.key;
      const name = key?.type === 'Identifier' ? key.name : key?.type === 'Literal' ? String(key.value) : undefined;
      if (name === undefined) continue;
      if (member.type === 'PropertyDefinition') {
        const value: AnyNode = member.value;
        properties.set(name, { values: value ? this.attempt(() => this.ev(value, undefined)) : [UNDEFINED] });
      } else if (member.type === 'MethodDefinition') {
        const fn: FunctionValue = { kind: 'function', node: member.value, env: undefined, name };
        if (member.kind === 'get') properties.set(name, { getter: fn });
        else if (member.kind === 'method') properties.set(name, { values: [fn] });
      }
    }
    return this.objectOf(properties, new Map(), undefined);
  }

  /** What a `for…of` or `for…in` loop assigns to its variable, where the source is a constant. */
  private loopElements(loop: AnyNode): Value[] {
    let source: AnyNode = loop.right;
    // The loop as the AgentScript transform writes it: `for (const x of __safe_forOf(items))`
    if (
      source?.type === 'CallExpression' &&
      this.isFreeName(source.callee, '__safe_forOf') &&
      source.arguments?.length === 1
    ) {
      source = source.arguments[0];
    }
    // `items.values()`, `items.keys()`, `items.entries()`, `new Set(items)`, `new Map(pairs)`
    let view: string | undefined;
    if (
      source?.type === 'CallExpression' &&
      source.callee?.type === 'MemberExpression' &&
      !source.callee.computed &&
      (source.arguments?.length ?? 0) === 0 &&
      ['values', 'keys', 'entries'].includes(source.callee.property?.name)
    ) {
      view = source.callee.property.name;
      source = source.callee.object;
    }
    let collection: 'array' | 'set' | 'map' = 'array';
    if (source?.type === 'NewExpression' && source.arguments?.length === 1) {
      if (this.isFreeName(source.callee, 'Set')) collection = 'set';
      else if (this.isFreeName(source.callee, 'Map')) collection = 'map';
      if (collection !== 'array') source = source.arguments[0];
    }

    const out: Value[] = [];
    for (const value of this.ev(source, undefined)) {
      if (value.kind === 'unresolved') {
        // Constants that are not read: a name among them cannot be seen
        if (!value.object) out.push(UNRESOLVED);
        continue;
      }
      if (loop.type === 'ForInStatement') {
        if (value.kind === 'array' && !hasHole(value.items)) {
          out.push(...value.items.map((_item, index) => primitive(String(index))));
        } else if (value.kind === 'object') out.push(...ownKeys(value).map(primitive));
        continue;
      }
      let items: Value[] | undefined;
      if (value.kind === 'array') items = dense(value.items);
      else if (value.kind === 'primitive' && typeof value.value === 'string' && value.value.length <= MAX_ITEMS) {
        // (A longer text is walked one character at a time as well: none of them is a name)
        items = Array.from(value.value).map(primitive);
      }
      if (!items) continue;
      this.tick(items.length);
      items.forEach((item, index) => {
        if (collection === 'map') {
          const pair = item.kind === 'array' ? dense(item.items) : undefined;
          if (!pair) return;
          if (view === 'keys') out.push(pair[0] ?? UNDEFINED);
          else if (view === 'values') out.push(pair[1] ?? UNDEFINED);
          else out.push(item);
        } else if (view === 'entries') {
          out.push(this.rawArray([collection === 'set' ? item : primitive(index), item]));
        } else if (view === 'keys' && collection === 'array') {
          out.push(primitive(index));
        } else {
          out.push(item);
        }
      });
    }
    return out;
  }

  /**
   * The values a parameter can be seen being given: by a call of the function where it is
   * written (`((k) => ...)('a')`), by a method that walks a list and calls it with each element
   * (`list.forEach((k) => ...)`), and by the calls of the name it is declared under.
   */
  private argumentsSeen(fn: AnyNode, index: number, rest = false): Value[] {
    const out: Value[] = [];
    const fromCall = (call: AnyNode): void => {
      const args: AnyNode[] = call.arguments ?? [];
      if (rest) {
        // (Before a spread, which argument is which is not known; from it on, they are listed)
        if (args.slice(0, index).some((argument) => argument.type === 'SpreadElement')) return;
        try {
          const lists = this.argumentLists(args.slice(index), call, undefined);
          if (!lists) out.push(UNRESOLVED);
          else for (const list of lists) out.push(this.arrayOf(list, call));
        } catch (signal) {
          if (!isSignal(signal)) throw signal;
          out.push(UNRESOLVED);
        }
        return;
      }
      // (After a spread, which argument is which is not known)
      if (args.slice(0, index + 1).some((argument) => argument.type === 'SpreadElement')) return;
      const argument = args[index];
      out.push(...(argument ? this.attempt(() => this.ev(argument, undefined)) : [UNDEFINED]));
    };
    const elementsOf = (list: AnyNode): Value[] =>
      this.attempt(() => this.ev(list, undefined)).flatMap((value) =>
        value.kind === 'array' ? dense(value.items) : [],
      );

    let node: AnyNode = fn;
    let parent = this.parentOf.get(node);
    while (parent?.type === 'ParenthesizedExpression') {
      node = parent;
      parent = this.parentOf.get(node);
    }
    if (parent?.type === 'CallExpression' && parent.callee === node) {
      fromCall(parent);
    } else if (parent?.type === 'CallExpression' && parent.arguments?.[0] === node) {
      let callee: AnyNode = parent.callee;
      while (callee?.type === 'ChainExpression' || callee?.type === 'ParenthesizedExpression')
        callee = callee.expression;
      const name = callee?.type === 'MemberExpression' ? staticName(callee) : undefined;
      if (name !== undefined && WALKING_METHODS.has(name) && rest) {
        // `list.forEach((...args) => ...)`: a list that holds an element, its index, the list, and
        // for `reduce` what was returned so far. Taken together: any of the elements, or the start.
        if (index === 0) {
          const start: AnyNode | undefined = parent.arguments[1];
          const items = [
            ...((name === 'reduce' || name === 'reduceRight') && start
              ? this.attempt(() => this.ev(start, undefined))
              : []),
            ...elementsOf(callee.object),
          ].filter(isResolved);
          out.push({ kind: 'array', items, bag: true, epoch: this.epoch, born: this.heap }, DYNAMIC);
        }
      } else if (name !== undefined && WALKING_METHODS.has(name)) {
        const reducing = name === 'reduce' || name === 'reduceRight';
        const comparing = name === 'sort' || name === 'toSorted';
        // `reduce((sum, item) => ...)`: the first parameter is what was returned so far, or the start
        if (index === 0 && reducing && parent.arguments[1]) {
          const start: AnyNode = parent.arguments[1];
          out.push(...this.attempt(() => this.ev(start, undefined)));
        }
        if (index === 0 || (index === 1 && (reducing || comparing))) out.push(...elementsOf(callee.object));
      }
    }

    // By name: `const f = (k) => ...; f('a')`, `function f(k) { ... } f('a')`
    const declarator =
      fn.type === 'FunctionDeclaration'
        ? fn.id
        : parent?.type === 'VariableDeclarator' && parent.init === node && parent.id?.type === 'Identifier'
          ? parent.id
          : undefined;
    const binding = declarator ? this.declared.get(declarator) : undefined;
    for (const read of binding ? (this.readsOf.get(binding) ?? []) : []) {
      this.tick();
      const call = this.parentOf.get(read);
      if (call?.type === 'CallExpression' && call.callee === read) fromCall(call);
    }
    return out;
  }

  /** The part of each value a pattern picks: `[a, b]`, `{ key: a }`, with their defaults. */
  private project(values: Value[], path: PatternStep[]): Value[] {
    for (let index = path.length - 1; index >= 0 && values.length > 0; index--) {
      const step = path[index];
      const next: Value[] = [];
      for (const value of values) {
        this.tick();
        if (!isResolved(value)) {
          if (value.kind === 'unresolved' && !value.object) next.push(value);
          continue;
        }
        if (step.type === 'default') {
          if (isUndefined(value)) next.push(...this.ev(step.node, undefined));
          else next.push(value);
        } else if (step.type === 'objectRest') {
          next.push(value);
        } else if (step.type === 'index' || step.type === 'rest') {
          let items: Value[] | undefined;
          if (value.kind === 'array') items = dense(value.items);
          else if (value.kind === 'primitive' && typeof value.value === 'string' && value.value.length <= MAX_ITEMS) {
            items = Array.from(value.value).map(primitive);
          }
          if (!items) continue;
          if (value.kind === 'array' && value.bag) next.push(...items);
          else if (step.type === 'rest') next.push(this.rawArray(items.slice(step.index)));
          else next.push(items[step.index] ?? UNDEFINED);
        } else {
          const property = step.property;
          const keys: KeyName[] = property.computed
            ? this.keysOf(this.ev(property.key, undefined), property.key, undefined)
            : [{ name: property.key?.type === 'Identifier' ? property.key.name : String(property.key?.value) }];
          for (const key of keys) {
            if (typeof key === 'object' && 'name' in key) {
              next.push(...this.getProperty(value, key.name, property, undefined));
            }
          }
        }
      }
      values = next;
    }
    return values;
  }

  /** Whether an expression is an object wherever it is written: a literal, an instance, a function. */
  private looksLikeObject(node: AnyNode, hops = 0): boolean {
    switch (node?.type) {
      case 'ObjectExpression':
      case 'ArrayExpression':
      case 'NewExpression':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
      case 'ClassExpression':
        return true;
      case 'Identifier': {
        const init = this.localInit(node);
        return init !== undefined && hops < 4 && this.looksLikeObject(init, hops + 1);
      }
      default:
        return false;
    }
  }

  /** The initializer of a variable that is declared once and never assigned again. */
  private localInit(identifier: AnyNode): AnyNode | undefined {
    const binding = this.bindingOf.get(identifier);
    if (!binding || binding.redeclarations || this.writesTo.has(binding)) return undefined;
    const source = this.sourceOf(binding.node);
    return source.kind === 'simple' && !source.loop && isAstNode(source.init) ? source.init : undefined;
  }

  // --- expressions ----------------------------------------------------------------------------

  private ev(node: AnyNode, env: Env | undefined): Value[] {
    this.tick();
    // (Something is evaluated after an assignment: see `disturbed`)
    if (this.effect) this.disturbed = true;
    if (!isAstNode(node)) return [DYNAMIC];
    if (this.depth >= MAX_DEPTH) throw new OutOfBudget();
    this.depth++;
    try {
      const values = this.evNode(node, env);
      // An expression has a value: none found is a value not found
      if (values.length === 0) return this.giveUp(node, env);
      // A value that is not known takes part in the expression from here on. What the engine
      // does with it (which conversions run, and they can be code of the script) is not
      // followed: the expression as a whole has no computed value.
      if (!this.disturbed && values.some((value) => !isResolved(value))) this.disturbed = true;
      return values;
    } finally {
      this.depth--;
    }
  }

  private evNode(node: AnyNode, env: Env | undefined): Value[] {
    switch (node.type) {
      case 'Literal':
        return [this.literal(node)];
      case 'TemplateLiteral':
        return this.template(node, env);
      case 'Identifier':
        return this.identifier(node, env);
      case 'ParenthesizedExpression':
        return this.ev(node.expression, env);
      case 'ChainExpression':
        return this.settle(this.ev(node.expression, env).map((value) => (value === STOPPED ? UNDEFINED : value)));
      case 'SequenceExpression': {
        // Every expression is evaluated, in order, for what it changes; the last one is the value
        let last: Value[] | undefined;
        for (const expression of node.expressions ?? []) last = this.ev(expression, env);
        return last ?? this.giveUp(node, env);
      }
      case 'AwaitExpression': {
        // Awaiting something that is not a promise gives the thing itself
        const out: Value[] = [];
        for (const value of this.ev(node.argument, env)) {
          if (value.kind === 'primitive' && !value.boxed) out.push(value);
          else if (!isResolved(value)) out.push(plain(value));
          else out.push(...this.giveUp(node, env)); // an object may be a promise, or look like one
        }
        return this.settle(out);
      }
      case 'UnaryExpression':
        return this.unary(node, env);
      case 'BinaryExpression':
        return this.binary(node, env);
      case 'LogicalExpression':
        return this.logical(node, env);
      case 'ConditionalExpression':
        return this.conditional(node, env);
      case 'AssignmentExpression':
        return this.assignment(node, env);
      case 'ArrayExpression':
        return this.array(node, env);
      case 'ObjectExpression':
        return this.object(node, env);
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        return [{ kind: 'function', node, env, name: this.nameOf(node) }];
      case 'MemberExpression':
        return this.member(node, env);
      case 'CallExpression':
        return this.call(node, env);
      case 'NewExpression':
        return this.construct(node, env);
      case 'TaggedTemplateExpression':
        return this.tagged(node, env);
      case 'ThisExpression': {
        // The object a function was called on. Called without one, or on a primitive, what
        // `this` is depends on the mode the script runs in.
        const self = selfOf(env);
        const isObject =
          self !== undefined &&
          (self.kind === 'object' ||
            self.kind === 'array' ||
            self.kind === 'function' ||
            self.kind === 'regexp' ||
            (self.kind === 'primitive' && self.boxed === true));
        return isObject ? [self] : this.giveUp(node, env);
      }
      case 'MetaProperty':
        // `new.target` in a function that is called, not constructed
        if (node.meta?.name === 'new' && ownsSelf(env)) return [UNDEFINED];
        return this.giveUp(node, env);
      case 'ClassExpression':
        // Looked into only for the constants a variable that holds the class can be read for
        return this.lenient ? [this.classStatics(node)] : this.giveUp(node, env, true);
      default:
        return this.giveUp(node, env);
    }
  }

  /**
   * The `name` of a function expression: its own, or the one the place it is written in gives it
   * (`const f = () => 1` is `f`). `undefined` where that is not known here.
   */
  private nameOf(node: AnyNode): string | undefined {
    if (node.id) return String(node.id.name);
    let child: AnyNode = node;
    let parent = this.parentOf.get(child);
    while (parent?.type === 'ParenthesizedExpression') {
      child = parent;
      parent = this.parentOf.get(child);
    }
    switch (parent?.type) {
      case 'VariableDeclarator':
        return parent.init === child && parent.id?.type === 'Identifier' ? String(parent.id.name) : '';
      case 'AssignmentExpression': {
        if (parent.right !== child) return '';
        if (parent.operator !== '=' && !LOGICAL_ASSIGNMENTS.has(parent.operator)) return '';
        if (parent.left?.type !== 'Identifier') return '';
        // `(name) = function () {}` does not name the function, and the parentheses may not be
        // in the tree: an assignment that does not start at its target has them
        return parent.left.start === parent.start ? String(parent.left.name) : undefined;
      }
      case 'AssignmentPattern':
        return parent.right === child && parent.left?.type === 'Identifier' ? String(parent.left.name) : '';
      case 'CallExpression':
      case 'NewExpression':
      case 'ArrayExpression':
      case 'MemberExpression':
      case 'ConditionalExpression':
      case 'SequenceExpression':
      case 'LogicalExpression':
      case 'ReturnStatement':
      case 'ArrowFunctionExpression':
      case 'UnaryExpression':
      case 'BinaryExpression':
      case 'SpreadElement':
      case 'TemplateLiteral':
      case 'TaggedTemplateExpression':
      case 'AwaitExpression':
      case 'ExpressionStatement':
      case 'ChainExpression':
        return '';
      default:
        // A property (named by its key, which the object literal passes on), a class member, an
        // export: not followed here
        return undefined;
    }
  }

  private literal(node: AnyNode): Value {
    if (node.regex) {
      return { kind: 'regexp', source: String(node.regex.pattern), flags: String(node.regex.flags ?? '') };
    }
    if (node.bigint !== undefined) {
      const digits = String(node.bigint);
      if (digits.length > MAX_BIGINT_DIGITS) return UNRESOLVED;
      try {
        return primitive(BigInt(digits));
      } catch {
        return UNRESOLVED;
      }
    }
    const value = node.value;
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return primitive(value);
    }
    return UNRESOLVED;
  }

  private identifier(node: AnyNode, env: Env | undefined): Value[] {
    const binding = this.bindingOf.get(node);
    if (binding === undefined) return [DYNAMIC];
    // Inside `with` a name may be a property of its object: it is not read as the variable, or
    // the built-in, of that name
    if (this.inWith.has(node)) return binding && !this.variables ? [DYNAMIC] : this.giveUp(node, env);
    if (binding === null) {
      // `arguments` of a function that is being applied: what it was called with, not followed
      if (node.name === 'arguments' && ownsSelf(env)) return this.giveUp(node, env);
      // The global object as a value: what is read from it is not followed, and it is not a
      // run-time value either (`(0, globalThis).String` is `String`)
      if (GLOBAL_OBJECT_NAMES.has(node.name)) return this.giveUp(node, env, true);
      // A name the script assigns without declaring it: what it can be seen giving it
      const assigned = this.variables ? this.globalWrites.get(node.name) : undefined;
      if (assigned) return this.globalValues(node.name, assigned);
      // A function declared in a block may be what the name stands for outside the block
      const declared = this.variables ? this.blockFunctions.get(node.name) : undefined;
      if (declared) {
        return [
          ...declared.map((fn): Value => ({ kind: 'function', node: fn, env: undefined, name: String(node.name) })),
          DYNAMIC,
        ];
      }
      return this.globalValue(node.name, node, env, false);
    }
    // A variable of a function that is being applied is what the call gave it, for as long as
    // nothing has assigned to a variable since. One that is declared twice (two functions of a
    // name, a function named like a parameter), or that was not followed, is not known; where
    // names are looked for, it is read for what it can be seen holding.
    const bound = lookupEnv(env, binding.node);
    if (bound || isLocalOf(env, binding.node)) {
      if (bound && !binding.redeclarations && (bound.createdAt === this.writes || this.lenient)) return bound.values;
      return this.lenient && this.variables && !this.computing.has(binding)
        ? this.bindingValues(binding)
        : this.giveUp(node, env);
    }
    return this.variables ? this.bindingValues(binding) : [DYNAMIC];
  }

  private globalValue(name: string, node: AnyNode, env: Env | undefined, viaGlobalObject: boolean): Value[] {
    switch (name) {
      case 'undefined':
        return [UNDEFINED];
      case 'NaN':
        return [primitive(NaN)];
      case 'Infinity':
        return [primitive(Infinity)];
      default:
        if (!isClosedGlobal(name)) return [DYNAMIC];
        if (!this.ok) return this.giveUp(node, env);
        return viaGlobalObject || PLATFORM_GLOBALS.has(name)
          ? [{ kind: 'builtin', path: name, uncertain: true }]
          : [{ kind: 'builtin', path: name }];
    }
  }

  /** Whether a value is true in a condition; `undefined` where that is not known here. */
  private truthiness(value: Value): boolean | undefined {
    if (!isResolved(value)) return undefined;
    // (A newer method may be missing in the engine the script runs in)
    if (value.kind === 'builtin' || value.kind === 'method') return undefined;
    return value.kind === 'primitive' ? value.boxed === true || Boolean(value.value) : true;
  }

  private template(node: AnyNode, env: Env | undefined): Value[] {
    const quasis: AnyNode[] = node.quasis ?? [];
    const expressions: AnyNode[] = node.expressions ?? [];
    if (expressions.length === 0 && quasis.length === 1) {
      // Without a substitution nothing is built: it is read as it is written, like a string literal
      const written = quasis[0].value?.cooked;
      return typeof written === 'string' ? [primitive(written)] : this.giveUp(node, env);
    }
    let acc: Value[] = [primitive('')];
    for (let index = 0; index < quasis.length; index++) {
      const cooked = quasis[index].value?.cooked;
      if (typeof cooked !== 'string') return this.giveUp(node, env);
      acc = this.concatenate(acc, [primitive(cooked)], node);
      if (index < expressions.length) {
        acc = this.concatenate(acc, this.asStrings(this.ev(expressions[index], env), node, env), node);
      }
    }
    return acc;
  }

  /** The string each value is converted to (a template substitution, `String(x)`). */
  private asStrings(values: Value[], node: AnyNode, env: Env | undefined): Value[] {
    const out: Value[] = [];
    for (const value of values) {
      for (const converted of this.toPrimitive(value, 'string', node, env)) {
        // (A string that exists already is not measured again: only what is built from it is)
        if (converted.kind === 'primitive') out.push(primitive(String(converted.value)));
        else if (converted.kind === 'symbol')
          out.push(...this.giveUp(node, env)); // a TypeError
        else out.push(plain(converted));
      }
    }
    return this.settle(out);
  }

  /** `left + right` where both sides are strings already. */
  private concatenate(left: Value[], right: Value[], node: AnyNode): Value[] {
    const out: Value[] = [];
    for (const a of left) {
      for (const b of right) {
        this.tick();
        if (a.kind === 'dynamic' || b.kind === 'dynamic') out.push(DYNAMIC);
        else if (a.kind !== 'primitive' || b.kind !== 'primitive') out.push(UNRESOLVED);
        else {
          const first = String(a.value);
          const second = String(b.value);
          if (first.length + second.length > MAX_STATIC_KEY_LENGTH) throw new TooLong(node);
          out.push(this.text(first + second, node));
        }
      }
    }
    return this.settle(out);
  }

  private unary(node: AnyNode, env: Env | undefined): Value[] {
    const operator: string = node.operator;
    if (operator === 'delete') return this.giveUp(node, env);

    // (`void x` evaluates `x` too, for what it changes)
    const operands = this.ev(node.argument, env);
    if (operator === 'void') return [UNDEFINED];

    const out: Value[] = [];
    for (const value of operands) {
      if (!isResolved(value)) {
        out.push(plain(value));
        continue;
      }
      if (operator === 'typeof') {
        const type = typeOf(value);
        if (type === undefined) out.push(...this.giveUp(node, env));
        else out.push(primitive(type));
        continue;
      }
      if (operator === '!') {
        const truth = this.truthiness(value);
        if (truth === undefined) out.push(...this.giveUp(node, env));
        else out.push(primitive(!truth));
        continue;
      }
      for (const operand of this.toPrimitive(value, 'number', node, env)) {
        if (operand.kind !== 'primitive') {
          out.push(...(operand.kind === 'symbol' ? this.giveUp(node, env) : [plain(operand)]));
          continue;
        }
        this.read(operand.value);
        const result = hostUnary(operator, operand.value);
        if (result === NO_VALUE) out.push(...this.giveUp(node, env));
        else out.push(primitive(result));
      }
    }
    return this.settle(out);
  }

  private binary(node: AnyNode, env: Env | undefined): Value[] {
    const operator: string = node.operator;
    // `a + b + c + ...` is one chain, read from the left, however long it is
    const operands: AnyNode[] = [];
    let current: AnyNode = node;
    while (current?.type === 'BinaryExpression' && current.operator === operator && operator !== '**') {
      operands.push(current.right);
      current = current.left;
    }
    if (operands.length === 0) {
      operands.push(node.right);
      current = node.left;
    }
    operands.reverse();

    // (Every operand is evaluated, also after a run-time one: it may change something)
    let acc = this.ev(current, env);
    for (const operand of operands) {
      acc = this.binaryValues(operator, acc, this.ev(operand, env), node, env);
    }
    return acc;
  }

  private binaryValues(operator: string, left: Value[], right: Value[], node: AnyNode, env: Env | undefined): Value[] {
    if (operator === 'in' || operator === 'instanceof') return this.giveUp(node, env);

    const out: Value[] = [];
    for (const a of left) {
      for (const b of right) {
        this.tick();
        if (!isResolved(a) || !isResolved(b)) {
          // The engine converts the operand that is known all the same, and that can be code
          // of the script: it is run here for what it changes
          const known = isResolved(a) ? a : isResolved(b) ? b : undefined;
          if (known && known.kind !== 'primitive')
            this.toPrimitive(known, operator === '+' ? 'default' : 'number', node, env);
          out.push(a.kind === 'dynamic' || b.kind === 'dynamic' ? DYNAMIC : UNRESOLVED);
          continue;
        }
        if (operator === '===' || operator === '!==' || operator === '==' || operator === '!=') {
          // Two primitives compare by value; anything else by identity, which is not tracked
          if (a.kind !== 'primitive' || b.kind !== 'primitive' || a.boxed || b.boxed) {
            out.push(...this.giveUp(node, env));
            continue;
          }
        }
        const hint = operator === '+' ? 'default' : 'number';
        for (const x of this.toPrimitive(a, hint, node, env)) {
          for (const y of this.toPrimitive(b, hint, node, env)) {
            if (x.kind === 'symbol' || y.kind === 'symbol') {
              out.push(...this.giveUp(node, env)); // a TypeError
            } else if (x.kind !== 'primitive' || y.kind !== 'primitive') {
              out.push(x.kind === 'dynamic' || y.kind === 'dynamic' ? DYNAMIC : UNRESOLVED);
            } else {
              out.push(...this.hostBinary(operator, x.value, y.value, node, env));
            }
          }
        }
      }
    }
    return this.settle(out);
  }

  private hostBinary(
    operator: string,
    x: StaticPrimitive,
    y: StaticPrimitive,
    node: AnyNode,
    env: Env | undefined,
  ): Value[] {
    if (operator === '+' && (typeof x === 'string' || typeof y === 'string')) {
      const left = String(x);
      const right = String(y);
      // (Measured before it is built: a literal can be long)
      if (left.length + right.length > MAX_STATIC_KEY_LENGTH) throw new TooLong(node);
      return [this.text(left + right, node)];
    }
    // (Converting a text to a number reads all of it, and so can comparing two texts, for order
    // or for equality, as far as they are alike)
    this.read(x, y);
    if (typeof x === 'bigint' && typeof y === 'bigint') {
      // A BigInt has no size limit of its own: bound what an operation may build
      const limit = BigInt(MAX_BIGINT_BITS);
      const magnitude = y < BigInt(0) ? -y : y;
      const grows =
        operator === '**'
          ? magnitude > limit || bitLength(x) * Number(magnitude) > MAX_BIGINT_BITS
          : operator === '<<' || operator === '>>'
            ? magnitude > limit
            : operator === '*' && bitLength(x) + bitLength(y) > MAX_BIGINT_BITS;
      if (grows) throw new TooLong(node);
    }
    if (operator === '**' && typeof x === 'number' && typeof y === 'number') {
      // A power is exact where both numbers are whole and the result is a whole number that a
      // double holds exactly; any other is left to the engine's approximation
      const power = x ** y;
      if (!Number.isInteger(x) || !Number.isInteger(y) || y < 0 || !Number.isSafeInteger(power)) {
        return this.giveUp(node, env);
      }
    }
    const result = hostBinaryOperation(operator, x, y);
    if (result === NO_VALUE) return this.giveUp(node, env); // a TypeError, a RangeError
    if (typeof result === 'bigint' && bitLength(result) > MAX_BIGINT_BITS) throw new TooLong(node);
    return [primitive(result)];
  }

  private logical(node: AnyNode, env: Env | undefined): Value[] {
    const operator: string = node.operator;
    const operands: AnyNode[] = [];
    let current: AnyNode = node;
    while (current?.type === 'LogicalExpression' && current.operator === operator) {
      operands.push(current.right);
      current = current.left;
    }
    operands.reverse();

    let acc = this.ev(current, env);
    for (const operand of operands) {
      acc = this.logicalValues(operator, acc, () => this.ev(operand, env));
    }
    return acc;
  }

  private logicalValues(operator: string, left: Value[], right: () => Value[]): Value[] {
    const out: Value[] = [];
    let continues = false;
    for (const value of left) {
      if (operator === '??' || operator === '??=') {
        // (Whether a function of the engine exists is not known: it may be `undefined`)
        const known = isResolved(value) && value.kind !== 'builtin' && value.kind !== 'method';
        const nullish = isNullish(value);
        if (!known || !nullish) out.push(value);
        if (!known || nullish) continues = true;
      } else {
        const truth = this.truthiness(value);
        const stops = operator === '||' || operator === '||=' ? truth === true : truth === false;
        if (truth === undefined || stops) out.push(value);
        if (truth === undefined || !stops) continues = true;
      }
    }
    if (continues) out.push(...right());
    return this.settle(out);
  }

  private conditional(node: AnyNode, env: Env | undefined): Value[] {
    let whenTrue = false;
    let whenFalse = false;
    for (const test of this.ev(node.test, env)) {
      const truth = this.truthiness(test);
      if (truth !== false) whenTrue = true;
      if (truth !== true) whenFalse = true;
    }
    const out: Value[] = [];
    if (whenTrue) out.push(...this.ev(node.consequent, env));
    if (whenFalse) out.push(...this.ev(node.alternate, env));
    return this.settle(out);
  }

  private assignment(node: AnyNode, env: Env | undefined): Value[] {
    const operator: string = node.operator;
    const target: AnyNode = node.left;
    // What the assignment changes: a variable; or, through a member, anything: the key is
    // converted and a setter may run, and both can be code of the script
    const changed = (values?: Value[]): void => {
      if (target?.type === 'Identifier') {
        this.writes++;
        this.effect = true;
        // (Where names are looked for, the variable is read for what it was given here as well)
        if (this.lenient && values) {
          const binding = this.bindingOf.get(target);
          const owner = binding ? ownerOf(env, binding.node) : undefined;
          const held = binding ? owner?.bindings.get(binding.node) : undefined;
          if (binding && owner && held) owner.bindings.set(binding.node, [...held, ...values]);
        }
      } else this.skipped();
    };

    if (operator === '=') {
      // (A member target is evaluated first: `a[i] = v` evaluates `a` and `i`, then `v`)
      if (target?.type === 'MemberExpression') {
        this.ev(target.object, env);
        if (target.computed) this.ev(target.property, env);
      } else if (target?.type !== 'Identifier') {
        this.skipped(); // a pattern: its defaults and keys are not followed
      }
      const values = this.ev(node.right, env);
      changed(values);
      return values;
    }
    if (LOGICAL_ASSIGNMENTS.has(operator)) {
      const values = this.logicalValues(operator, this.ev(target, env), () => this.ev(node.right, env));
      changed(values);
      return values;
    }
    const values = this.binaryValues(operator.slice(0, -1), this.ev(target, env), this.ev(node.right, env), node, env);
    changed(values);
    return values;
  }

  private array(node: AnyNode, env: Env | undefined): Value[] {
    // The elements are written in the script: an array literal is as large as its text, and is
    // read in one pass. Only an element with several possible values multiplies the lists.
    let lists: Value[][] = [[]];
    let spread = false;
    for (const element of node.elements ?? []) {
      let expansions: Value[][];
      if (element === null) {
        expansions = [[HOLE]];
      } else if (element.type === 'SpreadElement') {
        const spreads = this.spread(this.ev(element.argument, env), node);
        if (!spreads) return this.giveUp(node, env, true);
        expansions = spreads;
        spread = true;
      } else {
        expansions = this.ev(element, env).map((value) => [value]);
      }

      // What a spread builds is bounded; what is written out is as long as the script. The size
      // of every list is checked, and the copy is paid for, before anything is copied: one large
      // spread is copied into each of the lists there are.
      const fits = (list: Value[], added: Value[]): void => {
        if (spread && list.length + added.length > MAX_ITEMS) throw new TooLong(node);
      };
      if (expansions.length === 1) {
        const added = expansions[0];
        for (const list of lists) fits(list, added);
        this.tick(lists.length * Math.max(1, added.length));
        for (const list of lists) list.push(...added);
      } else {
        if (lists.length * expansions.length > MAX_ALTERNATIVES) throw new OutOfBudget();
        const next: Value[][] = [];
        for (const list of lists) {
          for (const expansion of expansions) {
            fits(list, expansion);
            this.tick(list.length + expansion.length + 1);
            next.push(list.concat(expansion));
          }
        }
        lists = next;
      }
    }
    return lists.map((items) => this.rawArray(items));
  }

  /** `...value`: the elements it spreads into, or `null` when that is not known. */
  private spread(values: Value[], node: AnyNode): Value[][] | null {
    if (!this.ok) return null; // spreading goes through an iterator of a prototype
    const out: Value[][] = [];
    for (const value of values) {
      if (value.kind === 'array' && this.fresh(value)) {
        this.tick(value.items.length);
        out.push(dense(value.items));
      } else if (value.kind === 'primitive' && !value.boxed && typeof value.value === 'string') {
        out.push(this.characters(value.value, node).map(primitive));
      } else if (this.lenient) {
        // (Where names are looked for, what can be spread is; the rest is left out)
        continue;
      } else return null;
    }
    return out.length > 0 ? out : null;
  }

  /** The characters a string iterates over. */
  private characters(text: string, node: AnyNode): string[] {
    if (text.length > MAX_ITEMS) throw new TooLong(node);
    this.tick(text.length);
    return Array.from(text);
  }

  private object(node: AnyNode, env: Env | undefined): Value[] {
    const properties = new Map<string, Slot>();
    const symbols = new Map<string, Slot>();
    let proto: ObjectValue | null | undefined;

    // Every property is evaluated where it is written, in order: a later one sees what an
    // earlier one changed
    for (const property of node.properties ?? []) {
      this.tick();
      if (property.type === 'SpreadElement') {
        const sources = this.ev(property.argument, env);
        if (sources.length !== 1) return this.giveUp(node, env, true);
        const source = sources[0];
        if (source.kind === 'object' && this.fresh(source)) {
          this.tick(source.properties.size);
          for (const [name, slot] of source.properties) {
            if (isAccessor(slot)) return this.giveUp(node, env, true);
            properties.set(name, slot);
          }
          for (const [name, slot] of source.symbols) {
            if (isAccessor(slot)) return this.giveUp(node, env, true);
            symbols.set(name, slot);
          }
        } else if (source.kind === 'array' && this.fresh(source)) {
          if (hasHole(source.items)) return this.giveUp(node, env, true);
          source.items.forEach((item, index) => properties.set(String(index), { values: [item] }));
        } else if (source.kind === 'primitive' && !source.boxed) {
          if (typeof source.value === 'string') {
            // (One property for each code unit: two for a character outside the basic plane)
            const text = source.value;
            if (text.length > MAX_ITEMS) throw new TooLong(node);
            this.tick(text.length);
            for (let index = 0; index < text.length; index++) {
              properties.set(String(index), { values: [primitive(text[index])] });
            }
          }
        } else {
          return this.giveUp(node, env, true);
        }
        continue;
      }
      if (property.type !== 'Property') return this.giveUp(node, env, true);

      let name: string | undefined;
      let symbol: string | undefined;
      if (property.computed) {
        const keys = this.keysOf(this.ev(property.key, env), property.key, env);
        if (keys.length !== 1) return this.giveUp(node, env, true);
        const key = keys[0];
        if (typeof key !== 'object') return this.giveUp(node, env, true);
        if ('name' in key) name = key.name;
        else if (key.symbol.wellKnown) symbol = key.symbol.wellKnown;
        else return this.giveUp(node, env, true);
      } else if (property.key?.type === 'Identifier') {
        name = property.key.name;
      } else if (property.key?.type === 'Literal') {
        name = property.key.bigint !== undefined ? String(property.key.bigint) : String(property.key.value);
      } else {
        return this.giveUp(node, env, true);
      }

      const slots = name !== undefined ? properties : symbols;
      const key = (name ?? symbol) as string;
      const label = name ?? `[Symbol.${symbol}]`;
      const valueNode: AnyNode = property.value;

      if (property.kind === 'get' || property.kind === 'set') {
        // An accessor replaces a data property of the name; a getter and a setter make one accessor
        const existing = slots.get(key);
        const accessor = existing && isAccessor(existing) ? existing : undefined;
        if (property.kind === 'get') {
          const getter: FunctionValue = { kind: 'function', node: valueNode, env, name: `get ${label}` };
          slots.set(key, accessor?.setter ? { getter, setter: true } : { getter });
        } else {
          slots.set(key, accessor?.getter ? { getter: accessor.getter, setter: true } : { setter: true });
        }
        continue;
      }

      const isFunction =
        (valueNode?.type === 'FunctionExpression' || valueNode?.type === 'ArrowFunctionExpression') && !valueNode.id;
      const values: Value[] = isFunction
        ? [{ kind: 'function', node: valueNode, env, name: label }]
        : this.ev(valueNode, env);

      // `{ __proto__: value }` sets the prototype of the new object: it is not a property
      if (name === '__proto__' && !property.computed && !property.shorthand && !property.method) {
        if (values.length !== 1) return this.giveUp(node, env, true);
        const value = values[0];
        if (value.kind === 'object') proto = value;
        else if (value.kind === 'primitive' && !value.boxed) {
          if (value.value === null) proto = null;
        } else return this.giveUp(node, env, true);
        continue;
      }

      slots.set(key, { values });
    }

    return [this.objectOf(properties, symbols, proto)];
  }

  // --- conversions ----------------------------------------------------------------------------

  /**
   * `ToPrimitive`: the primitive a value is converted to. An entry of the result is a primitive,
   * a symbol, `dynamic` or `unresolved`.
   */
  private toPrimitive(
    value: Value,
    hint: 'string' | 'number' | 'default',
    node: AnyNode,
    env: Env | undefined,
  ): Value[] {
    switch (value.kind) {
      case 'primitive':
        if (!value.boxed) return [value];
        // An object: converted by the `valueOf` and `toString` of its prototype
        return this.ok ? [primitive(value.value)] : this.giveUp(node, env);
      case 'symbol':
      case 'dynamic':
      case 'unresolved':
        return [value];
      case 'regexp':
        return this.ok ? [this.text(`/${value.source}/${value.flags}`, node)] : this.giveUp(node, env);
      case 'array': {
        const joined = this.joined(value, ',', node, env);
        if (!value.bag) return joined;
        // A function stored into what a variable holds may be the method that converts it
        // (`list.toString = () => 'name'`): what it gives is looked at too
        const out = [...joined];
        for (const item of value.items) {
          if (item.kind !== 'function') continue;
          const results = this.attempt(() => this.apply(item, [], undefined, node, env));
          out.push(...results.filter((result) => result.kind === 'primitive' && !result.boxed));
        }
        return out;
      }
      case 'function':
      case 'builtin':
      case 'method':
        // The text of a function: fixed, and not computed here
        return this.giveUp(node, env);
      case 'object':
        return this.objectToPrimitive(value, hint, node, env);
    }
  }

  private objectToPrimitive(
    value: ObjectValue,
    hint: 'string' | 'number' | 'default',
    node: AnyNode,
    env: Env | undefined,
  ): Value[] {
    if (!this.fresh(value)) return this.giveUp(node, env);
    if (this.depth >= MAX_DEPTH) throw new OutOfBudget();

    /**
     * What one conversion method gives. `next`: the method is not a function, or it returned an
     * object, so the language goes on to the next method. A property may hold one of several
     * values, so both can be the case.
     */
    const convert = (slot: Slot, args: Value[]): { found: Value[]; next: boolean } => {
      const found: Value[] = [];
      let next = false;
      for (const method of this.readSlot(slot, value, node, env)) {
        if (!isResolved(method)) {
          found.push(plain(method));
        } else if (!isCallable(method)) {
          next = true;
        } else {
          for (const result of this.invoke(method, args, value, node, env)) {
            // An object (also one that wraps a primitive) is not a primitive
            if (result.kind === 'primitive' ? !result.boxed : result.kind === 'symbol' || !isResolved(result)) {
              found.push(plain(result));
            } else {
              next = true;
            }
          }
        }
      }
      return { found, next };
    };

    this.depth++;
    try {
      const exotic = lookupSymbol(value, 'toPrimitive');
      if (exotic) {
        // `null` and `undefined` there mean "none"; anything else has to be a function, and has
        // to give a primitive
        const methods = this.readSlot(exotic, value, node, env);
        if (!methods.every(isNullish)) {
          if (methods.some((method) => isNullish(method) || (isResolved(method) && !isCallable(method)))) {
            return this.giveUp(node, env);
          }
          const { found, next } = convert(exotic, [primitive(hint)]);
          return next ? [...found, ...this.giveUp(node, env)] : found;
        }
      }

      const out: Value[] = [];
      for (const name of hint === 'string' ? ['toString', 'valueOf'] : ['valueOf', 'toString']) {
        const lookup = lookupProperty(value, name);
        if (lookup === 'default') {
          // Object.prototype.toString; Object.prototype.valueOf returns the object, which is no primitive
          if (!this.ok) return this.giveUp(node, env);
          if (name === 'toString') return this.settle([...out, ...this.defaultToString(value, node, env)]);
          continue;
        }
        if (lookup === 'none') continue;
        const { found, next } = convert(lookup, []);
        out.push(...found);
        if (!next) return this.settle(out);
        // The method ran, and may have changed the object: its next method is not read from
        // what the object was
        if (!this.fresh(value)) return this.settle([...out, ...this.giveUp(node, env)]);
      }
      // No method gave a primitive: a TypeError
      return this.settle([...out, ...this.giveUp(node, env)]);
    } finally {
      this.depth--;
    }
  }

  /** `Object.prototype.toString` of an object literal. */
  private defaultToString(value: ObjectValue, node: AnyNode, env: Env | undefined): Value[] {
    const tag = lookupSymbol(value, 'toStringTag');
    if (!tag) return [primitive('[object Object]')];
    const tags = this.readSlot(tag, value, node, env);
    if (tags.length !== 1) return this.giveUp(node, env);
    const only = tags[0];
    if (!isResolved(only)) return [plain(only)];
    return [
      only.kind === 'primitive' && !only.boxed && typeof only.value === 'string'
        ? this.text(`[object ${only.value}]`, node)
        : primitive('[object Object]'),
    ];
  }

  /** The values a property holds: its value, or what its getter returns. */
  private readSlot(slot: Slot, self: Value, node: AnyNode, env: Env | undefined): Value[] {
    if (slot.getter) return this.apply(slot.getter, [], self, node, env);
    return slot.values ?? [UNDEFINED]; // an accessor without a getter reads as `undefined`
  }

  /** `array.join(separator)`. */
  private joined(array: ArrayValue, separator: string, node: AnyNode, env: Env | undefined): Value[] {
    // (`toString` of an array is `join`, of its prototype)
    if (!this.ok || !this.fresh(array)) return this.giveUp(node, env);
    if (this.depth >= MAX_DEPTH) throw new OutOfBudget();
    const items = array.items;
    this.tick(items.length);

    // The usual case: every element is a primitive
    let length = Math.max(0, items.length - 1) * separator.length;
    if (length > MAX_STATIC_KEY_LENGTH) throw new TooLong(node);
    const parts: string[] = [];
    let simple = true;
    for (const item of items) {
      if (item.kind !== 'primitive' || item.boxed) {
        simple = false;
        break;
      }
      const part = item.value == null ? '' : String(item.value);
      length += part.length;
      if (length > MAX_STATIC_KEY_LENGTH) throw new TooLong(node);
      parts.push(part);
    }
    if (simple) return [primitive(parts.join(separator))];

    this.depth++;
    try {
      let acc: Value[] = [primitive('')];
      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        if (index > 0) acc = this.concatenate(acc, [primitive(separator)], node);
        if (isNullish(item)) continue;
        acc = this.concatenate(acc, this.asStrings([item], node, env), node);
        // Converting an element can run code of the script, which can change the list that is
        // being joined: the elements that follow are not read from what it was
        if (!this.fresh(array)) return this.giveUp(node, env);
      }
      return acc;
    } finally {
      this.depth--;
    }
  }

  /** The property keys a list of values stands for. */
  private keysOf(values: Value[], node: AnyNode, env: Env | undefined): KeyName[] {
    const out: KeyName[] = [];
    const seen = new Set<string>();
    const push = (key: KeyName): void => {
      const id = typeof key === 'string' ? key : 'name' in key ? `n:${key.name}` : undefined;
      if (id !== undefined) {
        if (seen.has(id)) return;
        seen.add(id);
      }
      out.push(key);
    };
    for (const value of values) {
      this.tick();
      if (value.kind === 'symbol') {
        push({ symbol: value });
        continue;
      }
      if (isCallable(value)) {
        // The text of a function. It is fixed, it is not computed here, and a script can cut a
        // name out of it once it is a key: it is not given a name it does not have.
        push(this.giveUp(node, env)[0].kind === 'dynamic' ? 'dynamic' : 'unresolved');
        continue;
      }
      for (const converted of this.toPrimitive(value, 'string', node, env)) {
        if (converted.kind === 'primitive') push({ name: String(converted.value) });
        else if (converted.kind === 'symbol') push({ symbol: converted });
        else push(converted.kind === 'dynamic' ? 'dynamic' : 'unresolved');
      }
    }
    return out;
  }

  // --- members --------------------------------------------------------------------------------

  private propertyKeys(member: AnyNode, env: Env | undefined): KeyName[] {
    const property = member.property;
    if (!member.computed) return property?.type === 'Identifier' ? [{ name: property.name }] : ['dynamic'];
    return this.keysOf(this.ev(property, env), property, env);
  }

  private member(node: AnyNode, env: Env | undefined): Value[] {
    const objectNode: AnyNode = node.object;
    if (!isAstNode(objectNode) || objectNode.type === 'Super') return this.giveUp(node, env);

    if (this.isGlobalObject(objectNode)) {
      const keys = this.propertyKeys(node, env);
      const only = keys.length === 1 ? keys[0] : undefined;
      if (!only || typeof only !== 'object' || !('name' in only)) return [DYNAMIC];
      // (The global object read off itself is the global object: not followed, and not a run-time value)
      if (isGlobalObjectMember(only.name)) return this.giveUp(node, env, true);
      return this.globalValue(only.name, node, env, true);
    }

    const objects = this.ev(objectNode, env);

    // The key is evaluated only when an object is there to read it from: `nothing?.[key]`
    // stops before it
    let keys: KeyName[] | undefined;
    const out: Value[] = [];
    for (const object of objects) {
      if (object === STOPPED) {
        out.push(object);
        continue;
      }
      if (isNullish(object)) {
        if (node.optional === true) out.push(STOPPED);
        else {
          keys ??= this.propertyKeys(node, env);
          out.push(...this.giveUp(node, env)); // a TypeError
        }
        continue;
      }
      keys ??= this.propertyKeys(node, env);
      if (!isResolved(object)) {
        out.push(through(object));
        continue;
      }
      // (`method?.name`: where the engine has no such method, the chain stops)
      if (node.optional === true && (object.kind === 'builtin' || object.kind === 'method')) out.push(STOPPED);
      for (const key of keys) {
        this.tick();
        if (key === 'unresolved') {
          out.push(UNRESOLVED);
        } else if (key === 'dynamic') {
          // A constant container read with a run-time key: one of what it holds
          out.push(DYNAMIC, ...this.contents(object));
        } else if ('symbol' in key) {
          const slot =
            object.kind === 'object' && this.fresh(object) && key.symbol.wellKnown
              ? lookupSymbol(object, key.symbol.wellKnown)
              : undefined;
          if (slot) out.push(...this.readSlot(slot, object, node, env));
          else out.push(...this.giveUp(node, env));
        } else {
          out.push(...this.getProperty(object, key.name, node, env));
        }
      }
    }
    return this.settle(out);
  }

  /** What an array or an object literal holds, whichever element is read. */
  private contents(value: Value): Value[] {
    if (value.kind === 'array' && this.fresh(value)) return dense(value.items).filter(isResolved);
    if (value.kind === 'object' && this.fresh(value)) {
      const out: Value[] = [];
      for (const slot of value.properties.values()) {
        if (slot.values) out.push(...slot.values.filter(isResolved));
      }
      return out;
    }
    return [];
  }

  private getProperty(object: Value, name: string, node: AnyNode, env: Env | undefined): Value[] {
    switch (object.kind) {
      case 'dynamic':
      case 'unresolved':
        return [through(object)];

      case 'primitive': {
        const value = object.value;
        if (value == null && !object.boxed) return this.giveUp(node, env); // a TypeError
        if (typeof value === 'string') {
          // Its own properties: they do not go through a prototype
          if (name === 'length') return [primitive(value.length)];
          if (isArrayIndex(name) && Number(name) < value.length) return [primitive(value[Number(name)])];
          // (An index past the end is read from the prototype, which has none)
          if (this.ok && isArrayIndex(name)) return [UNDEFINED];
          if (this.ok && STRING_METHODS.has(name)) return [{ kind: 'method', receiver: object, name }];
        } else if (typeof value === 'number' || typeof value === 'bigint') {
          if (this.ok && NUMBER_METHODS.has(name)) return [{ kind: 'method', receiver: object, name }];
        } else if (typeof value === 'boolean') {
          if (this.ok && (name === 'toString' || name === 'valueOf')) {
            return [{ kind: 'method', receiver: object, name }];
          }
        }
        return this.giveUp(node, env);
      }

      case 'symbol':
        if (!this.ok) return this.giveUp(node, env);
        if (name === 'description' && object.description !== undefined) {
          return [object.description === null ? UNDEFINED : primitive(object.description)];
        }
        if (name === 'toString' || name === 'valueOf') return [{ kind: 'method', receiver: object, name }];
        return this.giveUp(node, env);

      case 'array':
        if (!this.fresh(object)) return this.giveUp(node, env);
        if (name === 'length') return [primitive(object.items.length)];
        // What is stored into something a variable holds may be read back under any key
        // (and what was stored may have been stored one level down: `table.list[0] = value`)
        if (object.bag && !ARRAY_METHODS.has(name)) return [...dense(object.items), object];
        if (isArrayIndex(name) && Number(name) < object.items.length) {
          const item = object.items[Number(name)];
          // (An empty slot is read from the prototype)
          if (item !== HOLE) return [item];
          return this.ok ? [UNDEFINED] : this.giveUp(node, env);
        }
        // (So is an index past the end)
        if (this.ok && isArrayIndex(name)) return [UNDEFINED];
        if (this.ok && ARRAY_METHODS.has(name)) return [{ kind: 'method', receiver: object, name }];
        return this.giveUp(node, env);

      case 'object': {
        if (!this.fresh(object)) return this.giveUp(node, env);
        const lookup = lookupProperty(object, name);
        if (lookup === 'none') return this.ok || object.proto === null ? [UNDEFINED] : this.giveUp(node, env);
        if (lookup === 'default') {
          if (!this.ok) return this.giveUp(node, env);
          if (name === 'toString' || name === 'valueOf' || name === 'hasOwnProperty') {
            return [{ kind: 'method', receiver: object, name }];
          }
          return this.giveUp(node, env);
        }
        return this.readSlot(lookup, object, node, env);
      }

      case 'function':
        if (!this.ok) return this.giveUp(node, env);
        if (name === 'name' && object.name !== undefined) return [primitive(object.name)];
        if (name === 'length') return [primitive(parameterCount(object.node))];
        if (name === 'call' || name === 'apply') return [{ kind: 'method', receiver: object, name }];
        return this.giveUp(node, env);

      case 'builtin':
        return this.builtinMember(object, name, node, env);

      case 'method':
        // A method taken off a string or a list (`[].join`) is one function object the whole
        // realm shares, and a script can put a `call` of its own on it without naming a
        // built-in: nothing is read from it
        return this.giveUp(node, env);

      case 'regexp':
        if (!this.ok) return this.giveUp(node, env);
        if (name === 'source') return [this.text(object.source, node)];
        if (name === 'flags') return [primitive(object.flags)];
        if (name === 'toString') return [{ kind: 'method', receiver: object, name }];
        return this.giveUp(node, env);
    }
  }

  /** An own data property of a built-in of the host: `Math.PI`, `Symbol.iterator`, `String.raw`. */
  private builtinMember(object: BuiltinValue, name: string, node: AnyNode, env: Env | undefined): Value[] {
    if (!this.ok) return this.giveUp(node, env);
    if (name === 'call' || name === 'apply') {
      // (Followed only where names are looked for: see `invokeMethod`)
      return this.lenient ? [{ kind: 'method', receiver: object, name }] : this.giveUp(node, env);
    }

    const host = hostObject(object.path);
    if (host === undefined) return this.giveUp(node, env);
    // A function taken off a built-in (`Math.max`) may be held by the script under another
    // name, and what it holds (`name`, `length`) can be deleted or redefined there: it is read
    // only where names are looked for
    if (typeof host === 'function' && !HOST_OBJECTS.has(object.path) && !this.lenient) return this.giveUp(node, env);
    const descriptor = Object.getOwnPropertyDescriptor(host, name);
    if (!descriptor || !('value' in descriptor)) return this.giveUp(node, env);

    const value: unknown = descriptor.value;
    switch (typeof value) {
      case 'string':
      case 'number':
      case 'boolean':
      case 'bigint':
      case 'undefined':
        return [primitive(value)];
      case 'symbol':
        return [
          object.path === 'Symbol'
            ? { kind: 'symbol', description: value.description ?? null, wellKnown: name }
            : { kind: 'symbol', description: value.description ?? null },
        ];
      case 'function':
        return [{ kind: 'builtin', path: `${object.path}.${name}` }];
      default:
        return value === null ? [primitive(null)] : this.giveUp(node, env);
    }
  }

  // --- calls ----------------------------------------------------------------------------------

  /** The argument lists a call may be made with, or `null` when that is not known. */
  private argumentLists(nodes: AnyNode[], node: AnyNode, env: Env | undefined): Value[][] | null {
    let lists: Value[][] = [[]];
    let known = true;
    for (const argument of nodes) {
      let expansions: Value[][] | null;
      if (argument.type === 'SpreadElement') {
        expansions = this.spread(this.ev(argument.argument, env), node);
      } else {
        expansions = this.ev(argument, env).map((value) => [value]);
      }
      // (The arguments after one that is not known are evaluated too: they may change something)
      if (!expansions) {
        known = false;
        continue;
      }
      if (!known) continue;
      if (lists.length * expansions.length > MAX_ALTERNATIVES) throw new OutOfBudget();
      const next: Value[][] = [];
      for (const list of lists) {
        for (const expansion of expansions) {
          if (list.length + expansion.length > MAX_ITEMS) throw new TooLong(node);
          // (The copy is of the whole list, not only of what is added to it)
          this.tick(1 + list.length + expansion.length);
          next.push(list.concat(expansion));
        }
      }
      lists = next;
    }
    return known ? lists : null;
  }

  private call(node: AnyNode, env: Env | undefined): Value[] {
    let callee: AnyNode = node.callee;
    while (callee?.type === 'ParenthesizedExpression' || callee?.type === 'ChainExpression') callee = callee.expression;
    if (!isAstNode(callee) || callee.type === 'Super') return this.giveUp(node, env);

    const out: Value[] = [];
    // The arguments are evaluated once, after what is called, and only when something is called
    let lists: Value[][] | null | undefined;
    const invokeAll = (invoke: (args: Value[]) => Value[]): boolean => {
      if (lists === undefined) lists = this.argumentLists(node.arguments ?? [], node, env);
      if (!lists) return false;
      for (const args of lists) out.push(...invoke(args));
      return true;
    };
    /** A call into something that is not known: it may change whatever it can reach */
    const unknownCall = (value: Value): void => {
      if (lists === undefined) lists = this.argumentLists(node.arguments ?? [], node, env);
      this.skipped();
      out.push(through(value));
    };

    const isMethodCall =
      callee.type === 'MemberExpression' &&
      isAstNode(callee.object) &&
      callee.object.type !== 'Super' &&
      !this.isGlobalObject(callee.object);

    if (isMethodCall) {
      const receivers = this.ev(callee.object, env);
      let keys: KeyName[] | undefined;

      for (const receiver of receivers) {
        if (receiver === STOPPED) {
          out.push(receiver);
          continue;
        }
        if (isNullish(receiver)) {
          if (callee.optional === true) out.push(STOPPED);
          else {
            keys ??= this.propertyKeys(callee, env);
            out.push(...this.giveUp(node, env)); // a TypeError
          }
          continue;
        }
        keys ??= this.propertyKeys(callee, env);
        if (!isResolved(receiver)) {
          unknownCall(receiver);
          continue;
        }
        for (const key of keys) {
          if (key === 'dynamic') unknownCall(DYNAMIC);
          else if (key === 'unresolved') unknownCall(UNRESOLVED);
          else if ('symbol' in key) out.push(...this.giveUp(node, env));
          else if (node.optional === true && this.isMissing(receiver, key.name, callee, env)) {
            out.push(STOPPED); // `receiver.method?.()` where there is no such method
          } else {
            // (A method of the engine may be missing where the script runs: then the call stops.
            // One every engine has, a method of a text or a list of ES2019 or before, does not.)
            const standard =
              (receiver.kind === 'primitive' || receiver.kind === 'array') && BASELINE_METHODS.has(key.name);
            if (node.optional === true && receiver.kind !== 'object' && !standard) out.push(STOPPED);
            // The function is read before the arguments are evaluated, and reading it can run a
            // getter. (Arguments that were evaluated for another alternative, before this
            // getter changed something, are not the ones this call gets.)
            const before = this.writes + this.heap;
            const methods = this.methodsOf(receiver, key.name, node, env);
            if (methods && lists !== undefined && this.writes + this.heap !== before) {
              out.push(...this.giveUp(node, env));
            } else if (
              !invokeAll((args) =>
                methods
                  ? methods.flatMap((method) => this.invoke(method, args, receiver, node, env))
                  : this.invokeMethod(receiver, key.name, args, node, env),
              )
            ) {
              return this.giveUp(node, env);
            }
          }
        }
      }
      return this.settle(out);
    }

    for (const target of this.ev(callee, env)) {
      if (target === STOPPED) {
        out.push(target);
      } else if (isNullish(target) && node.optional === true) {
        out.push(STOPPED);
      } else if (!isResolved(target)) {
        unknownCall(target);
      } else {
        // (A function of the engine may be missing where the script runs: then the call stops)
        if (node.optional === true && target.kind === 'builtin') out.push(STOPPED);
        if (!invokeAll((args) => this.invoke(target, args, undefined, node, env))) return this.giveUp(node, env);
      }
    }
    return this.settle(out);
  }

  /**
   * The values of a property of an object literal that is about to be called, read now: before
   * the arguments of the call. `undefined` where the property is not one the literal defines
   * (then nothing of the script runs to read it).
   */
  private methodsOf(receiver: Value, name: string, node: AnyNode, env: Env | undefined): Value[] | undefined {
    if (receiver.kind !== 'object' || !this.fresh(receiver)) return undefined;
    const lookup = lookupProperty(receiver, name);
    if (lookup === 'none' || lookup === 'default') return undefined;
    return this.readSlot(lookup, receiver, node, env);
  }

  /** Whether `receiver.name` is `undefined` or `null`: what an optional call stops at. */
  private isMissing(receiver: Value, name: string, member: AnyNode, env: Env | undefined): boolean {
    const values = this.getProperty(receiver, name, member, env);
    return values.length > 0 && values.every(isNullish);
  }

  private construct(node: AnyNode, env: Env | undefined): Value[] {
    const out: Value[] = [];
    const targets = this.ev(node.callee, env);
    const lists = this.argumentLists(node.arguments ?? [], node, env);
    for (const target of targets) {
      if (!isResolved(target)) {
        this.skipped();
        // (Whatever is constructed, `new` gives an object)
        out.push(target.kind === 'unresolved' && !target.held ? UNRESOLVED_OBJECT : DYNAMIC);
        continue;
      }
      // An instance of a class of the script: looked into only for the constants its fields hold
      const definition = target.kind === 'object' ? this.classOf.get(target) : undefined;
      if (definition && this.lenient) {
        out.push(this.classInstance(definition), ...this.giveUp(node, env, true));
        continue;
      }
      // An instance of anything but a built-in that is modelled here is an object that is not read
      if (target.kind !== 'builtin' || !lists) return this.giveUp(node, env, true);
      for (const args of lists) out.push(...this.callBuiltin(target.path, args, node, env, true));
    }
    return this.settle(out);
  }

  private tagged(node: AnyNode, env: Env | undefined): Value[] {
    const quasi: AnyNode = node.quasi;
    const quasis: AnyNode[] = quasi?.quasis ?? [];
    const expressions: AnyNode[] = quasi?.expressions ?? [];
    let tag: AnyNode = node.tag;
    while (tag?.type === 'ParenthesizedExpression' || tag?.type === 'ChainExpression') tag = tag.expression;
    if (!isAstNode(tag)) return this.giveUp(node, env);

    const isMethodTag =
      tag.type === 'MemberExpression' &&
      isAstNode(tag.object) &&
      tag.object.type !== 'Super' &&
      !this.isGlobalObject(tag.object);

    // What is called is evaluated first (a getter may run to read it), then the substitutions
    const receivers = isMethodTag ? this.ev(tag.object, env) : [];
    const keys = isMethodTag ? this.propertyKeys(tag, env) : [];
    const targets = isMethodTag ? [] : this.ev(tag, env);
    const read = new Map<Value, Map<string, Value[] | undefined>>();
    for (const receiver of receivers) {
      if (!isResolved(receiver)) continue;
      const byName = new Map<string, Value[] | undefined>();
      for (const key of keys) {
        if (typeof key === 'object' && 'name' in key)
          byName.set(key.name, this.methodsOf(receiver, key.name, node, env));
      }
      read.set(receiver, byName);
    }
    const lists = this.argumentLists(expressions, node, env);
    if (!lists) return this.giveUp(node, env);

    // String.raw`...`: the text as it is written, with its substitutions
    const raw = (args: Value[]): Value[] => {
      if (!this.ok) return this.giveUp(node, env);
      let acc: Value[] = [primitive('')];
      for (let index = 0; index < quasis.length; index++) {
        const text = quasis[index].value?.raw;
        if (typeof text !== 'string') return this.giveUp(node, env);
        acc = this.concatenate(acc, [primitive(text)], node);
        if (index < args.length) acc = this.concatenate(acc, this.asStrings([args[index]], node, env), node);
      }
      return acc;
    };
    // Any other tag is called with the pieces of the template, then with the substitutions
    const strings = (): ArrayValue =>
      this.rawArray(
        quasis.map((element) => {
          const cooked = element.value?.cooked;
          return typeof cooked === 'string' ? primitive(cooked) : UNDEFINED;
        }),
      );

    const out: Value[] = [];
    for (const receiver of receivers) {
      if (!isResolved(receiver)) {
        this.skipped();
        out.push(through(receiver));
        continue;
      }
      for (const key of keys) {
        if (typeof key !== 'object') {
          this.skipped();
          out.push(key === 'dynamic' ? DYNAMIC : UNRESOLVED);
        } else if ('symbol' in key) out.push(...this.giveUp(node, env));
        else {
          for (const args of lists) {
            const isRaw = receiver.kind === 'builtin' && receiver.path === 'String' && key.name === 'raw';
            const methods = read.get(receiver)?.get(key.name);
            if (isRaw) out.push(...raw(args));
            else if (methods) {
              for (const method of methods) out.push(...this.invoke(method, [strings(), ...args], receiver, node, env));
            } else out.push(...this.invokeMethod(receiver, key.name, [strings(), ...args], node, env));
          }
        }
      }
    }
    for (const target of targets) {
      if (!isResolved(target)) {
        this.skipped();
        out.push(through(target));
        continue;
      }
      for (const args of lists) {
        if (target.kind === 'builtin' && target.path === 'String.raw') out.push(...raw(args));
        else out.push(...this.invoke(target, [strings(), ...args], undefined, node, env));
      }
    }
    return this.settle(out);
  }

  /** Call a value. */
  private invoke(target: Value, args: Value[], self: Value | undefined, node: AnyNode, env: Env | undefined): Value[] {
    switch (target.kind) {
      case 'function':
        return this.apply(target, args, self, node, env);
      case 'builtin':
        return this.callBuiltin(target.path, args, node, env, false);
      case 'dynamic':
      case 'unresolved':
        this.skipped();
        return [through(target)];
      default:
        // A method taken off its object and called on nothing, or something that is not a
        // function (a TypeError)
        return this.giveUp(node, env);
    }
  }

  /** Call `receiver.name(...args)`. */
  private invokeMethod(receiver: Value, name: string, args: Value[], node: AnyNode, env: Env | undefined): Value[] {
    this.tick();
    switch (receiver.kind) {
      case 'dynamic':
      case 'unresolved':
        this.skipped();
        return [through(receiver)];

      case 'primitive': {
        const value = receiver.value;
        if (!this.ok) return this.giveUp(node, env, typeof value === 'string' && STRING_ARRAY_METHODS.has(name));
        if (typeof value === 'string') return this.stringMethod(value, name, args, node, env);
        if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
          return this.numberMethod(value, name, args, node, env);
        }
        return this.giveUp(node, env);
      }

      case 'array':
        if (receiver.bag && !ARRAY_METHODS.has(name)) {
          // A call on what a variable holds (`map.get(key)`): one of what was stored into it
          this.skipped();
          // (An iterator of it gives them one by one)
          if (name === 'next') {
            return [
              this.objectOf(new Map([['value', { values: dense(receiver.items) }]]), new Map(), undefined),
              ...this.giveUp(node, env),
            ];
          }
          return [...dense(receiver.items), ...this.giveUp(node, env)];
        }
        if (!this.ok || !this.fresh(receiver)) return this.giveUp(node, env, ARRAY_RETURNING_METHODS.has(name));
        return this.arrayMethod(receiver, name, args, node, env);

      case 'object': {
        if (!this.fresh(receiver)) return this.giveUp(node, env);
        const lookup = lookupProperty(receiver, name);
        if (lookup === 'none') return this.giveUp(node, env); // not a function
        if (lookup === 'default') {
          if (!this.ok) return this.giveUp(node, env);
          if (name === 'toString') return this.defaultToString(receiver, node, env);
          if (name === 'valueOf') return [receiver];
          if (name === 'hasOwnProperty' && args.length > 0) {
            const keys = this.keysOf([args[0]], node, env);
            const only = keys.length === 1 ? keys[0] : undefined;
            if (only && typeof only === 'object' && 'name' in only) {
              return [primitive(receiver.properties.has(only.name))];
            }
          }
          return this.giveUp(node, env);
        }
        const out: Value[] = [];
        for (const method of this.readSlot(lookup, receiver, node, env)) {
          out.push(...this.invoke(method, args, receiver, node, env));
        }
        return out;
      }

      case 'function':
        if (!this.ok) return this.giveUp(node, env);
        if (name === 'call') return this.apply(receiver, args.slice(1), args[0], node, env);
        if (name === 'apply') {
          const list = this.argumentArray(args[1]);
          return list ? this.apply(receiver, list, args[0], node, env) : this.giveUp(node, env);
        }
        return this.giveUp(node, env);

      case 'builtin': {
        if (!this.ok) return this.giveUp(node, env);
        if (name === 'call' || name === 'apply') {
          // `Math.max.apply(null, list)`. A script that holds the function can put a `call` of
          // its own on it, and called on an object of the script's choosing a function of a
          // built-in may do something else (`Array.of.call(Other, ...)`): this is followed only
          // where names are looked for
          const self = args[0];
          if (!this.lenient || (self !== undefined && !isNullish(self))) return this.giveUp(node, env);
          const list = name === 'call' ? args.slice(1) : this.argumentArray(args[1]);
          return list ? this.callBuiltin(receiver.path, list, node, env, false) : this.giveUp(node, env);
        }
        return this.callBuiltin(`${receiver.path}.${name}`, args, node, env, false);
      }

      case 'method':
        // (`[].join.call(list, '')`: see `getProperty`)
        return this.giveUp(node, env);

      case 'symbol':
        if (!this.ok) return this.giveUp(node, env);
        if (name === 'toString' && receiver.description !== undefined) {
          return [this.text(`Symbol(${receiver.description ?? ''})`, node)];
        }
        if (name === 'valueOf') return [receiver];
        return this.giveUp(node, env);

      case 'regexp':
        // Never run a pattern here
        if (this.ok && name === 'toString') return [this.text(`/${receiver.source}/${receiver.flags}`, node)];
        return this.giveUp(node, env);
    }
  }

  /** The array given to `apply`, as a list of arguments. */
  private argumentArray(value: Value | undefined): Value[] | null {
    if (value === undefined) return [];
    if (value.kind === 'array') return this.fresh(value) ? dense(value.items) : null;
    if (isNullish(value)) return [];
    return null;
  }

  /** Apply a function written in the script to arguments. */
  private apply(
    fn: FunctionValue,
    args: Value[],
    self: Value | undefined,
    node: AnyNode,
    env: Env | undefined,
  ): Value[] {
    const definition: AnyNode = fn.node;
    // A call of an async function is a promise, and a generator runs when it is iterated: what
    // it can be seen yielding is reported next to the object that is not read
    if (definition.generator === true && definition.async !== true) {
      return [this.yieldsOf(definition), ...this.giveUp(node, env, true)];
    }
    if (definition.async === true) return this.giveUp(node, env, true);
    if (this.depth >= MAX_DEPTH) throw new OutOfBudget();

    // Two parameters of one name, or one named like the function: which one a name stands for
    // depends on rules that are not followed here. A parameter that is a pattern is not either.
    const params: AnyNode[] = definition.params ?? [];
    const names = new Set<string>();
    if (definition.type === 'FunctionExpression' && definition.id) names.add(definition.id.name);
    for (const param of params) {
      const identifier =
        param.type === 'Identifier'
          ? param
          : param.type === 'AssignmentPattern'
            ? param.left
            : param.type === 'RestElement'
              ? param.argument
              : undefined;
      if (identifier?.type !== 'Identifier' || names.has(identifier.name)) return this.giveUp(node, env);
      names.add(identifier.name);
    }

    const isArrow = definition.type === 'ArrowFunctionExpression';
    const bindings = new Map<AnyNode, Value[]>();
    const scope: Env = {
      parent: fn.env,
      bindings,
      fn: definition,
      self: isArrow ? undefined : self,
      ownsSelf: !isArrow,
      createdAt: this.writes,
    };

    if (definition.type === 'FunctionExpression' && definition.id) bindings.set(definition.id, [fn]);
    for (let index = 0; index < params.length; index++) {
      const param = params[index];
      const given = args[index];
      if (param.type === 'Identifier') {
        bindings.set(param, [given ?? UNDEFINED]);
      } else if (param.type === 'AssignmentPattern') {
        if (given !== undefined && !isResolved(given)) {
          // Whether the default is used is not known, and a default may assign: nothing it
          // could have changed is read after it
          this.skipped();
          bindings.set(param.left, [plain(given)]);
        } else {
          bindings.set(param.left, isUndefined(given) ? this.ev(param.right, scope) : [given]);
        }
      } else {
        bindings.set(param.argument, [this.arrayOf(args.slice(index), node)]);
      }
    }

    this.depth++;
    try {
      const body: AnyNode = definition.body;
      if (body?.type !== 'BlockStatement') return this.ev(body, scope);

      // Functions declared in the body exist from its start
      const statements: AnyNode[] = body.body ?? [];
      for (const statement of statements) {
        if (statement.type === 'FunctionDeclaration' && statement.id) {
          bindings.set(statement.id, [
            { kind: 'function', node: statement, env: scope, name: String(statement.id.name) },
          ]);
        }
      }

      // A body of constant declarations and one return is followed.
      for (const statement of statements) {
        this.tick();
        if (statement.type === 'EmptyStatement' || statement.type === 'FunctionDeclaration') continue;
        if (statement.type === 'ExpressionStatement' && typeof statement.directive === 'string') continue;
        if (statement.type === 'ReturnStatement') {
          return statement.argument ? this.ev(statement.argument, scope) : [UNDEFINED];
        }
        if (statement.type !== 'VariableDeclaration' || statement.kind !== 'const') {
          return this.notFollowed(body, scope, node, env);
        }
        for (const declarator of statement.declarations ?? []) {
          if (declarator.id?.type !== 'Identifier' || !isAstNode(declarator.init)) {
            return this.notFollowed(body, scope, node, env);
          }
          bindings.set(declarator.id, this.ev(declarator.init, scope));
        }
      }
      return [UNDEFINED];
    } finally {
      this.depth--;
    }
  }

  /**
   * A function body that is not followed statement by statement (it branches, loops or assigns).
   * What its statements do is not known, so nothing they could have changed is read: a `return`
   * gives a value here only where its expression stands on its own (`return 'a'`,
   * `return () => 1`).
   *
   * Where every `return` gives such a value, the call gives one of them, or `undefined` when the
   * body ends without returning. Otherwise the call is unresolved when it is made of constants,
   * and the constants it can be seen returning are reported next to that, so that a refused name
   * in one of its `return` statements is named.
   */
  private notFollowed(body: AnyNode, scope: Env, node: AnyNode, env: Env | undefined): Value[] {
    this.skipped();
    const out: Value[] = [];
    let known = true;
    let objects = true;
    let returns = 0;
    const stack: AnyNode[] = [body];
    while (stack.length > 0) {
      const current = stack.pop();
      this.tick();
      if (current.type === 'ReturnStatement') {
        returns++;
        const argument: AnyNode = current.argument;
        if (!argument) {
          objects = false;
          continue;
        }
        let values = this.attempt(() => this.ev(argument, scope));
        if (!values.every(isResolved)) known = false;
        // `return name` of a variable of the body that is given one value: what it was given
        // (which the body may have changed since: a value to look at, not the value)
        const init = argument.type === 'Identifier' ? this.localInit(argument) : undefined;
        if (init && !values.some(isResolved)) values = this.attempt(() => this.ev(init, scope));
        for (const value of values) {
          const isObject =
            value.kind === 'array' ||
            value.kind === 'object' ||
            value.kind === 'function' ||
            (value.kind === 'primitive' && value.boxed === true) ||
            (value.kind === 'unresolved' && (value.object === true || this.looksLikeObject(argument)));
          if (!isObject) objects = false;
          if (isResolved(value)) out.push(value);
        }
        continue;
      }
      // The returns of a function inside the body are that function's
      if (
        current.type === 'FunctionExpression' ||
        current.type === 'FunctionDeclaration' ||
        current.type === 'ArrowFunctionExpression' ||
        current.type === 'ClassExpression' ||
        current.type === 'ClassDeclaration'
      ) {
        continue;
      }
      forEachChild(current, (child) => stack.push(child));
    }
    if (known) return this.settle([...out, UNDEFINED]);
    // (A function that returns an object wherever it can be seen returning is taken to give one.
    // It can also end without a `return`: what it gives then, `undefined`, is not a name.)
    return this.settle([...out, ...this.giveUp(node, env, objects && returns > 0)]);
  }

  // --- methods of strings and numbers ---------------------------------------------------------

  /**
   * The arguments of a host function, as host primitives. An argument that is not a primitive is
   * given as the string it converts to when it is an array, and ends the evaluation otherwise.
   */
  private hostArguments(args: Value[], node: AnyNode, env: Env | undefined): StaticPrimitive[] | Value[] {
    const out: StaticPrimitive[] = [];
    for (const arg of args) {
      if (!isResolved(arg)) return [plain(arg)];
      if (arg.kind === 'primitive' && !arg.boxed) {
        out.push(arg.value);
      } else if (arg.kind === 'array') {
        const converted = this.toPrimitive(arg, 'string', node, env);
        if (converted.length !== 1) return this.giveUp(node, env);
        if (converted[0].kind !== 'primitive') return [plain(converted[0])];
        out.push(converted[0].value);
      } else {
        return this.giveUp(node, env);
      }
    }
    this.read(...out);
    return out;
  }

  private stringMethod(text: string, name: string, args: Value[], node: AnyNode, env: Env | undefined): Value[] {
    const givesArray = STRING_ARRAY_METHODS.has(name);
    if (!STRING_METHODS.has(name)) return this.giveUp(node, env, givesArray);

    const given = this.hostArguments(args, node, env);
    if (!isPrimitiveList(given)) {
      // A short constant cut at a place that is only known at run time: one of its pieces
      const cut = name === 'slice' || name === 'substring' || name === 'substr';
      if (!cut || text.length > MAX_CUT_LENGTH || !given.every((value) => value.kind === 'dynamic')) return given;
      const pieces = new Set<string>();
      for (let start = 0; start < text.length; start++) {
        for (let end = start + 1; end <= text.length; end++) pieces.add(text.slice(start, end));
      }
      this.tick(pieces.size);
      return [DYNAMIC, ...Array.from(pieces, primitive)];
    }

    if (name === 'toLocaleLowerCase' || name === 'toLocaleUpperCase') {
      // What it gives depends on the locale of the host. For a text in ASCII that is the letter
      // i: dotted or dotless in the Turkic languages. Both answers are given. A text outside
      // ASCII has more letters of that kind than are told apart here.
      if (!isAscii(text)) return this.giveUp(node, env);
      this.tick(1 + (text.length >> 4));
      const lower = name === 'toLocaleLowerCase';
      const usual = lower ? text.toLowerCase() : text.toUpperCase();
      const turkic = lower ? text.replace(/I/g, '\u0131').toLowerCase() : text.replace(/i/g, '\u0130').toUpperCase();
      return usual === turkic ? [primitive(usual)] : [primitive(usual), primitive(turkic)];
    }
    const implementation: unknown = Reflect.get(String.prototype, name);
    if (typeof implementation !== 'function') return this.giveUp(node, env, givesArray);
    // (Reading a text costs its length, before anything here searches it)
    this.tick(1 + (text.length >> 4));

    // What the method may build, before it builds it. A result that is made of the text itself
    // is as large as the text, which the script holds already.
    let bounded = BOUNDED_STRING_METHODS.has(name);
    const count = (value: StaticPrimitive): number => {
      const number = Number(value);
      return Number.isNaN(number) ? 0 : number;
    };
    if (name === 'repeat' && text.length * count(given[0]) > MAX_STATIC_KEY_LENGTH) throw new TooLong(node);
    if ((name === 'padStart' || name === 'padEnd') && count(given[0]) > MAX_STATIC_KEY_LENGTH) throw new TooLong(node);
    if (name === 'replace' || name === 'replaceAll') {
      // A string pattern only: a pattern object is never run here
      const [pattern, replacement] = given;
      if (given.length < 2 || typeof pattern !== 'string' || typeof replacement !== 'string') {
        return this.giveUp(node, env);
      }
      if (replacement.length <= pattern.length && !replacement.includes('$')) {
        bounded = true; // no occurrence is replaced by something longer
      } else {
        // How often the pattern is found: `replace` replaces the first place, `replaceAll` every
        // one (an empty pattern is found between all the characters)
        let occurrences = 0;
        if (pattern === '') occurrences = name === 'replace' ? 1 : text.length + 1;
        else if (name === 'replace') occurrences = text.includes(pattern) ? 1 : 0;
        else {
          for (let at = text.indexOf(pattern); at !== -1; at = text.indexOf(pattern, at + pattern.length)) {
            occurrences++;
          }
        }
        // `$&` and `` $` `` in a replacement stand for parts of the text
        const each = replacement.length + (replacement.includes('$') ? text.length * replacement.length : 0);
        if (text.length + occurrences * each > MAX_STATIC_KEY_LENGTH) throw new TooLong(node);
      }
    }
    if (name === 'concat') {
      const total = given.reduce((sum: number, arg) => sum + String(arg).length, text.length);
      if (total > MAX_STATIC_KEY_LENGTH) throw new TooLong(node);
    }
    if (name === 'split' && given.length > 0 && given[0] !== undefined && typeof given[0] !== 'string') {
      return this.giveUp(node, env, true);
    }
    if (name === 'normalize' && text.length > MAX_STATIC_KEY_LENGTH) throw new TooLong(node);

    let result: unknown;
    try {
      result = Reflect.apply(implementation, text, given);
    } catch {
      return this.giveUp(node, env, givesArray); // the script's call throws as well
    }
    return this.fromHost(result, node, env, bounded);
  }

  private numberMethod(
    value: number | bigint | boolean,
    name: string,
    args: Value[],
    node: AnyNode,
    env: Env | undefined,
  ): Value[] {
    const allowed = typeof value === 'boolean' ? name === 'toString' || name === 'valueOf' : NUMBER_METHODS.has(name);
    const owner =
      typeof value === 'number' ? Number.prototype : typeof value === 'bigint' ? BigInt.prototype : Boolean.prototype;
    const method: unknown = allowed ? Reflect.get(owner, name) : undefined;
    if (typeof method !== 'function') return this.giveUp(node, env);

    const given = this.hostArguments(args, node, env);
    if (!isPrimitiveList(given)) return given;
    if (given.some((arg) => typeof arg === 'bigint')) return this.giveUp(node, env);

    let result: unknown;
    try {
      result = Reflect.apply(method, value, given);
    } catch {
      return this.giveUp(node, env);
    }
    return this.fromHost(result, node, env, false);
  }

  /**
   * A value a host function returned: a primitive, or an array of strings.
   *
   * @param bounded The result is made of a text the script holds: it is not measured
   */
  private fromHost(result: unknown, node: AnyNode, env: Env | undefined, bounded: boolean): Value[] {
    switch (typeof result) {
      case 'string':
        return [bounded ? primitive(result) : this.text(result, node)];
      case 'number':
      case 'boolean':
      case 'bigint':
      case 'undefined':
        return [primitive(result)];
      case 'object':
        if (result === null) return [primitive(null)];
        if (Array.isArray(result)) {
          if (!bounded && result.length > MAX_ITEMS) throw new TooLong(node);
          this.tick(result.length);
          const items: Value[] = [];
          for (const entry of result) {
            if (typeof entry !== 'string') return this.giveUp(node, env, true);
            items.push(bounded ? primitive(entry) : this.text(entry, node));
          }
          return [this.rawArray(items)];
        }
        return this.giveUp(node, env);
      default:
        return this.giveUp(node, env);
    }
  }

  // --- methods of arrays ----------------------------------------------------------------------

  /** One call of a callback: its one result, or `null` when it has several. */
  private callOnce(callback: Value, args: Value[], node: AnyNode, env: Env | undefined): Value | null {
    const results = this.invoke(callback, args, undefined, node, env);
    return results.length === 1 ? results[0] : null;
  }

  private arrayMethod(array: ArrayValue, name: string, args: Value[], node: AnyNode, env: Env | undefined): Value[] {
    const items = array.items;
    this.tick(items.length);
    const givesArray = ARRAY_RETURNING_METHODS.has(name);
    // (A method that changes a frozen list throws, and so does one that adds to a sealed list or
    // takes from it. One that only writes the elements a sealed list has does not.)
    const lock = MUTATING_ARRAY_METHODS.has(name) ? this.locked.get(array.items) : undefined;
    if (lock === 'frozen' || (lock === 'sealed' && (!SHAPE_KEEPING_METHODS.has(name) || hasHole(items)))) {
      return this.giveUp(node, env, givesArray);
    }
    // These read one element or keep the slots as they are. Every other method walks the array
    // and treats an empty slot in a way of its own.
    if (hasHole(items) && !HOLE_NEUTRAL_METHODS.has(name)) return this.giveUp(node, env, givesArray);

    const integer = (value: Value | undefined, fallback: number): number | null => {
      if (value === undefined) return fallback;
      if (value.kind !== 'primitive' || value.boxed) return null;
      if (value.value === undefined) return fallback;
      if (typeof value.value !== 'number') return null;
      return Number.isNaN(value.value) ? 0 : Math.trunc(value.value);
    };
    const position = (index: number, length: number): number =>
      index < 0 ? Math.max(0, length + index) : Math.min(index, length);
    /** A method that changes its array leaves the array as it was read stale. */
    const changes = (): void => {
      if (MUTATING_ARRAY_METHODS.has(name)) this.heap++;
    };
    const listOf = (values: readonly Value[]): Value[] => {
      changes();
      const list = this.arrayOf(values, node);
      // `reverse`, `sort`, `fill` give the list they changed, which is still sealed
      if (lock && SHAPE_KEEPING_METHODS.has(name)) this.locked.set(list.items, lock);
      return [list];
    };
    /** Not computed. With a run-time argument: one of the elements, or a list of some of them. */
    const failed = (): Value[] => {
      const unknown = args.find((arg) => !isResolved(arg));
      if (!unknown) return this.giveUp(node, env, givesArray);
      this.skipped();
      if (through(unknown).kind !== 'dynamic') return [UNRESOLVED];
      const held = dense(items).filter(isResolved);
      return givesArray
        ? [DYNAMIC, { kind: 'array', items: held, bag: true, epoch: this.epoch, born: this.heap }]
        : [DYNAMIC, ...held];
    };

    switch (name) {
      case 'toString':
        return this.joined(array, ',', node, env);

      case 'join': {
        const separator = args[0];
        if (isUndefined(separator)) return this.joined(array, ',', node, env);
        const out: Value[] = [];
        for (const text of this.asStrings([separator], node, env)) {
          if (text.kind !== 'primitive') out.push(text);
          else out.push(...this.joined(array, String(text.value), node, env));
        }
        return this.settle(out);
      }

      case 'valueOf':
        return [array];

      case 'concat': {
        const out: Value[] = [...items];
        for (const arg of args) {
          if (!isResolved(arg)) return [through(arg)];
          if (arg.kind === 'array') {
            if (!this.fresh(arg)) return this.giveUp(node, env, true);
            // (Measured and paid for before it is copied: each list may fit where all do not)
            if (out.length + arg.items.length > MAX_ITEMS) throw new TooLong(node);
            this.tick(arg.items.length);
            out.push(...arg.items);
          } else if (arg.kind === 'object')
            return this.giveUp(node, env, true); // may be spreadable
          else out.push(arg);
        }
        return listOf(out);
      }

      case 'slice': {
        const start = integer(args[0], 0);
        const end = integer(args[1], items.length);
        if (start === null || end === null) return failed();
        return listOf(items.slice(position(start, items.length), position(end, items.length)));
      }

      case 'at': {
        const index = integer(args[0], 0);
        if (index === null) return failed();
        return [dense(items)[index < 0 ? items.length + index : index] ?? UNDEFINED];
      }

      case 'reverse':
        return listOf([...items].reverse());
      case 'toReversed':
        return listOf(dense(items).reverse());

      case 'pop':
        changes();
        return [dense(items)[items.length - 1] ?? UNDEFINED];
      case 'shift':
        changes();
        return [dense(items)[0] ?? UNDEFINED];
      case 'push':
      case 'unshift':
        changes();
        return [primitive(items.length + args.length)];

      case 'fill': {
        if (args.length !== 1) return failed();
        return listOf(items.map(() => args[0]));
      }

      case 'flat': {
        const depth = integer(args[0], 1);
        if (depth === null || depth > 16) return failed();
        // An empty slot of an array that is flattened is dropped: such an array is not evaluated
        let unknown = false;
        const flatten = (values: readonly Value[], level: number): Value[] => {
          const out: Value[] = [];
          for (const value of values) {
            this.tick();
            if (value.kind === 'array' && level > 0) {
              if (hasHole(value.items) || !this.fresh(value)) unknown = true;
              out.push(...flatten(value.items, level - 1));
            } else out.push(value);
            if (out.length > MAX_ITEMS) throw new TooLong(node);
          }
          return out;
        };
        const flat = flatten(items, depth);
        return unknown ? this.giveUp(node, env, true) : listOf(flat);
      }

      case 'includes':
      case 'indexOf':
      case 'lastIndexOf': {
        const wanted = args[0] ?? UNDEFINED;
        if (!isResolved(wanted)) return [through(wanted)];
        if (args.length > 1 || wanted.kind !== 'primitive' || wanted.boxed) return this.giveUp(node, env);
        if (!items.every((item) => item.kind === 'primitive' && !item.boxed)) return this.giveUp(node, env);
        const values = items.map((item) => (item as PrimitiveValue).value);
        if (name === 'includes') return [primitive(values.includes(wanted.value))];
        return [primitive(name === 'indexOf' ? values.indexOf(wanted.value) : values.lastIndexOf(wanted.value))];
      }

      case 'sort':
      case 'toSorted': {
        // Without a comparison function the order is that of the elements as strings
        if (args.length > 0) return failed();
        if (!items.every((item) => item.kind === 'primitive' && !item.boxed)) return this.giveUp(node, env, true);
        const values = items.map((item) => (item as PrimitiveValue).value);
        return listOf(values.sort().map(primitive));
      }

      case 'map':
      case 'flatMap':
      case 'forEach':
      case 'filter':
      case 'find':
      case 'findLast':
      case 'findIndex':
      case 'findLastIndex':
      case 'some':
      case 'every': {
        const callback = args[0];
        if (callback === undefined) return this.giveUp(node, env, givesArray);
        if (!isResolved(callback)) return failed();
        if (!isCallable(callback) || args.length > 1) return this.giveUp(node, env, givesArray);

        const backwards = name === 'findLast' || name === 'findLastIndex';
        const mapped: Value[] = [];
        const kept: Value[] = [];
        for (let step = 0; step < items.length; step++) {
          const index = backwards ? items.length - 1 - step : step;
          const item = items[index];
          const result = this.callOnce(callback, [item, primitive(index), array], node, env);
          // (The callback may have changed the array it walks)
          if (result === null || !this.fresh(array)) return this.giveUp(node, env, givesArray);
          if (name === 'map') {
            mapped.push(result);
            continue;
          }
          if (name === 'forEach') continue;
          if (name === 'flatMap') {
            if (!isResolved(result)) return [through(result)];
            if (result.kind === 'array') {
              // (An empty slot is dropped when it is flattened)
              if (hasHole(result.items) || !this.fresh(result)) return this.giveUp(node, env, true);
              mapped.push(...result.items);
            } else mapped.push(result);
            if (mapped.length > MAX_ITEMS) throw new TooLong(node);
            continue;
          }
          // The others decide on whether the result is true
          const yes = this.truthiness(result);
          if (yes === undefined) return isResolved(result) ? this.giveUp(node, env, givesArray) : [plain(result)];
          if (name === 'filter') {
            if (yes) kept.push(item);
          } else if (name === 'find' || name === 'findLast') {
            if (yes) return [item];
          } else if (name === 'findIndex' || name === 'findLastIndex') {
            if (yes) return [primitive(index)];
          } else if (name === 'some') {
            if (yes) return [primitive(true)];
          } else if (!yes) {
            return [primitive(false)];
          }
        }
        switch (name) {
          case 'map':
          case 'flatMap':
            return listOf(mapped);
          case 'filter':
            return listOf(kept);
          case 'forEach':
          case 'find':
          case 'findLast':
            return [UNDEFINED];
          case 'findIndex':
          case 'findLastIndex':
            return [primitive(-1)];
          case 'some':
            return [primitive(false)];
          default:
            return [primitive(true)];
        }
      }

      case 'reduce':
      case 'reduceRight': {
        const callback = args[0];
        if (callback === undefined) return this.giveUp(node, env);
        if (!isResolved(callback)) return failed();
        if (!isCallable(callback)) return this.giveUp(node, env);
        const order =
          name === 'reduce'
            ? items.map((_item, index) => index)
            : items.map((_item, index) => items.length - 1 - index);
        let acc: Value;
        if (args.length > 1) {
          acc = args[1];
        } else {
          const first = order.shift();
          if (first === undefined) return this.giveUp(node, env); // a TypeError: nothing to reduce
          acc = items[first];
        }
        for (const index of order) {
          const result = this.callOnce(callback, [acc, items[index], primitive(index), array], node, env);
          if (result === null || !this.fresh(array)) return this.giveUp(node, env);
          acc = result;
        }
        return [acc];
      }

      default:
        return this.giveUp(node, env, givesArray);
    }
  }

  // --- built-in functions ---------------------------------------------------------------------

  private callBuiltin(path: string, args: Value[], node: AnyNode, env: Env | undefined, isNew: boolean): Value[] {
    this.tick();
    // The clock, and a date in the time zone of the host: not in the script
    if (path === 'Date' || path.startsWith('Date.')) return [DYNAMIC];
    if (this.lenient && isNew) {
      // Looked into only for the constants they hold: what a map or a set was made from, the
      // message of an error
      if (path === 'Map' || path === 'Set') {
        const items: Value[] = [];
        const first = args[0];
        for (const entry of first?.kind === 'array' ? dense(first.items) : []) {
          // (Of a map, the values: they are what `get` gives)
          if (path === 'Map') {
            const value = entry.kind === 'array' ? dense(entry.items)[1] : undefined;
            if (value && isResolved(value)) items.push(value);
          } else if (isResolved(entry)) items.push(entry);
        }
        return [
          { kind: 'array', items, bag: true, epoch: this.epoch, born: this.heap },
          ...this.giveUp(node, env, true),
        ];
      }
      if (path === 'Error' || path.endsWith('Error')) {
        const message = args[0] ?? primitive('');
        const properties = new Map<string, Slot>([['message', { values: [message] }]]);
        return [this.objectOf(properties, new Map(), undefined), ...this.giveUp(node, env, true)];
      }
    }
    if (!this.ok) return this.giveUp(node, env, isNew);
    const first = args[0];

    switch (path) {
      // The random number generator: what it gives is not in the script
      case 'Math.random':
        return [DYNAMIC];

      case 'String': {
        if (args.length === 0) return [isNew ? { kind: 'primitive', value: '', boxed: true } : primitive('')];
        if (!isNew && first.kind === 'symbol' && first.description !== undefined) {
          return [this.text(`Symbol(${first.description ?? ''})`, node)];
        }
        const out: Value[] = [];
        for (const text of this.asStrings([first], node, env)) {
          if (text.kind === 'primitive' && isNew) out.push({ kind: 'primitive', value: text.value, boxed: true });
          else out.push(text);
        }
        return out;
      }

      case 'Number':
      case 'Boolean':
      case 'BigInt': {
        if (path === 'Boolean') {
          const value = first === undefined ? false : this.truthiness(first);
          if (value === undefined) return isResolved(first) ? this.giveUp(node, env) : [plain(first)];
          return [isNew ? { kind: 'primitive', value, boxed: true } : primitive(value)];
        }
        if (args.length === 0) {
          if (path === 'BigInt') return this.giveUp(node, env);
          return [isNew ? { kind: 'primitive', value: 0, boxed: true } : primitive(0)];
        }
        if (path === 'BigInt' && isNew) return this.giveUp(node, env);
        const out: Value[] = [];
        for (const operand of this.toPrimitive(first, 'number', node, env)) {
          if (operand.kind !== 'primitive') {
            out.push(...(operand.kind === 'symbol' ? this.giveUp(node, env) : [plain(operand)]));
            continue;
          }
          this.read(operand.value);
          if (path === 'BigInt') {
            const digits = typeof operand.value === 'string' ? operand.value.length : 0;
            if (digits > MAX_BIGINT_DIGITS) throw new TooLong(node);
            let big: bigint | undefined;
            try {
              big = BigInt(operand.value as string | number | bigint | boolean);
            } catch {
              big = undefined; // a SyntaxError, a RangeError, a TypeError
            }
            out.push(...(big === undefined ? this.giveUp(node, env) : [primitive(big)]));
          } else {
            let value: number | undefined;
            try {
              value = Number(operand.value);
            } catch {
              value = undefined;
            }
            if (value === undefined) out.push(...this.giveUp(node, env));
            else out.push(isNew ? { kind: 'primitive', value, boxed: true } : primitive(value));
          }
        }
        return out;
      }

      case 'Symbol':
      case 'Symbol.for': {
        if (isNew) return this.giveUp(node, env);
        // `Symbol()` and `Symbol(undefined)` have no description; `Symbol.for()` is keyed 'undefined'
        if (isUndefined(first) && path === 'Symbol') return [{ kind: 'symbol', description: null }];
        if (first === undefined) return [{ kind: 'symbol', description: 'undefined' }];
        const out: Value[] = [];
        for (const text of this.asStrings([first], node, env)) {
          if (text.kind === 'primitive') out.push({ kind: 'symbol', description: String(text.value) });
          else out.push(text);
        }
        return out;
      }

      case 'Object': {
        if (first === undefined) return [this.objectOf(new Map(), new Map(), undefined)];
        if (!isResolved(first)) return [plain(first)];
        if (first.kind === 'primitive' && !first.boxed) {
          return first.value == null
            ? [this.objectOf(new Map(), new Map(), undefined)]
            : [{ kind: 'primitive', value: first.value, boxed: true }];
        }
        return [first];
      }

      case 'Array': {
        // One number is a length. (A number in an object, `Array(Object(3))`, is one element.)
        if (
          args.length === 1 &&
          isResolved(first) &&
          first.kind === 'primitive' &&
          !first.boxed &&
          typeof first.value === 'number'
        ) {
          const length = first.value;
          if (!Number.isInteger(length) || length < 0) return this.giveUp(node, env); // a RangeError
          if (length > MAX_ITEMS) throw new TooLong(node);
          this.tick(length);
          return [
            this.arrayOf(
              Array.from({ length }, () => HOLE),
              node,
            ),
          ];
        }
        if (args.length === 1 && !isResolved(first)) return [plain(first)];
        return [this.arrayOf(args, node)];
      }

      case 'Array.of':
        return [this.arrayOf(args, node)];

      case 'Array.isArray':
        if (first === undefined) return [primitive(false)];
        return isResolved(first) ? [primitive(first.kind === 'array')] : [plain(first)];

      case 'Array.from': {
        if (first === undefined) return this.giveUp(node, env);
        if (!isResolved(first)) return [plain(first)];
        let items: Value[];
        if (first.kind === 'array' && this.fresh(first)) {
          this.tick(first.items.length);
          items = dense(first.items);
        } else if (first.kind === 'primitive' && !first.boxed && typeof first.value === 'string') {
          items = this.characters(first.value, node).map(primitive);
        } else return this.giveUp(node, env, true);
        if (args.length === 1) return [this.arrayOf(items, node)];
        if (args.length > 2) return this.giveUp(node, env, true);
        const mapper = args[1];
        if (isUndefined(mapper)) return [this.arrayOf(items, node)];
        if (!isResolved(mapper)) {
          this.skipped();
          return [through(mapper)];
        }
        if (!isCallable(mapper)) return this.giveUp(node, env, true); // a TypeError
        // (Unlike `map`, the mapper is not given the list: a third parameter keeps its default)
        const source = this.arrayOf(items, node);
        const mapped: Value[] = [];
        for (let index = 0; index < items.length; index++) {
          const result = this.callOnce(mapper, [items[index], primitive(index)], node, env);
          // (The mapper may have changed the list that is read)
          if (result === null || !this.fresh(source)) return this.giveUp(node, env, true);
          mapped.push(result);
        }
        return [this.arrayOf(mapped, node)];
      }

      case 'String.fromCharCode':
      case 'String.fromCodePoint': {
        if (args.length > MAX_STATIC_KEY_LENGTH) throw new TooLong(node);
        const given = this.hostArguments(args, node, env);
        if (!isPrimitiveList(given)) return given;
        if (given.some((arg) => typeof arg === 'bigint')) return this.giveUp(node, env);
        let text: string;
        try {
          const numbers = given.map((arg) => Number(arg));
          text = path === 'String.fromCharCode' ? String.fromCharCode(...numbers) : String.fromCodePoint(...numbers);
        } catch {
          return this.giveUp(node, env); // a RangeError
        }
        return [this.text(text, node)];
      }

      case 'parseInt':
      case 'parseFloat':
      case 'isNaN':
      case 'isFinite':
      case 'Number.parseInt':
      case 'Number.parseFloat':
      case 'Number.isInteger':
      case 'Number.isFinite':
      case 'Number.isNaN':
      case 'Number.isSafeInteger': {
        // The functions of `Number` answer false for anything that is not a number as it is,
        // also for a number in an object; the global ones convert their argument first
        if (path.startsWith('Number.is') && first !== undefined && isResolved(first)) {
          if (first.kind !== 'primitive' || first.boxed) return [primitive(false)];
        }
        const given = this.hostArguments(args, node, env);
        if (!isPrimitiveList(given)) return given;
        let result: StaticPrimitive;
        try {
          result = hostNumberFunction(path, given);
        } catch {
          return this.giveUp(node, env); // a TypeError: a BigInt that is converted
        }
        return [primitive(result)];
      }

      case 'JSON.stringify': {
        if (first === undefined) return [UNDEFINED];
        if (!isResolved(first)) return [plain(first)];
        const replacer = args[1];
        if (replacer !== undefined && !isNullish(replacer)) return this.giveUp(node, env);
        const indent = args[2];
        if (indent !== undefined && (indent.kind !== 'primitive' || indent.boxed || typeof indent.value === 'bigint')) {
          return this.giveUp(node, env);
        }
        // (The indentation: at most ten characters for each level, as the engine takes it)
        const gap =
          indent?.kind !== 'primitive'
            ? 0
            : typeof indent.value === 'number'
              ? Math.max(0, Math.min(10, Math.trunc(indent.value) || 0))
              : typeof indent.value === 'string'
                ? Math.min(10, indent.value.length)
                : 0;
        const data = this.toHostData(first, node, env, { left: MAX_ITEMS, written: 0, gap }, 0);
        if (data === NO_VALUE) return this.giveUp(node, env);
        let text: unknown;
        try {
          text = JSON.stringify(
            data,
            null,
            indent?.kind === 'primitive' ? (indent.value as string | number) : undefined,
          );
        } catch {
          return this.giveUp(node, env); // a TypeError: a BigInt
        }
        return typeof text === 'string' ? [this.text(text, node)] : [UNDEFINED];
      }

      case 'JSON.parse': {
        if (args.length !== 1) return this.giveUp(node, env);
        const out: Value[] = [];
        for (const text of this.asStrings([first], node, env)) {
          if (text.kind !== 'primitive') {
            out.push(text);
            continue;
          }
          const source = String(text.value);
          if (source.length > MAX_STATIC_KEY_LENGTH) throw new TooLong(node);
          let data: unknown;
          try {
            data = JSON.parse(source);
          } catch {
            out.push(...this.giveUp(node, env)); // a SyntaxError
            continue;
          }
          const value = this.fromHostData(data, node, { left: MAX_ITEMS }, 0);
          out.push(...(value ? [value] : this.giveUp(node, env)));
        }
        return out;
      }

      case 'Object.keys':
      case 'Object.getOwnPropertyNames':
      case 'Object.values':
      case 'Object.entries': {
        if (first === undefined) return this.giveUp(node, env);
        if (!isResolved(first)) return [plain(first)];
        let entries: Array<[string, () => Value[]]>;
        if (first.kind === 'object' && this.fresh(first)) {
          entries = ownKeys(first).map((key) => {
            const slot = first.properties.get(key) as Slot;
            return [key, () => this.readSlot(slot, first, node, env)];
          });
        } else if (first.kind === 'array' && this.fresh(first)) {
          if (hasHole(first.items)) return this.giveUp(node, env, true);
          entries = first.items.map((item, index) => [String(index), () => [item]]);
          if (path === 'Object.getOwnPropertyNames') entries.push(['length', () => [primitive(first.items.length)]]);
        } else if (first.kind === 'primitive' && !first.boxed && typeof first.value === 'string') {
          const text = first.value;
          if (text.length > MAX_ITEMS) throw new TooLong(node);
          entries = Array.from({ length: text.length }, (_unused, index) => [
            String(index),
            () => [primitive(text[index])],
          ]);
          if (path === 'Object.getOwnPropertyNames') entries.push(['length', () => [primitive(text.length)]]);
        } else {
          return this.giveUp(node, env, true);
        }
        this.tick(entries.length);
        if (path === 'Object.keys' || path === 'Object.getOwnPropertyNames') {
          return [this.rawArray(entries.map(([key]) => primitive(key)))];
        }
        const items: Value[] = [];
        for (const [key, read] of entries) {
          const values = read();
          // (A getter can change the object that is being listed)
          if (values.length !== 1 || (first.kind === 'object' && !this.fresh(first)))
            return this.giveUp(node, env, true);
          items.push(path === 'Object.values' ? values[0] : this.rawArray([primitive(key), values[0]]));
        }
        return [this.rawArray(items)];
      }

      case 'Object.freeze':
      case 'Object.seal':
      case 'Object.preventExtensions': {
        if (first === undefined) return [UNDEFINED];
        // The same object, holding what it held. From here on a write to it throws (to a sealed
        // one, may throw), through whichever name it is reached: it is not computed as a write
        // that succeeds.
        const content = first.kind === 'array' ? first.items : first.kind === 'object' ? first.properties : undefined;
        if (content) {
          // (Frozen stays frozen: sealing it afterwards does not make its elements writable)
          const frozen = path === 'Object.freeze' || this.locked.get(content) === 'frozen';
          this.locked.set(content, frozen ? 'frozen' : 'sealed');
        }
        return [first];
      }

      case 'Object.assign': {
        if (first === undefined) return this.giveUp(node, env);
        if (!isResolved(first)) {
          this.skipped();
          return [plain(first)];
        }
        if (first.kind !== 'object' || !this.fresh(first) || this.locked.has(first.properties)) {
          return this.giveUp(node, env, true);
        }
        // (What the target holds is copied: that costs what the target is large)
        this.tick(first.properties.size + first.symbols.size);
        const properties = new Map(first.properties);
        const symbols = new Map(first.symbols);
        for (const source of args.slice(1)) {
          if (!isResolved(source)) {
            this.skipped();
            return [source.kind === 'unresolved' && !source.held ? UNRESOLVED_OBJECT : DYNAMIC];
          }
          if (isNullish(source)) continue;
          if (source.kind !== 'object' || !this.fresh(source)) return this.giveUp(node, env, true);
          // Assigning `__proto__` changes the prototype of the target: it is not a copy
          if (source.properties.has('__proto__')) return this.giveUp(node, env, true);
          this.tick(source.properties.size);
          // A getter of the source is called, a setter of the target is called: neither is a copy
          for (const [key, slot] of source.properties) {
            const existing = properties.get(key) ?? lookupProperty(first, key);
            if (isAccessor(slot) || (typeof existing === 'object' && isAccessor(existing))) {
              return this.giveUp(node, env, true);
            }
            properties.set(key, slot);
          }
          for (const [key, slot] of source.symbols) {
            const existing = symbols.get(key);
            if (isAccessor(slot) || (existing && isAccessor(existing))) return this.giveUp(node, env, true);
            symbols.set(key, slot);
          }
        }
        // The target is changed and returned: the object as it was read is stale
        this.heap++;
        return [this.objectOf(properties, symbols, first.proto)];
      }

      case 'Object.fromEntries': {
        if (first === undefined) return this.giveUp(node, env);
        if (!isResolved(first)) return [plain(first)];
        if (first.kind !== 'array' || !this.fresh(first) || hasHole(first.items)) return this.giveUp(node, env, true);
        const properties = new Map<string, Slot>();
        this.tick(first.items.length);
        for (const entry of first.items) {
          if (!isResolved(entry)) return [entry.kind === 'unresolved' && !entry.held ? UNRESOLVED_OBJECT : DYNAMIC];
          if (entry.kind !== 'array' || !this.fresh(entry)) return this.giveUp(node, env, true);
          const pair = dense(entry.items);
          const keys = this.keysOf([pair[0] ?? UNDEFINED], node, env);
          const only = keys.length === 1 ? keys[0] : undefined;
          if (!only || typeof only !== 'object' || !('name' in only)) return this.giveUp(node, env, true);
          properties.set(only.name, { values: [pair[1] ?? UNDEFINED] });
        }
        return [this.objectOf(properties, new Map(), undefined)];
      }

      default:
        break;
    }

    const convert = TEXT_FUNCTIONS.get(path);
    if (convert) {
      const out: Value[] = [];
      for (const text of this.asStrings([first ?? UNDEFINED], node, env)) {
        if (text.kind !== 'primitive') {
          out.push(text);
          continue;
        }
        const source = String(text.value);
        if (source.length > MAX_STATIC_KEY_LENGTH) throw new TooLong(node);
        let converted: string | undefined;
        try {
          converted = convert(source);
        } catch {
          converted = undefined; // a URIError, or a character the function does not take
        }
        // (The limit of a key is checked outside the `try`: it is not an error of the function)
        out.push(...(converted === undefined ? this.giveUp(node, env) : [this.text(converted, node)]));
      }
      return out;
    }

    if (path.startsWith('Math.') && MATH_FUNCTIONS.has(path.slice(5))) {
      const given = this.hostArguments(args, node, env);
      if (!isPrimitiveList(given)) return given;
      if (given.some((arg) => typeof arg === 'bigint')) return this.giveUp(node, env);
      const method: unknown = Reflect.get(Math, path.slice(5));
      if (typeof method !== 'function') return this.giveUp(node, env);
      const numbers = given.map((arg) => Number(arg));
      return [primitive(Number(Reflect.apply(method, Math, numbers)))];
    }

    return this.giveUp(node, env, isNew);
  }

  /**
   * A value as plain host data, for `JSON.stringify`.
   *
   * The same string can be held many times, and it is written out each time: how many values
   * there are does not bound what the host would write. `budget.written` counts characters that
   * are written for certain (a string and its quotes, a key and its colon, what separates and
   * indents two elements), and the data is not built past the length a key can have. The count
   * is never more than what is written, so nothing that fits is refused by it.
   */
  private toHostData(
    value: Value,
    node: AnyNode,
    env: Env | undefined,
    budget: { left: number; written: number; gap: number },
    depth: number,
  ): unknown {
    if (--budget.left < 0) throw new TooLong(node);
    if (depth > 64) return NO_VALUE;
    this.tick();
    const written = (count: number): void => {
      budget.written += count;
      if (budget.written > MAX_STATIC_KEY_LENGTH) throw new TooLong(node);
    };
    /** A line of its own, indented, for what is inside an array or an object. */
    const line = budget.gap > 0 ? 1 + budget.gap * (depth + 1) : 0;
    switch (value.kind) {
      case 'primitive':
        if (value.boxed) return NO_VALUE;
        if (typeof value.value === 'string') written(value.value.length + 2);
        return value.value;
      case 'array': {
        if (!this.fresh(value)) return NO_VALUE;
        const out: unknown[] = [];
        for (const item of value.items) {
          written(1 + line); // (a comma or a bracket)
          const data = this.toHostData(item, node, env, budget, depth + 1);
          if (data === NO_VALUE) return NO_VALUE;
          out.push(data);
        }
        return out;
      }
      case 'object': {
        if (!this.fresh(value) || value.proto !== undefined || value.properties.has('toJSON')) return NO_VALUE;
        const out: Record<string, unknown> = Object.create(null);
        for (const key of ownKeys(value)) {
          const slot = value.properties.get(key) as Slot;
          const values = this.readSlot(slot, value, node, env);
          // (A getter can change the object that is being serialized)
          if (values.length !== 1 || !this.fresh(value)) return NO_VALUE;
          const data = this.toHostData(values[0], node, env, budget, depth + 1);
          if (data === NO_VALUE) return NO_VALUE;
          // (A property whose value is `undefined` is left out)
          if (data !== undefined) written(key.length + 3 + line);
          Object.defineProperty(out, key, { value: data, enumerable: true, writable: true, configurable: true });
        }
        return out;
      }
      default:
        return NO_VALUE;
    }
  }

  /** Plain data `JSON.parse` returned, as a value; `undefined` when it nests too deep to read. */
  private fromHostData(data: unknown, node: AnyNode, budget: { left: number }, depth: number): Value | undefined {
    if (--budget.left < 0) throw new TooLong(node);
    if (depth > 64) return undefined;
    this.tick();
    if (data === null || typeof data !== 'object') return primitive(data as StaticPrimitive);
    if (Array.isArray(data)) {
      const items: Value[] = [];
      for (const entry of data) {
        const item = this.fromHostData(entry, node, budget, depth + 1);
        if (!item) return undefined;
        items.push(item);
      }
      return this.arrayOf(items, node);
    }
    const properties = new Map<string, Slot>();
    for (const key of Object.keys(data)) {
      const value = this.fromHostData(Reflect.get(data, key), node, budget, depth + 1);
      if (!value) return undefined;
      properties.set(key, { values: [value] });
    }
    return this.objectOf(properties, new Map(), undefined);
  }
}

// ---------------------------------------------------------------------------------------------
// Helpers without state
// ---------------------------------------------------------------------------------------------

/** Marks "no value": the operation throws where the script runs. */
const NO_VALUE = Symbol('no-value');

/** Keys of a node that hold an object which is not a child node. */
const NON_CHILD_KEYS = new Set(['loc', 'range', 'regex']);

function forEachChild(node: AnyNode, visit: (child: AnyNode) => void): void {
  for (const key of Object.keys(node)) {
    const child = node[key];
    // (Most of what a node holds is a name, a position or a flag)
    if (child === null || typeof child !== 'object' || NON_CHILD_KEYS.has(key)) continue;
    if (Array.isArray(child)) {
      for (const item of child) if (isAstNode(item)) visit(item);
    } else if (isAstNode(child)) {
      visit(child);
    }
  }
}

/** The values of a variable of a function that is being applied, with when they were given. */
function lookupEnv(env: Env | undefined, declaration: AnyNode): { values: Value[]; createdAt: number } | undefined {
  for (let current = env; current; current = current.parent) {
    const values = current.bindings.get(declaration);
    if (values) return { values, createdAt: current.createdAt };
  }
  return undefined;
}

/** The call, among those being applied, that holds a variable. */
function ownerOf(env: Env | undefined, declaration: AnyNode): Env | undefined {
  for (let current = env; current; current = current.parent) {
    if (current.bindings.has(declaration)) return current;
  }
  return undefined;
}

/** Whether a declaration is inside a function that is being applied. */
function isLocalOf(env: Env | undefined, declaration: AnyNode): boolean {
  if (typeof declaration?.start !== 'number') return false;
  for (let current = env; current; current = current.parent) {
    const fn = current.fn;
    if (typeof fn?.start === 'number' && declaration.start >= fn.start && declaration.end <= fn.end) return true;
  }
  return false;
}

/** `this` of the function that is being applied: absent when it was called without an object. */
function selfOf(env: Env | undefined): Value | undefined {
  for (let current = env; current; current = current.parent) {
    if (current.ownsSelf) return current.self;
  }
  return undefined;
}

/** Whether a function with its own `this` is being applied. */
function ownsSelf(env: Env | undefined): boolean {
  for (let current = env; current; current = current.parent) {
    if (current.ownsSelf) return true;
  }
  return false;
}

function isAccessor(slot: Slot): boolean {
  return slot.getter !== undefined || slot.setter === true;
}

/** A property of an object literal, through its prototypes: the slot, `default`, or `none`. */
function lookupProperty(object: ObjectValue, name: string): Slot | 'default' | 'none' {
  let current: ObjectValue | null | undefined = object;
  for (let guard = 0; current && guard < 64; guard++) {
    const slot = current.properties.get(name);
    if (slot) return slot;
    if (current.proto === null) return 'none';
    if (current.proto === undefined) return OBJECT_PROTOTYPE_NAMES.has(name) ? 'default' : 'none';
    current = current.proto;
  }
  return 'default'; // a chain too long to follow: not known
}

function lookupSymbol(object: ObjectValue, name: string): Slot | undefined {
  let current: ObjectValue | null | undefined = object;
  for (let guard = 0; current && guard < 64; guard++) {
    const slot = current.symbols.get(name);
    if (slot) return slot;
    current = current.proto;
  }
  return undefined;
}

/** The keys of an object literal, in the order the language lists them. */
function ownKeys(object: ObjectValue): string[] {
  const indices: string[] = [];
  const names: string[] = [];
  for (const key of object.properties.keys()) (isArrayIndex(key) ? indices : names).push(key);
  indices.sort((a, b) => Number(a) - Number(b));
  return [...indices, ...names];
}

function parameterCount(fn: AnyNode): number {
  let count = 0;
  for (const param of fn.params ?? []) {
    if (param.type === 'AssignmentPattern' || param.type === 'RestElement') break;
    count++;
  }
  return count;
}

/**
 * What `typeof` gives; `undefined` where that is not known here: whether a built-in exists, and
 * what kind of thing it is, depends on where the script runs.
 */
function typeOf(value: Value): string | undefined {
  switch (value.kind) {
    case 'primitive':
      return value.boxed || value.value === null ? 'object' : typeof value.value;
    case 'symbol':
      return 'symbol';
    case 'function':
      return 'function';
    case 'builtin':
    case 'method':
      return undefined;
    default:
      return 'object';
  }
}

function isPrimitiveList(list: StaticPrimitive[] | Value[]): list is StaticPrimitive[] {
  return list.every((entry) => entry === null || typeof entry !== 'object');
}

function hostObject(path: string): object | undefined {
  const [root, ...rest] = path.split('.');
  let current: unknown = HOST_OBJECTS.get(root);
  for (const name of rest) {
    if (current === null || (typeof current !== 'object' && typeof current !== 'function')) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (!descriptor || !('value' in descriptor)) return undefined;
    current = descriptor.value;
  }
  return current !== null && (typeof current === 'object' || typeof current === 'function') ? current : undefined;
}

function bitLength(value: bigint): number {
  return (value < BigInt(0) ? -value : value).toString(2).length;
}

function hostUnary(operator: string, value: StaticPrimitive): StaticPrimitive | typeof NO_VALUE {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the operators of the language, on a primitive
    const operand: any = value;
    switch (operator) {
      case '+':
        return +operand;
      case '-':
        return -operand;
      case '~':
        return ~operand;
      default:
        return NO_VALUE;
    }
  } catch {
    return NO_VALUE; // a TypeError (`+1n`)
  }
}

function hostBinaryOperation(
  operator: string,
  x: StaticPrimitive,
  y: StaticPrimitive,
): StaticPrimitive | typeof NO_VALUE {
  try {
    /* eslint-disable @typescript-eslint/no-explicit-any -- the operators of the language, on two primitives */
    const a: any = x;
    const b: any = y;
    /* eslint-enable @typescript-eslint/no-explicit-any */
    switch (operator) {
      case '+':
        return a + b;
      case '-':
        return a - b;
      case '*':
        return a * b;
      case '/':
        return a / b;
      case '%':
        return a % b;
      case '**':
        return a ** b;
      case '|':
        return a | b;
      case '&':
        return a & b;
      case '^':
        return a ^ b;
      case '<<':
        return a << b;
      case '>>':
        return a >> b;
      case '>>>':
        return a >>> b;
      case '<':
        return a < b;
      case '<=':
        return a <= b;
      case '>':
        return a > b;
      case '>=':
        return a >= b;
      case '==':
        return a == b; // the operator the script wrote
      case '!=':
        return a != b;
      case '===':
        return a === b;
      case '!==':
        return a !== b;
      default:
        return NO_VALUE;
    }
  } catch {
    return NO_VALUE; // a TypeError (a BigInt with a number), a RangeError (a division by 0n)
  }
}

function hostNumberFunction(path: string, args: StaticPrimitive[]): StaticPrimitive {
  const [first, second] = args;
  switch (path) {
    case 'parseInt':
    case 'Number.parseInt':
      return parseInt(String(first), second === undefined ? undefined : Number(second));
    case 'parseFloat':
    case 'Number.parseFloat':
      return parseFloat(String(first));
    // (The global ones convert their argument as a number does, and throw for a BigInt)
    case 'isNaN':
      return isNaN(first as number);
    case 'isFinite':
      return isFinite(first as number);
    case 'Number.isInteger':
      return Number.isInteger(first);
    case 'Number.isFinite':
      return Number.isFinite(first);
    case 'Number.isNaN':
      return Number.isNaN(first);
    default:
      return Number.isSafeInteger(first);
  }
}

// ---------------------------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------------------------

const evaluators = new WeakMap<object, StaticEvaluator>();

function evaluatorOf(ast: unknown): StaticEvaluator {
  if (typeof ast !== 'object' || ast === null) return new StaticEvaluator(undefined);
  let evaluator = evaluators.get(ast);
  if (!evaluator) {
    evaluator = new StaticEvaluator(ast);
    evaluators.set(ast, evaluator);
  }
  return evaluator;
}

/**
 * Every value an expression may have, as far as it is known without running the script.
 *
 * @param ast The program the expression is part of (`ValidationContext.ast`): its variables are
 *   resolved in it
 * @param node The expression
 * @param options How a variable is read
 */
export function evaluateStatic(
  ast: unknown,
  node: AnyNode,
  options: StaticEvaluationOptions = {},
): StaticAlternative[] {
  return evaluatorOf(ast).describe(node, false, options.variables === true);
}

/**
 * The names a property key may be, as far as they are known without running the script, and
 * whether the key is made of constants that could not be computed.
 *
 * @param ast The program the key is part of (`ValidationContext.ast`)
 * @param key The key: the property of a computed member, the key of a computed pattern property
 * @param options How a variable is read
 * @throws {StaticKeyExpansionError} when the key is made of constants and is too large to build
 */
export function resolveStaticKey(ast: unknown, key: AnyNode, options: StaticEvaluationOptions = {}): StaticKey {
  const names: string[] = [];
  const seen = new Set<string>();
  let unresolved = false;
  for (const alternative of evaluatorOf(ast).describe(key, true, options.variables === true)) {
    if (alternative.type === 'unresolved') unresolved = true;
    else if (alternative.key !== undefined && !seen.has(alternative.key)) {
      seen.add(alternative.key);
      names.push(alternative.key);
    }
  }
  return { names, unresolved };
}

/**
 * Remember that `key` is unresolved in this program, to be reported with
 * {@link takeUnresolvedKeys}.
 */
export function noteUnresolvedKey(ast: unknown, key: AnyNode): void {
  evaluatorOf(ast).note(key);
}

/**
 * The keys noted with {@link noteUnresolvedKey} since the last call that have not been reported
 * at `rank` or above. Several rules read the same key: it is reported once, unless a rule that
 * counts for more reads it after one that counts for less.
 *
 * @param rank How much the report that is about to be made counts: a larger number for more
 */
export function takeUnresolvedKeys(ast: unknown, rank = 0): AnyNode[] {
  // Nothing was evaluated in a program that has no evaluator: do not build one to ask
  const evaluator = typeof ast === 'object' && ast !== null ? evaluators.get(ast) : undefined;
  return evaluator ? evaluator.take(rank) : [];
}

/**
 * Drop what was computed for a program. The validator calls it when the rules have run, so that
 * the tree it hands back does not keep the evaluation alive.
 */
export function releaseStaticEvaluation(ast: unknown): void {
  if (typeof ast === 'object' && ast !== null) evaluators.delete(ast);
}
