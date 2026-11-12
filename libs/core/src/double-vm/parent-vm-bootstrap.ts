/**
 * Parent VM Bootstrap Script Generator
 *
 * Generates the JavaScript code that runs inside the Parent VM.
 * The Parent VM is responsible for:
 * - Creating and managing the Inner VM where user code runs
 * - Intercepting and validating all tool calls from the Inner VM
 * - Applying enhanced security validation (rate limiting, pattern detection)
 * - Proxying validated tool calls to the host
 *
 * @packageDocumentation
 */

import type { NormalizedToolNamespace } from '@enclave-vm/ast';
import type { SerializableParentValidationConfig, SerializableSuspiciousPattern } from './types';
import type { SecurityLevel } from '../types';
import { globalFunctionLimitMessage, HOST_REGEXP_MESSAGE } from '../global-function-gate';
import { TOOL_NAMESPACE_FACTORY_SOURCE } from '../tool-namespaces';
import { CONSOLE_FACTORY_SOURCE } from '../console-handler';
import { realmTickSource } from '../deadline-guard';
import { booleanLiteral, numericLiteral } from '../enclave-options';
import { STACK_CAPTURE_OFF_SOURCE } from '../realm-stack';
import { realmArrayAccountingSource } from '../realm-memory';

/**
 * Recursion backstop for the in-VM secure-proxy membranes.
 *
 * The counter is a stack-safety limit, NOT a security control: every membrane level already
 * blocks the dangerous properties, so this number never decides whether an escape is possible.
 * Exceeding it must fail CLOSED (throw) — returning the raw target used to hand sandbox code an
 * unwrapped host reference (the reported `.bind`-chain escape inflated the counter past the old
 * cap of 10 and received a raw function whose chain reaches the host Function constructor).
 * It sits well above the deepest value that can legitimately arrive (a tool result is
 * pre-sanitized to at most `maxSanitizeDepth`, which peaks at 50; custom host globals are not
 * sanitize-bounded, hence the generous ~5x headroom) so legitimate data is never rejected. The
 * membrane is lazy (one property access = one wrap = O(1) synchronous stack), so a large value
 * costs nothing in stack depth or performance.
 */
const MEMBRANE_MAX_RECURSION_DEPTH = 256;

/**
 * Options for generating the parent VM bootstrap script
 */
export interface ParentVmBootstrapOptions {
  /** User code to execute (already transformed by ast-guard) */
  userCode: string;

  /** Timeout for the inner VM in milliseconds */
  innerTimeout: number;

  /** Maximum iterations allowed in loops */
  maxIterations: number;

  /** Maximum tool calls allowed */
  maxToolCalls: number;

  /**
   * Tool bridge mode used for host tool calls.
   * @default 'string'
   */
  toolBridgeMode: 'string' | 'direct';

  /**
   * Maximum size (in bytes) of a tool request/response payload.
   * @default 5 * 1024 * 1024 (5MB)
   */
  toolBridgeMaxPayloadBytes: number;

  /**
   * Whether to sanitize stack traces in the sandbox.
   * Prevents host stack frame/path leakage via `error.stack` when user code catches errors.
   */
  sanitizeStackTraces: boolean;

  /** Security level for dangerous global removal */
  securityLevel: SecurityLevel;

  /** Serialized validation config */
  validationConfig: SerializableParentValidationConfig;

  /** Serialized suspicious patterns */
  suspiciousPatterns: SerializableSuspiciousPattern[];

  /** List of property names to block via secure proxy */
  blockedProperties: string[];

  /** Whether composite reference handles are allowed (for string concatenation) */
  allowComposites?: boolean;

  /** Memory limit in bytes (0 = unlimited) */
  memoryLimit?: number;

  /** Whether to throw errors instead of returning undefined for blocked properties */
  throwOnBlocked?: boolean;

  /**
   * Maximum number of calls into host functions passed in `globals`
   * @default 1000
   */
  maxGlobalFunctionCalls?: number;

  /** Validated tool namespaces to bind in the inner VM */
  toolNamespaces?: readonly NormalizedToolNamespace[];

  /**
   * The global names the inner realm may hold (`realmGlobals: 'allowlist'`). When set, every
   * other global is removed from the inner realm before the script runs, the safe standard
   * globals that are not on the list are not defined, and regular expressions cannot be executed
   * there. Absent: only the security level's dangerous globals are removed.
   */
  realmGlobalAllowlist?: readonly string[];
}

/**
 * Node.js 24 dangerous globals that should be removed per security level
 * (Same as in vm-adapter.ts)
 *
 * Defense-in-depth: Even though codeGeneration.strings=false blocks
 * new Function() from strings, removing Function entirely eliminates
 * any potential bypass vectors discovered in the future.
 *
 * ATK-RECON-01 identified these accessible globals as attack surface:
 * Function, eval, Proxy, Reflect, WeakRef, FinalizationRegistry,
 * SharedArrayBuffer, Atomics, gc, WebAssembly, globalThis
 */
const NODEJS_24_DANGEROUS_GLOBALS: Record<SecurityLevel, string[]> = {
  STRICT: [
    // Code execution - CRITICAL
    'Function', // Constructor for functions - primary escape vector
    'eval', // Direct code execution
    'globalThis', // Indirect access to all globals

    // Metaprogramming - sandbox escape vectors
    'Proxy', // Can intercept all operations
    'Reflect', // Metaprogramming primitive

    // Memory/timing attacks
    'SharedArrayBuffer', // Spectre/timing attacks
    'Atomics', // Shared memory operations
    'gc', // Force garbage collection (shouldn't be exposed)

    // Future/experimental APIs
    'Iterator', // Iterator helpers
    'AsyncIterator', // Async iterator helpers
    'ShadowRealm', // New realm creation (major escape risk)
    'WeakRef', // Can observe GC behavior
    'FinalizationRegistry', // Can observe GC behavior
    'performance', // Timing information
    'Temporal', // New date/time API
  ],
  SECURE: [
    // Code execution - CRITICAL
    'Function',
    'eval',
    'globalThis',

    // Most dangerous metaprogramming
    'Proxy',

    // Memory/timing attacks
    'SharedArrayBuffer',
    'Atomics',
    'gc',

    // Future APIs
    'Iterator',
    'AsyncIterator',
    'ShadowRealm',
    'WeakRef',
    'FinalizationRegistry',
  ],
  STANDARD: [
    // Code execution - always block these
    'Function',
    'eval',

    // Memory/timing attacks
    'SharedArrayBuffer',
    'Atomics',
    'gc',

    // Definitely dangerous
    'ShadowRealm',
    'WeakRef',
    'FinalizationRegistry',
  ],
  PERMISSIVE: [
    // Even PERMISSIVE should block the most dangerous
    'ShadowRealm', // Too dangerous to allow
    'gc', // Shouldn't be exposed at all
    'SharedArrayBuffer', // Spectre risk
    'Atomics', // Goes with SharedArrayBuffer
  ],
};

/**
 * Source of an expression evaluated in the inner realm as soon as that realm exists. Its value is
 * the function that removes globals from the realm at the end of setup; compiling it first means
 * it holds the realm's pristine intrinsics whatever setup replaces afterwards.
 *
 * `scrub(remove, keep)`:
 * - `remove`: the global names to delete, or `null` for every own key of the global object;
 * - `keep`: names that are never deleted;
 * - returns the keys that still resolve as a global afterwards, for the caller to shadow.
 *
 * Two facts about `node:vm` shape it (both verified on Node 22 and 24):
 *
 * 1. The intrinsics live on the realm's own global object, not on the sandbox object passed to
 *    `vm.createContext`: `'Function' in sandbox` is false and `delete sandbox.Function` does
 *    nothing. A `delete` evaluated INSIDE the realm removes the name from both.
 * 2. A bare identifier is also resolved through the PROTOTYPE CHAIN of the global object, so
 *    `constructor`, `toString`, `valueOf`, `hasOwnProperty`, `__lookupGetter__`, ... all name a
 *    function. The scrub therefore ends that chain (`setPrototypeOf(global, null)`), and reports
 *    any inherited name that still resolves. (The sandbox object has its own chain, which the
 *    realm consults FIRST: see where the inner context is created.)
 */
const INNER_REALM_SCRUB_SOURCE = `
(function () {
  'use strict';
  var global = globalThis;
  var getOwnPropertyNames = Object.getOwnPropertyNames;
  var getOwnPropertySymbols = Object.getOwnPropertySymbols;
  var getPrototypeOf = Object.getPrototypeOf;
  var setPrototypeOf = Object.setPrototypeOf;

  return function scrub(remove, keep) {
    var kept = { __proto__: null };
    var i;
    var j;
    for (i = 0; i < keep.length; i++) kept[keep[i]] = true;

    var targets = [];
    if (remove) {
      for (i = 0; i < remove.length; i++) targets[targets.length] = remove[i];
    } else {
      var names = getOwnPropertyNames(global);
      for (i = 0; i < names.length; i++) targets[targets.length] = names[i];
      var symbols = getOwnPropertySymbols(global);
      for (i = 0; i < symbols.length; i++) targets[targets.length] = symbols[i];
    }

    // What the global object inherits resolves as a bare identifier too.
    var inherited = [];
    try {
      var hops = 0;
      for (var proto = getPrototypeOf(global); proto !== null && hops < 32; proto = getPrototypeOf(proto)) {
        hops++;
        var protoNames = getOwnPropertyNames(proto);
        for (j = 0; j < protoNames.length; j++) inherited[inherited.length] = protoNames[j];
      }
    } catch (e) {}
    try { setPrototypeOf(global, null); } catch (e) {}

    var left = [];
    for (i = 0; i < targets.length; i++) {
      var key = targets[i];
      if (typeof key === 'string' && kept[key] === true) continue;
      try { delete global[key]; } catch (e) {}
      if (key in global) left[left.length] = key;
    }
    for (i = 0; i < inherited.length; i++) {
      if (kept[inherited[i]] !== true && inherited[i] in global) left[left.length] = inherited[i];
    }
    return left;
  };
})()
`.trim();

/**
 * Source of an expression evaluated in the pristine inner realm. Its value is the function that
 * runs `parallel(items, fn)` once the parent realm has checked the arguments: it calls the
 * script's callback for every item and awaits the results with the inner realm's own
 * `Promise.all`.
 *
 * Doing this in the inner realm keeps two parent-realm objects out of the script's hands: the
 * resolving functions that `Promise.all` passes to the `then` of each result (a callback may
 * return any thenable), and the array the results arrive in.
 */
const INNER_REALM_PARALLEL_SOURCE = `
(function () {
  'use strict';
  var RealmPromise = Promise;
  var all = Promise.all;
  var reject = Promise.reject;
  var apply = Reflect.apply;
  return function runParallel(items, length, callback) {
    var results = [];
    try {
      for (var i = 0; i < length; i++) {
        results[i] = callback(items[i], i, items);
      }
    } catch (error) {
      // As from the async function this replaces: a callback that throws rejects the promise.
      return apply(reject, RealmPromise, [error]);
    }
    return apply(all, RealmPromise, [results]);
  };
})()
`.trim();

/**
 * How many arguments the stack reserve pushes (see INNER_REALM_GUARD_SOURCE): 8 bytes each, so
 * 64 KB.
 *
 * The size follows from one measured fact: V8 refuses to compile a function for its first call
 * when less than about 40 KB of stack is left (39.9 KB with Node.js 24, 46.4 KB with Node.js 22).
 * Below that, any function of the runtime that has not run yet in this process throws a
 * RangeError at its call site, in the middle of whatever was calling it. With half this reserve
 * (the first version) a host function passed in globals could run and then fail to hand its
 * result back. 64 KB is that zone plus room for the frames between the script and the deepest
 * call of the runtime's own code (measured: under 10 KB). Code the application supplied gets a
 * larger reserve of its own, where it starts: see ../stack-reserve.
 *
 * The check costs about 2.7 microseconds (the engine pushes every argument).
 */
export const STACK_RESERVE_ARGUMENTS = 8192;

/**
 * Source of an expression evaluated in a pristine sandbox realm (the inner realm of the double
 * VM, the one realm of the single VM). Its value is that realm's half of the membrane:
 * `makeProxy(target, parentHandler)`, `wrap(fn, needsReserve)`, `own(value)` (what a script may
 * be handed in place of a thrown value or a rejection reason) and `shell(kind)`.
 *
 * Why the membrane needs a half in the script's realm: an error is created in the realm of the
 * function that is running when it is raised, and a stack overflow is raised at the ENTRY of the
 * function that no longer fits. A script that recurses until the stack is full and then touches a
 * membrane proxy overflows at the entry of the trap, before any catch of the trap exists: the
 * RangeError it catches is a raw object of the trap's realm, never laundered. With a host function
 * called directly from inner-realm code (the memory accounting hook was one) it is a HOST error,
 * and its constructor chain reaches the one Function constructor that can generate code.
 *
 * So the first frame a script enters is always a function of its own realm:
 *
 * - a Proxy handler is an inner-realm object whose traps call the parent realm's traps inside a
 *   try block;
 * - every parent or host function that inner-realm code holds directly is wrapped the same way.
 *
 * Whatever comes out of that try block is passed on only if a script may have it: a primitive,
 * an object without a prototype (the runtime's inert errors), or an object of this realm.
 * Anything else is replaced by an error of this realm with the same name and message. The catch
 * runs in this realm as well, so if IT overflows, that error is this realm's too.
 *
 * The stack reserve: a call (and a construct) first checks that some stack is left, by calling a
 * function with STACK_RESERVE_ARGUMENTS arguments, which the engine has to push. With less room
 * than that the script gets a RangeError of its own realm before anything of the runtime has
 * started. The runtime's code therefore never begins at a nearly full stack, where a failure
 * halfway through is not something it is written for. Reading a property (the get trap and the
 * other traps) is not checked: it happens far too often for a check of this price.
 */
export const INNER_REALM_GUARD_SOURCE = `
(function () {
  'use strict';
  var apply = Reflect.apply;
  var reflectGet = Reflect.get;
  var reflectGetPrototypeOf = Reflect.getPrototypeOf;
  var ProxyCtor = Proxy;
  var ObjectPrototype = Object.prototype;
  var RealmError = Error;
  var RealmRangeError = RangeError;
  var RealmTypeError = TypeError;
  var freeze = Object.freeze;

  var pad = [];
  for (var i = 0; i < ${STACK_RESERVE_ARGUMENTS}; i++) pad[i] = 0;
  function nothing() {}
  function reserve() {
    apply(nothing, undefined, pad);
  }

  function passes(value) {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return true;
    var proto = reflectGetPrototypeOf(value);
    if (proto === null) return true;
    for (var depth = 0; depth < 32; depth++) {
      if (proto === ObjectPrototype) return true;
      proto = reflectGetPrototypeOf(proto);
      if (proto === null) return false;
    }
    return false;
  }

  function own(thrown) {
    var ok = false;
    try { ok = passes(thrown); } catch (e) { ok = false; }
    if (ok) return thrown;
    var name = 'Error';
    var message = 'Operation failed';
    try { var n = reflectGet(thrown, 'name'); if (typeof n === 'string') name = n; } catch (e) { /* keep the default */ }
    try { var m = reflectGet(thrown, 'message'); if (typeof m === 'string') message = m; } catch (e) { /* keep the default */ }
    var Ctor = name === 'RangeError' ? RealmRangeError : (name === 'TypeError' ? RealmTypeError : RealmError);
    return new Ctor(message);
  }

  function wrap(fn, needsReserve) {
    return function () {
      if (needsReserve) reserve();
      try {
        return apply(fn, undefined, arguments);
      } catch (thrown) {
        throw own(thrown);
      }
    };
  }

  // The traps every membrane proxy shares. 'this' is the proxy's handler, whose 'p' is the parent
  // realm's handler. A trap the parent handler does not define behaves as if there were none.
  // (One function body for all of them: this text is compiled for every execution.)
  function trap(name, fallback, needsReserve) {
    return function () {
      var p = this.p;
      var parentTrap = p[name];
      if (needsReserve) reserve();
      try {
        return parentTrap ? apply(parentTrap, p, arguments) : apply(fallback, undefined, arguments);
      } catch (thrown) {
        throw own(thrown);
      }
    };
  }
  var traps = freeze({
    __proto__: null,
    get: trap('get', Reflect.get, false),
    set: trap('set', Reflect.set, false),
    has: trap('has', Reflect.has, false),
    deleteProperty: trap('deleteProperty', Reflect.deleteProperty, false),
    defineProperty: trap('defineProperty', Reflect.defineProperty, false),
    getOwnPropertyDescriptor: trap('getOwnPropertyDescriptor', Reflect.getOwnPropertyDescriptor, false),
    ownKeys: trap('ownKeys', Reflect.ownKeys, false),
    getPrototypeOf: trap('getPrototypeOf', reflectGetPrototypeOf, false),
    setPrototypeOf: trap('setPrototypeOf', Reflect.setPrototypeOf, false),
    isExtensible: trap('isExtensible', Reflect.isExtensible, false),
    preventExtensions: trap('preventExtensions', Reflect.preventExtensions, false),
    apply: trap('apply', apply, true),
    construct: trap('construct', Reflect.construct, true)
  });

  function makeProxy(target, parentHandler) {
    return new ProxyCtor(target, { __proto__: traps, p: parentHandler });
  }

  // A fresh object of this realm to put a proxy on: an arrow function (callable, no 'prototype',
  // no [[Construct]]), an array, or a plain object.
  function shell(kind) {
    return kind === 'function' ? () => {} : (kind === 'array' ? [] : {});
  }

  return freeze({ wrap: wrap, makeProxy: makeProxy, own: own, shell: shell });
})()
`.trim();

/**
 * Source of a statement evaluated in the inner realm: `Symbol.for` refuses keys in the
 * `nodejs.` namespace.
 *
 * The symbol registry is the isolate's, shared with the host, and Node.js looks up some of its
 * own protocols there. `util.inspect` calls the method an object has under
 * `Symbol.for('nodejs.util.inspect.custom')` and passes it the host's own `inspect` function;
 * anything of the host that formats a value of a script (a log line, the printer for an uncaught
 * error) would hand that function to the script. No intrinsic of a fresh realm carries such a
 * key, so a script that cannot ask the registry for one cannot define the method.
 */
export const INNER_REALM_SYMBOL_REGISTRY_SOURCE = `
(function () {
  'use strict';
  var RealmSymbol = Symbol;
  var symbolFor = Symbol.for;
  var RealmString = String;
  var RealmTypeError = TypeError;
  var apply = Reflect.apply;
  var indexOf = String.prototype.indexOf;
  var defineProperty = Object.defineProperty;
  var guardedFor = function (key) {
    if (typeof key === 'symbol') throw new RealmTypeError('Cannot convert a Symbol value to a string');
    var name = typeof key === 'string' ? key : RealmString(key);
    if (apply(indexOf, name, ['nodejs.']) === 0) {
      throw new RealmTypeError('Symbol.for: keys in the "nodejs." namespace are not available in this sandbox');
    }
    return apply(symbolFor, RealmSymbol, [name]);
  };
  defineProperty(guardedFor, 'name', { value: 'for', configurable: true });
  defineProperty(RealmSymbol, 'for', { value: guardedFor, writable: false, enumerable: false, configurable: false });
})();
`.trim();

/**
 * Global names the runtime itself needs in the inner realm when a realm allowlist is in force,
 * whatever the caller's list says: its own script-facing API, the three value globals (which
 * cannot be deleted), and the error constructors that trusted in-realm helpers construct lazily
 * (the computed-key guard, the console factory, `__safe_concat`). Every `__safe_*` and `__ag_*`
 * name the runtime defines is kept as well (see generateSanitizeContextCode).
 */
