/**
 * Secure Proxy - Runtime Property Access Protection
 *
 * Wraps objects with Proxies that block access to dangerous properties like:
 * - constructor: Gives access to Function constructor for code execution
 * - __proto__: Prototype chain manipulation
 * - prototype: Prototype access
 *
 * This provides defense-in-depth against attacks like:
 * ```javascript
 * const m = 'const';
 * const Func = callTool[m + 'ructor'];  // Blocked!
 * ```
 *
 * @packageDocumentation
 */

import type { SecureProxyLevelConfig, SecurityLevel } from './types';
import { createSafeError, isSafeError } from './safe-error';
import { builtinMethodHomes, hostFunctionText, isBuiltinMethod, isFunctionTextMethod } from './global-function-gate';

// SECURITY (GHSA-3279 defense-in-depth): pin pristine reflection intrinsics at module load so the
// membrane traps below never re-read a global that could be overwritten to capture a raw target.
// In single-VM mode these traps run in the host realm (not sandbox-reachable), but pinning keeps the
// guarantee intact if this membrane is ever driven from a shared realm (e.g. a browser adapter).
const ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const ObjectToString = Object.prototype.toString;
const FunctionBind = Function.prototype.bind;
const ReflectGet = Reflect.get;
const ReflectSet = Reflect.set;
const ReflectDefineProperty = Reflect.defineProperty;
const ReflectGetOwnPropertyDescriptor = Reflect.getOwnPropertyDescriptor;
const ReflectOwnKeys = Reflect.ownKeys;
const ReflectApply = Reflect.apply;
const ReflectHas = Reflect.has;
const ReflectConstruct = Reflect.construct;
const ObjectGetPrototypeOf = Object.getPrototypeOf;
const HostObjectPrototype: object = Object.prototype;
// The Reflect namespace itself, pinned so `createSafeReflect` proxies the pristine object rather
// than whatever the `Reflect` binding resolves to when the safe runtime is assembled.
const ReflectObject = Reflect;

/**
 * Snapshot of every own value on the pristine `Reflect` namespace, taken at module load.
 *
 * `createSafeReflect` serves reads from this snapshot instead of re-reading the namespace, so a
 * later `Reflect.get = evil` in a shared realm cannot be observed through the sandbox's Reflect.
 * Pinning the namespace object alone is not enough: the proxy target's own properties stay
 * writable, so only a value snapshot closes the window. Every own property of `Reflect` is a data
 * property (the methods plus `Symbol.toStringTag`), so building the snapshot triggers no getters.
 */
const PINNED_REFLECT_VALUES = new Map<string | symbol, unknown>();
for (const key of ReflectOwnKeys(ReflectObject)) {
  PINNED_REFLECT_VALUES.set(key, ReflectGet(ReflectObject, key));
}

// Function constructors, pinned at module load. `createSafeReflect`'s construct guard compares
// against these: reading them live (`async function () {}.constructor`) walks a prototype whose
// `constructor` is writable, so a shared-realm attacker could point the comparison at a decoy and
// slip the real Function constructor past the check.
const FunctionCtor = Function;
// Intentional empty functions used only to reach the hidden function-constructor intrinsics.
/* eslint-disable @typescript-eslint/no-empty-function */
const AsyncFunctionCtor = async function () {}.constructor;
const GeneratorFunctionCtor = function* () {}.constructor;
const AsyncGeneratorFunctionCtor = async function* () {}.constructor;
/* eslint-enable @typescript-eslint/no-empty-function */

/**
 * Absolute floor for the membrane recursion cap.
 *
 * The recursion counter is a stack-safety backstop, NOT a security control: every level of the
 * membrane already blocks the dangerous properties, so the cap value never decides whether an
 * escape is possible. Its only job is to stop pathological recursion. It must therefore sit
 * comfortably above the deepest value that can legitimately reach the membrane (a tool result is
 * pre-sanitized to at most `maxSanitizeDepth`, which peaks at 50), or legitimate deep data would
 * be rejected (custom host globals are not sanitize-bounded, hence the generous ~5x headroom).
 * The membrane is lazy (one property access = one wrap = O(1) synchronous stack), so a large
 * value costs nothing. Exceeding the cap fails CLOSED (throws) — it must never hand back a raw
 * target.
 *
 * Exported so tests can derive their traversal depth from the real cap instead of hardcoding a
 * value that would silently rot if the cap changed.
 */
export const MIN_MEMBRANE_RECURSION_DEPTH = 256;

/**
 * Categorized blocked properties for defense-in-depth
 *
 * Organized by attack category to support per-security-level configuration
 */
export const BLOCKED_PROPERTY_CATEGORIES = {
  /**
   * Core prototype manipulation properties (always blocked except PERMISSIVE)
   */
  PROTOTYPE: new Set([
    'constructor',
    '__proto__',
    'prototype',
    '__defineGetter__',
    '__defineSetter__',
    '__lookupGetter__',
    '__lookupSetter__',
  ]),

  /**
   * Property-descriptor and prototype MUTATION gadgets. These are the primitives behind the
   * GHSA-3279 membrane self-leak (`Object.defineProperty(Object, 'getOwnPropertyDescriptor', hook)`
   * to intercept the trap's raw target) and classic prototype pollution (`setPrototypeOf`). They
   * are never needed by AgentScript and are already refused by the single-VM SafeObject
   * (`DANGEROUS_OBJECT_STATIC_METHODS`), so they are blocked at every level that blocks the
   * constructor (all except PERMISSIVE). Read-only reflection (getPrototypeOf, keys, entries,
   * getOwnPropertyNames) is intentionally NOT here: the membrane's own getPrototypeOf/ownKeys traps
   * already neutralize it for proxied values, and it has legitimate uses.
   */
  DESCRIPTOR_MUTATION: new Set([
    'getOwnPropertyDescriptor',
    'getOwnPropertyDescriptors',
    'defineProperty',
    'defineProperties',
    'setPrototypeOf',
  ]),

  /**
   * Node.js 24 Iterator helper method names
   * Blocked at STRICT/SECURE to prevent prototype chain access via iterators
   */
  ITERATOR_HELPERS: new Set(['toArray', 'forEach', 'some', 'every', 'find', 'reduce', 'flatMap', 'drop', 'take']),

  /**
   * Reflection properties on Object
   * Blocked at STRICT to prevent introspection attacks
   */
  REFLECTION: new Set([
    'getOwnPropertyDescriptor',
    'getOwnPropertyDescriptors',
    'getOwnPropertyNames',
    'getOwnPropertySymbols',
    'getPrototypeOf',
    'setPrototypeOf',
    'defineProperty',
    'defineProperties',
    'preventExtensions',
    'isExtensible',
    'seal',
    'isSealed',
    'freeze',
    'isFrozen',
  ]),

  /**
   * Timing API properties
   * Blocked at STRICT to prevent timing attacks
   */
  TIMING: new Set(['hrtime', 'timeOrigin']),
} as const;

