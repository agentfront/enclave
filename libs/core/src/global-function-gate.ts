/**
 * Host-Function Gate
 *
 * With `allowFunctionsInGlobals`, the host can hand the script functions through `globals`.
 * Those calls cross the same boundary as `callTool()`, so they get the same treatment:
 * - refused once the execution is aborted, and capped by `maxGlobalFunctionCalls`
 *   (the double VM also applies its operation rate limit, shared with tool calls);
 * - the return value is sanitized exactly like a tool result (`sanitizeValue` with the security
 *   level's limits, then serialized) and re-created inside the sandbox realm, so no host object,
 *   function or prototype crosses; values that cannot be sanitized are refused;
 * - a host error becomes a plain error (name and message only, no host stack).
 *
 * Which calls are gated is fail-closed: every host function reachable through `globals` (a
 * function passed directly, a method of a passed object or class instance, and
 * `Function.prototype.call`/`apply`/`bind`, which invoke their receiver) is gated, except the
 * built-in prototype methods of the data itself ({@link isBuiltinMethod}: `Array.prototype.map`,
 * iterators, `Date.prototype.toISOString`, ...), which keep working on data globals as before.
 *
 * The double VM applies the count and rate limit in its parent VM and uses
 * {@link createHostGlobalFunctionInvoker} for the host side; the single-VM adapter uses
 * {@link createGlobalFunctionGate} through the secure proxy's `callGate` hook.
 *
 * @packageDocumentation
 */

import type { ExecutionContext } from './types';
import { sanitizeValue } from './value-sanitizer';
import { createSafeError } from './safe-error';
import { hasHostStackReserve, STACK_EXHAUSTED_MESSAGE } from './stack-reserve';
import type { HostActivity } from './execution-deadline';

const ReflectApply = Reflect.apply;
const ReflectOwnKeys = Reflect.ownKeys;
const ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const ObjectGetPrototypeOf = Object.getPrototypeOf;
const ArrayIsArray = Array.isArray;
const JsonStringify = JSON.stringify;

/**
 * The methods of this realm's built-in prototypes (arrays, strings, numbers, dates, maps, sets,
 * promises, typed arrays, errors, iterators, and `Object.prototype`). `Function.prototype` is
 * deliberately excluded: `call`, `apply` and `bind` invoke their receiver, so a call through
 * them is a call into the host function itself.
 */
const BUILTIN_PROTOTYPES: readonly object[] = (() => {
  const typedArrays = [
    Int8Array,
    Uint8Array,
    Uint8ClampedArray,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
    Float32Array,
    Float64Array,
    BigInt64Array,
    BigUint64Array,
  ];
  const arrayIteratorPrototype = ObjectGetPrototypeOf([][Symbol.iterator]());
  const prototypes: unknown[] = [
    Object.prototype,
    Array.prototype,
    String.prototype,
    Number.prototype,
    Boolean.prototype,
    Symbol.prototype,
    BigInt.prototype,
    Date.prototype,
    RegExp.prototype,
    Error.prototype,
    EvalError.prototype,
    RangeError.prototype,
    ReferenceError.prototype,
    SyntaxError.prototype,
    TypeError.prototype,
    URIError.prototype,
    Map.prototype,
    Set.prototype,
    WeakMap.prototype,
    WeakSet.prototype,
    Promise.prototype,
    ArrayBuffer.prototype,
    DataView.prototype,
    ObjectGetPrototypeOf(Uint8Array.prototype), // %TypedArray%.prototype
    ...typedArrays.map((TypedArray) => TypedArray.prototype),
    arrayIteratorPrototype,
    ObjectGetPrototypeOf(arrayIteratorPrototype), // %IteratorPrototype%
    ObjectGetPrototypeOf(new Map()[Symbol.iterator]()),
    ObjectGetPrototypeOf(new Set()[Symbol.iterator]()),
    ObjectGetPrototypeOf(''[Symbol.iterator]()),
  ];
  return prototypes.filter((prototype): prototype is object => prototype !== null && typeof prototype === 'object');
})();