const REALM_RUNTIME_GLOBALS = [
  'callTool',
  'parallel',
  '__maxIterations',
  'undefined',
  'NaN',
  'Infinity',
  'Error',
  'TypeError',
  'RangeError',
] as const;

/**
 * Source of a statement evaluated in the inner realm when a realm allowlist without `RegExp` is in
 * force: it makes regular expressions unusable there.
 *
 * AgentScript has no regular expressions, and the validator refuses every way to write or run one.
 * This is the runtime half of that rule: `String.prototype.match/matchAll/search` build a RegExp
 * from a STRING argument inside the engine (no `RegExp` binding and no literal needed), and a
 * backtracking pattern run that way is not interruptible work the iteration limit can see.
 * Every regular expression of the realm reaches its matcher through `RegExp.prototype`, so the
 * methods there are replaced by a function that throws, and the prototype is frozen.
 */
const INNER_REALM_REGEX_BACKSTOP_SOURCE = `
(function () {
  'use strict';
  var defineProperty = Object.defineProperty;
  var freeze = Object.freeze;
  var RealmTypeError = TypeError;
  var proto = RegExp.prototype;
  var refuse = () => {
    throw new RealmTypeError('Regular expressions are not available in this sandbox');
  };
  freeze(refuse);
  var keys = ['exec', 'test', 'compile', Symbol.match, Symbol.matchAll, Symbol.replace, Symbol.search, Symbol.split];
  for (var i = 0; i < keys.length; i++) {
    defineProperty(proto, keys[i], { value: refuse, writable: false, configurable: false, enumerable: false });
  }
  freeze(proto);
})()
`.trim();

/**
 * Source of an expression that, evaluated in a pristine realm, yields a function freezing that
 * realm's intrinsics: every constructor, prototype and namespace object the global object names
 * (including the constructors inside namespaces such as `Intl` and `WebAssembly`), and the ones
 * only syntax reaches (generator, async and iterator prototypes, the typed array base). Used for
 * the PARENT realm, right before the script runs.
 *
 * Why: the parent realm's trusted code (the membrane, the tool gate) calls `Object.keys`,
 * `JSON.stringify`, `Array.isArray`, `Reflect.apply`, ... on every operation. A value of the parent
 * realm that reached the script unwrapped used to be enough to replace one of those with a function
 * of the script's, which the trusted code then called with raw objects. A handful of them were
 * pinned after such a report; freezing the objects that hold them covers the ones nobody listed.
 * A method is replaced by writing to the object that holds it, so the method functions themselves
 * are left alone: that keeps this to about two hundred objects per execution.
 *
 * The objects are collected when the expression is evaluated. Only objects of the realm itself
 * are taken from the global object: a value another realm put there (a host bridge) has a
 * prototype chain that never reaches this realm's `Object.prototype`. The global object itself is
 * not frozen. Accessors are never invoked: properties are read as descriptors.
 *
 * It is NOT used for the inner realm: the membrane hands out the methods of the inner realm's safe
 * globals (`Math.max`, `JSON.parse`, ...) as wrapped forwarders, and a Proxy must report the exact
 * value of a frozen target's property, so freezing those objects would unwrap them.
 */
export const REALM_LOCKDOWN_SOURCE = `
(function () {
  'use strict';
  var global = globalThis;
  var freeze = Object.freeze;
  var getPrototypeOf = Object.getPrototypeOf;
  var getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  var getOwnPropertyNames = Object.getOwnPropertyNames;
  var objectPrototype = Object.prototype;
  var targets = [];

  function isReference(value) {
    return value !== null && (typeof value === 'object' || typeof value === 'function');
  }

  function ofThisRealm(value) {
    try {
      var hops = 0;
      for (var current = value; current !== null && hops < 64; current = getPrototypeOf(current)) {
        if (current === objectPrototype) return true;
        hops++;
      }
    } catch (e) {}
    return false;
  }

  function dataValue(object, key) {
    var descriptor = getOwnPropertyDescriptor(object, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  }

  function add(value) {
    if (isReference(value) && value !== global) targets[targets.length] = value;
  }

  // An intrinsic together with what it links to: the prototype it creates instances with, the
  // constructor it names (the only way to GeneratorFunction and its relatives) and its own prototype.
  function addLinked(value) {
    if (!isReference(value)) return;
    add(value);
    add(dataValue(value, 'prototype'));
    add(dataValue(value, 'constructor'));
    add(getPrototypeOf(value));
  }

  var names = getOwnPropertyNames(global);
  for (var i = 0; i < names.length; i++) {
    var value = dataValue(global, names[i]);
    if (!isReference(value) || value === global || !ofThisRealm(value)) continue;
    add(value);
    if (typeof value === 'function') {
      add(dataValue(value, 'prototype'));
    } else {
      // A plain object on the global is a namespace (Intl, WebAssembly, Reflect, Math, ...).
      // The constructors it holds are intrinsics too.
      var members = getOwnPropertyNames(value);
      for (var m = 0; m < members.length; m++) {
        var member = dataValue(value, members[m]);
        if (typeof member !== 'function') continue;
        var memberPrototype = dataValue(member, 'prototype');
        if (isReference(memberPrototype)) {
          add(member);
          add(memberPrototype);
        }
      }
    }
  }

  // Intrinsics that no global names.
  var hidden = [
    function () { return getPrototypeOf(async function () {}); },
    function () { return getPrototypeOf(function* () {}); },
    function () { return getPrototypeOf(async function* () {}); },
    function () { return getPrototypeOf(getPrototypeOf(async function* () {}).prototype); },
    function () { return getPrototypeOf([][Symbol.iterator]()); },
    function () { return getPrototypeOf(''[Symbol.iterator]()); },
    function () { return getPrototypeOf(new Map()[Symbol.iterator]()); },
    function () { return getPrototypeOf(new Set()[Symbol.iterator]()); },
    function () { return getPrototypeOf(''.matchAll(/(?:)/g)); },
    function () { return getPrototypeOf(Int8Array); }
  ];
  for (var h = 0; h < hidden.length; h++) {
    try { addLinked(hidden[h]()); } catch (e) {}
  }

  return function lockdown() {
    for (var t = 0; t < targets.length; t++) {
      try { freeze(targets[t]); } catch (e) {}
    }
    return targets.length;
  };
})()
`.trim();

/**
 * Generate code (run in the PARENT realm, as the last setup step) that removes globals from the
 * inner realm with the realm's own scrub function (see INNER_REALM_SCRUB_SOURCE).
 *
 * - Without a realm allowlist, the dangerous globals of the security level are removed.
 * - With one, EVERY global is removed except the names the runtime defined on the sandbox object
 *   that are on the allowlist or carry a reserved prefix. An allowlisted name the runtime did not
 *   define (the engine's own `console`, say) goes too: what remains is what the runtime put there.
 *
 * Whatever cannot be deleted is shadowed with an `undefined`, read-only property on the sandbox
 * object, which the realm's global lookup consults first. With an allowlist a failure here aborts
 * the execution: a realm that could not be reduced to its allowlist does not run the script.
 */
function generateSanitizeContextCode(securityLevel: SecurityLevel, hasRealmAllowlist: boolean): string {
  const shadow = `__ag_defineProperty(innerContext, left[i], {
        value: undefined,
        writable: false,
        configurable: false,
        enumerable: false
      });`;

  if (hasRealmAllowlist) {
    return `
  (function() {
    var defined = __ag_ReflectOwnKeys(innerContext);
    var keep = ['undefined', 'NaN', 'Infinity'];
    for (var d = 0; d < defined.length; d++) {
      var name = defined[d];
      if (typeof name !== 'string') continue;
      if (__ag_realmAllowed[name] === true || name.indexOf('__safe_') === 0 || name.indexOf('__ag_') === 0) {
        keep.push(name);
      }
    }
    var left = __ag_scrubInnerRealm(null, keep);
    for (var i = 0; i < left.length; i++) {
      ${shadow}
    }
  })();`;
  }

  const globalsToRemove = NODEJS_24_DANGEROUS_GLOBALS[securityLevel];
  return `
  (function() {
    var names = ${JSON.stringify(globalsToRemove)};
    var left;
    try {
      left = __ag_scrubInnerRealm(names, []);
    } catch (e) {
      left = names;
    }
    for (var i = 0; i < left.length; i++) {
      try {
        ${shadow}
      } catch (e) { /* already defined by the runtime under this name */ }
    }
  })();`;
}

/**
 * Generate code for pattern detectors
 */
function generatePatternDetectorsCode(patterns: SerializableSuspiciousPattern[]): string {
  const patternDefs = patterns
    .map(
      (p) => `{
    id: ${JSON.stringify(p.id)},
    description: ${JSON.stringify(p.description)},
    detect: function(operationName, args, history) {
      ${p.detectBody}
    }
  }`,
    )
    .join(',\n    ');

  return `[
    ${patternDefs}
  ]`;
}

/**
 * Generate the parent VM bootstrap script
 *
 * This returns JavaScript code as a string that will be executed
 * inside the parent VM context.
 */
/**
 * `value` as a JavaScript string literal made of ASCII characters only.
 *
 * The bootstrap is ASCII, so the engine stores its source with one byte per character. A single
 * character outside Latin-1 anywhere in the text doubles that, and the engine keeps the source of
 * every script it compiled until several major garbage collections have passed. The script to run
 * is the one part of the bootstrap that can contain any character.
 */