/**
 * Type representing the available blocked property categories
 *
 * Each category groups related dangerous properties that can be selectively
 * blocked based on security level requirements.
 */
export type BlockedPropertyCategory = keyof typeof BLOCKED_PROPERTY_CATEGORIES;

/**
 * Get blocked properties for a security level
 *
 * @param level Security level
 * @returns Set of property names to block
 */
export function getBlockedPropertiesForLevel(level: SecurityLevel): Set<string> {
  const blocked = new Set<string>();

  // PERMISSIVE: No prototype blocking (handled by explicit config)
  // All other levels: Block core prototype manipulation AND the descriptor/prototype mutation
  // gadgets that enable the membrane self-leak + prototype pollution (GHSA-3279).
  if (level !== 'PERMISSIVE') {
    BLOCKED_PROPERTY_CATEGORIES.PROTOTYPE.forEach((p) => blocked.add(p));
    BLOCKED_PROPERTY_CATEGORIES.DESCRIPTOR_MUTATION.forEach((p) => blocked.add(p));
  }

  switch (level) {
    case 'STRICT':
      // Block everything
      BLOCKED_PROPERTY_CATEGORIES.ITERATOR_HELPERS.forEach((p) => blocked.add(p));
      BLOCKED_PROPERTY_CATEGORIES.REFLECTION.forEach((p) => blocked.add(p));
      BLOCKED_PROPERTY_CATEGORIES.TIMING.forEach((p) => blocked.add(p));
      break;
    case 'SECURE':
      // Block iterator helpers (potential sandbox escape vectors)
      BLOCKED_PROPERTY_CATEGORIES.ITERATOR_HELPERS.forEach((p) => blocked.add(p));
      break;
    case 'STANDARD':
    case 'PERMISSIVE':
      // Handled above
      break;
  }

  return blocked;
}

/**
 * Default blocked properties (for backward compatibility)
 */
const BLOCKED_PROPERTIES = new Set([
  // Code execution
  'constructor',

  // Prototype manipulation
  '__proto__',
  'prototype',

  // Legacy getter/setter definition
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',

  // Descriptor / prototype mutation gadgets (GHSA-3279 self-leak + prototype pollution)
  'getOwnPropertyDescriptor',
  'getOwnPropertyDescriptors',
  'defineProperty',
  'defineProperties',
  'setPrototypeOf',
]);

/**
 * Build blocked properties set from SecureProxyLevelConfig
 *
 * @param config The security level proxy configuration
 * @returns Set of property names to block
 */
export function buildBlockedPropertiesFromConfig(config: SecureProxyLevelConfig): Set<string> {
  const blocked = new Set<string>();

  if (config.blockConstructor) {
    blocked.add('constructor');
    // Blocking the constructor without blocking the descriptor/prototype mutation gadgets leaves
    // the GHSA-3279 self-leak open (patch Object.getOwnPropertyDescriptor, capture the trap's raw
    // target). These share the constructor's threat model and are never needed by AgentScript.
    BLOCKED_PROPERTY_CATEGORIES.DESCRIPTOR_MUTATION.forEach((p) => blocked.add(p));
  }

  if (config.blockPrototype) {
    blocked.add('__proto__');
    blocked.add('prototype');
  }

  if (config.blockLegacyAccessors) {
    blocked.add('__defineGetter__');
    blocked.add('__defineSetter__');
    blocked.add('__lookupGetter__');
    blocked.add('__lookupSetter__');
  }

  return blocked;
}

/**
 * Default SecureProxyLevelConfig (matches current behavior - blocks everything)
 */
export const DEFAULT_SECURE_PROXY_CONFIG: SecureProxyLevelConfig = {
  blockConstructor: true,
  blockPrototype: true,
  blockLegacyAccessors: true,
  proxyMaxDepth: 10,
  throwOnBlocked: true,
};

/**
 * Create a safe Reflect wrapper that blocks dangerous operations
 *
 * @param securityLevel The security level to apply
 * @returns A safe Reflect object or undefined (STRICT blocks Reflect entirely)
 */
export function createSafeReflect(securityLevel: SecurityLevel): typeof Reflect | undefined {
  // STRICT: Block Reflect entirely
  if (securityLevel === 'STRICT') {
    return undefined;
  }

  const dangerousMethods = new Set<string>(['setPrototypeOf']);

  // SECURE: Block additional methods
  if (securityLevel === 'SECURE') {
    dangerousMethods.add('apply');
    dangerousMethods.add('defineProperty');
  }

  // SECURITY: this proxy is installed as the sandbox's `Reflect` global (see vm-adapter), so every
  // MUTATING trap must be refused. With only a `get` trap defined, the defaults forward to the
  // target — `Reflect.get = evil` inside the sandbox wrote straight through to the HOST realm's
  // Reflect namespace, poisoning it for the host application and for any code that still reads it
  // live. The namespace the sandbox sees is read-only.
  const refuseMutation = (): never => {
    throw createSafeError('Reflect is read-only in the sandbox', 'SecurityError');
  };

  return new Proxy(ReflectObject, {
    set: refuseMutation,
    defineProperty: refuseMutation,
    deleteProperty: refuseMutation,
    setPrototypeOf: refuseMutation,
    preventExtensions: refuseMutation,

    get(_target, prop: string | symbol) {
      if (typeof prop === 'string' && dangerousMethods.has(prop)) {
        return undefined;
      }

      // Serve from the module-load snapshot: the proxy target's own properties are writable, so
      // re-reading them here would expose whatever the current realm holds. Keys absent from the
      // snapshot were not on the pristine namespace and are therefore never served.
      if (!PINNED_REFLECT_VALUES.has(prop)) {
        return undefined;
      }
      const value = PINNED_REFLECT_VALUES.get(prop);

      // Wrap Reflect.construct to block Function constructors
      if (typeof value === 'function' && prop === 'construct') {
        // `newTarget` is taken as a rest element, not an optional parameter: `Reflect.construct`
        // treats it as PRESENT as soon as a third argument is passed, so an explicit `undefined`
        // must still reach the native call (and throw) rather than be read as "omitted".
        const safeConstruct = function (ctorTarget: unknown, args: unknown[], ...newTarget: unknown[]) {
          // Block Function, AsyncFunction, GeneratorFunction, AsyncGeneratorFunction constructors
          if (
            ctorTarget === FunctionCtor ||
            ctorTarget === AsyncFunctionCtor ||
            ctorTarget === GeneratorFunctionCtor ||
            ctorTarget === AsyncGeneratorFunctionCtor
          ) {
            throw createSafeError('Reflect.construct with function constructors is blocked', 'SecurityError');
          }
          if (newTarget.length === 0) {
            return ReflectConstruct(ctorTarget as new (...args: unknown[]) => unknown, args as unknown[]);
          }
          return ReflectConstruct(
            ctorTarget as new (...args: unknown[]) => unknown,
            args as unknown[],
            newTarget[0] as new (...args: unknown[]) => unknown,
          );
        };
        // Wrap so the returned function cannot itself be walked to the host Function constructor.
        return createSecureProxy(safeConstruct);
      }

      // SECURITY: never hand back the RAW native Reflect methods. Each is a host-realm function
      // whose prototype chain reaches the host Function constructor, and Reflect.get /
      // Reflect.getOwnPropertyDescriptor are reflection primitives whose STRING-LITERAL key
      // argument bypasses the AST computed-key guard. Wrapping in a secure proxy blocks
      // `.constructor` on the method and keeps every result behind the membrane.
      if (typeof value === 'function') {
        return createSecureProxy(value);
      }

      return value;
    },
  });
}