const BUILTIN_PROTOTYPE_SET: WeakSet<object> = new WeakSet(BUILTIN_PROTOTYPES);

/**
 * Whether `prototype` is one of the built-in prototypes whose methods are not gated. The
 * validation of `globals` stops there when it walks the classes of a value: what lies beyond is
 * the language's own.
 */
export function isBuiltinPrototype(prototype: unknown): boolean {
  return typeof prototype === 'object' && prototype !== null && BUILTIN_PROTOTYPE_SET.has(prototype);
}

const BUILTIN_METHODS: WeakSet<object> = (() => {
  const methods = new WeakSet<object>();
  for (const prototype of BUILTIN_PROTOTYPES) {
    for (const key of ReflectOwnKeys(prototype)) {
      if (key === 'constructor') continue;
      const descriptor = ObjectGetOwnPropertyDescriptor(prototype, key);
      if (descriptor && typeof descriptor.value === 'function') {
        methods.add(descriptor.value);
      }
    }
  }
  return methods;
})();

/**
 * Whether `fn` is a method of a built-in prototype (see the module description). Such calls
 * operate on data and are not gated; every other host function is.
 */
export function isBuiltinMethod(fn: unknown): boolean {
  return (typeof fn === 'function' || (typeof fn === 'object' && fn !== null)) && BUILTIN_METHODS.has(fn as object);
}

/**
 * The built-in methods that change the object they are called on (`push`, `sort`, `Map.prototype.set`,
 * `Date.prototype.setTime`, ...).
 *
 * A value passed in `globals` is the host's own object, shared by every execution of the enclave. The
 * membrane refuses assignments to it, and these methods are the other way to write to it: called on a
 * host array, Map, Set, Date or typed array they would change what later executions and the host read.
 */
const MUTATING_BUILTIN_METHODS: WeakSet<object> = (() => {
  const methods = new WeakSet<object>();
  const add = (prototype: object, names: readonly string[]): void => {
    for (const name of names) {
      const descriptor = ObjectGetOwnPropertyDescriptor(prototype, name);
      if (descriptor && typeof descriptor.value === 'function') {
        methods.add(descriptor.value);
      }
    }
  };
  const settersOf = (prototype: object): string[] =>
    ReflectOwnKeys(prototype).filter((key): key is string => typeof key === 'string' && key.startsWith('set'));

  add(Array.prototype, ['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin']);
  add(Map.prototype, ['set', 'delete', 'clear']);
  add(Set.prototype, ['add', 'delete', 'clear']);
  add(WeakMap.prototype, ['set', 'delete']);
  add(WeakSet.prototype, ['add', 'delete']);
  add(Date.prototype, settersOf(Date.prototype));
  add(ObjectGetPrototypeOf(Uint8Array.prototype), ['set', 'fill', 'sort', 'reverse', 'copyWithin']);
  add(DataView.prototype, settersOf(DataView.prototype));
  add(ArrayBuffer.prototype, ['resize', 'transfer', 'transferToFixedLength']);
  add(RegExp.prototype, ['compile']);
  add(Object.prototype, ['__defineGetter__', '__defineSetter__']);
  return methods;
})();

/**
 * Whether `fn` is a built-in method that changes its receiver (see {@link MUTATING_BUILTIN_METHODS}).
 */
export function isMutatingBuiltinMethod(fn: unknown): boolean {
  return (
    (typeof fn === 'function' || (typeof fn === 'object' && fn !== null)) && MUTATING_BUILTIN_METHODS.has(fn as object)
  );
}

/**
 * The built-in methods that run a regular expression in the HOST realm when they are called on a
 * value passed in `globals`:
 *
 * - of `RegExp.prototype`, the ones that run the pattern: `test`, `exec`, and the ones the string
 *   methods call (`match`, `matchAll`, `replace`, `search`, `split` with the expression as
 *   argument). A regular expression passed in `globals` is the host's own object. Run from the
 *   sandbox it matches a text the script chooses with a pattern the script did not have to get
 *   past the validator or the realm's own rules, on the host's `RegExp.prototype`; and a match
 *   with the `g` or `y` flag writes `lastIndex` on the host's object, which the next execution
 *   reads.
 * - of `String.prototype`, the ones that compile their argument into a pattern: `match`,
 *   `matchAll` and `search`. A string is passed as a primitive and has the sandbox realm's
 *   methods; a boxed `String` is an object of the host, and on it these would compile and run a
 *   pattern the script chooses with the host's `RegExp`.
 */