export function asciiStringLiteral(value: string): string {
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/**
 * Source of the statements that define `__safe_concat` and `__safe_template` inside a sandbox
 * realm (the inner realm of the double VM, the one realm of the single VM): the `+` operator
 * and template literals of a transformed script, with memory accounting and reference handling.
 *
 * They are functions OF the realm on purpose. As host or parent-realm functions they would be
 * raw objects of another realm in the script's hands, and a stack overflow inside one would
 * span realms (see INNER_REALM_GUARD_SOURCE). The realm must still have its `Proxy`, `Reflect`
 * and `globalThis` when this runs, and `__host_memory_track__` if memory is accounted for.
 */
export function innerRealmRuntimeSource(params: {
  stackTraceHardeningCode: string;
  allowComposites: boolean;
  memoryLimit: number;
  blockedProperties: readonly string[];
}): string {
  const { stackTraceHardeningCode, allowComposites, memoryLimit, blockedProperties } = params;
  return `
(function() {
${stackTraceHardeningCode}
})();

	(function() {
	  var __ag_Object = Object;
	  var __ag_Reflect = (typeof Reflect !== 'undefined') ? Reflect : null;
	  var __ag_Proxy = (typeof Proxy !== 'undefined') ? Proxy : null;
	  var __ag_WeakMap = (typeof WeakMap !== 'undefined') ? WeakMap : null;
	  var __ag_proxyCache = __ag_WeakMap ? new __ag_WeakMap() : null;

	  // Capture intrinsics before any later global sanitization/proxying.
	  var __ag_String = String;
	  var __ag_ArrayProto = __ag_Object.getPrototypeOf([]);
	  var __ag_refIdPattern = /^__REF_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}__$/i;
  // This pattern keeps its own matcher: where the script may not use regular expressions, the
  // realm's RegExp.prototype methods are replaced afterwards (INNER_REALM_REGEX_BACKSTOP_SOURCE).
  try {
    __ag_Object.defineProperty(__ag_refIdPattern, 'exec', { value: __ag_refIdPattern.exec });
    __ag_Object.defineProperty(__ag_refIdPattern, 'test', { value: __ag_refIdPattern.test });
  } catch (e) {}
  var __ag_allowComposites = ${allowComposites};
  var __ag_memoryLimit = ${memoryLimit};
  var __ag_track = (typeof __host_memory_track__ === 'function') ? __host_memory_track__ : null;

	  // Best-effort secure proxy to block dangerous property access on these runtime helpers.
	  // This mirrors the "constructor/__proto__/prototype" defense-in-depth used elsewhere.
	  var __ag_blocked = new Set(${JSON.stringify(blockedProperties)});
	  function __ag_createSecureProxy(obj, depth) {
	    if (depth === undefined) depth = 0;
	    if (!__ag_Proxy || !__ag_Reflect) return obj;
	    // Fail CLOSED past the recursion backstop: returning the raw target would leak an
	    // unwrapped reference (see MEMBRANE_MAX_RECURSION_DEPTH). Use the hardened safe-error
	    // helper (sanitized stack, nulled constructor/proto) rather than a raw Error.
	    if (depth > ${MEMBRANE_MAX_RECURSION_DEPTH}) {
	      throw __ag_createSafeError('Security violation: secure-proxy recursion depth exceeded.');
	    }
	    if (obj === null || (typeof obj !== 'object' && typeof obj !== 'function')) return obj;

	    if (__ag_proxyCache) {
	      try {
	        var cached = __ag_proxyCache.get(obj);
	        if (cached) return cached;
	      } catch (e) {}
	    }

	    var proxy = new __ag_Proxy(obj, {
	      get: function(target, property, receiver) {
	        var propName = __ag_String(property);
	        if (__ag_blocked.has(propName)) {
	          throw new Error(
	            "Security violation: Access to '" + propName + "' is blocked. " +
            "This property can be used for sandbox escape attacks."
          );
        }
        var value = __ag_Reflect.get(target, property, receiver);
        if (typeof value === 'function') {
          // Bind methods to preserve internal slots when relevant.
          try { value = value.bind(target); } catch (e) {}
          return __ag_createSecureProxy(value, depth + 1);
        }
        // Only objects still need proxying; primitives (e.g. length/name) are inert and must be
        // returned directly, so a deep chain cannot turn a safe primitive read into a
        // recursion-depth error.
        if (value !== null && typeof value === 'object') {
          return __ag_createSecureProxy(value, depth + 1);
        }
        return value;
	      },
	      apply: function(target, thisArg, args) {
	        return __ag_Reflect.apply(target, thisArg, args);
	      },
	      construct: function(target, args, newTarget) {
	        return __ag_Reflect.construct(target, args, newTarget);
	      }
	    });

	    if (__ag_proxyCache) {
	      try {
	        __ag_proxyCache.set(obj, proxy);
	      } catch (e) {}
	    }

	    return proxy;
	  }

  function __ag_createSafeError(message, name) {
    if (name === undefined) name = 'Error';
    var error = new Error(message);
    // NOTE: Use __ag_Object.defineProperty instead of direct assignment because
    // Error.prototype.name is frozen, and in strict mode direct assignment fails.
    try {
      __ag_Object.defineProperty(error, 'name', {
        value: name,
        writable: true,
        enumerable: false,
        configurable: true
      });
    } catch (e) {}
    try {
      var SafeConstructor = __ag_Object.create(null);
      __ag_Object.defineProperties(SafeConstructor, {
        constructor: { value: SafeConstructor, writable: false, enumerable: false, configurable: false },
        prototype: { value: null, writable: false, enumerable: false, configurable: false },
        name: { value: 'SafeError', writable: false, enumerable: false, configurable: false }
      });
      __ag_Object.freeze(SafeConstructor);
      __ag_Object.defineProperty(error, 'constructor', {
        value: SafeConstructor,
        writable: false,
        enumerable: false,
        configurable: false
      });
    } catch (e) {}
    try {
      __ag_Object.defineProperty(error, '__proto__', {
        value: null,
        writable: false,
        enumerable: false,
        configurable: false
      });
    } catch (e) {}
    try {
      __ag_Object.defineProperty(error, 'stack', {
        value: undefined,
        writable: false,
        enumerable: false,
        configurable: false
      });
    } catch (e) {}
    try { __ag_Object.freeze(error); } catch (e) {}
    return error;
  }

  function __ag_innerConcat(left, right) {
    if (typeof left === 'number' && typeof right === 'number') {
      return left + right;
    }

    if (typeof left === 'string' && typeof right === 'string') {
      var leftLen = left.length;
      var rightLen = right.length;

      var leftIsRef = __ag_refIdPattern.test(left);
      var rightIsRef = __ag_refIdPattern.test(right);

      if (!leftIsRef && !rightIsRef) {
        if (__ag_track && __ag_memoryLimit > 0) {
          __ag_track(rightLen * 2);
        }
        return left + right;
      }

      if (!__ag_allowComposites) {
        throw __ag_createSafeError(
          'Cannot concatenate reference IDs. Pass references directly to callTool arguments. ' +
          'Composite handles are disabled in the current security configuration.'
        );
      }

      return {
        __type: 'composite',
        __operation: 'concat',
        __parts: [left, right],
        __estimatedSize: 0
      };
    }

    if (typeof left === 'string' || typeof right === 'string') {
      var leftIsRef2 = typeof left === 'string' && __ag_refIdPattern.test(left);
      var rightIsRef2 = typeof right === 'string' && __ag_refIdPattern.test(right);

      if (leftIsRef2 || rightIsRef2) {
        if (!__ag_allowComposites) {
          throw __ag_createSafeError(
            'Cannot concatenate reference IDs. Pass references directly to callTool arguments. ' +
            'Composite handles are disabled in the current security configuration.'
          );
        }

        var leftStr = __ag_String(left);
        var rightStr = __ag_String(right);
        return {
          __type: 'composite',
          __operation: 'concat',
          __parts: [leftStr, rightStr],
          __estimatedSize: 0
        };
      }
    }

    var result = left + right;
    if (typeof result === 'string' && __ag_track && __ag_memoryLimit > 0) {
      __ag_track(result.length * 2);
    }
    return result;
  }

  function __ag_innerTemplate(quasis) {
    var values = __ag_ArrayProto.slice.call(arguments, 1);
    var parts = [];
    var hasReferences = false;

    for (var i = 0; i < quasis.length; i++) {
      parts.push(quasis[i]);
      if (i < values.length) {
        var valueStr = __ag_String(values[i]);
        parts.push(valueStr);
        if (__ag_refIdPattern.test(valueStr)) {
          hasReferences = true;
        }
      }
    }

    if (!hasReferences) {
      var joined = parts.join('');
      if (typeof joined === 'string' && __ag_track && __ag_memoryLimit > 0) {
        __ag_track(joined.length * 2);
      }
      return joined;
    }

    if (!__ag_allowComposites) {
      throw __ag_createSafeError(
        'Cannot concatenate reference IDs in template literals. Pass references directly to callTool arguments. ' +
        'Composite handles are disabled in the current security configuration.'
      );
    }

    return {
      __type: 'composite',
      __operation: 'concat',
      __parts: parts,
      __estimatedSize: 0
    };
  }

  try {
    __ag_Object.defineProperty(globalThis, '__safe_concat', {
      value: __ag_createSecureProxy(__ag_innerConcat, 0),
      writable: false,
      configurable: false,
      enumerable: false
    });
  } catch (e) {}

  try {
    __ag_Object.defineProperty(globalThis, '__safe_template', {
      value: __ag_createSecureProxy(__ag_innerTemplate, 0),
      writable: false,
      configurable: false,
      enumerable: false
    });
  } catch (e) {}
})();
`.trim();
}

export function generateParentVmBootstrap(options: ParentVmBootstrapOptions): string {
  const {
    userCode,
    innerTimeout,
    maxIterations,
    maxToolCalls,
    toolBridgeMode = 'string',
    toolBridgeMaxPayloadBytes = 5 * 1024 * 1024,
    sanitizeStackTraces,
    securityLevel,
    validationConfig,
    suspiciousPatterns,
    blockedProperties,
    allowComposites = false,
    memoryLimit = 0,
    throwOnBlocked = true,
    maxGlobalFunctionCalls = 1000,
    toolNamespaces = [],
    realmGlobalAllowlist,
  } = options;

  // The limits and switches below are written into the script this function returns. Whatever
  // checked them before, only a finite number or a boolean is: a parameter of any other type is
  // refused here, so that no caller's value can become program text of the bootstrap.
  numericLiteral('innerTimeout', innerTimeout);
  numericLiteral('maxIterations', maxIterations);
  numericLiteral('maxToolCalls', maxToolCalls);
  numericLiteral('toolBridgeMaxPayloadBytes', toolBridgeMaxPayloadBytes);
  numericLiteral('memoryLimit', memoryLimit);
  numericLiteral('maxGlobalFunctionCalls', maxGlobalFunctionCalls);
  booleanLiteral('sanitizeStackTraces', sanitizeStackTraces);
  booleanLiteral('allowComposites', allowComposites);
  booleanLiteral('throwOnBlocked', throwOnBlocked);
  if (toolBridgeMode !== 'string' && toolBridgeMode !== 'direct') {
    throw new TypeError(`Invalid toolBridgeMode: ${String(toolBridgeMode)}`);
  }

  // Realm allowlist: the caller's names plus what the runtime itself needs there. Custom globals
  // are added inside the parent VM (it holds them), so the list is right whoever built it.
  const hasRealmAllowlist = Array.isArray(realmGlobalAllowlist);
  const realmAllowedNames = hasRealmAllowlist
    ? [
        ...new Set([
          ...(realmGlobalAllowlist as readonly string[]),
          ...REALM_RUNTIME_GLOBALS,
          ...toolNamespaces.map((ns) => ns.name),
        ]),
      ]
    : [];

  const sanitizeContextCode = generateSanitizeContextCode(securityLevel, hasRealmAllowlist);
  const patternDetectorsCode = generatePatternDetectorsCode(suspiciousPatterns);

  // Patch code executed inside VM realms to prevent leaking host stack traces via error.stack.
  // We avoid including any file names/paths/line numbers in the formatted stack.
  const stackTraceHardeningCode = `
(function() {
  function __ag_redactStackString(stackStr) {
    try {
      if (typeof stackStr !== 'string' || !stackStr) return 'Error';
      var lines = String(stackStr).split('\\n');
      var header = lines[0] ? String(lines[0]) : 'Error';
      var frameCount = (lines.length > 1) ? (lines.length - 1) : 0;
      var max = frameCount;
      if (max > 25) max = 25;
      var out = [header];
      for (var i = 0; i < max; i++) out.push('    at [REDACTED]');
      if (frameCount > max) out.push('    at [REDACTED]');
      return out.join('\\n');
    } catch (e) {
      return 'Error';
    }
  }

  function __ag_prepareStackTrace(err, stack) {
    try {
      var name = (err && err.name) ? String(err.name) : 'Error';
      var message = (err && err.message) ? String(err.message) : '';
      var header = message ? (name + ': ' + message) : name;
      if (!stack || !stack.length) return header;
      var lines = [header];
      var max = stack.length;
      if (max > 25) max = 25;
      for (var i = 0; i < max; i++) {
        lines.push('    at [REDACTED]');
      }
      if (stack.length > max) {
        lines.push('    at [REDACTED]');
      }
      return lines.join('\\n');
    } catch (e) {
      return 'Error';
    }
  }

  function __ag_lockStackGetter(proto) {
    if (!proto) return;
    try {
      var desc = Object.getOwnPropertyDescriptor(proto, 'stack');
      if (!desc || typeof desc.get !== 'function') return;
      var origGet = desc.get;
      var origSet = desc.set;
      Object.defineProperty(proto, 'stack', {
        get: function() {
          try {
            return __ag_redactStackString(origGet.call(this));
          } catch (e) {
            return 'Error';
          }
        },
        set: function(v) {
          try {
            if (typeof origSet === 'function') return origSet.call(this, v);
          } catch (e) {}
        },
        configurable: false,
        enumerable: false
      });
    } catch (e) {}
  }

  function __ag_lockPrepareStackTrace(ErrCtor) {
    if (!ErrCtor) return;
    try {
      Object.defineProperty(ErrCtor, 'prepareStackTrace', {
        value: __ag_prepareStackTrace,
        writable: false,
        configurable: false,
        enumerable: false
      });
    } catch (e) {}
    try {
      Object.defineProperty(ErrCtor, 'stackTraceLimit', {
        value: 25,
        writable: false,
        configurable: false,
        enumerable: false
      });
    } catch (e) {}
  }

  // Each one on its own: this code also runs at the start of the script itself, where a realm
  // reduced to its allowlist no longer has a binding for most of these names.
  try { __ag_lockStackGetter(Error.prototype); } catch (e) {}
  try { __ag_lockPrepareStackTrace(Error); } catch (e) {}
  try { __ag_lockPrepareStackTrace(EvalError); } catch (e) {}
  try { __ag_lockPrepareStackTrace(RangeError); } catch (e) {}
  try { __ag_lockPrepareStackTrace(ReferenceError); } catch (e) {}
  try { __ag_lockPrepareStackTrace(SyntaxError); } catch (e) {}
  try { __ag_lockPrepareStackTrace(TypeError); } catch (e) {}
  try { __ag_lockPrepareStackTrace(URIError); } catch (e) {}
  try { __ag_lockPrepareStackTrace(AggregateError); } catch (e) {}
})();
`.trim();
  const stackTraceHardeningCodeJson = JSON.stringify(stackTraceHardeningCode);

  // Detect and report code-generation attempts (Function/eval) even if user code catches the thrown error.
  // Used to fail closed in STRICT/SECURE modes.
  const codeGenViolationDetectorCode = `
(function() {
  var __ag_report = (typeof __ag_reportViolation__ === 'function') ? __ag_reportViolation__ : null;
  function __ag_reportOnce(kind) {
    try {
      if (__ag_report) __ag_report(kind);
    } catch (e) {}
  }

  var __ag_Reflect = (typeof Reflect !== 'undefined') ? Reflect : null;
  var __ag_Proxy = (typeof Proxy !== 'undefined') ? Proxy : null;
  var __ag_Object = (typeof Object !== 'undefined') ? Object : null;

  function __ag_wrapCtor(Ctor, kind) {
    if (!Ctor || !__ag_Proxy || !__ag_Reflect || !__ag_Object) return;
    try {
      var proxy = new __ag_Proxy(Ctor, {
        apply: function(target, thisArg, args) {
          __ag_reportOnce(kind);
          return __ag_Reflect.apply(target, thisArg, args);
        },
        construct: function(target, args, newTarget) {
          __ag_reportOnce(kind);
          return __ag_Reflect.construct(target, args, newTarget);
        }
      });

      try {
        if (Ctor.prototype) {
          __ag_Object.defineProperty(Ctor.prototype, 'constructor', {
            value: proxy,
            writable: false,
            configurable: false,
            enumerable: false
          });
        }
      } catch (e) {}
    } catch (e) {}
  }

  try { __ag_wrapCtor(Function, 'CODE_GENERATION'); } catch (e) {}
  try { __ag_wrapCtor((async function(){}).constructor, 'CODE_GENERATION'); } catch (e) {}
  try { __ag_wrapCtor((function*(){}).constructor, 'CODE_GENERATION'); } catch (e) {}
  try { __ag_wrapCtor((async function*(){}).constructor, 'CODE_GENERATION'); } catch (e) {}
})();
`.trim();
  const codeGenViolationDetectorCodeJson = JSON.stringify(codeGenViolationDetectorCode);

  // Define __safe_concat/__safe_template inside the INNER VM realm.
  //
  // Why: when `__safe_concat` is a host/parent-realm function (injected into the inner context),
  // stack-overflow errors can span multiple realms and Node/V8 may bypass Error.prepareStackTrace
  // formatting entirely, leaking internal filenames like "parent-vm.js" into user-accessible stacks.
  //
  // By defining these helpers inside the inner realm, stack overflows stay within the inner realm
  // and our stack-trace hardening can reliably redact frames.
  const innerRealmSafeConcatAndTemplateCode = innerRealmRuntimeSource({
    stackTraceHardeningCode,
    allowComposites,
    memoryLimit,
    blockedProperties,
  });
  const innerRealmSafeConcatAndTemplateCodeJson = JSON.stringify(innerRealmSafeConcatAndTemplateCode);

  // Generate allowed/blocked pattern reconstruction code
  let patternReconstructCode = '';
  if (validationConfig.allowedOperationPatternSource) {
    patternReconstructCode += `
  const allowedOperationPattern = new RegExp(${JSON.stringify(
    validationConfig.allowedOperationPatternSource,
  )}, ${JSON.stringify(validationConfig.allowedOperationPatternFlags || '')});
`;
  }

  if (validationConfig.blockedOperationPatternSources && validationConfig.blockedOperationPatternSources.length > 0) {
    const blockedPatterns = validationConfig.blockedOperationPatternSources
      .map(
        (src, i) =>
          `new RegExp(${JSON.stringify(src)}, ${JSON.stringify(
            validationConfig.blockedOperationPatternFlags?.[i] || '',
          )})`,
      )
      .join(', ');
    patternReconstructCode += `
  const blockedOperationPatterns = [${blockedPatterns}];
`;
  }

  return `
'use strict';

// Parent VM Bootstrap Script
// This code runs inside the Parent VM and creates/manages the Inner VM

  (async function parentVmMain() {
    // The script to run. It is the first thing in this text so that the bootstraps of two
    // different scripts differ near their start: the engine's compilation cache compares a new
    // source with the sources of the same length it still holds, character by character.
    var userCode = ${asciiStringLiteral(userCode)};

    // This realm captures no stack traces (see ../realm-stack). First, before any error is made.
    ${STACK_CAPTURE_OFF_SOURCE}

    // Get injected references from host
    const vm = __host_vm_module__;
    const hostCallTool = __host_callTool__;
    const hostStats = __host_stats__;
    const hostAbortCheck = __host_abort_check__;
    const hostReportViolation = __host_reportViolation__;
    const hostConfig = __host_config__;
    const hostMemoryTrack = typeof __host_memory_track__ === 'function' ? __host_memory_track__ : function(){};
    const hostInvokeGlobal = typeof __host_invokeGlobal__ === 'function' ? __host_invokeGlobal__ : null;
    const hostIsBuiltinMethod = typeof __host_isBuiltinMethod__ === 'function' ? __host_isBuiltinMethod__ : function() { return false; };
    // Fail closed without the classifier: every built-in method of host data counts as mutating.
    const hostIsMutatingBuiltin = typeof __host_isMutatingBuiltin__ === 'function' ? __host_isMutatingBuiltin__ : function() { return true; };
    const hostConsoleSink = typeof __host_consoleSink__ === 'function' ? __host_consoleSink__ : null;
    // Writes one line to the host console at a level. The host console OBJECT is never in this realm.
    const hostConsoleWrite = typeof __host_console_write__ === 'function' ? __host_console_write__ : function() {};
    const toolBridgeMode = ${JSON.stringify(toolBridgeMode)};
    const toolBridgeMaxPayloadBytes = ${toolBridgeMaxPayloadBytes};

    // Defense-in-depth: remove direct access to host bridge references after capture.
    // If the inner VM escapes to the parent global, these names should not be discoverable.
    try { delete globalThis.__host_callTool__; } catch (e) { /* ignore */ }
    try { delete globalThis.__host_vm_module__; } catch (e) { /* ignore */ }
    try { delete globalThis.__host_stats__; } catch (e) { /* ignore */ }
    try { delete globalThis.__host_abort_check__; } catch (e) { /* ignore */ }
    try { delete globalThis.__host_reportViolation__; } catch (e) { /* ignore */ }
    try { delete globalThis.__host_config__; } catch (e) { /* ignore */ }
    try { delete globalThis.__host_memory_track__; } catch (e) { /* ignore */ }
    try { delete globalThis.__host_invokeGlobal__; } catch (e) { /* ignore */ }
    try { delete globalThis.__host_isBuiltinMethod__; } catch (e) { /* ignore */ }
    try { delete globalThis.__host_isMutatingBuiltin__; } catch (e) { /* ignore */ }
    try { delete globalThis.__host_consoleSink__; } catch (e) { /* ignore */ }
    try { delete globalThis.__host_console_write__; } catch (e) { /* ignore */ }

    // The function that freezes this realm's intrinsics right before the script runs (see
    // REALM_LOCKDOWN_SOURCE). Built now, while the realm is pristine and the host bridges are
    // already off its global.
    const __ag_lockdownParentRealm = ${REALM_LOCKDOWN_SOURCE};

    // Policy violation reporter (best-effort; host decides how to handle based on security level)
    function __ag_reportViolation(kind) {
      try {
        if (typeof hostReportViolation === 'function') hostReportViolation(kind);
    } catch (e) { /* ignore */ }
  }

  // SECURITY HARDENING: prevent leaking host stack traces via error.stack inside the sandbox.
  const sanitizeStackTraces = ${sanitizeStackTraces};
  if (sanitizeStackTraces) {
    try {
      // Patch the PARENT VM realm (errors thrown from safe runtime functions).
      // Note: we execute code directly here, and separately apply the same patch to the INNER VM.
      ${stackTraceHardeningCode}
    } catch (e) { /* ignore */ }
  }

  // SECURITY (GHSA-3279): pin pristine intrinsics BEFORE any sandbox code runs, so the membrane
  // traps and the error hardening below never re-read a realm global the sandbox can overwrite.
  // The reported escape replaced Object.getOwnPropertyDescriptor with a hook; the get trap then
  // called it and handed the attacker the RAW target of a membrane proxy (the host Promise from
  // callTool), reaching the host Function constructor. The same gadget aimed at the Object.*
  // mutators below would let an attacker observe safe-error construction or defeat the final
  // freeze, leaving the returned error with a live prototype and constructor chain. Using
  // captured references makes a later monkeypatch a no-op.
  const __ag_getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const __ag_defineProperty = Object.defineProperty;
  const __ag_defineProperties = Object.defineProperties;
  const __ag_setPrototypeOf = Object.setPrototypeOf;
  const __ag_objectCreate = Object.create;
  const __ag_ParentProxy = Proxy;
  const __ag_objectFreeze = Object.freeze;
  const __ag_ReflectGet = Reflect.get;
  const __ag_ReflectSet = Reflect.set;
  const __ag_ReflectDefineProperty = Reflect.defineProperty;
  const __ag_ReflectGetOwnPropertyDescriptor = Reflect.getOwnPropertyDescriptor;
  const __ag_ReflectOwnKeys = Reflect.ownKeys;
  const __ag_ReflectApply = Reflect.apply;
  const __ag_ReflectHas = Reflect.has;
  const __ag_ReflectDeleteProperty = Reflect.deleteProperty;
  const __ag_ReflectGetPrototypeOf = Reflect.getPrototypeOf;
  const __ag_ArrayIsArray = Array.isArray;
  const __ag_hasOwnProperty = Object.prototype.hasOwnProperty;
  const __ag_Promise = Promise;

  /**
   * Creates a "safe" error object that cannot be used to escape the sandbox.
   *
   * SECURITY: This function creates error objects with a severed prototype chain
   * to prevent attacks that climb the prototype chain to reach the host Function constructor.
   * It also removes the stack trace to prevent information leakage (Vector 1230).
   *
   * Attack vectors blocked:
   * - err.constructor.constructor('return process.env.SECRET')()
   * - err.__proto__.constructor.constructor('malicious code')()
   * - err.stack leaking internal function frames and file paths (Vector 1230)
   */
  // Unique symbol-like marker for identifying safe errors (not a real Symbol to avoid sandbox escape)
  var SAFE_ERROR_MARKER = '__enclave_safe_error_' + Math.random().toString(36).slice(2);

  // Every error createSafeError built. The membrane lets these through as they are; a script
  // can copy the marker property onto an object of its own, but cannot add it to this set.
  const safeErrors = new WeakSet();

  function createSafeError(message, name) {
    if (name === undefined) name = 'Error';

    // Create the real error
    var error = new Error(message);
    // NOTE: Use Object.defineProperty instead of direct assignment because
    // Error.prototype.name is frozen, and in strict mode direct assignment fails.
    __ag_defineProperty(error, 'name', {
      value: name,
      writable: true,
      enumerable: false,
      configurable: true
    });

    // CRITICAL: sever the *actual* prototype chain (native getters / Object.getPrototypeOf).
    // A shadowing __proto__ data property is not sufficient.
    __ag_setPrototypeOf(error, null);

    // Create a null-prototype object to use as a safe "constructor"
    // This object has no prototype chain to climb
    var SafeConstructor = __ag_objectCreate(null);
    __ag_defineProperties(SafeConstructor, {
      // Make constructor point to itself to break the chain
      constructor: {
        value: SafeConstructor,
        writable: false,
        enumerable: false,
        configurable: false
      },
      // Block prototype access
      prototype: {
        value: null,
        writable: false,
        enumerable: false,
        configurable: false
      },
      // Add name for debugging
      name: {
        value: 'SafeError',
        writable: false,
        enumerable: false,
        configurable: false
      }
    });
    __ag_objectFreeze(SafeConstructor);

    // Override the constructor property on the error instance
    // This breaks the prototype chain: err.constructor.constructor no longer reaches Function
    __ag_defineProperty(error, 'constructor', {
      value: SafeConstructor,
      writable: false,
      enumerable: false,
      configurable: false
    });

    // SECURITY: Override __proto__ on the error instance to prevent prototype chain escape
    // Attack vector blocked: err.__proto__.constructor.constructor('malicious code')()
    __ag_defineProperty(error, '__proto__', {
      value: null,
      writable: false,
      enumerable: false,
      configurable: false
    });

    // SECURITY: Remove the stack property to prevent information leakage (Vector 1230)
    // The stack trace can reveal internal implementation details like function names,
    // file paths, and line numbers which can be used for reconnaissance attacks.
    __ag_defineProperty(error, 'stack', {
      value: undefined,
      writable: false,
      enumerable: false,
      configurable: false
    });

    // Add a unique marker to identify this as a safe error from our runtime
    // This is used by suspicious pattern detection to distinguish our errors from user errors
    __ag_defineProperty(error, SAFE_ERROR_MARKER, {
      value: true,
      writable: false,
      enumerable: false,
      configurable: false
    });

    // Freeze the error to prevent modifications
    __ag_objectFreeze(error);

    safeErrors.add(error);
    return error;
  }

  // Helper to check if an error is a safe error from our runtime
  function isSafeError(e) {
    return e && e[SAFE_ERROR_MARKER] === true;
  }

  // Validation configuration
  const validationConfig = ${JSON.stringify({
    validateOperationNames: validationConfig.validateOperationNames,
    maxOperationsPerSecond: validationConfig.maxOperationsPerSecond,
    blockSuspiciousSequences: validationConfig.blockSuspiciousSequences,
    rapidEnumerationThreshold: validationConfig.rapidEnumerationThreshold,
    rapidEnumerationOverrides: validationConfig.rapidEnumerationOverrides,
  })};
  ${patternReconstructCode}

  // Suspicious pattern detectors
  const suspiciousPatterns = ${patternDetectorsCode};

  // Operation history for pattern detection
  const operationHistory = [];

  // Tool call stats for rate limiting
  let toolCallCount = 0;

  // Calls into host functions passed in globals: counted against their own cap, and their
  // timestamps share the operation rate limit with tool calls. They are not recorded in
  // operationHistory, so the tool-call suspicious-sequence detectors only see tool calls.
  let globalFunctionCallCount = 0;
  const globalFunctionCallTimes = [];

  // Fail-closed: every call into a host function goes through the gate, except the built-in
  // prototype methods of host data (Array.prototype.map, iterators, Date methods, ...), which
  // the get trap binds and records here so data globals keep working as before.
  const ungatedHostFunctions = new WeakSet();

  // Errors that report a failure of the tool itself (the handler threw, or its result could not
  // be delivered), as opposed to a refusal by the enclave. callTool(..., { throwOnError: false })
  // turns only these into { success: false, error } results. Keyed by the safe error thrown.
  const toolFailures = new WeakMap();

  // Blocked properties for secure proxy (from security level)
  const blockedPropertiesSet = new Set(${JSON.stringify(blockedProperties)});

  // Whether to throw errors instead of returning undefined for blocked properties
  const throwOnBlocked = ${throwOnBlocked};
  const hostRegExpMessage = ${JSON.stringify(HOST_REGEXP_MESSAGE)};

  // Whether composite reference handles are allowed (for string concatenation)
  const allowComposites = ${allowComposites};

  // Memory limit in bytes (0 = unlimited)
  const memoryLimit = ${memoryLimit};

  // Reference ID pattern for detecting sidecar references
  const refIdPattern = /^__REF_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}__$/i;

  // Proxy caches to avoid infinite recursion and duplicate wrapping. Host-owned values are
  // cached separately from realm-owned ones because the two use different blocking rules.
  const proxyCache = new WeakMap();
  const hostProxyCache = new WeakMap();

  // SECURITY (function realm): the engine resolves a callable's realm by looking THROUGH Proxy
  // and bound-function layers to the innermost function (GetFunctionRealm). That realm then owns
  // objects the engine creates on the callable's behalf: the resolving functions a thenable job
  // passes to a 'then' (await { then: f }), and the fallback prototype of
  // Reflect.construct(X, args, f). A membrane Proxy whose target chain ends at a HOST function
  // (a custom global, a method of a host promise, a bound host method) therefore made the engine
  // create HOST-realm functions and hand them to sandbox code, which wrapped the membrane proxy
  // in its own Proxy with an apply trap to receive them. A raw host function reaches the host
  // Function constructor, the only one with code generation enabled.
  //
  // So no callable handed to the sandbox may have a host function anywhere in its target chain:
  // - a callable is proxied over a fresh INNER-realm shell (see createSecureProxy); the real
  //   function is only ever reached from the traps, which close over it;
  // - a method read off an object is a forwarder closure, never Function.prototype.bind (a bound
  //   function keeps its target's realm);
  // - a host promise is adopted into a promise of this realm before it is wrapped
  //   (see adoptHostPromise), so its methods are this realm's.
  // The only callables proxied directly are the constructors registered here, which need the
  // construct and 'prototype' behavior of a real target and belong to this sandbox's realms.
  const realmOwnedCallables = new WeakSet();

  // Forwarder -> the method it calls, so 'length' and 'name' still describe the method.
  const forwardedMethods = new WeakMap();

  // Forwarders for the built-in methods of PARENT-realm objects (an array Object.keys built, a
  // promise of this realm). What such a method passes to a script callback is a raw object of
  // this realm, so their callbacks are guarded (see guardCallbacksForRealm).
  const parentRealmMethods = new WeakSet();

  // Every proxy createSecureProxy made. (The proxy caches cannot answer "is this a membrane
  // proxy": they are keyed by the wrapped originals as well.)
  const membraneProxies = new WeakSet();

  // The inner half of the membrane, set as soon as the inner realm exists.
  var __ag_innerMembrane = null;

  /**
   * A function that calls 'method' on 'holder', as 'method.bind(holder)' would, but as a closure
   * of this realm rather than a bound function that keeps the realm of 'method'.
   */
  function createMethodForwarder(method, holder) {
    var forwarder = (...args) => __ag_ReflectApply(method, holder, args);
    forwardedMethods.set(forwarder, method);
    return forwarder;
  }

  /**
   * Settle a promise of this realm the way a HOST promise settles, so the sandbox never holds
   * the host promise (whose 'then', 'catch' and 'finally' are host functions). A rejection
   * reason is a host value like any other, so it goes through launderThrown.
   */
  function adoptHostPromise(hostPromise) {
    return new __ag_Promise(function(resolve, reject) {
      hostPromise.then(resolve, function(reason) {
        reject(launderThrown(reason));
      });
    });
  }

  // Host bridge calls that have not been started yet (see deferHostCall).
  const pendingHostCalls = [];
  var hostCallsScheduled = false;

  function startPendingHostCalls() {
    hostCallsScheduled = false;
    var calls = pendingHostCalls.splice(0, pendingHostCalls.length);
    for (var i = 0; i < calls.length; i++) {
      var call = calls[i];
      try {
        call.start().then(call.resolve, call.reject);
      } catch (thrown) {
        call.reject(thrown);
      }
    }
  }

  /**
   * A promise of this realm for the result of a call into the host's tool bridge, with the call
   * itself made from a microtask instead of from where the script is.
   *
   * A script can call a tool with the stack nearly full. Started there, the host's async bridge
   * failed halfway and returned a rejected HOST promise, and Node.js, whose own bookkeeping of
   * rejections is JavaScript that needs stack too, kept that rejection listed as unhandled: the
   * host process ended. From a microtask the bridge always starts on an empty stack, and at the
   * script's depth nothing of the host runs and no host promise exists.
   *
   * 'start' returns the host promise; 'onRejected' turns its rejection reason into what the
   * script may see.
   */
  function deferHostCall(start, onRejected) {
    return new __ag_Promise(function(resolve, reject) {
      // Scheduled before it is queued: if this cannot finish because the stack is full, nothing
      // is left in the queue for a later flush to start on the script's behalf.
      if (!hostCallsScheduled) {
        __ag_Promise.resolve().then(startPendingHostCalls);
        hostCallsScheduled = true;
      }
      pendingHostCalls[pendingHostCalls.length] = {
        start: start,
        resolve: resolve,
        reject: function(reason) { reject(onRejected(reason)); }
      };
    });
  }

  /**
   * Whether a value was created by script code: its prototype chain passes through the inner
   * realm's Object.prototype. A script Proxy answers for itself here, which is fine: whatever
   * it claims, it is still a script value.
   */
  function belongsToInnerRealm(value) {
    var proto = value;
    for (var i = 0; i < 64; i++) {
      try {
        proto = __ag_ReflectGetPrototypeOf(proto);
      } catch (e) {
        return false;
      }
      if (proto === null) return false;
      if (proto === innerObjectPrototype) return true;
    }
    return false;
  }

  /**
   * What a script may catch. A value thrown while the membrane works on a host or parent-realm
   * object (a TypeError raised inside a host built-in, an error from a host getter) is an
   * object of that realm with a live prototype chain: handing it to a catch block is the same
   * leak as handing out the object it came from. Only primitives, safe errors, values already
   * behind the membrane and the script's own objects pass; anything else is reduced to a safe
   * error carrying its name and message.
   */
  function launderThrown(thrown) {
    if (thrown === null || (typeof thrown !== 'object' && typeof thrown !== 'function')) {
      return thrown;
    }
    if (safeErrors.has(thrown) || membraneProxies.has(thrown) || belongsToInnerRealm(thrown)) {
      return thrown;
    }
    var name = 'Error';
    var message = 'Operation failed';
    try {
      var rawName = __ag_ReflectGet(thrown, 'name');
      if (typeof rawName === 'string' && rawName) name = rawName;
    } catch (e) { /* keep the default */ }
    try {
      var rawMessage = __ag_ReflectGet(thrown, 'message');
      if (typeof rawMessage === 'string') message = rawMessage;
    } catch (e) { /* keep the default */ }
    return createSafeError(message, name);
  }

  /**
   * Wrap a membrane trap so that nothing it throws reaches the script without going through
   * launderThrown.
   */
  function guarded(trap) {
    return function() {
      try {
        return __ag_ReflectApply(trap, this, arguments);
      } catch (thrown) {
        throw launderThrown(thrown);
      }
    };
  }

  /**
   * A value a host built-in hands to script code (an array element, a Map value, the array
   * itself). The script's own values and values already behind the membrane are passed as they
   * are; a raw host object is wrapped as host-owned.
   */
  function toSandboxValue(value) {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
      return value;
    }
    // An argument guard on its way back is the script's own value again.
    if (guardedHostArguments.has(value)) {
      return guardedHostArguments.get(value);
    }
    if (membraneProxies.has(value) || belongsToInnerRealm(value)) {
      return value;
    }
    return createSecureProxy(value, 0, true);
  }

  /**
   * Arguments for a built-in method of host data. Such a method runs in the host's realm, and
   * whatever of the script it calls, it calls with the host's own values:
   *
   * - a callback (map, forEach, sort, find, ...) receives the elements, the index and the
   *   collection itself: each callback is replaced by one that receives them wrapped;
   * - a method of an object argument (the set operations ask the other collection has(element)
   *   for each element of the receiver): the object is replaced by a guard, see
   *   guardObjectForHost.
   */
  function guardCallbacksForHost(args) {
    var guardedArgs = [];
    for (var i = 0; i < args.length; i++) {
      guardedArgs[i] = guardArgumentForHost(args[i]);
    }
    return guardedArgs;
  }

  function guardArgumentForHost(value) {
    if (typeof value === 'function') {
      return guardedHostArguments.has(value) ? value : guardCallbackForHost(value);
    }
    return guardObjectForHost(value);
  }

  function guardCallbackForHost(callback) {
    return (...hostArgs) => {
      for (var i = 0; i < hostArgs.length; i++) {
        hostArgs[i] = toSandboxValue(hostArgs[i]);
      }
      return __ag_ReflectApply(callback, undefined, hostArgs);
    };
  }

  // The guard of an object of the script, and what each guard stands for (so that a guard a
  // built-in hands back, as an element of its result say, is the script's own value again).
  const hostArgumentGuards = new WeakMap();
  const guardedHostArguments = new WeakMap();

  /**
   * An object of the script on its way into a built-in method of host data.
   *
   * The built-in may look up a method on it and call that method with host values. So it gets a
   * guard instead: an object of this realm that answers every property read from the script's
   * object, with a function member replaced by one that passes its arguments through
   * toSandboxValue (and keeps the script's object as its receiver), and an object member or
   * result guarded the same way. Its own properties are listed as they are, so a built-in that
   * copies or serializes the object sees the same data. An array is data to every built-in and
   * is passed as it is, as is a value that is behind the membrane already.
   */
  function guardObjectForHost(value) {
    if (value === null || typeof value !== 'object') {
      return value;
    }
    if (membraneProxies.has(value) || guardedHostArguments.has(value) || __ag_ArrayIsArray(value)) {
      return value;
    }
    var existing = hostArgumentGuards.get(value);
    if (existing) {
      return existing;
    }
    // Over an empty object of this realm, not over the script's object: a frozen member of the
    // target would have to be reported as it is (proxy invariant), unguarded.
    var guard = new __ag_ParentProxy(__ag_objectCreate(null), {
      get: function(_shell, property) {
        return guardMemberForHost(__ag_ReflectGet(value, property, value), value);
      },
      has: function(_shell, property) {
        return __ag_ReflectHas(value, property);
      },
      // A built-in that lists the object (to copy or to serialize it) sees the script's own
      // properties, each as a data property holding what a read of it gives.
      ownKeys: function() {
        return __ag_ReflectOwnKeys(value);
      },
      getOwnPropertyDescriptor: function(_shell, property) {
        var descriptor = __ag_ReflectGetOwnPropertyDescriptor(value, property);
        if (!descriptor) {
          return undefined;
        }
        return {
          value: guardMemberForHost(__ag_ReflectGet(value, property, value), value),
          writable: true,
          enumerable: descriptor.enumerable === true,
          configurable: true
        };
      },
      // What a built-in stores in the object is a host value like any other.
      set: function(_shell, property, stored) {
        return __ag_ReflectSet(value, property, toSandboxValue(stored), value);
      }
    });
    hostArgumentGuards.set(value, guard);
    guardedHostArguments.set(guard, value);
    return guard;
  }

  function guardMemberForHost(member, holder) {
    if (typeof member !== 'function') {
      return guardObjectForHost(member);
    }
    var method = function() {
      var hostArgs = [];
      for (var i = 0; i < arguments.length; i++) {
        hostArgs[i] = toSandboxValue(arguments[i]);
      }
      return guardArgumentForHost(__ag_ReflectApply(member, holder, hostArgs));
    };
    guardedHostArguments.set(method, member);
    return method;
  }

  /**
   * A value of THIS realm on its way into script code. Objects created here (the arrays that
   * Object.keys and Object.entries build, a promise of this realm) are not the script's and not
   * the host's; unwrapped, each is a raw parent-realm object with a live prototype chain.
   * Primitives, the script's own values, safe errors and values already behind the membrane
   * pass as they are.
   */
  function toScriptValue(value) {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
      return value;
    }
    if (membraneProxies.has(value) || safeErrors.has(value) || belongsToInnerRealm(value)) {
      return value;
    }
    return createSecureProxy(value, 0, false);
  }

  /**
   * Arguments for a built-in method of a parent-realm object (see parentRealmMethods). Such a
   * method (forEach, map, sort, reduce, then, ...) calls a script callback with the elements and
   * with the collection itself: each callback is replaced by one that receives them through
   * toScriptValue. The callback keeps its receiver, and what it returns goes back unchanged.
   */
  function guardCallbacksForRealm(args) {
    var guardedArgs = [];
    for (var i = 0; i < args.length; i++) {
      guardedArgs[i] = typeof args[i] === 'function' ? guardCallbackForRealm(args[i]) : args[i];
    }
    return guardedArgs;
  }

  function guardCallbackForRealm(callback) {
    return function() {
      var realmArgs = [];
      for (var i = 0; i < arguments.length; i++) {
        realmArgs[i] = toScriptValue(arguments[i]);
      }
      return __ag_ReflectApply(callback, toScriptValue(this), realmArgs);
    };
  }

  // SECURITY (a function of the script on a value of this realm): a script can store a function
  // of its own on a value of THIS realm that it holds behind the membrane (a tool result, the
  // array a built-in made, a promise), as a property, a getter or a setter. Whoever finds the
  // function there calls it: the script through the membrane, but also a built-in of this realm
  // that works on the raw value (a conversion looks up toString, a read runs a getter), and that
  // built-in calls it with the raw value as its receiver. So what is stored on the raw value is
  // never the script's function but a guard of this realm that calls it with what the script may
  // hold (see guardCallbackForRealm), and a read through the membrane gives the script its own
  // function back.
  const scriptFunctionGuards = new WeakMap();
  const guardedScriptFunctions = new WeakMap();

  function isScriptFunction(value) {
    return typeof value === 'function' && !membraneProxies.has(value) && belongsToInnerRealm(value);
  }

  function guardScriptFunction(fn) {
    var existing = scriptFunctionGuards.get(fn);
    if (existing) {
      return existing;
    }
    var guard = guardCallbackForRealm(fn);
    scriptFunctionGuards.set(fn, guard);
    guardedScriptFunctions.set(guard, fn);
    return guard;
  }

  /**
   * Whether a value is a raw object or function of this realm: not a primitive, not the script's
   * own, not a safe error and not behind the membrane already.
   */
  function isRawRealmReference(value) {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
      return false;
    }
    return !membraneProxies.has(value) && !safeErrors.has(value) && !belongsToInnerRealm(value);
  }

  /**
   * The descriptor to apply when a script defines a property on a value of this realm.
   *
   * - A function of the script (the value, the getter or the setter) is stored as its guard.
   * - A data property that ends up neither configurable nor writable is pinned: the language
   *   requires every later read through a Proxy to answer with exactly what is stored. What is
   *   stored then is the membrane's own answer for the value (its proxy), so that freezing or
   *   sealing a value does not turn its nested values into raw objects of this realm.
   */
  function descriptorForRealmValue(obj, property, descriptor, depth) {
    if (descriptor === null || typeof descriptor !== 'object') {
      return descriptor;
    }
    var next = {};
    var fields = ['value', 'get', 'set', 'writable', 'enumerable', 'configurable'];
    for (var f = 0; f < fields.length; f++) {
      if (fields[f] in descriptor) next[fields[f]] = descriptor[fields[f]];
    }
    if (isScriptFunction(next.value)) next.value = guardScriptFunction(next.value);
    if (isScriptFunction(next.get)) next.get = guardScriptFunction(next.get);
    if (isScriptFunction(next.set)) next.set = guardScriptFunction(next.set);

    if ('get' in next || 'set' in next) {
      return next;
    }
    var current = __ag_getOwnPropertyDescriptor(obj, property);
    var currentIsData = !!current && 'value' in current;
    if (current && !currentIsData && !('value' in next) && !('writable' in next)) {
      // Stays an accessor
      return next;
    }
    if (currentIsData && !current.configurable && !current.writable) {
      // Pinned already: nothing can be stored in its place
      return next;
    }
    var configurable = 'configurable' in next ? next.configurable : (current ? current.configurable : false);
    var writable = 'writable' in next ? next.writable : (currentIsData ? current.writable : false);
    if (!configurable && !writable) {
      var pinned = 'value' in next ? next.value : (currentIsData ? current.value : undefined);
      if (isRawRealmReference(pinned)) {
        next.value = createSecureProxy(pinned, depth + 1, false);
      }
    }
    return next;
  }

  /**
   * An object of this realm on its way behind the membrane: a function of the script that a
   * built-in of this realm stored in it by name (Object.fromEntries, Object.groupBy) is replaced
   * by its guard, as the membrane does for a function the script stores there itself. An array
   * holds its items by index, which no built-in calls as a method of the array.
   */
  function guardScriptFunctionsOf(obj) {
    var keys;
    try {
      keys = __ag_ReflectOwnKeys(obj);
    } catch (e) {
      return;
    }
    for (var k = 0; k < keys.length; k++) {
      var own = __ag_getOwnPropertyDescriptor(obj, keys[k]);
      if (!own || !('value' in own) || !own.writable || !isScriptFunction(own.value)) continue;
      try {
        obj[keys[k]] = guardScriptFunction(own.value);
      } catch (e) { /* left as it is */ }
    }
  }

  /**
   * The result of a built-in method of host data. An array (map, filter, slice, concat, ...) is
   * copied into an array of this realm, so the script can sort or extend what it derived
   * without that being a write to a host object; its elements stay wrapped. Anything else is
   * wrapped as host-owned.
   */
  function wrapHostBuiltinResult(result) {
    if (result === null || (typeof result !== 'object' && typeof result !== 'function')) {
      return result;
    }
    if (guardedHostArguments.has(result)) {
      result = guardedHostArguments.get(result);
    }
    if (membraneProxies.has(result)) {
      return result;
    }
    if (belongsToInnerRealm(result)) {
      return createSecureProxy(result, 0, false);
    }
    if (__ag_ArrayIsArray(result)) {
      var copy = [];
      var length = result.length;
      for (var i = 0; i < length; i++) {
        copy[i] = toSandboxValue(result[i]);
      }
      return createSecureProxy(copy, 0, false);
    }
    return createSecureProxy(result, 0, true);
  }

  /**
   * Refuse a write through the membrane to a HOST-owned value. A custom global is the host's own
   * object, shared by every execution of the enclave: a script that could assign to it would
   * change what later executions and the host itself read, and could plant sandbox objects in it.
   */
  /**
   * What a script gets in place of a built-in method of host data that may not be called on it:
   * one that changes its receiver (push, sort, Map.prototype.set, ... called on host data would
   * write to the host's own object without ever reaching the set trap), or one that runs a
   * regular expression (test, exec and the methods a string calls on one: the host's pattern is
   * not run for the script, whatever the security level; a result that is silently undefined
   * would read as "no match"). Null for every other method.
   */
  function refusedHostBuiltin(value, propName, depth) {
    var refusedOnHostData = hostIsMutatingBuiltin(value);
    if (refusedOnHostData === 'match') {
      return createSecureProxy(function() {
        throw createSafeError(hostRegExpMessage);
      }, depth + 1, false);
    }
    if (refusedOnHostData) {
      return createSecureProxy(function() {
        return refuseHostWrite("Calling '" + propName + "' on the value", undefined);
      }, depth + 1, false);
    }
    return null;
  }

  function refuseHostWrite(action, whenIgnored) {
    if (throwOnBlocked) {
      throw createSafeError(
        "Security violation: " + action + " is blocked. " +
        "Values passed in globals are read-only inside the sandbox."
      );
    }
    // Where blocked operations do not throw (PERMISSIVE), the write is dropped and the trap
    // reports whenIgnored. For set, defineProperty and deleteProperty that is success: a false
    // result is a TypeError in strict-mode code, which would not be "ignored".
    return whenIgnored;
  }

  /**
   * Create a secure proxy that blocks access to dangerous properties
   * Defense-in-depth against attacks like: callTool['const' + 'ructor']
   *
   * IMPORTANT: Must respect JavaScript proxy invariants:
   * - Non-configurable properties must return their actual value
   * - Non-configurable non-writable properties cannot be hidden
   *
   * The host flag marks a value that originates in the HOST realm (custom globals and
   * everything reachable from what they return). The host realm is the only one with code
   * generation from strings enabled, so a raw reference that escapes from it is remote code
   * execution; such a subtree refuses the reads a realm-owned object is allowed to answer.
   */
  function createSecureProxy(obj, depth, host) {
    if (depth === undefined) depth = 0;
    host = host === true;
    // Recursion backstop. Fail CLOSED: returning the raw target here was the reported escape.
    // A bind chain inflates depth (each read binds a FRESH function, so the identity cache never
    // dedupes it) past the cap, and the raw host function prototype chain reaches the host
    // Function constructor for RCE. Throwing keeps the membrane total; the cap sits far above any
    // legitimately-deep (pre-sanitized) value so real data is never rejected.
    if (depth > ${MEMBRANE_MAX_RECURSION_DEPTH}) {
      throw createSafeError('Security violation: secure-proxy recursion depth exceeded.');
    }

    // Skip primitives and null
    if (obj === null || typeof obj !== 'object' && typeof obj !== 'function') {
      return obj;
    }

    // Idempotent in both modes: a membrane proxy is never wrapped again.
    if (membraneProxies.has(obj)) {
      return obj;
    }

    // An argument guard (see guardObjectForHost) that a built-in of host data kept in what it
    // returned stands for a value of the script: that value is what the script gets back.
    if (guardedHostArguments.has(obj)) {
      return guardedHostArguments.get(obj);
    }

    // Check cache
    var cache = host ? hostProxyCache : proxyCache;
    if (cache.has(obj)) {
      return cache.get(obj);
    }

    // A callable is proxied over an inner-realm shell, never over itself (see
    // realmOwnedCallables): the Proxy target decides the realm the engine attributes to the
    // proxy. The shell is an arrow function, so it has no non-configurable own property and no
    // [[Construct]]; the traps below answer for the real function, obj, which they close over.
    // Every trap therefore reads obj and ignores its target argument.
    var shelled = typeof obj === 'function' && !realmOwnedCallables.has(obj);
    var proxyTarget = shelled ? newCallableShell() : obj;

    // Whether obj is a value of THIS realm: neither the host's nor the script's own (an array a
    // built-in made, a tool result, a promise of this realm, a forwarder). Decided once, here:
    // the answer follows the prototype chain, which a script cannot change afterwards (see the
    // setPrototypeOf trap).
    var foreign = !host && !belongsToInnerRealm(obj);
    if (foreign && typeof obj === 'object' && !__ag_ArrayIsArray(obj)) {
      guardScriptFunctionsOf(obj);
    }

    var handler = {
      get: function(_target, property, receiver) {
        var propName = String(property);

        // Check if property is non-configurable (proxy invariant requires returning actual value)
        var descriptor = __ag_getOwnPropertyDescriptor(obj, property);
        var isNonConfigurable = descriptor && !descriptor.configurable;

        // Proxy invariant: if the target has a non-configurable, non-writable data property,
        // the proxy must return the exact same value (cannot wrap/bind/proxy it).
        // This matters for hardened properties like Error.prepareStackTrace.
        if (descriptor && isNonConfigurable && 'value' in descriptor && descriptor.writable === false) {
          var exactValue = descriptor.value;
          var exactIsReference = exactValue !== null && (typeof exactValue === 'object' || typeof exactValue === 'function');
          // On a host-owned value the exact reference cannot be handed over: it would cross
          // the barrier unwrapped and its prototype chain reaches the host Function
          // constructor. Primitives stay safe to report, so only object/function values are
          // refused, and throwing satisfies the invariant that wrapping would break.
          if (host && exactIsReference) {
            throw createSafeError(
              "Security violation: Access to '" + propName + "' is blocked. " +
              "This property cannot be exposed without breaking the sandbox barrier."
            );
          }
          // A shelled callable is not the Proxy target, so no invariant pins its value: a
          // reference takes the blocking and wrapping path below like any other read.
          if (!shelled || !exactIsReference) {
            // A raw object of this realm that is pinned in a value of this realm (a member of
            // an intrinsic of this realm, which is frozen) can be neither handed over nor
            // wrapped. What a script pins itself is stored wrapped (descriptorForRealmValue).
            if (foreign && isRawRealmReference(exactValue)) {
              throw createSafeError(
                "Security violation: Access to '" + propName + "' is blocked. " +
                "This property cannot be exposed without breaking the sandbox barrier."
              );
            }
            return exactValue;
          }
        }

        // Block dangerous properties. The ONLY [[Get]] invariant that forces a specific return
        // value is for a non-writable + non-configurable DATA property, which is handled above.
        // Anything reaching here is configurable, a non-configurable WRITABLE data property (such
        // as a function own prototype), or a non-configurable accessor; the invariant constrains
        // none of these, so the trap must never hand back the raw value. GHSA-3279: the old
        // "isNonConfigurable and not host -> return Reflect.get(...)" branch leaked the raw
        // writable prototype, exposing a parent-realm Object and defeating the membrane.
        if (blockedPropertiesSet.has(propName)) {
          if (throwOnBlocked) {
            throw createSafeError(
              "Security violation: Access to '" + propName + "' is blocked. " +
              "This property can be used for sandbox escape attacks."
            );
          }
          return undefined;
        }

        // A forwarder stands in for the method it calls: report that method's arity and name.
        if (shelled && (property === 'length' || property === 'name') && forwardedMethods.has(obj)) {
          var described = __ag_getOwnPropertyDescriptor(forwardedMethods.get(obj), property);
          var describedValue = described && 'value' in described ? described.value : undefined;
          return (typeof describedValue === 'number' || typeof describedValue === 'string')
            ? describedValue
            : (property === 'length' ? 0 : '');
        }

        // The receiver is obj, not the proxy: an accessor that checks its receiver's internal
        // slot (Map.prototype.size, a typed array's length, ...) rejects a Proxy.
        var value = __ag_ReflectGet(obj, property, obj);

        // A method is handed out as a forwarder that calls it on the object it was read from
        // (this keeps internal-slot access working for Promises, Dates, ...), then proxied to
        // block constructor access. It is a closure rather than value.bind(obj): a bound
        // function keeps the realm of its target (see realmOwnedCallables).
        if (typeof value === 'function') {
          // A function of the script that sits on a value of this realm is the script's own: it
          // gets it back as it is, and calls it on the value it holds (see guardScriptFunction).
          if (foreign) {
            if (guardedScriptFunctions.has(value)) {
              return guardedScriptFunctions.get(value);
            }
            if (isScriptFunction(value)) {
              return value;
            }
          }
          var hostBuiltin = host && hostIsBuiltinMethod(value);
          // push, sort, Map.prototype.set, ... called on host data would write to the host's
          // own object without ever reaching the set trap.
          var refusedMethod = hostBuiltin ? refusedHostBuiltin(value, propName, depth) : null;
          if (refusedMethod) {
            return refusedMethod;
          }
          var method = createMethodForwarder(value, obj);
          if (hostBuiltin) {
            ungatedHostFunctions.add(method);
          } else if (foreign && typeof obj === 'object') {
            parentRealmMethods.add(method);
          }
          return createSecureProxy(method, depth + 1, host);
        }

        // Recursively proxy nested objects to maintain security barrier
        // This prevents attacks like: process.env.__proto__.constructor
        if (value !== null && typeof value === 'object') {
          return createSecureProxy(value, depth + 1, host);
        }

        return value;
      },
      set: function(_target, property, value, receiver) {
        var propName = String(property);
        if (blockedPropertiesSet.has(propName)) {
          if (throwOnBlocked) {
            throw createSafeError(
              "Security violation: Setting '" + propName + "' is blocked. " +
              "This property can be used for sandbox escape attacks."
            );
          }
          return false;
        }
        if (host) {
          return refuseHostWrite("Setting '" + propName + "'", true);
        }
        return __ag_ReflectSet(obj, property, value, receiver);
      },
      defineProperty: function(_target, property, descriptor) {
        var propName = String(property);
        if (blockedPropertiesSet.has(propName)) {
          if (throwOnBlocked) {
            throw createSafeError(
              "Security violation: Defining '" + propName + "' is blocked. " +
              "This property can be used for sandbox escape attacks."
            );
          }
          return false;
        }
        if (host) {
          return refuseHostWrite("Defining '" + propName + "'", true);
        }
        // A shell cannot vouch for a non-configurable property (it has none), so the engine
        // would reject the definition after it had already been applied to the real function.
        if (shelled && descriptor && descriptor.configurable === false) {
          throw createSafeError(
            "Security violation: Defining non-configurable property '" + propName + "' on a function is blocked."
          );
        }
        return __ag_ReflectDefineProperty(
          obj,
          property,
          foreign ? descriptorForRealmValue(obj, property, descriptor, depth) : descriptor
        );
      },
      deleteProperty: function(_target, property) {
        if (host) {
          return refuseHostWrite("Deleting '" + String(property) + "'", true);
        }
        return __ag_ReflectDeleteProperty(obj, property);
      },
      has: function(_target, property) {
        return __ag_ReflectHas(obj, property);
      },
      // Freezing or sealing a host-owned value would change it for the host and for every later
      // execution. A shell must stay extensible, or the engine would start holding the traps
      // above to the shell's own (empty) shape instead of letting them answer for obj.
      preventExtensions: host ? function() {
        // The engine checks a true result against the target, so this one cannot report success.
        return refuseHostWrite('Freezing or sealing the value', false);
      } : (shelled ? function() { return false; } : undefined),
      getOwnPropertyDescriptor: function(_target, property) {
        var propName = String(property);
        var descriptor = __ag_ReflectGetOwnPropertyDescriptor(obj, property);

        // A shelled callable is not the Proxy target, so the engine would reject a
        // non-configurable report (the shell has no such property): describe such a property as
        // configurable. Nothing is lost, because no invariant pins the shell to obj either.
        var reportable = function(actual) {
          if (!shelled || !actual || actual.configurable) return actual;
          var relaxed = {};
          for (var rk in actual) { if (__ag_hasOwnProperty.call(actual, rk)) relaxed[rk] = actual[rk]; }
          relaxed.configurable = true;
          return relaxed;
        };

        // Mirror the get trap's host-owned pinned-value refusal: a non-configurable, non-writable
        // data property must be reported with its exact value (proxy invariant), so on a HOST-owned
        // value an object/function would cross the barrier unwrapped via descriptor.value and its
        // prototype chain reaches the host Function constructor. Deny the read instead (throwing
        // satisfies the invariant); primitives stay safe to report.
        if (host && descriptor && !descriptor.configurable && descriptor.writable === false && 'value' in descriptor) {
          var exactValue = descriptor.value;
          if (exactValue !== null && (typeof exactValue === 'object' || typeof exactValue === 'function')) {
            throw createSafeError(
              "Security violation: Access to property descriptor for '" + propName + "' is blocked. " +
              "This property cannot be exposed without breaking the sandbox barrier."
            );
          }
          return reportable(descriptor);
        }

        // Accessor descriptors expose raw getter/setter functions. A non-configurable accessor
        // must be reported with its exact get/set (proxy invariant) and so cannot be wrapped:
        // deny it if it carries a function whose prototype chain reaches the host constructor.
        if (descriptor && !descriptor.configurable &&
            (typeof descriptor.get === 'function' || typeof descriptor.set === 'function')) {
          throw createSafeError(
            "Security violation: Access to property descriptor for '" + propName + "' is blocked. " +
            "This property cannot be exposed without breaking the sandbox barrier."
          );
        }

        // Must return actual descriptor for other non-configurable properties (proxy invariant).
        // A shelled callable has no such invariant: its property takes the blocking and wrapping
        // path below, described as configurable.
        if (descriptor && !descriptor.configurable) {
          if (!shelled) {
            // On a value of this realm such a description would hand out a raw object of this
            // realm. A writable property may be described with another value (the wrapped one);
            // a pinned one may not, and is refused as the get trap refuses it.
            if (foreign && 'value' in descriptor && isRawRealmReference(descriptor.value)) {
              if (descriptor.writable === false) {
                throw createSafeError(
                  "Security violation: Access to property descriptor for '" + propName + "' is blocked. " +
                  "This property cannot be exposed without breaking the sandbox barrier."
                );
              }
              var described = {};
              for (var nk in descriptor) { if (__ag_hasOwnProperty.call(descriptor, nk)) described[nk] = descriptor[nk]; }
              described.value = guardedScriptFunctions.has(descriptor.value)
                ? guardedScriptFunctions.get(descriptor.value)
                : createSecureProxy(descriptor.value, depth + 1, false);
              return described;
            }
            return descriptor;
          }
          descriptor = reportable(descriptor);
        }

        // Block configurable dangerous properties
        if (blockedPropertiesSet.has(propName)) {
          if (throwOnBlocked) {
            throw createSafeError(
              "Security violation: Access to property descriptor for '" + propName + "' is blocked. " +
              "This property can be used for sandbox escape attacks."
            );
          }
          return undefined;
        }

        // A configurable accessor's getter/setter may be safely proxied so the descriptor never
        // hands back a raw function that leads to the host Function constructor.
        if (descriptor && (typeof descriptor.get === 'function' || typeof descriptor.set === 'function')) {
          var accessorWrapped = {};
          for (var ak in descriptor) { if (__ag_hasOwnProperty.call(descriptor, ak)) accessorWrapped[ak] = descriptor[ak]; }
          // A getter or setter of the script is described as the script's function, not as the
          // guard that is stored for it (see guardScriptFunction).
          if (typeof descriptor.get === 'function') {
            accessorWrapped.get = guardedScriptFunctions.has(descriptor.get)
              ? guardedScriptFunctions.get(descriptor.get)
              : createSecureProxy(descriptor.get, depth + 1, host);
          }
          if (typeof descriptor.set === 'function') {
            accessorWrapped.set = guardedScriptFunctions.has(descriptor.set)
              ? guardedScriptFunctions.get(descriptor.set)
              : createSecureProxy(descriptor.set, depth + 1, host);
          }
          return accessorWrapped;
        }

        // Wrap object/function values so a descriptor read cannot hand back a raw reference that
        // the get trap would otherwise have proxied. A built-in method the get trap withholds on
        // host data (one that changes its receiver, or runs a regular expression) is withheld
        // here in the same way: a descriptor is another way to read the same property.
        if (descriptor && 'value' in descriptor) {
          var value = descriptor.value;
          if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
            var wrapped = {};
            for (var dk in descriptor) { if (__ag_hasOwnProperty.call(descriptor, dk)) wrapped[dk] = descriptor[dk]; }
            var refusedValue = (host && typeof value === 'function' && hostIsBuiltinMethod(value))
              ? refusedHostBuiltin(value, propName, depth)
              : null;
            wrapped.value = refusedValue || (guardedScriptFunctions.has(value)
              ? guardedScriptFunctions.get(value)
              : createSecureProxy(value, depth + 1, host));
            return wrapped;
          }
        }
        return descriptor;
      },
      ownKeys: function(_target) {
        var keys = __ag_ReflectOwnKeys(obj);
        return keys.filter(function(key) {
          var keyStr = String(key);
          // Keep non-blocked properties
          if (!blockedPropertiesSet.has(keyStr)) {
            return true;
          }
          // Must keep non-configurable properties (proxy invariant). A shelled callable is not
          // the Proxy target, so nothing forces its blocked keys to be listed.
          if (shelled) {
            return false;
          }
          var descriptor = __ag_getOwnPropertyDescriptor(obj, key);
          if (descriptor && !descriptor.configurable) {
            return true;
          }
          // Filter out blocked configurable properties
          return false;
        });
      },
      getPrototypeOf: function(_target) {
        // Return null to hide prototype chain
        return null;
      },
      // The default would change the prototype of the Proxy target: of the shell (pointless), of
      // a host-owned value (a write to the host), or of a value of this realm, whose prototype
      // chain is how the membrane tells it from a value of the script (see 'foreign' above).
      setPrototypeOf: (host || shelled || foreign) ? function() {
        if (host) {
          return refuseHostWrite('Changing the prototype of the value', false);
        }
        return false;
      } : undefined,
      // SECURITY (GHSA-grmc-r8vw-226r): the get trap re-wraps values obtained via property
      // ACCESS, but function-call results cross the same trust boundary and must be wrapped
      // too. Without an apply trap, calling a wrapped function (for example the then method
      // of the secure Promise returned by callTool) falls through to the default call and
      // returns a RAW host object; the sandbox can then walk its prototype chain
      // (Promise.prototype up to Function) to reach the host Function constructor for RCE.
      // Results are re-wrapped at a FRESH depth (0) so a chain of calls such as
      // then().then() cannot inflate depth past the recursion cap and leak an unwrapped value.
      //
      // SECURITY: a call into a HOST function (a custom global, a method read off one, or
      // call/apply/bind on one) goes through the global-function gate instead: abort check,
      // maxGlobalFunctionCalls, the shared operation rate limit, and a sanitized, parent-realm
      // copy of the result. Without it those calls skipped every limit that guards callTool, and
      // their results arrived unsanitized. Only built-in methods of host data are exempt.
      apply: function(_target, thisArg, args) {
        if (!host) {
          return createSecureProxy(
            __ag_ReflectApply(obj, thisArg, parentRealmMethods.has(obj) ? guardCallbacksForRealm(args) : args),
            0,
            false
          );
        }
        if (!ungatedHostFunctions.has(obj)) {
          return callHostFunction(obj, args);
        }
        // A built-in method of host data: script callbacks receive wrapped host values, and the
        // result is wrapped (an array is copied into this realm first).
        return wrapHostBuiltinResult(__ag_ReflectApply(obj, undefined, guardCallbacksForHost(args)));
      },
      // Constructing a HOST function would hand back a raw host instance without passing the
      // gate, so it is refused. Realm-owned values keep NO construct trap (undefined here means
      // the default behavior): every constructor reachable from sandbox code resolves to an
      // inner-VM or parent-VM intrinsic, and BOTH of those realms run with code generation
      // from strings disabled, so a 'new X()' result cannot reach a usable Function
      // constructor. Wrapping construct results would additionally break the proxy invariant
      // for the frozen (non-extensible) Error objects the harness throws (getPrototypeOf must
      // not report null for a non-extensible target), masking legitimate errors.
      construct: host ? function() {
        throw createSafeError('Host functions cannot be called with new', 'TypeError');
      } : undefined
    };

    // Nothing a trap throws reaches the script without going through launderThrown.
    for (var trapName in handler) {
      if (typeof handler[trapName] === 'function') {
        handler[trapName] = guarded(handler[trapName]);
      }
    }

    // The handler the engine calls is an inner-realm object (see INNER_REALM_GUARD_SOURCE);
    // 'handler' above is what its traps call.
    var proxy = __ag_innerMembrane.makeProxy(proxyTarget, handler);
    membraneProxies.add(proxy);

    cache.set(obj, proxy);
    // Idempotency: re-wrapping an already-secure proxy must return it unchanged, so an apply
    // result that is itself already a secure proxy is not double-wrapped (which would nest
    // proxies and inflate depth toward the recursion cap).
    cache.set(proxy, proxy);
    return proxy;
  }

  /**
   * Operation rate limit, shared by tool calls and calls into host functions.
   * Sliding one-second window; entries older than two seconds are dropped.
   */
  function enforceRateLimit(now) {
    // Kept for as long as the longest look-back of a sequence detector (30 seconds for the
    // built-in ones, twice that here), not only for the rate window below: a detector that
    // asks for the last ten seconds has to find them.
    while (operationHistory.length > 0 && now - operationHistory[0].timestamp > 60000) {
      operationHistory.shift();
    }
    while (globalFunctionCallTimes.length > 0 && now - globalFunctionCallTimes[0] > 2000) {
      globalFunctionCallTimes.shift();
    }
    var recent = 0;
    for (var r = 0; r < operationHistory.length; r++) {
      if (now - operationHistory[r].timestamp < 1000) recent++;
    }
    for (var g = 0; g < globalFunctionCallTimes.length; g++) {
      if (now - globalFunctionCallTimes[g] < 1000) recent++;
    }
    if (recent >= validationConfig.maxOperationsPerSecond) {
      throw createSafeError('Operation rate limit exceeded (' + validationConfig.maxOperationsPerSecond + ' operations/second)');
    }
  }

  /**
   * Parse the host invoker's JSON envelope into a parent-realm value, or throw its error.
   */
  function decodeGlobalFunctionResult(envelopeJson) {
    if (typeof envelopeJson !== 'string') {
      throw createSafeError('Global function bridge returned an invalid response');
    }
    var envelope;
    try {
      envelope = JSON.parse(envelopeJson);
    } catch (e) {
      throw createSafeError('Global function bridge returned invalid JSON');
    }
    if (!envelope || typeof envelope !== 'object' || envelope.v !== 1) {
      throw createSafeError('Global function bridge returned an invalid response');
    }
    if (envelope.ok === true) {
      return __ag_hasOwnProperty.call(envelope, 'value') ? envelope.value : undefined;
    }
    var failure = envelope.error;
    var message = (failure && typeof failure.message === 'string') ? failure.message : 'Global function call failed';
    var name = (failure && typeof failure.name === 'string') ? failure.name : 'Error';
    throw createSafeError(message, name);
  }

  /**
   * The global-function gate: every call from the sandbox into a host function passed in
   * globals (including functions nested in objects) comes through here.
   */
  function callHostFunction(target, args) {
    if (hostAbortCheck()) {
      throw createSafeError('Execution aborted');
    }
    if (typeof hostInvokeGlobal !== 'function') {
      throw createSafeError('Global function bridge is not available');
    }

    globalFunctionCallCount++;
    if (globalFunctionCallCount > ${maxGlobalFunctionCalls}) {
      throw createSafeError(${JSON.stringify(globalFunctionLimitMessage(maxGlobalFunctionCalls))});
    }

    var now = Date.now();
    enforceRateLimit(now);
    globalFunctionCallTimes.push(now);

    // The script's 'this' is never passed: a method read off a host object is a forwarder that
    // already calls it on that object, and a bare host function has no receiver to honor. The
    // host sanitizes the arguments into plain host data before the function sees them.
    var outcome = hostInvokeGlobal(target, undefined, args);
    if (typeof outcome === 'string') {
      return createSecureProxy(decodeGlobalFunctionResult(outcome));
    }

    // A host function that returned a thenable: settle to a sanitized parent-realm value. The
    // host promise is adopted first, so the promise the script receives is one of this realm.
    return createSecureProxy(adoptHostPromise(outcome).then(decodeGlobalFunctionResult).then(function(value) {
      return createSecureProxy(value);
    }));
  }

  /**
   * Validate an operation before forwarding to host
   */
  function validateOperation(operationName, args) {
    // Rate limiting check with sliding window cleanup
    enforceRateLimit(Date.now());

    // Operation name format validation
    if (typeof operationName !== 'string' || !operationName) {
      throw createSafeError('Operation name must be a non-empty string', 'TypeError');
    }

    // Operation name pattern validation (whitelist)
    if (validationConfig.validateOperationNames && typeof allowedOperationPattern !== 'undefined') {
      if (!allowedOperationPattern.test(operationName)) {
        throw createSafeError('Operation "' + operationName + '" does not match allowed pattern');
      }
    }

    // Operation name pattern validation (blacklist)
    if (typeof blockedOperationPatterns !== 'undefined') {
      for (var i = 0; i < blockedOperationPatterns.length; i++) {
        if (blockedOperationPatterns[i].test(operationName)) {
          throw createSafeError('Operation "' + operationName + '" matches blocked pattern');
        }
      }
    }

    // Suspicious sequence detection
    // NOTE: User-provided pattern functions can throw; those errors are intentionally ignored to avoid
    // breaking the sandbox due to a buggy detector. If a detector returns true, we always fail closed.
    if (validationConfig.blockSuspiciousSequences) {
      for (var j = 0; j < suspiciousPatterns.length; j++) {
        var pattern = suspiciousPatterns[j];
        var detected = false;
        try {
          detected = !!pattern.detect(operationName, args, operationHistory);
        } catch (e) {
          detected = false;
        }
        if (detected) {
          throw createSafeError('Suspicious pattern detected: ' + pattern.description + ' [' + pattern.id + ']');
        }
      }
    }
  }

  /**
   * Read a script's callTool options. Only { throwOnError: false } changes behavior.
   */
  function readThrowOnError(options) {
    if (options === undefined || options === null) return true;
    if (typeof options !== 'object') {
      throw createSafeError('callTool options must be an object', 'TypeError');
    }
    return options.throwOnError !== false;
  }

  /**
   * Remember that a safe error reports a failure of the tool itself (see toolFailures).
   */
  function markToolFailure(error, toolName, name, message, code) {
    var info = { name: name, message: message, toolName: toolName };
    if (typeof code === 'string') info.code = code;
    toolFailures.set(error, info);
    return error;
  }

  /**
   * Whether a tool bridge payload is larger than the limit in UTF-8 bytes, as the host counts it.
   * A code unit is 1 to 3 bytes (a surrogate pair is 4), so only lengths in between are counted.
   */
  function exceedsPayloadLimit(str, maxBytes) {
    if (str.length > maxBytes) return true;
    if (str.length * 3 <= maxBytes) return false;
    var bytes = 0;
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) bytes += 1;
      else if (c < 0x800) bytes += 2;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        var d = str.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) {
          bytes += 4;
          i++;
        } else {
          bytes += 3;
        }
      } else bytes += 3;
      if (bytes > maxBytes) return true;
    }
    return false;
  }

  /**
   * Inner VM's callTool function
   * Proxies through parent VM with validation
   *
   * options.throwOnError === false: a failing tool resolves to { success: false, error } and a
   * working one to { success: true, data }. Refusals by the enclave (abort, tool-call cap, rate
   * limit, operation-name and suspicious-sequence checks, invalid arguments) still throw.
   */
  function innerCallTool(toolName, args, options) {
    var throwOnError = readThrowOnError(options);

    // Check if aborted
    if (hostAbortCheck()) {
      throw createSafeError('Execution aborted');
    }

    // Increment count and check limit
    toolCallCount++;
    if (toolCallCount > ${maxToolCalls}) {
      throw createSafeError('Maximum tool call limit exceeded (${maxToolCalls}). This limit prevents runaway script execution.');
    }

    // Validate args
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      throw createSafeError('Tool arguments must be an object', 'TypeError');
    }

    // Double sanitization (defense in depth)
    var sanitizedArgs;
    try {
      sanitizedArgs = JSON.parse(JSON.stringify(args));
    } catch (e) {
      throw createSafeError('Tool arguments must be JSON-serializable');
    }

    // Enhanced validation
    validateOperation(toolName, sanitizedArgs);

    // Record in history
    operationHistory.push({
      operationName: toolName,
      timestamp: Date.now(),
      argKeys: Object.keys(sanitizedArgs)
    });

    // Update host stats
    hostStats.toolCallCount = toolCallCount;

    // Forward to host and wrap the Promise + result in secure proxies
    // This prevents access to Promise.constructor and result object constructors
    var promise;
    if (toolBridgeMode === 'string') {
      var requestJson;
      try {
        requestJson = JSON.stringify({ v: 1, tool: toolName, args: sanitizedArgs });
      } catch (e) {
        throw createSafeError('Tool request must be JSON-serializable');
      }

      // Counted in UTF-8 bytes, as the host counts it, so both sides agree on the limit.
      if (requestJson && exceedsPayloadLimit(requestJson, toolBridgeMaxPayloadBytes)) {
        throw createSafeError('Tool request exceeds maximum size (' + toolBridgeMaxPayloadBytes + ' bytes)');
      }

      // The limits and checks above ran at the call; the host bridge itself is started from a
      // microtask (see deferHostCall). Everything chained from here on, including the promise the
      // script receives, is a promise of this realm.
      promise = deferHostCall(function() {
        return hostCallTool(requestJson);
      }, launderThrown).then(function(responseJson) {
        if (typeof responseJson !== 'string') {
          throw createSafeError('Tool bridge returned non-string response');
        }

        // The host refuses an oversized response as a tool failure; this check only backs it up,
        // and reports the same way so { throwOnError: false } resolves it to a result.
        if (exceedsPayloadLimit(responseJson, toolBridgeMaxPayloadBytes)) {
          var tooLarge = 'Tool response exceeds maximum size (' + toolBridgeMaxPayloadBytes + ' bytes)';
          throw markToolFailure(
            createSafeError(tooLarge, 'RangeError'),
            toolName,
            'RangeError',
            tooLarge,
            'TOOL_BRIDGE_RESPONSE_TOO_LARGE'
          );
        }

        var response;
        try {
          response = JSON.parse(responseJson);
        } catch (e) {
          throw createSafeError('Tool bridge returned invalid JSON');
        }

        if (!response || typeof response !== 'object' || Array.isArray(response)) {
          throw createSafeError('Tool bridge returned invalid response');
        }

        if (response.v !== 1) {
          throw createSafeError('Tool bridge protocol version mismatch');
        }

        if (response.ok === true) {
          if (__ag_hasOwnProperty.call(response, 'value')) {
            return response.value;
          }
          return undefined;
        }

        if (response.ok === false) {
          var err = response.error;
          var msg = (err && typeof err.message === 'string') ? err.message : 'Tool call failed';
          var name = (err && typeof err.name === 'string') ? err.name : 'Error';
          var failure = createSafeError(msg, name);
          if (err && err.toolError === true) {
            markToolFailure(failure, toolName, name, msg, err.code);
          }
          throw failure;
        }

        throw createSafeError('Tool bridge returned invalid response');
      });
    } else {
      // Direct mode: the rejection is mapped here rather than by launderThrown alone, which
      // would drop the code the host uses to mark a failure of the tool itself.
      promise = deferHostCall(function() {
        return hostCallTool(toolName, sanitizedArgs);
      }, function(error) {
        var code;
        var message;
        try {
          code = error && error.code;
          message = error && error.message;
        } catch (e) { /* treated as an unmarked failure */ }
        if (code === 'TOOL_CALL_FAILED') {
          var text = typeof message === 'string' ? message : 'Tool call failed';
          return markToolFailure(createSafeError(text), toolName, 'Error', text, 'TOOL_CALL_FAILED');
        }
        return launderThrown(error);
      });
    }

    // In direct mode the result is the host's own object, not a copy parsed in this realm.
    var hostOwnedResult = toolBridgeMode !== 'string';

    if (!throwOnError) {
      promise = promise.then(function(result) {
        return { success: true, data: createSecureProxy(result, 0, hostOwnedResult) };
      }, function(error) {
        var info = toolFailures.get(error);
        if (info) {
          return { success: false, error: info };
        }
        throw error;
      });
    }

    // Create a secure promise that wraps both the promise object and its result
    // Note: We can't just wrap the promise because Promise.then/catch/finally must work
    // Instead, we chain the promise to wrap the result
    return createSecureProxy(promise.then(function(result) {
      return createSecureProxy(result, 0, hostOwnedResult);
    }, function(error) {
      throw launderThrown(error);
    }));
  }

  /**
   * Safe for-of iterator for inner VM
   */
  function* innerForOf(iterable) {
    var iterations = 0;
    for (var item of iterable) {
      if (hostAbortCheck()) {
        throw createSafeError('Execution aborted');
      }
      iterations++;
      hostStats.iterationCount++;
      if (iterations > ${maxIterations}) {
        throw createSafeError('Maximum iteration limit exceeded (${maxIterations}). This limit prevents infinite loops.');
      }
      yield item;
    }
  }

  /**
   * Safe for loop wrapper for inner VM
   */
  function innerFor(init, test, update, body) {
    var iterations = 0;
    init();
    while (test()) {
      if (hostAbortCheck()) {
        throw createSafeError('Execution aborted');
      }
      iterations++;
      hostStats.iterationCount++;
      if (iterations > ${maxIterations}) {
        throw createSafeError('Maximum iteration limit exceeded (${maxIterations}). This limit prevents infinite loops.');
      }
      body();
      update();
    }
  }

  /**
   * Safe while loop wrapper for inner VM
   */
  function innerWhile(test, body) {
    var iterations = 0;
    while (test()) {
      if (hostAbortCheck()) {
        throw createSafeError('Execution aborted');
      }
      iterations++;
      hostStats.iterationCount++;
      if (iterations > ${maxIterations}) {
        throw createSafeError('Maximum iteration limit exceeded (${maxIterations}). This limit prevents infinite loops.');
      }
      body();
    }
  }

  /**
   * Safe do-while loop wrapper for inner VM
   */
  function innerDoWhile(test, body) {
    var iterations = 0;
    do {
      if (hostAbortCheck()) {
        throw createSafeError('Execution aborted');
      }
      iterations++;
      hostStats.iterationCount++;
      if (iterations > ${maxIterations}) {
        throw createSafeError('Maximum iteration limit exceeded (${maxIterations}). This limit prevents infinite loops.');
      }
      body();
    } while (test());
  }

  /**
   * Safe addition/concatenation for inner VM
   * Supports numeric addition, string concatenation, and reference ID handling.
   * Also tracks memory allocation when memoryLimit is set.
   */
  function innerConcat(left, right) {
    // Fast path: both are numbers - do numeric addition (JavaScript + semantics)
    if (typeof left === 'number' && typeof right === 'number') {
      return left + right;
    }

    // Fast path: both are strings
    if (typeof left === 'string' && typeof right === 'string') {
      var leftLen = left.length;
      var rightLen = right.length;

      var leftIsRef = refIdPattern.test(left);
      var rightIsRef = refIdPattern.test(right);

      if (!leftIsRef && !rightIsRef) {
        // Track memory if enabled
        if (memoryLimit > 0) {
          hostMemoryTrack(rightLen * 2); // UTF-16 encoding
        }
        return left + right;
      }

      // References detected - check if composites are allowed
      if (!allowComposites) {
        throw createSafeError(
          'Cannot concatenate reference IDs. Pass references directly to callTool arguments. ' +
          'Composite handles are disabled in the current security configuration.'
        );
      }

      return {
        __type: 'composite',
        __operation: 'concat',
        __parts: [left, right],
        __estimatedSize: 0
      };
    }

    // For mixed types (one string, one non-string), check for references first
    // then use native + for proper ToPrimitive handling
    if (typeof left === 'string' || typeof right === 'string') {
      // Check if the string operand(s) are references BEFORE coercion
      var leftIsRef = typeof left === 'string' && refIdPattern.test(left);
      var rightIsRef = typeof right === 'string' && refIdPattern.test(right);

      if (leftIsRef || rightIsRef) {
        // Reference detected - check if composites are allowed
        if (!allowComposites) {
          throw createSafeError(
            'Cannot concatenate reference IDs. Pass references directly to callTool arguments. ' +
            'Composite handles are disabled in the current security configuration.'
          );
        }

        // Convert both to strings for composite
        var leftStr = String(left);
        var rightStr = String(right);
        return {
          __type: 'composite',
          __operation: 'concat',
          __parts: [leftStr, rightStr],
          __estimatedSize: 0
        };
      }
    }

    // For all other cases (objects, booleans, null, undefined, or strings without refs),
    // use JavaScript's default + behavior which correctly handles ToPrimitive
    var result = left + right;

    // Track if result is a string
    if (typeof result === 'string' && memoryLimit > 0) {
      hostMemoryTrack(result.length * 2);
    }

    return result;
  }

  /**
   * Safe template literal for inner VM
   * Detects reference IDs and handles them according to allowComposites config
   */
  function innerTemplate(quasis) {
    var values = Array.prototype.slice.call(arguments, 1);
    var parts = [];
    var hasReferences = false;

    for (var i = 0; i < quasis.length; i++) {
      parts.push(quasis[i]);
      if (i < values.length) {
        var valueStr = String(values[i]);
        parts.push(valueStr);
        if (refIdPattern.test(valueStr)) {
          hasReferences = true;
        }
      }
    }

    // If no references, just concatenate normally
    if (!hasReferences) {
      return parts.join('');
    }

    // References detected - check if composites are allowed
    if (!allowComposites) {
      throw createSafeError(
        'Cannot concatenate reference IDs in template literals. Pass references directly to callTool arguments. ' +
        'Composite handles are disabled in the current security configuration.'
      );
    }

    // Create a composite handle for lazy resolution at callTool boundary
    return {
      __type: 'composite',
      __operation: 'concat',
      __parts: parts,
      __estimatedSize: 0
    };
  }

  /**
   * Safe parallel execution for inner VM
   */
  async function innerParallel(items, fn) {
    if (!Array.isArray(items)) {
      throw createSafeError('parallel() requires an array', 'TypeError');
    }
    if (typeof fn !== 'function') {
      throw createSafeError('parallel() requires a callback function as second argument', 'TypeError');
    }
    // SECURITY: items may be an attacker Proxy that only passes Array.isArray. Read the length
    // ONCE and build the promise list by index rather than items.map(fn), so a .map trap can
    // neither be handed our callback nor use a stateful length to slip past the 100-item cap.
    var len = items.length;
    if (typeof len !== 'number' || !isFinite(len) || len < 0) len = 0;
    len = Math.floor(len);
    if (len > 100) {
      throw createSafeError('parallel() is limited to 100 items');
    }
    // The callbacks run, and their results are awaited, INSIDE the inner realm (see
    // INNER_REALM_PARALLEL_SOURCE). Promise.all of this realm would hand its own resolving
    // functions to whatever 'then' a callback's result has, and would resolve to an array of
    // this realm: both are raw parent-realm objects in the script's hands.
    return innerParallelRuntime(items, len, fn);
  }

  /**
   * Rate-limited console for inner VM
   */
  var consoleStats = { totalBytes: 0, callCount: 0 };
  var maxConsoleBytes = hostConfig.maxConsoleOutputBytes || 65536;
  var maxConsoleCalls = hostConfig.maxConsoleCalls || 100;

  function createSafeConsoleMethod(level) {
    return function() {
      consoleStats.callCount++;
      if (consoleStats.callCount > maxConsoleCalls) {
        throw createSafeError('Console call limit exceeded (max: ' + maxConsoleCalls + '). This limit prevents I/O flood attacks.');
      }
      var output = Array.prototype.map.call(arguments, function(a) {
        if (a === undefined) return 'undefined';
        if (a === null) return 'null';
        if (typeof a === 'object') {
          try { return JSON.stringify(a); } catch (e) { return String(a); }
        }
        return String(a);
      }).join(' ');
      consoleStats.totalBytes += output.length;
      if (consoleStats.totalBytes > maxConsoleBytes) {
        throw createSafeError('Console output size limit exceeded (max: ' + maxConsoleBytes + ' bytes). This limit prevents I/O flood attacks.');
      }
      // false: the host refused to start its console with the stack nearly full
      if (hostConsoleWrite(level, output) === false) {
        throw createSafeError('Maximum call stack size exceeded', 'RangeError');
      }
    };
  }

  var innerConsole = {
    log: createSafeConsoleMethod('log'),
    error: createSafeConsoleMethod('error'),
    warn: createSafeConsoleMethod('warn'),
    info: createSafeConsoleMethod('info')
  };

  // With a consoleHandler, the script's console is built inside the inner realm and writes
  // (level, line) strings to the host sink instead of the host console.
  function createHandlerConsole() {
    var installConsole = new vm.Script(${JSON.stringify(CONSOLE_FACTORY_SOURCE)}, {
      filename: 'inner-console.js'
    }).runInContext(innerContext);
    var writeToSink = createSecureProxy(function(level, line) { hostConsoleSink(level, line); });
    return installConsole(writeToSink, maxConsoleCalls, maxConsoleBytes);
  }

  // ============================================================
  // Create Inner VM
  // ============================================================

  // Create completely isolated context
  // codeGeneration.strings=false disables new Function() and eval() from strings
  // This prevents sandbox escape via constructor chain: [][c][c]('malicious code')
  //
  // The sandbox object has NO prototype. The inner realm resolves a bare identifier on this
  // object first, prototype chain included, so with a plain {} the names constructor, toString,
  // valueOf, hasOwnProperty, __lookupGetter__, ... were THIS realm's Object.prototype members:
  // raw parent-realm functions in the script's hands, with no membrane in between.
  var innerContext = vm.createContext(__ag_objectCreate(null), {
    codeGeneration: { strings: false, wasm: false }
  });

  // The inner realm captures no stack traces, at every security level (see ../realm-stack): the
  // first thing that runs there, while its Error is the intrinsic one.
  new vm.Script(${JSON.stringify(STACK_CAPTURE_OFF_SOURCE)}, { filename: 'inner-stack.js' }).runInContext(innerContext);

  // The function that removes globals from the inner realm at the end of setup (see
  // INNER_REALM_SCRUB_SOURCE). Compiled before anything else runs there.
  var __ag_scrubInnerRealm = new vm.Script(${JSON.stringify(INNER_REALM_SCRUB_SOURCE)}, {
    filename: 'inner-scrub.js'
  }).runInContext(innerContext);

  // The inner half of the membrane (see INNER_REALM_GUARD_SOURCE): makes the proxies, and wraps
  // every function of this realm or of the host that inner-realm code is handed directly.
  __ag_innerMembrane = new vm.Script(${JSON.stringify(INNER_REALM_GUARD_SOURCE)}, {
    filename: 'inner-membrane.js'
  }).runInContext(innerContext);

  // Symbol.for refuses the host's own namespace (see INNER_REALM_SYMBOL_REGISTRY_SOURCE).
  new vm.Script(${JSON.stringify(INNER_REALM_SYMBOL_REGISTRY_SOURCE)}, {
    filename: 'inner-symbol-registry.js'
  }).runInContext(innerContext);

  // parallel(): calls the script's callback for every item and awaits the results in the inner
  // realm (see innerParallel).
  var innerParallelRuntime = new vm.Script(${JSON.stringify(INNER_REALM_PARALLEL_SOURCE)}, {
    filename: 'inner-parallel.js'
  }).runInContext(innerContext);

  // Realm allowlist (realmGlobals: 'allowlist'): the global names the inner realm may hold, as a
  // prototype-less lookup table, or null when only the security level's dangerous globals go.
  var __ag_realmAllowed = ${
    hasRealmAllowlist
      ? `(function(names) {
    var allowed = __ag_objectCreate(null);
    for (var i = 0; i < names.length; i++) allowed[names[i]] = true;
    // Custom globals are part of the script's API whoever computed the list.
    if (hostConfig.globals) {
      for (var customKey in hostConfig.globals) {
        if (__ag_hasOwnProperty.call(hostConfig.globals, customKey)) allowed[customKey] = true;
      }
    }
    return allowed;
  })(${JSON.stringify(realmAllowedNames)})`
      : 'null'
  };

  // Inner-realm pieces the membrane needs (see realmOwnedCallables): a factory for the functions
  // that callable proxies use as their target, evaluated in the inner realm so that they belong
  // to it, and that realm's Object.prototype, which identifies the script's own objects.
  var newCallableShell = new vm.Script(
    '(function() { "use strict"; return function() { return () => {}; }; })()',
    { filename: 'inner-callable-shell.js' }
  ).runInContext(innerContext);
  var innerObjectPrototype = new vm.Script('Object.prototype', {
    filename: 'inner-object-prototype.js'
  }).runInContext(innerContext);

  // The script's cooperative deadline (see ../deadline-guard): the inner realm's __safe_tick,
  // which the transformed script calls at every function entry and loop iteration. vm's timeout
  // below only covers the script up to its first await.
  // What that script evaluates to ends the checks: called when the script has settled, it makes
  // whatever the script left behind stop at its next function entry or loop iteration.
  var __ag_endDeadlineChecks = new vm.Script(${JSON.stringify(realmTickSource(innerTimeout))}, {
    filename: 'inner-deadline.js'
  }).runInContext(innerContext);

  // STRICT/SECURE: record code-generation attempts (Function/eval) even if user code catches them.
  if (${securityLevel === 'STRICT' || securityLevel === 'SECURE'}) {
    try {
      // The reporter the script's realm sees is a function OF that realm that calls this one.
      // Placing __ag_reportViolation itself on the inner global would put a raw parent-realm
      // function there (its prototype chain is this realm's).
      Object.defineProperty(innerContext, '__ag_reportViolation__', {
        value: new vm.Script(
          '(function (report) { "use strict"; return Object.freeze((kind) => { report(typeof kind === "string" ? kind : ""); }); })',
          { filename: 'inner-report-violation.js' }
        ).runInContext(innerContext)(__ag_innerMembrane.wrap(__ag_reportViolation, false)),
        writable: false,
        configurable: false,
        enumerable: false
      });
      var codeGenPatchScript = new vm.Script(${codeGenViolationDetectorCodeJson});
      codeGenPatchScript.runInContext(innerContext);
    } catch (e) { /* ignore */ }
  }

  // Apply stack trace hardening to INNER VM realm (prevents error.stack leakage to user code).
  if (sanitizeStackTraces) {
    try {
      var stackPatchScript = new vm.Script(${stackTraceHardeningCodeJson});
      stackPatchScript.runInContext(innerContext);
    } catch (e) { /* ignore */ }
  }

  // CRITICAL: Inject memory-safe prototype methods BEFORE sanitization
  // This must happen FIRST because sanitization may remove globals needed for patching.
  // The patch needs the intrinsic Object.getPrototypeOf to access the VM's actual
  // String.prototype and Array.prototype (not the global realm's).
  // Security: Prevents ATK-JSON-03 (Parser Bomb) and similar attacks
  // These checks happen BEFORE allocation, not after
  //
  // SECURITY FIX (Vector 320): Track CUMULATIVE memory usage across all allocations
  // Previously only checked if single allocation exceeded limit, allowing attackers
  // to create many smaller allocations that together exceed the limit.
  // We use __host_memory_track__ to track cumulative memory in the host's MemoryTracker.
  (function() {
    var memoryLimit = hostConfig.memoryLimit || 0;
    if (memoryLimit > 0) {
      // First, inject the host memory tracking callback into innerContext
      // This allows the patched methods to track cumulative memory
      // The patched methods call this from inner-realm code, so it is a function of that realm
      // around the host's (see INNER_REALM_GUARD_SOURCE): called raw, a stack overflow at its
      // entry was a HOST RangeError in the script's catch block.
      Object.defineProperty(innerContext, '__host_memory_track__', {
        value: __ag_innerMembrane.wrap(hostMemoryTrack, false),
        writable: false,
        configurable: true,
        enumerable: false
      });

      // Run the patching code in innerContext
      // Math, String and RangeError are parameters: the patched methods run for as long as the
      // script does and must use the realm's own intrinsics, captured here, not whatever those
      // global names are bound to (or no longer bound to) by then.
      var patchCode = '(function(Math, String, RangeError) {' +
        // Strict mode: an unbound call (const f = [].fill; f(0)) must fail on its undefined "this".
        // In sloppy mode "this" was coerced to the realm's global object, and fill RETURNED it.
        '"use strict";' +
        // The functions of Math, not the object: a script can assign to its members, and a
        // replaced Math.max would decide what a fill is charged.
        'Math = { max: Math.max, min: Math.min, round: Math.round };' +
        'var memoryLimit = ' + memoryLimit + ';' +
        'var trackMemory = __host_memory_track__;' +
        // A size is only usable when it is a positive number. NaN (a missing or non-numeric count,
        // a receiver without a numeric length) must never reach the tracker: added to its running
        // total it turns the total into NaN, and no limit check fires after that.
        'function saneSize(n) { return (typeof n === "number" && n > 0) ? n : 0; }' +
        // Charge what was really allocated when it is more than the estimate (a receiver or an
        // argument that reports one size and then produces another).
        'function chargeActual(result, estimated, label) {' +
        '  var actual = (typeof result === "string") ? result.length * 2 : 0;' +
        '  if (actual > estimated) {' +
        '    if (actual > memoryLimit) {' +
        '      throw new RangeError(label + " would exceed memory limit");' +
        '    }' +
        '    trackMemory(actual - estimated);' +
        '  }' +
        '  return result;' +
        '}' +
        // Get the ACTUAL prototype used by literals in this realm
        'var stringProto = Object.getPrototypeOf("");' +
        'var arrayProto = Object.getPrototypeOf([]);' +
        // Patch string repeat
        'var originalRepeat = stringProto.repeat;' +
        'stringProto.repeat = function(count) {' +
        '  var estimatedSize = saneSize(this.length * saneSize(+count) * 2);' +
        '  if (estimatedSize > memoryLimit) {' +
        '    throw new RangeError("String.repeat would exceed memory limit: " +' +
        '      Math.round(estimatedSize / 1024 / 1024) + "MB > " +' +
        '      Math.round(memoryLimit / 1024 / 1024) + "MB");' +
        '  }' +
        '  trackMemory(estimatedSize);' +
        '  return chargeActual(originalRepeat.call(this, count), estimatedSize, "String.repeat");' +
        '};' +
        // Patch array join
        'var originalJoin = arrayProto.join;' +
        'arrayProto.join = function(separator) {' +
        '  var sep = separator === undefined ? "," : String(separator);' +
        '  var estimatedSize = 0;' +
        '  for (var i = 0; i < this.length; i++) {' +
        '    var item = this[i];' +
        '    estimatedSize += (item === null || item === undefined) ? 0 : String(item).length;' +
        '    if (i > 0) estimatedSize += sep.length;' +
        '  }' +
        '  estimatedSize = saneSize(estimatedSize * 2);' +
        '  if (estimatedSize > memoryLimit) {' +
        '    throw new RangeError("Array.join would exceed memory limit: " +' +
        '      Math.round(estimatedSize / 1024 / 1024) + "MB > " +' +
        '      Math.round(memoryLimit / 1024 / 1024) + "MB");' +
        '  }' +
        '  trackMemory(estimatedSize);' +
        '  return chargeActual(originalJoin.call(this, separator), estimatedSize, "Array.join");' +
        '};' +
        // Patch string padStart/padEnd
        'var originalPadStart = stringProto.padStart;' +
        'var originalPadEnd = stringProto.padEnd;' +
        'stringProto.padStart = function(targetLength, padString) {' +
        '  var estimatedSize = saneSize(Math.max(saneSize(this.length), saneSize(+targetLength)) * 2);' +
        '  if (estimatedSize > memoryLimit) {' +
        '    throw new RangeError("String.padStart would exceed memory limit");' +
        '  }' +
        '  trackMemory(estimatedSize);' +
        '  return chargeActual(originalPadStart.call(this, targetLength, padString), estimatedSize, "String.padStart");' +
        '};' +
        'stringProto.padEnd = function(targetLength, padString) {' +
        '  var estimatedSize = saneSize(Math.max(saneSize(this.length), saneSize(+targetLength)) * 2);' +
        '  if (estimatedSize > memoryLimit) {' +
        '    throw new RangeError("String.padEnd would exceed memory limit");' +
        '  }' +
        '  trackMemory(estimatedSize);' +
        '  return chargeActual(originalPadEnd.call(this, targetLength, padString), estimatedSize, "String.padEnd");' +
        '};' +
        // Patch array fill - converts sparse arrays to dense (allocates memory)
        // Vector 1110/1170: Array(dynamicSize).fill() can exhaust memory
        'var originalFill = arrayProto.fill;' +
        'arrayProto.fill = function(value, start, end) {' +
        '  var len = this.length >>> 0;' +
        '  var relativeStart = start === undefined ? 0 : (start >> 0);' +
        '  var relativeEnd = end === undefined ? len : (end >> 0);' +
        '  var k = relativeStart < 0 ? Math.max(len + relativeStart, 0) : Math.min(relativeStart, len);' +
        '  var finalEnd = relativeEnd < 0 ? Math.max(len + relativeEnd, 0) : Math.min(relativeEnd, len);' +
        '  var fillCount = Math.max(0, finalEnd - k);' +
        '  var estimatedSize = fillCount * 8;' +
        '  if (estimatedSize > memoryLimit) {' +
        '    throw new RangeError("Array.fill would exceed memory limit: " +' +
        '      Math.round(estimatedSize / 1024 / 1024) + "MB > " +' +
        '      Math.round(memoryLimit / 1024 / 1024) + "MB");' +
        '  }' +
        '  trackMemory(estimatedSize);' +
        '  return originalFill.call(this, value, start, end);' +
        '};' +
        '})(Math, String, RangeError);';
      var patchScript = new vm.Script(patchCode);
      patchScript.runInContext(innerContext);
    }
  })();

  // Arrays that grow are accounted for like strings that grow (see ../realm-memory), and the
  // helpers the transformed code calls around an array literal with spreads are defined. Always:
  // without a memory limit the helpers count nothing.
  new vm.Script(${JSON.stringify(realmArrayAccountingSource(memoryLimit))}, {
    filename: 'inner-array-accounting.js'
  }).runInContext(innerContext);

  // ============================================================
  // PHASE 2 HARDENING: CVE-2023-29017 Stack Overflow Escape Defense
  // ============================================================
  //
  // CRITICAL: Hardening MUST run BEFORE prototypes are frozen!
  // Otherwise Object.defineProperty calls will silently fail on frozen prototypes.
  //
  // Defense-in-depth against prototype chain escape via stack overflow errors:
  // 1. __proto__ shadowing to block prototype chain traversal
  // 2. Legacy method blocking (__lookupGetter__, etc.)
  // 3. Error constructor wrapping to secure V8-generated errors
  // 4. Then freeze all prototypes to lock in hardening

  // HARDENING 1: Shadow __proto__ on PARENT VM error prototypes with null
  // This prevents e["__proto__"]["__proto__"] traversal attacks by making
  // __proto__ return null instead of the actual prototype chain.
  // MUST run before freeze!
  (function() {
    var errorProtos = [
      Error.prototype,
      TypeError.prototype,
      RangeError.prototype,
      SyntaxError.prototype,
      ReferenceError.prototype,
      URIError.prototype,
      EvalError.prototype
    ];
    for (var i = 0; i < errorProtos.length; i++) {
      // Shadow __proto__ with a null-returning getter
      // This blocks: error["__proto__"]["__proto__"]["__proto__"] attacks
      Object.defineProperty(errorProtos[i], '__proto__', {
        get: function() { return null; },
        set: function() { /* silently ignore */ },
        configurable: false,
        enumerable: false
      });
    }
  })();

  // HARDENING 2: Shadow __proto__ in INNER VM error prototypes
  // MUST run before freeze!
  (function() {
    var shadowProtoCode =
      '(function() {' +
      '  var errorProtos = [' +
      '    Error.prototype,' +
      '    TypeError.prototype,' +
      '    RangeError.prototype,' +
      '    SyntaxError.prototype,' +
      '    ReferenceError.prototype,' +
      '    URIError.prototype,' +
      '    EvalError.prototype' +
      '  ];' +
      '  for (var i = 0; i < errorProtos.length; i++) {' +
      '    Object.defineProperty(errorProtos[i], "__proto__", {' +
      '      get: function() { return null; },' +
      '      set: function() {},' +
      '      configurable: false,' +
      '      enumerable: false' +
      '    });' +
      '  }' +
      '})();';
    var shadowScript = new vm.Script(shadowProtoCode);
    shadowScript.runInContext(innerContext);
  })();

  // HARDENING 3: Block legacy prototype manipulation methods in PARENT VM
  // These deprecated methods (__lookupGetter__, __lookupSetter__, __defineGetter__, __defineSetter__)
  // can be used to bypass frozen prototype protections.
  // MUST run before freeze!
  (function() {
    var legacyMethods = ['__lookupGetter__', '__lookupSetter__', '__defineGetter__', '__defineSetter__'];
    for (var i = 0; i < legacyMethods.length; i++) {
      Object.defineProperty(Object.prototype, legacyMethods[i], {
        value: function() { return undefined; },
        writable: false,
        configurable: false,
        enumerable: false
      });
    }
  })();

  // HARDENING 4: Block legacy prototype methods in INNER VM
  // MUST run before freeze!
  (function() {
    var blockLegacyCode =
      '(function() {' +
      '  var methods = ["__lookupGetter__", "__lookupSetter__", "__defineGetter__", "__defineSetter__"];' +
      '  for (var i = 0; i < methods.length; i++) {' +
      '    Object.defineProperty(Object.prototype, methods[i], {' +
      '      value: function() { return undefined; },' +
      '      writable: false,' +
      '      configurable: false,' +
      '      enumerable: false' +
      '    });' +
      '  }' +
      '})();';
    var blockScript = new vm.Script(blockLegacyCode);
    blockScript.runInContext(innerContext);
  })();

  // ============================================================
  // PROTOTYPE FREEZING: Lock in hardening by freezing all prototypes
  // ============================================================
  //
  // We freeze prototypes in TWO places:
  // 1. PARENT VM prototypes - because SafeObject.prototype = Object.prototype uses parent's prototype
  //    and user code accessing Object.prototype gets SafeObject.prototype
  // 2. INNER VM prototypes - for string/array literals which use intrinsic prototypes
  //
  // This provides defense-in-depth against prototype pollution attacks.

  // Freeze PARENT VM prototypes (used by SafeObject and other safe globals)
  Object.freeze(Object.prototype);
  Object.freeze(Array.prototype);
  Object.freeze(Function.prototype);
  Object.freeze(String.prototype);
  Object.freeze(Number.prototype);
  Object.freeze(Boolean.prototype);
  Object.freeze(Date.prototype);
  Object.freeze(Error.prototype);
  Object.freeze(TypeError.prototype);
  Object.freeze(RangeError.prototype);
  Object.freeze(SyntaxError.prototype);
  Object.freeze(ReferenceError.prototype);
  Object.freeze(URIError.prototype);
  Object.freeze(EvalError.prototype);
  Object.freeze(Promise.prototype);
  // The membrane keeps its state in Set, WeakSet and WeakMap instances and calls their methods
  // through these prototypes on every trap.
  Object.freeze(Set.prototype);
  Object.freeze(Map.prototype);
  Object.freeze(WeakSet.prototype);
  Object.freeze(WeakMap.prototype);

  // Freeze INNER VM prototypes (used by literals like '', [], etc.)
  (function() {
    var freezeCode =
      'Object.freeze(Object.prototype);' +
      'Object.freeze(Array.prototype);' +
      'Object.freeze(Function.prototype);' +
      'Object.freeze(String.prototype);' +
      'Object.freeze(Number.prototype);' +
      'Object.freeze(Boolean.prototype);' +
      'Object.freeze(Date.prototype);' +
      'Object.freeze(Error.prototype);' +
      'Object.freeze(TypeError.prototype);' +
      'Object.freeze(RangeError.prototype);' +
      'Object.freeze(SyntaxError.prototype);' +
      'Object.freeze(ReferenceError.prototype);' +
      'Object.freeze(URIError.prototype);' +
      'Object.freeze(EvalError.prototype);' +
      'Object.freeze(Promise.prototype);';
    var freezeScript = new vm.Script(freezeCode);
    freezeScript.runInContext(innerContext);
  })();

  // HARDENING 5: Wrap error constructors to freeze instances
  // V8-generated errors (like stack overflow RangeError) are created internally,
  // not via the constructor. But wrapping provides defense-in-depth for any
  // errors that ARE created via constructors.
  // NOTE: This can run after freeze because it replaces global constructors, not prototype properties
  (function() {
    var wrapErrorCode =
      '(function() {' +
      '  var origError = Error;' +
      '  var origTypeError = TypeError;' +
      '  var origRangeError = RangeError;' +
      '  var origSyntaxError = SyntaxError;' +
      '  var origReferenceError = ReferenceError;' +
      '  var origEvalError = EvalError;' +
      '  var origURIError = URIError;' +
      '  function wrapErrorCtor(OrigCtor, name) {' +
      '    var WrappedCtor = function(msg) {' +
      '      var err;' +
      '      if (new.target) {' +
      '        err = new OrigCtor(msg);' +
      '      } else {' +
      '        err = OrigCtor(msg);' +
      '      }' +
      '      try { Object.freeze(err); } catch (e) {}' +
      '      return err;' +
      '    };' +
      '    WrappedCtor.prototype = OrigCtor.prototype;' +
      '    try { Object.setPrototypeOf(WrappedCtor, OrigCtor); } catch (e) {}' +
      '    try { Object.freeze(WrappedCtor); } catch (e) {}' +
      '    return WrappedCtor;' +
      '  }' +
      '  try { Error = wrapErrorCtor(origError, "Error"); } catch (e) {}' +
      '  try { TypeError = wrapErrorCtor(origTypeError, "TypeError"); } catch (e) {}' +
      '  try { RangeError = wrapErrorCtor(origRangeError, "RangeError"); } catch (e) {}' +
      '  try { SyntaxError = wrapErrorCtor(origSyntaxError, "SyntaxError"); } catch (e) {}' +
      '  try { ReferenceError = wrapErrorCtor(origReferenceError, "ReferenceError"); } catch (e) {}' +
      '  try { EvalError = wrapErrorCtor(origEvalError, "EvalError"); } catch (e) {}' +
      '  try { URIError = wrapErrorCtor(origURIError, "URIError"); } catch (e) {}' +
      '})();';
    try {
      var wrapScript = new vm.Script(wrapErrorCode);
      wrapScript.runInContext(innerContext);
    } catch (e) { /* ignore */ }
  })();

  // NOTE: HARDENING 6 and 7 (Object.getPrototypeOf / Reflect.getPrototypeOf wrappers)
  // were removed as they break legitimate internal functionality like __safe_template.
  // The existing defenses (prototype freezing, __proto__ shadowing, error constructor
  // wrapping, codeGeneration.strings=false) provide sufficient protection against
  // the CVE-2023-29017 attack pattern.

  // Inject safe runtime functions (non-writable, non-configurable)
  // Wrap with secure proxy to block dangerous property access
  var safeRuntime = {
    __safe_callTool: createSecureProxy(innerCallTool),
    __safe_forOf: createSecureProxy(innerForOf),
    __safe_for: createSecureProxy(innerFor),
    __safe_while: createSecureProxy(innerWhile),
    __safe_doWhile: createSecureProxy(innerDoWhile),
    __safe_parallel: createSecureProxy(innerParallel),
    __safe_console: hostConsoleSink ? createHandlerConsole() : createSecureProxy(innerConsole),
    callTool: createSecureProxy(innerCallTool),
    parallel: createSecureProxy(innerParallel),
    // Loop transformation runtime support
    __maxIterations: ${maxIterations}
  };

  // SECURITY FIX (Vector 640): Use enumerable: false to prevent valueOf context-hijack
  // Attack uses arrow functions in valueOf hooks where "this" refers to global scope.
  // Object.values(this) would enumerate all enumerable properties including internal
  // functions, leaking their source code. Non-enumerable prevents this information leak.
  for (var key in safeRuntime) {
    if (safeRuntime.hasOwnProperty(key)) {
      Object.defineProperty(innerContext, key, {
        value: safeRuntime[key],
        writable: false,
        configurable: false,
        enumerable: false
      });
    }
  }

  // Define __safe_concat and __safe_template in the INNER realm to avoid cross-realm stacks.
  // (See innerRealmSafeConcatAndTemplateCode for rationale.)
  try {
    var innerRuntimeScript = new vm.Script(${innerRealmSafeConcatAndTemplateCodeJson}, { filename: 'inner-runtime.js' });
    innerRuntimeScript.runInContext(innerContext);
  } catch (e) { /* ignore */ }

  // Tool namespaces (mail.list(args)): built INSIDE the inner realm by a factory evaluated there
  // (before Object/JSON are replaced by the safe globals below), so each namespace is a frozen,
  // null-prototype inner-realm object whose methods call the gated callTool. A namespace call is
  // therefore an ordinary tool call: counted, rate-limited, pattern-checked and sanitized.
  var toolNamespaceNames = ${JSON.stringify(toolNamespaces.map((ns) => ns.name))};
  if (toolNamespaceNames.length > 0) {
    var installToolNamespaces = new vm.Script(${JSON.stringify(TOOL_NAMESPACE_FACTORY_SOURCE)}, {
      filename: 'inner-tool-namespaces.js'
    }).runInContext(innerContext);
    var builtToolNamespaces = installToolNamespaces(safeRuntime.__safe_callTool, ${JSON.stringify(
      JSON.stringify(toolNamespaces),
    )});
    for (var tn = 0; tn < toolNamespaceNames.length; tn++) {
      var toolNamespaceName = toolNamespaceNames[tn];
      var toolNamespace = builtToolNamespaces[toolNamespaceName];
      __ag_defineProperty(innerContext, toolNamespaceName, {
        value: toolNamespace,
        writable: false,
        configurable: false,
        enumerable: false
      });
      __ag_defineProperty(innerContext, '__safe_' + toolNamespaceName, {
        value: toolNamespace,
        writable: false,
        configurable: false,
        enumerable: false
      });
    }
  }

  // Runtime half of "AgentScript has no regular expressions": with a realm allowlist that does
  // not name RegExp, nothing in the inner realm can run one (see INNER_REALM_REGEX_BACKSTOP_SOURCE).
  // After inner-runtime.js, whose one trusted pattern has kept its own matcher. Not optional:
  // a failure here aborts the execution.
  if (__ag_realmAllowed && __ag_realmAllowed.RegExp !== true) {
    new vm.Script(${JSON.stringify(INNER_REALM_REGEX_BACKSTOP_SOURCE)}, {
      filename: 'inner-regex-backstop.js'
    }).runInContext(innerContext);
  }

  // Defense-in-depth: Remove host callback from inner sandbox after all scripts have captured it
  try { delete innerContext['__host_memory_track__']; } catch (e) { /* ignore */ }

  // Create a safe Object that blocks dangerous STATIC methods
  // Prevents ATK-DATA-02 (Serialization Hijack via defineProperty)
  // Note: __defineGetter__ etc. are on Object.prototype (instance methods), not static
  var DANGEROUS_OBJECT_STATIC_METHODS = [
    'defineProperty',
    'defineProperties',
    'setPrototypeOf',
    'getOwnPropertyDescriptor',
    'getOwnPropertyDescriptors'
  ];

  var SafeObject = function(value) {
    if (value === null || value === undefined) return {};
    return Object(value);
  };

  // Copy safe static methods
  var safeObjectMethods = [
    'keys', 'values', 'entries', 'fromEntries', 'assign', 'is', 'hasOwn',
    'freeze', 'isFrozen', 'seal', 'isSealed', 'preventExtensions', 'isExtensible',
    'getOwnPropertyNames', 'getOwnPropertySymbols', 'getPrototypeOf'
  ];
  for (var i = 0; i < safeObjectMethods.length; i++) {
    var m = safeObjectMethods[i];
    if (m in Object) SafeObject[m] = Object[m];
  }

  // Safe Object.create without property descriptors
  SafeObject.create = function(proto, props) {
    if (props !== undefined) {
      throw createSafeError('Object.create with property descriptors is not allowed (security restriction)');
    }
    return Object.create(proto);
  };

  SafeObject.prototype = Object.prototype;

  // Block dangerous methods with helpful errors
  for (var i = 0; i < DANGEROUS_OBJECT_STATIC_METHODS.length; i++) {
    (function(method) {
      SafeObject[method] = function() {
        throw createSafeError('Object.' + method + ' is not allowed (security restriction: prevents property manipulation attacks)');
      };
    })(DANGEROUS_OBJECT_STATIC_METHODS[i]);
  }

  // Get INNER context's intrinsic constructors
  // CRITICAL: We must use the inner context's Array/String/etc constructors
  // so that objects created with new Array() use the patched prototypes.
  // Using parent VM constructors would bypass our memory-safe prototype patches.
  var innerIntrinsics = (function() {
    var getIntrinsicsCode =
      '({ ' +
      '  Array: Array, ' +
      '  String: String, ' +
      '  Number: Number, ' +
      '  Boolean: Boolean, ' +
      '  Date: Date, ' +
      '  RegExp: RegExp, ' +
      '  Error: Error, ' +
      '  TypeError: TypeError, ' +
      '  RangeError: RangeError, ' +
      '  Promise: Promise, ' +
      '  Math: Math, ' +
      '  JSON: JSON, ' +
      '  isNaN: isNaN, ' +
      '  isFinite: isFinite, ' +
      '  parseInt: parseInt, ' +
      '  parseFloat: parseFloat, ' +
      '  encodeURI: encodeURI, ' +
      '  decodeURI: decodeURI, ' +
      '  encodeURIComponent: encodeURIComponent, ' +
      '  decodeURIComponent: decodeURIComponent ' +
      '})';
    var script = new vm.Script(getIntrinsicsCode);
    return script.runInContext(innerContext);
  })();

  // The constructors the script uses with new and instanceof. They are proxied directly (see
  // realmOwnedCallables): each belongs to the inner realm, except SafeObject, which is a
  // function of this realm. Neither realm can generate code from strings.
  [
    innerIntrinsics.Array, innerIntrinsics.String, innerIntrinsics.Number, innerIntrinsics.Boolean,
    innerIntrinsics.Date, innerIntrinsics.RegExp, innerIntrinsics.Error, innerIntrinsics.TypeError,
    innerIntrinsics.RangeError, innerIntrinsics.Promise, SafeObject
  ].forEach(function(constructor) {
    realmOwnedCallables.add(constructor);
  });

  // Add safe standard globals wrapped with secure proxy
  // Use inner context intrinsics for constructors to ensure patched prototypes are used
  var safeGlobals = {
    Math: createSecureProxy(innerIntrinsics.Math),
    JSON: createSecureProxy(innerIntrinsics.JSON),
    Array: createSecureProxy(innerIntrinsics.Array),
    Object: createSecureProxy(SafeObject),
    String: createSecureProxy(innerIntrinsics.String),
    Number: createSecureProxy(innerIntrinsics.Number),
    Date: createSecureProxy(innerIntrinsics.Date),
    Boolean: createSecureProxy(innerIntrinsics.Boolean),
    RegExp: createSecureProxy(innerIntrinsics.RegExp),
    Error: createSecureProxy(innerIntrinsics.Error),
    TypeError: createSecureProxy(innerIntrinsics.TypeError),
    RangeError: createSecureProxy(innerIntrinsics.RangeError),
    Promise: createSecureProxy(innerIntrinsics.Promise),
    undefined: undefined,
    NaN: NaN,
    Infinity: Infinity,
    // The inner realm's own functions, not this realm's: a function of this realm placed on the
    // inner global would be a raw parent-realm reference in the script's hands.
    isNaN: innerIntrinsics.isNaN,
    isFinite: innerIntrinsics.isFinite,
    parseInt: innerIntrinsics.parseInt,
    parseFloat: innerIntrinsics.parseFloat,
    encodeURI: innerIntrinsics.encodeURI,
    decodeURI: innerIntrinsics.decodeURI,
    encodeURIComponent: innerIntrinsics.encodeURIComponent,
    decodeURIComponent: innerIntrinsics.decodeURIComponent
  };

  // SECURITY FIX (Vector 640): Use enumerable: false for defense-in-depth
  // While standard globals (Math, JSON, etc.) are less sensitive than internal functions,
  // making them non-enumerable prevents Object.values(this) from revealing sandbox structure.
  // Skip globals that the user is providing their own version of
  for (var gKey in safeGlobals) {
    if (safeGlobals.hasOwnProperty(gKey)) {
      // If user provides this global, skip so their version takes precedence
      if (hostConfig.globals && __ag_hasOwnProperty.call(hostConfig.globals, gKey)) {
        continue;
      }
      // With a realm allowlist, a standard global the script may not name is not defined at all
      // (Promise, RegExp and Boolean under the AgentScript lists).
      if (__ag_realmAllowed && __ag_realmAllowed[gKey] !== true) {
        continue;
      }
      Object.defineProperty(innerContext, gKey, {
        value: safeGlobals[gKey],
        writable: false,
        configurable: false,
        enumerable: false
      });
    }
  }

  // Add user-provided globals if any (also wrapped with secure proxy and non-writable)
  // SECURITY: Use enumerable: false to prevent Object.assign({}, this) from copying globals
  // This blocks Vector 380 (Bridge-Serialized State Reflection) attack
  // Custom globals are HOST-realm values, so they are wrapped in host mode: the whole
  // subtree reachable through them (including whatever their calls return) refuses to hand
  // back a raw reference, even for descriptor shapes where a realm-owned object may.
  if (hostConfig.globals) {
    for (var uKey in hostConfig.globals) {
      // (Not as a method of the object: custom globals may have no prototype, as the ones a
      // worker receives do, or an own property of that name.)
      if (__ag_hasOwnProperty.call(hostConfig.globals, uKey)) {
        var wrappedGlobal = createSecureProxy(hostConfig.globals[uKey], 0, true);
        Object.defineProperty(innerContext, uKey, {
          value: wrappedGlobal,
          writable: false,
          configurable: false,
          enumerable: false
        });
        // Also add __safe_ prefixed version
        Object.defineProperty(innerContext, '__safe_' + uKey, {
          value: wrappedGlobal,
          writable: false,
          configurable: false,
          enumerable: false
        });
      }
    }
  }

  // ============================================================
  // Execute User Code
  // ============================================================

  // HARDENING 4: Runtime prototype verification before user code execution
  // Verifies that critical prototypes are still frozen. If any have been
  // unfrozen (which shouldn't be possible but defense-in-depth), abort.
  (function() {
    var criticalPrototypes = [
      { name: 'Object.prototype', proto: Object.prototype },
      { name: 'Array.prototype', proto: Array.prototype },
      { name: 'Function.prototype', proto: Function.prototype },
      { name: 'Error.prototype', proto: Error.prototype },
      { name: 'RangeError.prototype', proto: RangeError.prototype }
    ];
    for (var i = 0; i < criticalPrototypes.length; i++) {
      var item = criticalPrototypes[i];
      if (!Object.isFrozen(item.proto)) {
        throw new Error('SECURITY VIOLATION: ' + item.name + ' is not frozen. Aborting execution.');
      }
    }
  })();

  // HARDENING 5: Runtime verification in INNER VM
  (function() {
    var verifyCode =
      '(function() {' +
      '  var protos = [Object.prototype, Array.prototype, Error.prototype, RangeError.prototype];' +
      '  for (var i = 0; i < protos.length; i++) {' +
      '    if (!Object.isFrozen(protos[i])) {' +
      '      throw new Error("SECURITY VIOLATION: Inner VM prototype not frozen");' +
      '    }' +
      '  }' +
      '})();';
    try {
      var verifyScript = new vm.Script(verifyCode);
      verifyScript.runInContext(innerContext);
    } catch (e) {
      if (e.message && e.message.indexOf('SECURITY VIOLATION') >= 0) {
        throw e;
      }
      /* ignore other errors */
    }
  })();

  // Defense-in-depth: Neutralize dangerous static methods on the intrinsic Object constructor
  // in the inner VM. SafeObject only replaces the global Object variable; the REAL intrinsic
  // Object is still reachable via {}.constructor and retains getOwnPropertyDescriptors etc.
  // NOTE: Only applied to inner VM - parent VM needs these for createSecureProxy/createSafeError.
  (function() {
    var neutralizeCode =
      '(function() {' +
      '  var RealObject = Object.getPrototypeOf({}).constructor;' +
      '  var dangerous = ["getOwnPropertyDescriptors","getOwnPropertyDescriptor","defineProperty","defineProperties","setPrototypeOf"];' +
      '  for (var i = 0; i < dangerous.length; i++) { try { delete RealObject[dangerous[i]]; } catch(e) {} }' +
      '})();';
    try { var s = new vm.Script(neutralizeCode); s.runInContext(innerContext); } catch(e) { /* defense-in-depth */ }
  })();

  // Remove dangerous globals from the inner realm. This is the LAST setup step: the trusted
  // scripts above have captured the intrinsics they need (Proxy, Reflect, ...), and script code
  // has not run yet.
  ${sanitizeContextCode}

  // IMPORTANT: For stack overflow errors (RangeError: Maximum call stack size exceeded),
  // Node/V8 may ignore Error.prepareStackTrace when it was installed by a different Script
  // than the one that triggered the overflow. To make stack sanitization reliable,
  // we also prepend the hardening code into the same Script that executes user code.
  var __ag_stackHardenPrefix = sanitizeStackTraces ? (${stackTraceHardeningCodeJson} + '\\n') : '';
  var wrappedCode =
    // Strict mode for everything the script contains. A function called without a receiver then
    // has no \`this\` (in sloppy mode it is the realm's global object, for __ag_main and for every
    // arrow function inside it), an assignment to an undeclared name is an error instead of a new
    // global, a write that cannot happen throws instead of being silently dropped, and a function
    // of the script has no \`caller\` or \`arguments.callee\` to walk the stack with.
    '(async function() { "use strict"; ' +
    __ag_stackHardenPrefix +
    userCode +
    ' return typeof __ag_main === "function" ? await __ag_main() : undefined; })()';

  var script = new vm.Script(wrappedCode, { filename: 'inner-agentscript.js' });

  // SECURITY HARDENING: Disable vm module before running user code
  // This prevents access to vm module even if user code escapes to parent context
  // We null out the vm object's methods since we can't delete globals in strict mode
  try {
    vm.createContext = null;
    vm.Script = null;
  } catch (e) { /* ignore if properties are non-writable */ }

  // PARENT LOCKDOWN: from here on nothing in this realm needs to change, so every intrinsic
  // constructor, prototype and namespace object is frozen (see REALM_LOCKDOWN_SOURCE). The
  // trusted code of this realm runs for as long as the script does and looks most of its
  // built-ins up at call time; none of them can be replaced any more.
  __ag_lockdownParentRealm();

  // Note: codeGeneration is set in createContext(), not runInContext()
  var result;
  try {
    result = await script.runInContext(innerContext, {
      timeout: ${innerTimeout},
      breakOnSigint: true
    });
  } finally {
    // The execution is over, whichever way: nothing the script left behind runs on from here
    try { __ag_endDeadlineChecks(); } catch (e) { /* the realm is gone */ }
  }

  return result;
})();
`.trim();
}