/**
 * What sandbox code may catch from a call through the membrane.
 *
 * An error raised inside a host function (a `TypeError` from a built-in, a `MemoryLimitError` from
 * the tracker) is a host object with a live prototype chain: handing it to a script's `catch` block
 * is the same leak as handing out the function that threw it. Such an error is replaced by a safe
 * error with the same name, message and string `code`.
 *
 * Only an `Error` of THIS realm is replaced. `instanceof` is false for a value the sandbox created
 * (what a script callback threw travels through unchanged) and for a safe error (it has no
 * prototype).
 */
function launderHostError(error: unknown): unknown {
  let isHostError = false;
  try {
    isHostError = error instanceof Error;
  } catch {
    // A hostile getPrototypeOf trap: the value is the script's own, pass it on.
  }
  if (!isHostError) {
    return error;
  }
  const hostError = error as Error & { code?: unknown };
  return createSafeError(
    String(hostError.message),
    String(hostError.name || 'Error'),
    typeof hostError.code === 'string' ? hostError.code : undefined,
  );
}

/**
 * Properties that are specifically dangerous on Function objects
 */
const FUNCTION_BLOCKED_PROPERTIES = new Set([
  // Function object properties that could leak information
  'caller', // Deprecated but still exists
  'arguments', // Deprecated but still exists

  // Binding/applying could be used for exploitation
  // Note: We may want to allow these in some cases
  // 'bind',
  // 'call',
  // 'apply',
]);

/**
 * Options for secure proxy creation
 */
export interface SecureProxyOptions {
  /**
   * Security level configuration for the proxy
   * When provided, uses this to determine which properties to block
   */
  levelConfig?: SecureProxyLevelConfig;

  /**
   * Additional properties to block
   */
  additionalBlocked?: string[];

  /**
   * Maximum depth for recursive proxying
   * Default: 10
   */
  maxDepth?: number;

  /**
   * Custom handler for blocked property access
   * If not provided, returns undefined (or throws if throwOnBlocked is true)
   */
  onBlocked?: (target: unknown, property: string | symbol) => void;

  /**
   * Whether to throw an error when blocked properties are accessed.
   *
   * Default behavior:
   * - When using `createSecureProxy()` directly without options: `false` (returns undefined)
   * - When using security levels STRICT/SECURE/STANDARD: `true` (throws error)
   * - When using security level PERMISSIVE: `false` (returns undefined)
   *
   * When true, accessing blocked properties like 'constructor', '__proto__',
   * 'prototype' will throw a SecurityError instead of returning undefined.
   * This makes security violations explicit and easier to detect.
   *
   * **Breaking change note**: Prior versions returned undefined for all security levels.
   * Code that relied on silent undefined returns should either:
   * - Use PERMISSIVE security level, or
   * - Explicitly set `throwOnBlocked: false` in options
   */
  throwOnBlocked?: boolean;

  /**
   * Gate for calls into wrapped functions (used for host functions passed in `globals`).
   *
   * When set, a call through this proxy, or through any proxy derived from it (a method read off
   * a wrapped object), whose target `gates()` accepts is handed to `call(target, thisArg, args)`
   * instead of being invoked directly, and its return value is returned unwrapped: the gate is
   * responsible for producing a sandbox-safe value. Calling such a function with `new` is refused.
   */
  callGate?: {
    gates(target: unknown): boolean;
    call(target: unknown, thisArg: unknown, args: unknown[]): unknown;
  };

  /**
   * Applied to every value this membrane passes INTO a script callback (the arguments and the
   * receiver a host built-in calls it with), after the value has been wrapped. The single-VM
   * adapter uses it to put its airlock in front of those values as well (see ./realm-airlock):
   * a callback is called by host code, so what it receives does not come out of a trap.
   */
  exposeToSandbox?: (value: unknown) => unknown;

  /**
   * Whether an object was made in the sandbox realm (by the script, or for it). Such a value is
   * the script's own, wherever it comes back from: passed to a callback by a host built-in (the
   * object a script gave `reduce` to collect into), read out of what a built-in returned (a
   * function a `map` callback returned), or returned by a call. It leaves the membrane as it is,
   * never behind a proxy: a proxy would make the script's object read-only and would send a call
   * to the script's function through the gate for host functions. The test must only say yes to
   * what certainly is of that realm.
   */
  ownedBySandbox?: (value: object) => boolean;

  /**
   * Whether a value is the form in which the sandbox holds a value of the host: what
   * `exposeToSandbox` returned for it earlier (the single VM's airlock proxy). A script passes
   * such a value into a call as it is. Whatever the callee does with it (hands it on to a
   * function of the script, keeps it in what it returns), it leaves the membrane as it went in,
   * and it is not wrapped a second time.
   *
   * With this hook set, a built-in method of host data runs on host data only: on an object
   * that is not a value of the host the call is refused (see the apply trap).
   */
  heldBySandbox?: (value: object) => boolean;
}

/**
 * Proxies built with a `callGate` belong to one execution: they are cached per gate (weakly, so
 * they go away with the gate) and never shared through the global cache.
 */
const gatedProxyCaches = new WeakMap<object, WeakMap<object, object>>();

function gatedProxyCache(gate: object): WeakMap<object, object> {
  let cache = gatedProxyCaches.get(gate);
  if (!cache) {
    cache = new WeakMap<object, object>();
    gatedProxyCaches.set(gate, cache);
  }
  return cache;
}

/**
 * WeakMap to track already-proxied objects to prevent infinite recursion
 * and ensure we return the same proxy for the same object with the same config.
 *
 * The outer WeakMap is keyed by target object.
 * The inner Map is keyed by a config signature string.
 * This allows the same object to be proxied with different blocking configs.
 */
const proxyCache = new WeakMap<object, Map<string, object>>();

/**
 * WeakSet to track proxy objects (for isSecureProxy checks)
 * This is separate from proxyCache because proxyCache keys are targets, not proxies.
 */
const proxySet = new WeakSet<object>();