const REGEXP_MATCH_METHODS: WeakSet<object> = (() => {
  const methods = new WeakSet<object>();
  const add = (prototype: object, keys: Array<string | symbol>): void => {
    for (const key of keys) {
      const descriptor = ObjectGetOwnPropertyDescriptor(prototype, key);
      if (descriptor && typeof descriptor.value === 'function') {
        methods.add(descriptor.value);
      }
    }
  };
  add(RegExp.prototype, ['test', 'exec', Symbol.match, Symbol.matchAll, Symbol.replace, Symbol.search, Symbol.split]);
  add(String.prototype, ['match', 'matchAll', 'search']);
  return methods;
})();

/**
 * Whether `fn` is a built-in method that runs a regular expression (see {@link REGEXP_MATCH_METHODS}).
 */
export function isRegExpMatchMethod(fn: unknown): boolean {
  return (
    (typeof fn === 'function' || (typeof fn === 'object' && fn !== null)) && REGEXP_MATCH_METHODS.has(fn as object)
  );
}

/** What a script is told when it runs a regular expression of the host */
export const HOST_REGEXP_MESSAGE =
  'A regular expression passed in globals cannot be run in the sandbox, ' +
  'and a pattern cannot be run on a String object passed in globals. ' +
  'Read its source and flags (or the text), or pass a function that does the matching.';

/** Default `maxGlobalFunctionCalls` is this many times `maxToolCalls`. */
export const DEFAULT_GLOBAL_FUNCTION_CALLS_PER_TOOL_CALL = 10;

const DEFAULT_MAX_PAYLOAD_BYTES = 5 * 1024 * 1024;
const MAX_ERROR_MESSAGE_LENGTH = 4096;
const MAX_ERROR_NAME_LENGTH = 128;

const UNSAFE_RESULT_MESSAGE =
  'Global function returned a value that cannot be passed into the sandbox ' +
  '(functions, symbols, and values beyond the sanitization depth or size limits are not allowed)';

const UNSAFE_ARGUMENT_MESSAGE =
  'Global function was called with a value that cannot be passed to the host ' +
  '(functions, symbols, and values beyond the sanitization depth or size limits are not allowed)';

/**
 * Effective cap on calls into host functions for an execution.
 */
export function resolveMaxGlobalFunctionCalls(config: {
  maxToolCalls?: number;
  maxGlobalFunctionCalls?: number;
}): number {
  const explicit = config.maxGlobalFunctionCalls;
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit >= 0) {
    return Math.floor(explicit);
  }
  const maxToolCalls =
    typeof config.maxToolCalls === 'number' && Number.isFinite(config.maxToolCalls) ? config.maxToolCalls : 100;
  return Math.max(0, Math.floor(maxToolCalls)) * DEFAULT_GLOBAL_FUNCTION_CALLS_PER_TOOL_CALL;
}

/** Error message for an exceeded `maxGlobalFunctionCalls` (shared with the double VM). */
export function globalFunctionLimitMessage(max: number): string {
  return `Maximum global function call limit exceeded (${max}). This limit prevents runaway calls into host functions.`;
}

type GlobalCallOutcome = { ok: true; json?: string } | { ok: false; name: string; message: string };

interface ResultLimits {
  maxDepth: number;
  maxProperties: number;
  maxPayloadBytes: number;
}