/**
 * Reverse map from a secure proxy back to the exact object it wraps.
 *
 * Used to unwrap the `this` receiver when a proxied method is invoked: `proxy.method()`
 * calls `method` with `thisArg === proxy`, but a Proxy does not carry the class's private
 * (`#field`) brand, so such methods would throw. Unwrapping to the original target restores
 * correct `this` (and private-field access) while the method's return value is still wrapped.
 */
const proxyToTarget = new WeakMap<object, object>();

/**
 * Generate a cache key from all SecureProxyOptions that affect proxy behavior
 * This ensures different options create different proxies for the same target
 *
 * NOTE: onBlocked callback is intentionally excluded from cache key.
 * Having different callbacks for the same blocking configuration is unusual,
 * and including function identity would effectively disable caching.
 * If you need different callbacks, use different additionalBlocked values.
 */
function getFullCacheKey(options: SecureProxyOptions): string {
  const parts: string[] = [];

  // Level config signature
  if (options.levelConfig) {
    const cfg = options.levelConfig;
    parts.push(
      `L:${cfg.blockConstructor ? 'C' : 'c'}${cfg.blockPrototype ? 'P' : 'p'}${cfg.blockLegacyAccessors ? 'L' : 'l'}`,
    );
  } else {
    parts.push('L:default');
  }

  // Additional blocked properties (sorted for consistent keys)
  if (options.additionalBlocked && options.additionalBlocked.length > 0) {
    parts.push(`B:${[...options.additionalBlocked].sort().join(',')}`);
  }

  // Max depth (only include if non-default)
  const effectiveMaxDepth = options.maxDepth ?? options.levelConfig?.proxyMaxDepth ?? 10;
  if (effectiveMaxDepth !== 10) {
    parts.push(`D:${effectiveMaxDepth}`);
  }

  // Throw on blocked (only include if true)
  if (options.throwOnBlocked) {
    parts.push('T:1');
  }

  return parts.join('|') || 'default';
}

/**
 * Built-in objects whose methods and accessors read internal slots, so they only work on the
 * original instance and never on a Proxy of it.
 *
 * These used to be handed to the sandbox UNWRAPPED ("not proxyable"): a Map or a typed array
 * passed in `globals`, the iterator a host array's `entries()` returns, a generator. Each one was
 * a raw host object in the script's hands, with the host's prototype chain behind it. They are
 * proxied like everything else; what makes them work is that the membrane always runs their
 * code against the original instance: a method call restores the instance as `this` (see the
 * apply trap), and a property read uses the instance as the receiver (see the get trap), which
 * is what an accessor such as `Map.prototype.size` or a typed array's `length` needs.
 */
const INTERNAL_SLOT_BUILTINS = new Set([
  '[object Map]',
  '[object Set]',
  '[object WeakMap]',
  '[object WeakSet]',
  '[object ArrayBuffer]',
  '[object SharedArrayBuffer]',
  '[object DataView]',
  '[object Int8Array]',
  '[object Uint8Array]',
  '[object Uint8ClampedArray]',
  '[object Int16Array]',
  '[object Uint16Array]',
  '[object Int32Array]',
  '[object Uint32Array]',
  '[object Float16Array]',
  '[object Float32Array]',
  '[object Float64Array]',
  '[object BigInt64Array]',
  '[object BigUint64Array]',
  '[object Date]',
  '[object RegExp]',
  // Generators and iterators
  '[object Generator]',
  '[object AsyncGenerator]',
  '[object Array Iterator]',
  '[object String Iterator]',
  '[object Map Iterator]',
  '[object Set Iterator]',
  '[object RegExp String Iterator]',
  '[object Iterator Helper]',
]);

/**
 * Types that need method binding when proxied
 * These types have internal slots that require `this` to be the original object
 * when calling their methods (e.g., Promise.prototype.then checks [[PromiseState]])
 */
const INTERNAL_SLOT_TYPES = new Set(['[object Promise]']);

/**
 * Host functions that call a callback with values of the host realm: the built-in methods of
 * host data (`forEach`, `map`, `sort`, `reduce`, a Map's `forEach`, ...), their bound forms, and
 * the JSON functions (a reviver or replacer is called with the holder object). The callbacks a
 * script passes to these are guarded (see guardCallbackArguments).
 */
const boundBuiltinMethods = new WeakSet<object>();

// The guard of an object a script passed to a host function (see guardObjectArgument in
// createSecureProxy). A guard hands values on through the membrane that made it, so it is kept
// the way that membrane's proxies are: per call gate (per execution), otherwise per
// configuration. The same object passed through another membrane gets that membrane's guard.
const argumentGuards = new WeakMap<object, Map<string, object>>();
const gatedArgumentGuards = new WeakMap<object, WeakMap<object, object>>();

function gatedArgumentGuardCache(gate: object): WeakMap<object, object> {
  let cache = gatedArgumentGuards.get(gate);
  if (!cache) {
    cache = new WeakMap<object, object>();
    gatedArgumentGuards.set(gate, cache);
  }
  return cache;
}

// What each guard stands for, whichever membrane made it
const guardedArguments = new WeakMap<object, unknown>();
const JsonParse = JSON.parse;
const JsonStringify = JSON.stringify;

/** What a script is told when it calls a built-in method of host data on an object of its own */
const HOST_RECEIVER_MESSAGE =
  'A built-in method of a value passed in globals can only be called on a value passed in globals. ' +
  'Use the method of the same name of your own value.';

/** What a script is told when it calls a built-in method of one kind of host value on another kind */
const HOST_RECEIVER_KIND_MESSAGE =
  'A built-in method of a value passed in globals can only be called on a value of the same kind ' +
  '(an array method on an array, a Map method on a Map).';

/**
 * Whether a host value is of the kind a built-in method belongs to: one of the prototypes the
 * method is defined on is in its prototype chain. The methods of `Object.prototype` are every
 * object's. A value that cannot be asked is not of the kind.
 */
function isOfBuiltinKind(receiver: object, homes: readonly object[]): boolean {
  for (let h = 0; h < homes.length; h++) {
    const home = homes[h];
    if (home === HostObjectPrototype) {
      return true;
    }
    try {
      let proto: unknown = ObjectGetPrototypeOf(receiver);
      for (let depth = 0; depth < 32 && proto !== null; depth++) {
        if (proto === home) {
          return true;
        }
        proto = ObjectGetPrototypeOf(proto as object);
      }
    } catch {
      return false;
    }
  }
  return false;
}

function passesHostValuesToCallbacks(fn: unknown, builtinMethod: boolean): boolean {
  return (
    builtinMethod ||
    fn === JsonParse ||
    fn === JsonStringify ||
    (typeof fn === 'function' && boundBuiltinMethods.has(fn))
  );
}

/**
 * Check if a value is a proxyable target (object or function). Every object and function is:
 * a value of the host realm that reached the sandbox unwrapped would bring the host's prototype
 * chain with it.
 */
function isProxyable(value: unknown): value is object {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}

/** The `Object.prototype.toString` tag of a value (through pinned intrinsics). */
function builtinTag(value: object): string {
  // ReflectApply, not `.call`: `.call` resolves Function.prototype.call live, which a
  // shared-realm attacker can replace to intercept every tag check.
  try {
    return ReflectApply(ObjectToString, value, []) as string;
  } catch {
    return '';
  }
}

/**
 * Create a secure proxy that blocks dangerous property access
 *
 * @param target The object to wrap
 * @param options Configuration options
 * @returns A proxy that blocks dangerous property access
 */
export function createSecureProxy<T extends object>(target: T, options: SecureProxyOptions = {}): T {
  // Return primitives as-is
  if (!isProxyable(target)) {
    return target;
  }

  // Generate cache key based on all options that affect proxy behavior
  const cacheKey = getFullCacheKey(options);

  // Gated proxies are cached per gate (per execution), everything else in the global cache
  const gateCache = options.callGate ? gatedProxyCache(options.callGate) : undefined;
  const lookupCached = (obj: object): object | undefined =>
    gateCache ? gateCache.get(obj) : proxyCache.get(obj)?.get(cacheKey);

  // The guards this membrane made for the objects that were passed to its host functions
  const gateGuards = options.callGate ? gatedArgumentGuardCache(options.callGate) : undefined;
  const lookupGuard = (obj: object): object | undefined =>
    gateGuards ? gateGuards.get(obj) : argumentGuards.get(obj)?.get(cacheKey);
  const storeGuard = (obj: object, guard: object): void => {
    if (gateGuards) {
      gateGuards.set(obj, guard);
      return;
    }
    let guards = argumentGuards.get(obj);
    if (!guards) {
      guards = new Map<string, object>();
      argumentGuards.set(obj, guards);
    }
    guards.set(cacheKey, guard);
  };

  // Check if already proxied with this config
  const cached = lookupCached(target);
  if (cached) {
    return cached as T;
  }

  // Build blocked set from levelConfig if provided, otherwise use defaults
  const baseBlocked = options.levelConfig
    ? buildBlockedPropertiesFromConfig(options.levelConfig)
    : new Set(BLOCKED_PROPERTIES);

  // Add any additional blocked properties
  const blockedSet = new Set([...baseBlocked, ...(options.additionalBlocked || [])]);

  // Use maxDepth from levelConfig if provided, otherwise from options or default.
  // Floor it so the (fail-closed) recursion cap can never sit below the deepest value that can
  // legitimately arrive; a higher cap only wraps MORE of the graph, so it is never less secure.
  const configuredMaxDepth = options.maxDepth ?? options.levelConfig?.proxyMaxDepth ?? 10;
  // A non-finite value (NaN/Infinity) would make `depth > maxDepth` never trip, silently
  // disabling the fail-closed backstop — reject it and fall back to the floor. Valid values are
  // floored so the cap can never sit below the deepest value that can legitimately arrive.
  const maxDepth = Number.isFinite(configuredMaxDepth)
    ? Math.max(configuredMaxDepth, MIN_MEMBRANE_RECURSION_DEPTH)
    : MIN_MEMBRANE_RECURSION_DEPTH;

  // Use throwOnBlocked from options or levelConfig (options takes precedence)
  const throwOnBlocked = options.throwOnBlocked ?? options.levelConfig?.throwOnBlocked ?? false;

  // Whether this membrane can tell a value the sandbox may hold as it is from a value of the
  // host (see ownedBySandbox and heldBySandbox). Without either hook everything is wrapped.
  const { ownedBySandbox, heldBySandbox } = options;
  const classifiesValues = ownedBySandbox !== undefined || heldBySandbox !== undefined;
  const passesAsItIs = (value: object): boolean =>
    (heldBySandbox !== undefined && heldBySandbox(value)) ||
    (ownedBySandbox !== undefined && !proxySet.has(value) && ownedBySandbox(value));

  // Create inner function for recursive proxying with depth tracking
  function proxyWithDepth<U extends object>(obj: U, depth: number): U {
    // Return primitives as-is
    if (!isProxyable(obj)) {
      return obj;
    }

    // An argument guard (see guardObjectArgument) that a host built-in kept in what it returned
    // stands for the value it was made for: that value is what leaves the membrane.
    if (guardedArguments.has(obj)) {
      const guarded = guardedArguments.get(obj) as U;
      if (!classifiesValues || !isProxyable(guarded)) {
        return guarded;
      }
      // A guard is made for whatever a built-in was called with, which is a value of the script
      // only as a rule: it leaves like any other value.
      obj = guarded;
    }

    // Check cache first with config key
    const cachedProxy = lookupCached(obj);
    if (cachedProxy) {
      return cachedProxy as U;
    }

    // A value the script may hold as it is (its own, or a host value in the form it holds one).
    // Asked after the cache, so only for a value this membrane has not wrapped before, and never
    // for the value the caller of createSecureProxy asked to have wrapped.
    if (depth > 0 && passesAsItIs(obj)) {
      return obj;
    }

    // Recursion backstop. Fail CLOSED: returning the raw target here would hand sandbox code an
    // unwrapped reference whose prototype chain reaches the host Function constructor (the
    // reported `.bind`-chain / deep-graph escape). Throwing keeps the membrane total.
    if (depth > maxDepth) {
      throw createSafeError(
        `Security violation: secure-proxy recursion depth (${maxDepth}) exceeded. ` +
          `The value cannot be exposed without breaking the sandbox barrier.`,
        'SecurityError',
      );
    }

    // Whether this object's own code reads internal slots (see INTERNAL_SLOT_BUILTINS)
    const hasInternalSlots = INTERNAL_SLOT_BUILTINS.has(builtinTag(obj));

    /**
     * Arguments for a host function that calls its callbacks with host values (see
     * passesHostValuesToCallbacks): every function the script passed is replaced by one that
     * receives those values, and its receiver, behind the membrane. Without this, the third
     * argument of a `forEach` callback is the raw host array.
     */
    // A value of the host on its way into script code. A host error (a rejection reason, say)
    // arrives as a safe error, as a thrown one does; a safe error is inert and passes as it is;
    // every other object or function is wrapped.
    const toSandbox = (value: unknown): unknown => {
      if (!isProxyable(value)) {
        return value;
      }
      // A host value in the form the script holds it: what the script passed, handed on
      if (heldBySandbox && heldBySandbox(value)) {
        return value;
      }
      const laundered = launderHostError(value);
      // A value of the script's own realm is the script's: the object it gave `reduce` to
      // collect into comes back as it is, and stays writable. Everything else is the host's
      // and goes behind the membrane. (proxyWithDepth decides which is which, and resolves an
      // argument guard that a built-in handed back.)
      const wrapped =
        isProxyable(laundered) && !isSafeError(laundered) ? proxyWithDepth(laundered, depth + 1) : laundered;
      return options.exposeToSandbox ? options.exposeToSandbox(wrapped) : wrapped;
    };

    /**
     * An object of the script on its way into a host function that may call one of its methods
     * with host values (the set operations of a `Set` ask the other collection `has(element)`
     * for each element of the receiver). It gets a guard instead: an object that answers every
     * property read from the script's object, with a function member replaced by one that
     * receives its arguments behind the membrane and keeps the script's object as its receiver,
     * and an object member or result guarded the same way. Its own properties are listed as
     * they are, so a function that copies or serializes the object sees the same data. An array
     * is data to every built-in and passes as it is, as does a value that is behind the
     * membrane already.
     */
    const guardObjectArgument = (value: unknown): unknown => {
      if (value === null || typeof value !== 'object') return value;
      if (proxySet.has(value) || guardedArguments.has(value) || Array.isArray(value)) return value;
      if (heldBySandbox && heldBySandbox(value)) return value;
      const existing = lookupGuard(value);
      if (existing) return existing;
      const original = value;
      // Over an empty object, not over the script's object: a frozen member of the target would
      // have to be reported as it is (proxy invariant), unguarded.
      const guard = new Proxy(Object.create(null) as object, {
        get: (_shell, property) => guardMember(ReflectGet(original, property, original), original),
        has: (_shell, property) => ReflectHas(original, property),
        // A function that lists the object (to copy or to serialize it, as JSON.stringify does)
        // sees the script's own properties, each as a data property holding what a read gives.
        ownKeys: () => ReflectOwnKeys(original),
        getOwnPropertyDescriptor: (_shell, property) => {
          const descriptor = ReflectGetOwnPropertyDescriptor(original, property);
          if (!descriptor) return undefined;
          return {
            value: guardMember(ReflectGet(original, property, original), original),
            writable: true,
            enumerable: descriptor.enumerable === true,
            configurable: true,
          };
        },
        // What a host function stores in the object is a host value like any other
        set: (_shell, property, stored) => ReflectSet(original, property, toSandbox(stored), original),
      });
      storeGuard(original, guard);
      guardedArguments.set(guard, original);
      return guard;
    };

    const guardMember = (member: unknown, holder: object): unknown => {
      if (typeof member !== 'function') return guardObjectArgument(member);
      const method = function guardedMethod(...hostArgs: unknown[]): unknown {
        return guardArgument(ReflectApply(member, holder, hostArgs.map(toSandbox)));
      };
      guardedArguments.set(method, member);
      return method;
    };

    const guardCallback = (callback: (...args: unknown[]) => unknown): unknown => {
      const guarded = function guardedCallback(this: unknown, ...hostArgs: unknown[]): unknown {
        return ReflectApply(callback, toSandbox(this), hostArgs.map(toSandbox));
      };
      // A built-in that keeps the function instead of calling it (concat, with) hands back the
      // script's function, not this one
      guardedArguments.set(guarded, callback);
      return guarded;
    };

    const guardArgument = (arg: unknown): unknown => {
      if (typeof arg === 'function') {
        return proxySet.has(arg) || guardedArguments.has(arg) || (heldBySandbox && heldBySandbox(arg))
          ? arg
          : guardCallback(arg as (...args: unknown[]) => unknown);
      }
      return guardObjectArgument(arg);
    };

    /**
     * Arguments for a host function that calls into what it is given with values of the host
     * realm (see passesHostValuesToCallbacks): every function the script passed is replaced by
     * one that receives those values, and its receiver, behind the membrane (without this, the
     * third argument of a `forEach` callback is the raw host array), and every object by a guard
     * (see guardObjectArgument).
     */
    const guardCallbackArguments = (args: unknown[]): unknown[] => args.map(guardArgument);

    const proxy = new Proxy(obj, {
      get(target: U, property: string | symbol, receiver: unknown): unknown {
        // Convert symbol to string for checking
        const propName = typeof property === 'symbol' ? property.toString() : property;

        // A non-configurable, non-writable data property must be reported with its exact
        // value (proxy invariant), so it can neither be wrapped nor hidden. Primitives are
        // inert and safe to hand back — this covers constants such as Math.PI and hardened
        // slots pinned to undefined. An object or function cannot be handed back: it would
        // cross the barrier unwrapped and its prototype chain reaches the host Function
        // constructor, so deny the read instead. Throwing always satisfies the invariant.
        const descriptor = ObjectGetOwnPropertyDescriptor(target, property);
        if (descriptor && !descriptor.configurable && descriptor.writable === false && 'value' in descriptor) {
          const exactValue: unknown = descriptor.value;
          if (exactValue !== null && (typeof exactValue === 'object' || typeof exactValue === 'function')) {
            throw createSafeError(
              `Security violation: Access to '${String(propName)}' is blocked. ` +
                `This property cannot be exposed without breaking the sandbox barrier.`,
              'SecurityError',
            );
          }
          return exactValue;
        }

        // Block dangerous properties. Every descriptor shape that would force the trap's
        // return value has been handled above, so denying here is invariant-safe.
        if (typeof propName === 'string' && blockedSet.has(propName)) {
          if (options.onBlocked) {
            options.onBlocked(target, propName);
          }

          if (throwOnBlocked) {
            throw createSafeError(
              `Security violation: Access to '${propName}' is blocked. ` +
                `This property can be used for sandbox escape attacks.`,
              'SecurityError',
            );
          }
          return undefined;
        }

        // Block function-specific properties if target is a function
        if (typeof target === 'function' && typeof propName === 'string' && FUNCTION_BLOCKED_PROPERTIES.has(propName)) {
          if (options.onBlocked) {
            options.onBlocked(target, propName);
          }

          if (throwOnBlocked) {
            throw createSafeError(
              `Security violation: Access to '${propName}' is blocked. ` +
                `This property can be used for sandbox escape attacks.`,
              'SecurityError',
            );
          }
          return undefined;
        }

        // Get the actual value. An accessor of a built-in with internal slots (a Map's size, a
        // typed array's length) must run against the instance itself, not against this proxy.
        const value = ReflectGet(target, property, hasInternalSlots ? target : receiver);

        // For methods on objects with internal slots (like Promise), we need to:
        // 1. Bind the method to the original object so internal slot checks pass
        // 2. Proxy the bound method to block constructor access
        // This prevents attacks like: callTool(...).then.constructor
        if (typeof value === 'function') {
          const tag = builtinTag(target);
          if (INTERNAL_SLOT_TYPES.has(tag)) {
            // Bind to original object so methods like .then() work correctly
            // Then proxy the bound function to block .constructor access
            const boundMethod = ReflectApply(FunctionBind, value, [target]);
            if (isBuiltinMethod(value)) {
              boundBuiltinMethods.add(boundMethod);
            }
            return proxyWithDepth(boundMethod, depth + 1);
          }
        }

        // Recursively proxy objects and functions
        if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
          return proxyWithDepth(value as object, depth + 1);
        }

        return value;
      },

      // Block setting dangerous properties
      set(target: U, property: string | symbol, value: unknown, receiver: unknown): boolean {
        const propName = typeof property === 'symbol' ? property.toString() : property;

        // Block setting dangerous properties
        if (typeof propName === 'string' && blockedSet.has(propName)) {
          if (options.onBlocked) {
            options.onBlocked(target, propName);
          }
          if (throwOnBlocked) {
            throw createSafeError(
              `Security violation: Setting '${propName}' is blocked. ` +
                `This property can be used for sandbox escape attacks.`,
              'SecurityError',
            );
          }
          return false; // Silently fail
        }

        return ReflectSet(target, property, value, receiver);
      },

      // Block defining dangerous properties
      defineProperty(target: U, property: string | symbol, descriptor: PropertyDescriptor): boolean {
        const propName = typeof property === 'symbol' ? property.toString() : property;

        if (typeof propName === 'string' && blockedSet.has(propName)) {
          if (options.onBlocked) {
            options.onBlocked(target, propName);
          }
          if (throwOnBlocked) {
            throw createSafeError(
              `Security violation: Defining '${propName}' is blocked. ` +
                `This property can be used for sandbox escape attacks.`,
              'SecurityError',
            );
          }
          return false;
        }

        return ReflectDefineProperty(target, property, descriptor);
      },

      // Filter blocked property names from enumeration (Object.keys, Object.entries, etc.)
      // Must respect proxy invariants: non-configurable own properties cannot be hidden
      ownKeys(target: U): (string | symbol)[] {
        const keys = ReflectOwnKeys(target);
        return keys.filter((key) => {
          const keyStr = typeof key === 'symbol' ? key.toString() : key;
          // Keep non-blocked properties
          if (typeof keyStr !== 'string' || !blockedSet.has(keyStr)) {
            return true;
          }
          // Must keep non-configurable properties (proxy invariant)
          const descriptor = ObjectGetOwnPropertyDescriptor(target, key);
          if (descriptor && !descriptor.configurable) {
            return true;
          }
          // Filter out blocked configurable properties
          return false;
        });
      },

      // Hide blocked properties from property descriptor queries (defense-in-depth)
      // Must respect proxy invariants: non-configurable properties must return actual descriptor
      getOwnPropertyDescriptor(target: U, property: string | symbol): PropertyDescriptor | undefined {
        const propName = typeof property === 'symbol' ? property.toString() : property;
        const descriptor = ReflectGetOwnPropertyDescriptor(target, property);

        // Mirror the get trap: a non-configurable, non-writable data property must be reported
        // with its exact value (proxy invariant), so an object/function value cannot be wrapped
        // or hidden and would cross the barrier unwrapped via `descriptor.value`. Deny the read
        // instead (throwing satisfies the invariant); primitives are inert and safe to report.
        if (descriptor && !descriptor.configurable && descriptor.writable === false && 'value' in descriptor) {
          const exactValue: unknown = descriptor.value;
          if (exactValue !== null && (typeof exactValue === 'object' || typeof exactValue === 'function')) {
            throw createSafeError(
              `Security violation: Access to property descriptor for '${String(propName)}' is blocked. ` +
                `This property cannot be exposed without breaking the sandbox barrier.`,
              'SecurityError',
            );
          }
          return descriptor;
        }

        // Accessor descriptors expose raw getter/setter functions. A non-configurable accessor
        // must be reported with its exact get/set (proxy invariant), so it cannot be wrapped —
        // deny it if it carries a function whose prototype chain reaches the host constructor.
        if (
          descriptor &&
          !descriptor.configurable &&
          (typeof descriptor.get === 'function' || typeof descriptor.set === 'function')
        ) {
          throw createSafeError(
            `Security violation: Access to property descriptor for '${String(propName)}' is blocked. ` +
              `This property cannot be exposed without breaking the sandbox barrier.`,
            'SecurityError',
          );
        }

        // Must return actual descriptor for other non-configurable properties (proxy invariant)
        if (descriptor && !descriptor.configurable) {
          return descriptor;
        }

        // Return undefined (or throw) for blocked configurable properties
        if (typeof propName === 'string' && blockedSet.has(propName)) {
          if (options.onBlocked) {
            options.onBlocked(target, propName);
          }
          if (throwOnBlocked) {
            throw createSafeError(
              `Security violation: Access to property descriptor for '${propName}' is blocked. ` +
                `This property can be used for sandbox escape attacks.`,
              'SecurityError',
            );
          }
          return undefined;
        }

        // A configurable accessor's getter/setter may be safely proxied so the descriptor never
        // hands back a raw function whose prototype chain reaches the host Function constructor.
        if (descriptor && (typeof descriptor.get === 'function' || typeof descriptor.set === 'function')) {
          return {
            ...descriptor,
            get: typeof descriptor.get === 'function' ? proxyWithDepth(descriptor.get, depth + 1) : descriptor.get,
            set: typeof descriptor.set === 'function' ? proxyWithDepth(descriptor.set, depth + 1) : descriptor.set,
          };
        }

        // Wrap object/function values so a descriptor read cannot hand back a raw reference that
        // the get trap would have proxied (a configurable property's value may be safely wrapped).
        if (descriptor && 'value' in descriptor) {
          const value: unknown = descriptor.value;
          if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
            return { ...descriptor, value: proxyWithDepth(value as object, depth + 1) };
          }
        }

        return descriptor;
      },

      // Block getPrototypeOf to prevent prototype chain walking
      getPrototypeOf(): object | null {
        // Return null to hide the prototype chain
        return null;
      },

      // Block setPrototypeOf
      setPrototypeOf(): boolean {
        return false;
      },

      // Intercept function calls to proxy return values
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Proxy handler signature requires any for compatibility
      apply(target: any, thisArg: any, argArray: any[]): any {
        // Preserve the ORIGINAL instance as `this`. When the sandbox calls `proxy.method()`,
        // thisArg is our proxy; running the method with the proxy as `this` breaks methods
        // that read `#private` fields (a Proxy lacks the class's private brand). Unwrap a
        // known secure proxy back to its wrapped target before invoking the method. This only
        // affects proxies WE created, and the method's return value is still wrapped below.
        const receiverIsReference = thisArg !== null && (typeof thisArg === 'object' || typeof thisArg === 'function');
        const wrappedReceiver = receiverIsReference ? proxyToTarget.get(thisArg) : undefined;
        const unwrappedThis = wrappedReceiver !== undefined ? wrappedReceiver : thisArg;

        // The text of a host function is a fixed form, never its source: asked of a function
        // of the host, toString (and toLocaleString, which calls it) answer with that form.
        // Before the gate: the answer is not a call into the function.
        if (classifiesValues && typeof wrappedReceiver === 'function' && isFunctionTextMethod(target)) {
          return hostFunctionText(wrappedReceiver);
        }

        // Gated functions (host functions from `globals`) are called by the gate, which
        // enforces the limits and returns a value that is already safe for the sandbox.
        if (options.callGate && options.callGate.gates(target)) {
          // Only a receiver this membrane wrapped (the host object the method was read from) is
          // passed on. A script value as `this` never reaches a host function, for the same
          // reason its arguments are copied first (see sanitizeArguments in global-function-gate).
          const hostReceiver = unwrappedThis !== thisArg ? unwrappedThis : undefined;
          return options.callGate.call(target, hostReceiver, argArray);
        }

        // A built-in method of host data runs on host data only. Its arguments are prepared for
        // host code (a guard in place of a script object, a wrapper in place of a callback), and
        // on host data that is where they stay: nothing of the script is called with them except
        // through those guards.
        //
        // And on host data of its own kind: an array method on an array, a Date method on a
        // Date. What a method reads off its receiver, returns and reports in an error is what
        // the membrane expects of it only for the kind of value it is defined for.
        const homes = builtinMethodHomes(target);
        const builtinMethod = homes !== undefined;
        if (builtinMethod && heldBySandbox !== undefined && receiverIsReference) {
          if (wrappedReceiver === undefined) {
            throw createSafeError(HOST_RECEIVER_MESSAGE, 'TypeError');
          }
          if (!isOfBuiltinKind(wrappedReceiver, homes)) {
            throw createSafeError(HOST_RECEIVER_KIND_MESSAGE, 'TypeError');
          }
        }

        // Call the original function
        let result: unknown;
        try {
          result = ReflectApply(
            target,
            unwrappedThis,
            passesHostValuesToCallbacks(target, builtinMethod) ? guardCallbackArguments(argArray) : argArray,
          );
        } catch (error) {
          throw launderHostError(error);
        }

        // Proxy the return value if it's an object or function
        if (isProxyable(result)) {
          return proxyWithDepth(result, depth + 1);
        }

        return result;
      },

      // Intercept constructor calls to proxy the created instance. Without this, code such as
      // `new (wrappedCtor)()` would return a RAW object whose prototype chain reaches the
      // host Function constructor — the same escape class the apply trap closes for calls.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Proxy handler signature requires any for compatibility
      construct(target: any, argArray: any[], newTarget: any): any {
        // A gated host function is only ever called; constructing one would hand back a raw
        // host instance without going through the gate.
        if (options.callGate && options.callGate.gates(target)) {
          throw createSafeError('Host functions cannot be called with new', 'TypeError');
        }

        // When invoked as `new (proxy)(...)`, newTarget is the proxy itself; reading its
        // blocked `.prototype` would fail, so fall back to the original constructor.
        let instance: unknown;
        try {
          instance = ReflectConstruct(target, argArray, newTarget === proxy ? target : newTarget);
        } catch (error) {
          throw launderHostError(error);
        }

        // Proxy the instance so the created object stays behind the security barrier.
        if (isProxyable(instance)) {
          return proxyWithDepth(instance, depth + 1);
        }

        return instance;
      },
    });

    // Cache the proxy with config key
    if (gateCache) {
      gateCache.set(obj, proxy);
    } else {
      let objCacheMap = proxyCache.get(obj);
      if (!objCacheMap) {
        objCacheMap = new Map<string, object>();
        proxyCache.set(obj, objCacheMap);
      }
      objCacheMap.set(cacheKey, proxy);
    }

    // Track the proxy in the WeakSet for isSecureProxy checks
    proxySet.add(proxy);
    // Record proxy -> target so method calls can restore the original `this` (see apply trap).
    proxyToTarget.set(proxy, obj);

    return proxy;
  }

  return proxyWithDepth(target, 0);
}