function resultLimits(context: ExecutionContext): ResultLimits {
  const { config } = context;
  return {
    maxDepth: config.maxSanitizeDepth,
    maxProperties: config.maxSanitizeProperties,
    maxPayloadBytes: config.toolBridge?.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
  };
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/** Name and message of a host error, as strings only. */
function failure(error: unknown): GlobalCallOutcome {
  let name = 'Error';
  let message = 'Global function call failed';
  try {
    if (error && typeof error === 'object') {
      const rawName = (error as { name?: unknown }).name;
      const rawMessage = (error as { message?: unknown }).message;
      if (typeof rawName === 'string' && rawName) name = rawName;
      if (typeof rawMessage === 'string' && rawMessage) message = rawMessage;
    } else if (typeof error === 'string' && error) {
      message = error;
    }
  } catch {
    // A throwing getter on a hostile error keeps the defaults.
  }
  return {
    ok: false,
    name: truncate(name, MAX_ERROR_NAME_LENGTH),
    message: truncate(message, MAX_ERROR_MESSAGE_LENGTH),
  };
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value;
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/** Sanitize a host return value like a tool result and serialize it for the sandbox. */
function encodeResult(value: unknown, limits: ResultLimits): GlobalCallOutcome {
  if (value === undefined) return { ok: true };

  let json: string | undefined;
  try {
    const sanitized = sanitizeValue(value, {
      maxDepth: limits.maxDepth,
      maxProperties: limits.maxProperties,
      allowDates: false,
      allowErrors: true,
    });
    json = JsonStringify(sanitized, jsonReplacer);
  } catch {
    return { ok: false, name: 'GlobalFunctionError', message: UNSAFE_RESULT_MESSAGE };
  }

  if (json === undefined) return { ok: true };
  if (utf8ByteLength(json) > limits.maxPayloadBytes) {
    return {
      ok: false,
      name: 'GlobalFunctionError',
      message: `Global function result exceeds maximum size (${limits.maxPayloadBytes} bytes)`,
    };
  }
  return { ok: true, json };
}

function isThenable(value: unknown): boolean {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
  try {
    return typeof (value as { then?: unknown }).then === 'function';
  } catch {
    return false;
  }
}

/**
 * Returns the object behind a sandbox-side wrapper, for reading a builtin's internal slots (the
 * single VM's secure proxy wraps the script's `Date`s). See `SanitizeOptions.unwrap`.
 */
export type UnwrapSandboxValue = (value: object) => object;

/**
 * Copy the script's arguments into plain host data, the way tool arguments are copied.
 *
 * A host function must never be handed a live script value. Whatever the function does with one runs
 * script code inside the host: reading a property runs a getter or a Proxy trap, and returning or
 * awaiting it makes the host's promise machinery call the script's `then` with the host's own
 * resolving functions, from which the host `Function` constructor is one property read away. After
 * this copy the function sees null-prototype objects, arrays, primitives and host `Date`s only; a
 * function or a symbol among the arguments is refused.
 */
function sanitizeArguments(args: unknown, limits: ResultLimits, unwrap?: UnwrapSandboxValue): unknown[] {
  if (!ArrayIsArray(args)) return [];
  const sanitized = sanitizeValue(args, {
    maxDepth: limits.maxDepth,
    maxProperties: limits.maxProperties,
    allowDates: true,
    allowErrors: true,
    unwrap,
  });
  return ArrayIsArray(sanitized) ? sanitized : [];
}

/** Call a host function and encode its outcome; never throws. */
function invokeGlobalFunction(
  fn: unknown,
  thisArg: unknown,
  args: unknown,
  limits: ResultLimits,
  unwrap?: UnwrapSandboxValue,
  activity?: HostActivity,
): GlobalCallOutcome | Promise<GlobalCallOutcome> {
  if (typeof fn !== 'function') {
    return { ok: false, name: 'TypeError', message: 'Global is not a function' };
  }

  let safeArgs: unknown[];
  try {
    safeArgs = sanitizeArguments(args, limits, unwrap);
  } catch {
    return { ok: false, name: 'TypeError', message: UNSAFE_ARGUMENT_MESSAGE };
  }

  // Not started unless it has room to finish and to hand back what it returns (./stack-reserve).
  // Asked here, after the arguments are copied and right before the call, so that the answer
  // holds for the function itself, whatever lies between the script and this frame.
  let room = false;
  try {
    room = hasHostStackReserve();
  } catch {
    // No room even to ask
  }
  if (!room) {
    return { ok: false, name: 'RangeError', message: STACK_EXHAUSTED_MESSAGE };
  }

  let result: unknown;
  try {
    result = ReflectApply(fn, thisArg, safeArgs);
  } catch (error: unknown) {
    return failure(error);
  }

  if (isThenable(result)) {
    // In flight until it settles: a script waiting for it at the deadline is waiting for the host
    const end = activity?.begin();
    return Promise.resolve(result).then(
      (value) => {
        end?.();
        return encodeResult(value, limits);
      },
      (error: unknown) => {
        end?.();
        return failure(error);
      },
    );
  }

  return encodeResult(result, limits);
}

function toEnvelope(outcome: GlobalCallOutcome): string {
  if (outcome.ok) {
    return outcome.json === undefined ? '{"v":1,"ok":true}' : `{"v":1,"ok":true,"value":${outcome.json}}`;
  }
  return JsonStringify({ v: 1, ok: false, error: { name: outcome.name, message: outcome.message } });
}

/**
 * Host side of the double VM's global-function gate.
 *
 * The parent VM enforces the abort check, `maxGlobalFunctionCalls` and the rate limit, then calls
 * this with the host function, the receiver and the arguments. The result is a JSON envelope
 * (`{ v: 1, ok: true, value }` or `{ v: 1, ok: false, error: { name, message } }`), or a Promise
 * of one when the function returned a thenable; the parent VM parses it in its own realm.
 */
export function createHostGlobalFunctionInvoker(
  context: ExecutionContext,
): (fn: unknown, thisArg: unknown, args: unknown) => string | Promise<string> {
  const limits = resultLimits(context);
  return (fn, thisArg, args) => {
    const outcome = invokeGlobalFunction(fn, thisArg, args, limits, undefined, context.hostActivity);
    return outcome instanceof Promise ? outcome.then(toEnvelope) : toEnvelope(outcome);
  };
}

/**
 * Functions from the sandbox realm the single-VM gate uses to re-create values there.
 */
export interface SandboxRealmBridge {
  /** The sandbox realm's `JSON.parse` */
  parseJson(json: string): unknown;
  /** Wrap a host promise in a sandbox-realm promise that settles the same way */
  adoptPromise(promise: Promise<unknown>): unknown;
}

/** A secure-proxy `callGate`: decides which calls are gated and runs them. */
export interface GlobalFunctionCallGate {
  /** Whether a call to `target` goes through the gate */
  gates(target: unknown): boolean;
  /** Run a gated call; returns a sandbox-safe value */
  call(target: unknown, thisArg: unknown, args: unknown[]): unknown;
}

/**
 * Gate for host functions called from the single-VM sandbox (the secure proxy's `callGate`).
 *
 * Refuses calls once the execution is aborted or `maxGlobalFunctionCalls` is spent, sanitizes the
 * return value like a tool result and re-creates it in the sandbox realm (a promise becomes a
 * sandbox-realm promise), and turns host errors into safe errors.
 */
export function createGlobalFunctionGate(
  context: ExecutionContext,
  realm: SandboxRealmBridge,
  unwrap?: UnwrapSandboxValue,
): GlobalFunctionCallGate {
  const limits = resultLimits(context);
  const max = resolveMaxGlobalFunctionCalls(context.config);
  let calls = 0;

  const settle = (outcome: GlobalCallOutcome): unknown => {
    if (!outcome.ok) {
      throw createSafeError(outcome.message, outcome.name);
    }
    return outcome.json === undefined ? undefined : realm.parseJson(outcome.json);
  };

  return {
    gates: (target) => !isBuiltinMethod(target),
    call: (target, thisArg, args) => {
      if (context.aborted) {
        throw createSafeError('Execution aborted');
      }
      calls++;
      if (calls > max) {
        throw createSafeError(globalFunctionLimitMessage(max));
      }

      const outcome = invokeGlobalFunction(target, thisArg, args, limits, unwrap, context.hostActivity);
      if (outcome instanceof Promise) {
        return realm.adoptPromise(outcome.then(settle));
      }
      return settle(outcome);
    },
  };
}