/**
 * Wrap multiple globals with secure proxies
 *
 * @param globals Object containing global values to wrap
 * @param options Proxy options
 * @returns New object with all values wrapped in secure proxies
 */
export function wrapGlobalsWithSecureProxy(
  globals: Record<string, unknown>,
  options: SecureProxyOptions = {},
): Record<string, unknown> {
  const wrapped: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(globals)) {
    if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
      wrapped[key] = createSecureProxy(value as object, options);
    } else {
      // Primitives don't need proxying
      wrapped[key] = value;
    }
  }

  return wrapped;
}

/**
 * Create a secure version of standard library objects
 *
 * This creates proxied versions of Math, JSON, Array, Object, etc.
 * that block access to dangerous properties.
 */
export function createSecureStandardLibrary(options: SecureProxyOptions = {}): Record<string, unknown> {
  return wrapGlobalsWithSecureProxy(
    {
      Math,
      JSON,
      Array,
      Object,
      String,
      Number,
      Date,
      // Note: We intentionally don't include:
      // - Function (dangerous)
      // - eval (dangerous)
      // - Proxy, Reflect (meta-programming)
    },
    options,
  );
}

/**
 * Whether an object that is not a secure proxy belongs to the host: its prototype chain reaches
 * the host's `Object.prototype`, or it has no prototype at all (the host builds such objects for
 * its results; nothing of the sandbox realm comes out of a secure proxy without a prototype).
 * Every other object was made in the sandbox realm, by the script or for it.
 */
export function isRawHostObject(value: object): boolean {
  let current: unknown = value;
  for (let depth = 0; depth < 32; depth++) {
    try {
      current = ObjectGetPrototypeOf(current as object);
    } catch {
      return true;
    }
    if (current === null) {
      return depth === 0;
    }
    if (current === HostObjectPrototype) {
      return true;
    }
  }
  return true;
}

/**
 * Check if an object is a secure proxy
 *
 * @param obj Object to check
 * @returns true if the object is wrapped in a secure proxy
 */
export function isSecureProxy(obj: unknown): boolean {
  // A proxied function is a secure proxy too (its typeof is 'function', not 'object')
  if (obj === null || (typeof obj !== 'object' && typeof obj !== 'function')) {
    return false;
  }
  return proxySet.has(obj as object);
}

/**
 * The object a secure proxy wraps, or `value` itself when it is not one.
 *
 * For host code that must read a sandbox value's internal slots, which a proxy does not carry
 * (a proxied Date fails `Date.prototype.getTime`). Never hand the result back to the sandbox.
 */
export function unwrapSecureProxy<T>(value: T): T {
  let current: unknown = value;
  while (current !== null && (typeof current === 'object' || typeof current === 'function')) {
    const target = proxyToTarget.get(current as object);
    if (target === undefined) break;
    current = target;
  }
  return current as T;
}

/**
 * Clear the proxy cache
 *
 * @deprecated This function always throws an error. WeakMap and WeakSet entries are
 * automatically garbage collected when their target objects become unreachable.
 * Manual cache clearing is not supported or necessary.
 *
 * @throws {Error} Always throws to inform callers that this operation is not supported
 */
export function clearProxyCache(): void {
  throw new Error(
    'clearProxyCache is not supported. WeakMap/WeakSet entries are automatically garbage collected when target objects become unreachable.',
  );
}
