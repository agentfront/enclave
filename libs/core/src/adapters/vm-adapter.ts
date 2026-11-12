/**
 * VM Adapter - Node.js vm module implementation
 *
 * Uses Node.js built-in vm module for sandboxed code execution.
 * Provides isolated execution context with controlled globals.
 *
 * @packageDocumentation
 */

import * as vm from 'vm';
import { compileSandboxScript, ReusableSandboxScript } from '../sandbox-script';
import type { SandboxAdapter, ExecutionContext, ExecutionResult, SecurityLevel } from '../types';
import { createSafeRuntime } from '../safe-runtime';
import {
  createSecureProxy,
  unwrapSecureProxy,
  buildBlockedPropertiesFromConfig,
  getBlockedPropertiesForLevel,
} from '../secure-proxy';
import { createSafeError } from '../safe-error';
import { MemoryTracker, MemoryLimitError } from '../memory-tracker';
import { createHostToolBridge, encodeToolBridgeFailure, toolCallLimitMessage } from '../tool-bridge';
import { checkSerializedSize, sanitizeValue } from '../value-sanitizer';
import { sanitizeStackTrace } from '../stack-trace';
import { createGlobalFunctionGate, type SandboxRealmBridge } from '../global-function-gate';
import { realmTickSource } from '../deadline-guard';
import { guardSandboxRejections } from '../sandbox-rejections';
import { createRealmAirlock, type RealmMembrane } from '../realm-airlock';
import { numericLiteral } from '../enclave-options';
import { STACK_CAPTURE_OFF_SOURCE } from '../realm-stack';
import { realmArrayAccountingSource } from '../realm-memory';
import { describeThrown, isMemoryLimitPayload, THROWN_WITHOUT_MESSAGE } from '../thrown-value';
import {
  INNER_REALM_GUARD_SOURCE,
  INNER_REALM_SYMBOL_REGISTRY_SOURCE,
  innerRealmRuntimeSource,
} from '../double-vm/parent-vm-bootstrap';
import { TOOL_NAMESPACE_FACTORY_SOURCE, buildToolNamespaceBindings } from '../tool-namespaces';
import { CONSOLE_FACTORY_SOURCE, createConsoleSink, type ConsoleHandler, type ConsoleLimits } from '../console-handler';
import {
  SANDBOX_CONSOLE_FACTORY_SOURCE,
  createHostConsoleWriter,
  type InstallSandboxConsole,
} from '../sandbox-console';

/**
 * Patch code executed inside the sandbox realm to prevent leaking host stack traces via `error.stack`.
 *
 * Note: This is intentionally conservative: it avoids emitting any file names/paths/line numbers
 * and also locks `Error.prepareStackTrace` to prevent CallSite-based exfiltration.
 */
const STACK_TRACE_HARDENING_CODE = `
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

  __ag_lockStackGetter(Error && Error.prototype);
  __ag_lockPrepareStackTrace(Error);
  __ag_lockPrepareStackTrace(EvalError);
  __ag_lockPrepareStackTrace(RangeError);
  __ag_lockPrepareStackTrace(ReferenceError);
  __ag_lockPrepareStackTrace(SyntaxError);
  __ag_lockPrepareStackTrace(TypeError);
  __ag_lockPrepareStackTrace(URIError);
  try {
    if (typeof AggregateError !== 'undefined') __ag_lockPrepareStackTrace(AggregateError);
  } catch (e) {}
})();
`.trim();

const STACK_TRACE_HARDENING_SCRIPT = new ReusableSandboxScript(STACK_TRACE_HARDENING_CODE);

/** Run first in the sandbox realm, at every security level: it captures no stack traces (see ../realm-stack). */
const STACK_CAPTURE_OFF_SCRIPT = new ReusableSandboxScript(STACK_CAPTURE_OFF_SOURCE, { filename: 'realm-stack.js' });

/**
 * Detect and report code-generation attempts (Function/eval) even if user code catches the thrown error.
 *
 * In STRICT/SECURE mode we treat these as policy violations and fail the execution after it returns.
 */
const CODE_GENERATION_VIOLATION_DETECTOR_CODE = `
(function() {
  var __ag_report = (typeof __ag_reportViolation__ === 'function') ? __ag_reportViolation__ : null;
  function __ag_reportOnce(kind) {
    try {
      if (__ag_report) __ag_report(kind);
    } catch (e) {}
  }

  // Capture intrinsics BEFORE any sanitization mutates globals like Reflect.
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

      // Ensure constructor-chain escapes (x.constructor.constructor) hit the proxy.
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

const CODE_GENERATION_VIOLATION_DETECTOR_SCRIPT = new ReusableSandboxScript(CODE_GENERATION_VIOLATION_DETECTOR_CODE);

/**
 * Neutralize dangerous static methods on the intrinsic Object constructor.
 * SafeObject only replaces the global Object variable; the REAL intrinsic Object
 * is still reachable via {}.constructor and retains getOwnPropertyDescriptors etc.
 */
const INTRINSIC_OBJECT_NEUTRALIZATION_CODE = `
(function() {
  var RealObject = Object.getPrototypeOf({}).constructor;
  var dangerous = [
    'getOwnPropertyDescriptors',
    'getOwnPropertyDescriptor',
    'defineProperty',
    'defineProperties',
    'setPrototypeOf'
  ];
  for (var i = 0; i < dangerous.length; i++) {
    try { delete RealObject[dangerous[i]]; } catch (e) {}
  }
})();
`;
const INTRINSIC_OBJECT_NEUTRALIZATION_SCRIPT = new ReusableSandboxScript(INTRINSIC_OBJECT_NEUTRALIZATION_CODE);

/**
 * Evaluated in a pristine sandbox realm, returns a function that gives the realm's global object a
 * null prototype. It captures the realm's own Object.setPrototypeOf up front: by the time the
 * function is called, that method has been removed from the realm's Object.
 */
const DETACH_GLOBAL_PROTOTYPE_SCRIPT = new ReusableSandboxScript(
  `(function (global) {
    'use strict';
    var setPrototypeOf = Object.setPrototypeOf;
    return function () { setPrototypeOf(global, null); };
  })(this)`,
  { filename: 'detach-global-prototype.js' },
);

/**
 * Sandbox-realm helpers for the host-function gate: the realm's own `JSON.parse` (so a sanitized
 * host result is re-created as sandbox-realm data) and a way to settle a sandbox-realm promise
 * from a host promise (so no host promise reaches the script).
 */
const SANDBOX_REALM_BRIDGE_SCRIPT = new ReusableSandboxScript(`
(function (own) {
  'use strict';
  var parse = JSON.parse;
  var SandboxPromise = Promise;
  return Object.freeze({
    parseJson: function (json) { return parse(json); },
    adoptPromise: function (hostPromise) {
      return new SandboxPromise(function (resolve, reject) {
        // A rejection reason is a host value like any other: 'own' replaces a host error
        hostPromise.then(resolve, function (reason) { reject(own(reason)); });
      });
    }
  });
})
`);

/** The sandbox realm's half of the membrane (see INNER_REALM_GUARD_SOURCE). */
const REALM_GUARD_SCRIPT = new ReusableSandboxScript(INNER_REALM_GUARD_SOURCE, { filename: 'realm-membrane.js' });

/** `Symbol.for` refuses the host's own namespace (see INNER_REALM_SYMBOL_REGISTRY_SOURCE). */
const REALM_SYMBOL_REGISTRY_SCRIPT = new ReusableSandboxScript(INNER_REALM_SYMBOL_REGISTRY_SOURCE, {
  filename: 'realm-symbol-registry.js',
});

/**
 * Evaluated in a pristine sandbox realm, returns factories for the runtime pieces that have to be
 * functions OF that realm. A host function placed on the sandbox global is a raw host function in
 * the script's hands: its prototype chain is the host's, whatever the function does.
 *
 * - `createForOf(startLoop)`: the `__safe_forOf` generator. `startLoop()` is the host's
 *   per-loop counter; it returns a function that counts one iteration and throws at the limit.
 * - `createLoops(startLoop)`: `__safe_for`, `__safe_while` and `__safe_doWhile`, counted the same way.
 * - `createParallel(isAborted)`: `__safe_parallel`.
 * - `createReporter(report)`: the policy-violation reporter of STRICT and SECURE.
 * - `createSafeObject()`: the `Object` global, without the methods that redefine properties.
 * - `createSafeReflect(blocked)`: the `Reflect` global of a level that has one.
 *
 * The host functions these close over are never visible to the script, and each of them is
 * wrapped by the realm's half of the membrane before it is passed in (see REALM_GUARD_SCRIPT).
 */
const REALM_RUNTIME_FACTORY_SCRIPT = new ReusableSandboxScript(
  `(function () {
    'use strict';
    var freeze = Object.freeze;
    var RealObject = Object;
    var objectCreate = Object.create;
    var getOwnPropertyNames = Object.getOwnPropertyNames;
    var defineProperty = Object.defineProperty;
    var objectToString = Object.prototype.toString;
    var RealmReflect = Reflect;
    var realmConstruct = Reflect.construct;
    var apply = Reflect.apply;
    var RealmError = Error;
    var RealmTypeError = TypeError;
    var RealmString = String;
    var RealmPromise = Promise;
    var promiseAll = Promise.all;
    var isArray = Array.isArray;
    var mathMin = Math.min;
    var mathMax = Math.max;
    var FunctionCtor = Function;
    var AsyncFunctionCtor = (async function () {}).constructor;
    var GeneratorFunctionCtor = (function* () {}).constructor;
    var AsyncGeneratorFunctionCtor = (async function* () {}).constructor;

    function securityError(message) {
      var error = new RealmError(message);
      defineProperty(error, 'name', { value: 'SecurityError', writable: true, configurable: true });
      return error;
    }

    return freeze({
      createForOf: function (startLoop) {
        return freeze(function* __safe_forOf(iterable) {
          var countIteration = startLoop();
          for (var item of iterable) {
            countIteration();
            yield item;
          }
        });
      },
      createLoops: function (startLoop) {
        return freeze({
          __safe_for: freeze(function __safe_for(init, test, update, body) {
            var countIteration = startLoop();
            init();
            while (test()) {
              countIteration();
              body();
              update();
            }
          }),
          __safe_while: freeze(function __safe_while(test, body) {
            var countIteration = startLoop();
            while (test()) {
              countIteration();
              body();
            }
          }),
          __safe_doWhile: freeze(function __safe_doWhile(body, test) {
            var countIteration = startLoop();
            do {
              countIteration();
              body();
            } while (test());
          })
        });
      },
      createParallel: function (isAborted) {
        var MAX_ITEMS = 100;
        var MAX_CONCURRENCY = 20;
        function messageOf(error) {
          if (error && typeof error === 'object') {
            return typeof error.message === 'string' ? error.message : apply(objectToString, error, []);
          }
          return RealmString(error);
        }
        return freeze(async function __safe_parallel(fns, options) {
          if (isAborted()) throw new RealmError('Execution aborted');
          if (!isArray(fns)) throw new RealmTypeError('__safe_parallel requires an array of functions');
          var count = fns.length;
          if (count === 0) return [];
          if (count > MAX_ITEMS) {
            throw new RealmError(
              'Cannot execute more than ' + MAX_ITEMS + ' operations in parallel. Split into smaller batches.'
            );
          }
          var tasks = [];
          for (var i = 0; i < count; i++) {
            if (typeof fns[i] !== 'function') throw new RealmTypeError('Item at index ' + i + ' is not a function');
            tasks[i] = fns[i];
          }
          var requested = options === null || options === undefined ? undefined : options.maxConcurrency;
          if (typeof requested !== 'number' || requested !== requested) requested = 10;
          var concurrency = mathMin(mathMax(1, requested), MAX_CONCURRENCY);
          var results = [];
          results.length = count;
          var failures = [];
          var next = 0;
          async function runNext() {
            while (next < count) {
              if (isAborted()) throw new RealmError('Execution aborted');
              var index = next++;
              try {
                results[index] = await tasks[index]();
              } catch (error) {
                failures[failures.length] = '[' + index + ']: ' + messageOf(error);
              }
            }
          }
          var workers = [];
          for (var w = 0; w < mathMin(concurrency, count); w++) workers[w] = runNext();
          await apply(promiseAll, RealmPromise, [workers]);
          if (failures.length > 0) {
            var text = failures[0];
            for (var f = 1; f < failures.length; f++) text += '\\n' + failures[f];
            throw new RealmError(failures.length + ' of ' + count + ' parallel operations failed:\\n' + text);
          }
          return results;
        });
      },
      createReporter: function (report) {
        return freeze(function (kind) {
          report(typeof kind === 'string' ? kind : '');
        });
      },
      createSafeObject: function () {
        var SafeObject = function (value) {
          if (value === null || value === undefined) return {};
          return RealObject(value);
        };
        var safe = [
          'keys', 'values', 'entries', 'fromEntries', 'assign', 'is', 'hasOwn', 'freeze', 'isFrozen', 'seal',
          'isSealed', 'preventExtensions', 'isExtensible', 'getOwnPropertyNames', 'getOwnPropertySymbols',
          'getPrototypeOf'
        ];
        for (var i = 0; i < safe.length; i++) {
          if (safe[i] in RealObject) SafeObject[safe[i]] = RealObject[safe[i]];
        }
        SafeObject.create = function (proto, properties) {
          if (properties !== undefined) {
            throw securityError('Object.create with property descriptors is not allowed (security restriction)');
          }
          return objectCreate(proto);
        };
        SafeObject.prototype = RealObject.prototype;
        var dangerous = [
          'defineProperty', 'defineProperties', 'setPrototypeOf', 'getOwnPropertyDescriptor',
          'getOwnPropertyDescriptors'
        ];
        for (var d = 0; d < dangerous.length; d++) {
          (function (method) {
            SafeObject[method] = function () {
              throw securityError(
                'Object.' + method + ' is not allowed (security restriction: prevents property manipulation attacks)'
              );
            };
          })(dangerous[d]);
        }
        return SafeObject;
      },
      createSafeReflect: function (blocked) {
        var safe = {};
        var names = getOwnPropertyNames(RealmReflect);
        for (var i = 0; i < names.length; i++) {
          if ((',' + blocked + ',').indexOf(',' + names[i] + ',') < 0) safe[names[i]] = RealmReflect[names[i]];
        }
        safe.construct = function construct(target, args) {
          if (
            target === FunctionCtor ||
            target === AsyncFunctionCtor ||
            target === GeneratorFunctionCtor ||
            target === AsyncGeneratorFunctionCtor
          ) {
            throw securityError('Reflect.construct with function constructors is blocked');
          }
          return arguments.length > 2 ? realmConstruct(target, args, arguments[2]) : realmConstruct(target, args);
        };
        return freeze(safe);
      }
    });
  })()`,
  { filename: 'realm-runtime.js' },
);

/** What {@link REALM_RUNTIME_FACTORY_SCRIPT} evaluates to. */
interface RealmRuntimeFactories {
  createForOf(startLoop: () => () => void): unknown;
  createLoops(startLoop: () => () => void): Record<string, unknown>;
  createParallel(isAborted: () => boolean): unknown;
  createReporter(report: (kind: string) => void): unknown;
  createSafeObject(): unknown;
  /** @param blocked Comma-separated names of the Reflect methods the level does not get */
  createSafeReflect(blocked: string): unknown;
}

/** Builds `toolNamespaces` objects inside the sandbox realm (see ../tool-namespaces). */
const TOOL_NAMESPACE_FACTORY_SCRIPT = new ReusableSandboxScript(TOOL_NAMESPACE_FACTORY_SOURCE, {
  filename: 'tool-namespaces.js',
});

/** Builds the script's console inside the sandbox realm (see ../sandbox-console). */
const SANDBOX_CONSOLE_FACTORY_SCRIPT = new ReusableSandboxScript(SANDBOX_CONSOLE_FACTORY_SOURCE, {
  filename: 'console.js',
});

const CONSOLE_FACTORY_SCRIPT = new ReusableSandboxScript(CONSOLE_FACTORY_SOURCE, { filename: 'handler-console.js' });

/** The script's console when a consoleHandler is set, built inside the sandbox realm (see ../console-handler). */
function createHandlerConsole(
  sandbox: vm.Context,
  realmMembrane: RealmMembrane,
  handler: ConsoleHandler,
  limits: ConsoleLimits,
): object {
  const install = CONSOLE_FACTORY_SCRIPT.runInContext(sandbox) as (
    write: ReturnType<typeof createConsoleSink>,
    maxCalls: number,
    maxBytes: number,
  ) => object;
  // The console of the realm calls the host's sink through a function of the realm
  return install(
    realmMembrane.wrap(createConsoleSink(handler, limits), true),
    limits.maxConsoleCalls,
    limits.maxConsoleOutputBytes,
  );
}

/**
 * Protected identifier prefixes that cannot be modified from sandbox code
 * Security: Prevents runtime override attacks on safe functions
 */
const PROTECTED_PREFIXES = ['__safe_', '__ag_'];

/**
 * Console statistics for tracking I/O flood attacks
 * @internal
 */
interface ConsoleStats {
  totalBytes: number;
  callCount: number;
}

/**
 * Create a rate-limited console wrapper
 * Security: Prevents I/O flood attacks via excessive console.log output
 *
 * @param config Configuration with maxConsoleOutputBytes and maxConsoleCalls
 * @param stats Mutable stats object to track output across all console methods
 * @returns Safe console object with rate limiting
 */
function createSafeConsole(
  config: { maxConsoleOutputBytes: number; maxConsoleCalls: number },
  stats: ConsoleStats,
): { log: typeof console.log; error: typeof console.error; warn: typeof console.warn; info: typeof console.info } {
  const wrap =
    (method: (...args: unknown[]) => void) =>
    (...args: unknown[]) => {
      // Check call count limit BEFORE doing any work
      stats.callCount++;
      if (stats.callCount > config.maxConsoleCalls) {
        throw createSafeError(
          `Console call limit exceeded (max: ${config.maxConsoleCalls}). ` + `This limit prevents I/O flood attacks.`,
          'SecurityError',
        );
      }

      // Calculate output size
      const output = args
        .map((a) => {
          if (a === undefined) return 'undefined';
          if (a === null) return 'null';
          if (typeof a === 'object') {
            try {
              return JSON.stringify(a);
            } catch {
              return String(a);
            }
          }
          return String(a);
        })
        .join(' ');

      // Check output size limit
      stats.totalBytes += output.length;
      if (stats.totalBytes > config.maxConsoleOutputBytes) {
        throw createSafeError(
          `Console output size limit exceeded (max: ${config.maxConsoleOutputBytes} bytes). ` +
            `This limit prevents I/O flood attacks.`,
          'SecurityError',
        );
      }

      // Safe to call the real console method with pre-stringified output only
      method(output);
    };

  return {
    log: wrap(console.log.bind(console)),
    error: wrap(console.error.bind(console)),
    warn: wrap(console.warn.bind(console)),
    info: wrap(console.info.bind(console)),
  };
}

/**
 * Check if an identifier is protected
 */
function isProtectedIdentifier(prop: string | symbol): boolean {
  if (typeof prop !== 'string') return false;
  return PROTECTED_PREFIXES.some((prefix) => prop.startsWith(prefix));
}

/**
 * Create a protected sandbox context using Proxy
 * Security: Prevents runtime reassignment of __safe_* and __ag_* functions
 *
 * @param sandbox The original VM context sandbox
 * @returns A proxy that protects reserved identifiers from modification
 */
function createProtectedSandbox(sandbox: vm.Context): vm.Context {
  return new Proxy(sandbox, {
    set(target, prop, value) {
      if (isProtectedIdentifier(prop)) {
        throw createSafeError(
          `Cannot modify protected identifier "${String(prop)}". ` +
            `Identifiers starting with ${PROTECTED_PREFIXES.map((p) => `"${p}"`).join(
              ', ',
            )} are protected runtime functions.`,
          'SecurityError',
        );
      }
      return Reflect.set(target, prop, value);
    },
    defineProperty(target, prop, descriptor) {
      if (isProtectedIdentifier(prop)) {
        throw createSafeError(
          `Cannot define protected identifier "${String(prop)}". ` +
            `Identifiers starting with ${PROTECTED_PREFIXES.map((p) => `"${p}"`).join(
              ', ',
            )} are protected runtime functions.`,
          'SecurityError',
        );
      }
      return Reflect.defineProperty(target, prop, descriptor);
    },
    deleteProperty(target, prop) {
      if (isProtectedIdentifier(prop)) {
        throw createSafeError(
          `Cannot delete protected identifier "${String(prop)}". ` +
            `Identifiers starting with ${PROTECTED_PREFIXES.map((p) => `"${p}"`).join(
              ', ',
            )} are protected runtime functions.`,
          'SecurityError',
        );
      }
      return Reflect.deleteProperty(target, prop);
    },
  });
}

/**
 * Node.js 24 dangerous globals that should be removed per security level
 * These globals can be used for various escape/attack vectors
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
 * Remove the dangerous globals of a security level from the sandbox realm.
 *
 * The intrinsics live on the realm's global object, not on the sandbox object passed to
 * `vm.createContext`: `'Function' in context` is false and `delete context.Function` does nothing, so
 * removing them through the sandbox object left every one of them in place. They are deleted by a
 * script evaluated INSIDE the realm. A name that cannot be deleted there is shadowed with an
 * `undefined`, read-only property on the sandbox object, which the realm's global lookup consults
 * first.
 *
 * `Proxy` is removed at every level, unlike in the double VM. This adapter's membrane proxies host
 * functions directly, and the engine attributes a Proxy to the realm of its innermost target: a
 * script that wrapped any sandbox function in a Proxy of its own and awaited `{ then: thatProxy }`
 * would be handed resolving functions of the HOST realm (see ATK-REALM). Without `Proxy` a script
 * has no way to observe what the engine passes to a callable it did not write.
 *
 * Call this LAST, after every trusted setup script has captured the intrinsics it needs.
 *
 * @param context The VM context to sanitize
 * @param securityLevel The security level to determine which globals to remove
 */
function removeDangerousGlobals(context: vm.Context, securityLevel: SecurityLevel): void {
  const names = [...new Set([...NODEJS_24_DANGEROUS_GLOBALS[securityLevel], 'Proxy'])];
  let notDeleted = names;
  try {
    // Returns the names still present, comma-separated (a string, so no realm object crosses).
    const remaining = compileSandboxScript(
      `(function (g, names) {
        var left = [];
        for (var i = 0; i < names.length; i++) {
          try { delete g[names[i]]; } catch (e) {}
          if (names[i] in g) left.push(names[i]);
        }
        return left.join(',');
      })(this, ${JSON.stringify(names)})`,
      { filename: 'sanitize.js' },
    ).runInContext(context) as unknown;
    notDeleted = typeof remaining === 'string' && remaining ? remaining.split(',') : [];
  } catch {
    // Fall back to shadowing every name below.
  }

  for (const name of notDeleted) {
    try {
      Object.defineProperty(context, name, {
        value: undefined,
        writable: false,
        configurable: false,
        enumerable: false,
      });
    } catch {
      // Already defined by the runtime under this name (for example the safe Reflect).
    }
  }
}

/**
 * VM-based sandbox adapter
 *
 * Uses Node.js vm module to execute AgentScript code in an isolated context.
 * Injects safe runtime wrappers and controls available globals.
 */
export class VmAdapter implements SandboxAdapter {
  private context?: vm.Context;
  private readonly securityLevel: SecurityLevel;

  constructor(securityLevel: SecurityLevel = 'STANDARD') {
    this.securityLevel = securityLevel;
  }

  /**
   * Execute code in the VM sandbox
   *
   * @param code Transformed AgentScript code to execute
   * @param executionContext Execution context with config and handlers
   * @returns Execution result
   */
  async execute<T = unknown>(code: string, executionContext: ExecutionContext): Promise<ExecutionResult<T>> {
    const { stats, config } = executionContext;
    const startTime = Date.now();

    // A promise rejection the script leaves unhandled must not end the host process
    guardSandboxRejections();

    // Create memory tracker if memory limit is configured
    // This tracks string/array allocations and enforces the limit
    const memoryTracker =
      config.memoryLimit && config.memoryLimit > 0
        ? new MemoryTracker({
            memoryLimit: config.memoryLimit,
            trackStrings: true,
            trackArrays: true,
            trackObjects: false, // Object tracking has higher overhead, skip for now
          })
        : undefined;

    // Start tracking before execution
    memoryTracker?.start();

    // Set once the realm has its deadline check (see ../deadline-guard)
    let endDeadlineChecks: (() => void) | undefined;

    try {
      // Create sandbox context with safe globals only
      // IMPORTANT: Use empty object to get NEW isolated prototypes
      // codeGeneration.strings=false disables new Function() and eval() from strings
      // This prevents sandbox escape via constructor chain: [][c][c]('malicious code')
      // The sandbox object has NO prototype. The realm resolves a bare identifier through this
      // object's prototype chain before its own global, so with a plain `{}` (whose prototype is
      // the HOST's Object.prototype) the bare names `constructor`, `toString`, `valueOf`, ... were
      // raw host functions inside the sandbox: `constructor` was the host's Object.
      const baseSandbox = vm.createContext(Object.create(null) as Record<string, unknown>, {
        codeGeneration: { strings: false, wasm: false },
      });

      // Before anything else runs in the realm: no stack traces for the errors made there.
      STACK_CAPTURE_OFF_SCRIPT.runInContext(baseSandbox);

      // Capture sandbox-realm helpers before any sanitization touches the realm's globals:
      // - the realm bridge re-creates host-function results as sandbox-realm values;
      // - the tool-namespace factory builds `toolNamespaces` objects inside the realm;
      // - the console factory builds the script's console inside the realm.
      // The realm's half of the membrane comes first: every host function that realm code is
      // handed below is wrapped by it, and so is every value of the host a script can hold.
      const realmMembrane = REALM_GUARD_SCRIPT.runInContext(baseSandbox) as RealmMembrane;
      const airlock = createRealmAirlock(realmMembrane);
      REALM_SYMBOL_REGISTRY_SCRIPT.runInContext(baseSandbox);
      const realmBridge = (
        SANDBOX_REALM_BRIDGE_SCRIPT.runInContext(baseSandbox) as (own: RealmMembrane['own']) => SandboxRealmBridge
      )(realmMembrane.own);
      const detachGlobalPrototype = DETACH_GLOBAL_PROTOTYPE_SCRIPT.runInContext(baseSandbox) as () => void;
      const realmRuntime = REALM_RUNTIME_FACTORY_SCRIPT.runInContext(baseSandbox) as RealmRuntimeFactories;

      // What sanitizeValue and the call gate use to get from a value a script holds to the host
      // object behind it: through the airlock, then through the secure proxy.
      const unwrapHostValue = <V>(value: V): V => unwrapSecureProxy(airlock.toHost(value));

      // The host's per-loop iteration counter. Realm code calls both functions, so both are
      // functions of the realm around the host's (called raw, a stack overflow at the entry of
      // one was a HOST RangeError in the script's catch block).
      const startLoop = realmMembrane.wrap(() => {
        let iterations = 0;
        return realmMembrane.wrap(() => {
          if (executionContext.aborted) {
            throw createSafeError('Execution aborted');
          }
          iterations++;
          stats.iterationCount++;
          if (iterations > config.maxIterations) {
            throw createSafeError(
              `Maximum iteration limit exceeded (${config.maxIterations}). This limit prevents infinite loops.`,
            );
          }
        }, false);
      }, false);

      // for...of with the iteration limit, as a generator of the sandbox realm. (The safe
      // runtime's __safe_forOf is a host generator function, which the membrane cannot wrap.)
      const realmHelpers: Record<string, unknown> = {
        __safe_forOf: realmRuntime.createForOf(startLoop),
        ...realmRuntime.createLoops(startLoop),
        __safe_parallel: realmRuntime.createParallel(
          realmMembrane.wrap(() => executionContext.aborted === true, false),
        ),
      };
      for (const [name, value] of Object.entries(realmHelpers)) {
        Object.defineProperty(baseSandbox, name, {
          value,
          writable: false,
          configurable: false,
          enumerable: true,
        });
      }
      // The script's cooperative deadline (see ../deadline-guard): vm's timeout below only covers
      // the script up to its first await.
      // What it evaluates to ends the checks: called when the execution is over (see `finally`
      // below), it makes whatever the script left behind stop at its next function entry or loop
      // iteration instead of going on until the deadline.
      endDeadlineChecks = compileSandboxScript(realmTickSource(config.timeout), {
        filename: 'deadline.js',
      }).runInContext(baseSandbox) as () => void;
      const installToolNamespaces = executionContext.toolNamespaces?.length
        ? (TOOL_NAMESPACE_FACTORY_SCRIPT.runInContext(baseSandbox) as unknown)
        : undefined;
      const handlerConsole = executionContext.consoleHandler
        ? createHandlerConsole(baseSandbox, realmMembrane, executionContext.consoleHandler, config)
        : undefined;
      const installConsole = handlerConsole
        ? undefined
        : (SANDBOX_CONSOLE_FACTORY_SCRIPT.runInContext(baseSandbox) as InstallSandboxConsole);

      // Every call into a host function passed in `globals` goes through this gate
      // (abort check, maxGlobalFunctionCalls, result sanitization, safe errors).
      const globalFunctionGate = createGlobalFunctionGate(executionContext, realmBridge, unwrapHostValue);

      // The host side of the runtime: only the direct-mode tool call function and the value
      // globals. The sandbox realm has intrinsics of its own; it is given none of the host's.
      const safeRuntime = createSafeRuntime(executionContext, {
        sidecar: executionContext.sidecar,
        referenceConfig: executionContext.referenceConfig,
        secureProxyConfig: executionContext.secureProxyConfig,
        memoryTracker, // Pass tracker for allocation monitoring
        globalFunctionGate,
        exposeToSandbox: airlock.toRealm,
        ownedBySandbox: airlock.isRealmValue,
        hostObjects: false,
      });

      // CRITICAL: Inject memory-safe prototype methods BEFORE sanitizeVmContext
      // This must happen FIRST because sanitizeVmContext replaces the intrinsic Object
      // with SafeObject. The patch needs the intrinsic Object.getPrototypeOf to access
      // the VM's actual String.prototype and Array.prototype (not the global realm's).
      // Security: Prevents ATK-JSON-03 (Parser Bomb) and similar attacks
      // that use repeat()/join() to allocate massive strings before we can track them
      // The check happens BEFORE allocation, not after
      //
      // SECURITY FIX (Vector 320): Track CUMULATIVE memory usage across all allocations
      // Previously only checked if single allocation exceeded limit, allowing attackers
      // to create many smaller allocations that together exceed the limit.
      if (memoryTracker && config.memoryLimit && config.memoryLimit > 0) {
        // Inject memory tracking callback into the sandbox
        // This allows the patched methods to track cumulative memory in the host
        Object.defineProperty(baseSandbox, '__host_memory_track__', {
          // A function of the realm around the host's: the patched methods call it from realm code
          value: realmMembrane.wrap((bytes: number) => {
            try {
              memoryTracker.track(bytes);
            } catch (err: unknown) {
              // SECURITY: never throw a host Error into the sandbox realm (its prototype chain
              // reaches the host Function constructor): the error is replaced here.
              const code = (err as { code?: unknown } | null)?.code;
              throw createSafeError(
                err instanceof Error ? err.message : 'Memory tracking failed',
                err instanceof Error ? err.name : 'Error',
                typeof code === 'string' ? code : undefined,
              );
            }
          }, false),
          writable: false,
          configurable: true,
          enumerable: false,
        });

        const patchScript = compileSandboxScript(`
          (function() {
            // Strict mode: an unbound call (const f = [].fill; f(0)) must fail on its undefined
            // "this". In sloppy mode "this" was coerced to the realm's global object, and fill
            // RETURNED it.
            'use strict';
            // The functions of Math, not the object: a script can assign to its members, and a
            // replaced Math.max would decide what a fill is charged.
            var Math = (function (M) { return { max: M.max, min: M.min, round: M.round }; })(globalThis.Math);
            var memoryLimit = ${numericLiteral('memoryLimit', config.memoryLimit)};
            var trackMemory = __host_memory_track__;

            // A size is only usable when it is a positive number. NaN (a missing or non-numeric
            // count, a receiver without a numeric length) must never reach the tracker: added to
            // its running total it turns the total into NaN, and no limit check fires after that.
            function saneSize(n) { return (typeof n === 'number' && n > 0) ? n : 0; }

            // Charge what was really allocated when it is more than the estimate (a receiver or an
            // argument that reports one size and then produces another).
            function chargeActual(result, estimated, label) {
              var actual = (typeof result === 'string') ? result.length * 2 : 0;
              if (actual > estimated) {
                if (actual > memoryLimit) {
                  throw new RangeError(label + ' would exceed memory limit');
                }
                trackMemory(actual - estimated);
              }
              return result;
            }

            // Get the ACTUAL prototype used by string literals in this realm
            // Using Object.getPrototypeOf('') gets the intrinsic String.prototype
            var stringProto = Object.getPrototypeOf('');
            var arrayProto = Object.getPrototypeOf([]);

            // Patch string repeat - primary attack vector for string bombs
            var originalRepeat = stringProto.repeat;
            stringProto.repeat = function(count) {
              // Pre-check: estimate size BEFORE allocation (2 bytes per char, UTF-16)
              var estimatedSize = saneSize(this.length * saneSize(+count) * 2);
              if (estimatedSize > memoryLimit) {
                throw new RangeError('String.repeat would exceed memory limit: ' +
                  Math.round(estimatedSize / 1024 / 1024) + 'MB > ' +
                  Math.round(memoryLimit / 1024 / 1024) + 'MB');
              }
              // Track cumulative memory BEFORE allocation (throws if limit exceeded)
              trackMemory(estimatedSize);
              return chargeActual(originalRepeat.call(this, count), estimatedSize, 'String.repeat');
            };

            // Patch array join - can create huge strings from large arrays
            var originalJoin = arrayProto.join;
            arrayProto.join = function(separator) {
              // Estimate: separator between each element + element string lengths
              var sep = separator === undefined ? ',' : String(separator);
              var estimatedSize = 0;
              for (var i = 0; i < this.length; i++) {
                var item = this[i];
                estimatedSize += (item === null || item === undefined) ? 0 : String(item).length;
                if (i > 0) estimatedSize += sep.length;
              }
              estimatedSize = saneSize(estimatedSize * 2); // UTF-16
              if (estimatedSize > memoryLimit) {
                throw new RangeError('Array.join would exceed memory limit: ' +
                  Math.round(estimatedSize / 1024 / 1024) + 'MB > ' +
                  Math.round(memoryLimit / 1024 / 1024) + 'MB');
              }
              trackMemory(estimatedSize);
              return chargeActual(originalJoin.call(this, separator), estimatedSize, 'Array.join');
            };

            // Patch string padStart/padEnd - can pad to huge sizes
            var originalPadStart = stringProto.padStart;
            var originalPadEnd = stringProto.padEnd;

            stringProto.padStart = function(targetLength, padString) {
              var estimatedSize = saneSize(Math.max(saneSize(this.length), saneSize(+targetLength)) * 2);
              if (estimatedSize > memoryLimit) {
                throw new RangeError('String.padStart would exceed memory limit');
              }
              trackMemory(estimatedSize);
              return chargeActual(originalPadStart.call(this, targetLength, padString), estimatedSize, 'String.padStart');
            };

            stringProto.padEnd = function(targetLength, padString) {
              var estimatedSize = saneSize(Math.max(saneSize(this.length), saneSize(+targetLength)) * 2);
              if (estimatedSize > memoryLimit) {
                throw new RangeError('String.padEnd would exceed memory limit');
              }
              trackMemory(estimatedSize);
              return chargeActual(originalPadEnd.call(this, targetLength, padString), estimatedSize, 'String.padEnd');
            };

            // Patch array fill - converts sparse arrays to dense (allocates memory)
            // Vector 1110/1170: Array(dynamicSize).fill() can exhaust memory
            // Estimate: each element uses ~8 bytes (pointer) for objects/primitives
            var originalFill = arrayProto.fill;
            arrayProto.fill = function(value, start, end) {
              // Calculate actual fill range
              var len = this.length >>> 0;
              var relativeStart = start === undefined ? 0 : (start >> 0);
              var relativeEnd = end === undefined ? len : (end >> 0);
              var k = relativeStart < 0 ? Math.max(len + relativeStart, 0) : Math.min(relativeStart, len);
              var finalEnd = relativeEnd < 0 ? Math.max(len + relativeEnd, 0) : Math.min(relativeEnd, len);
              var fillCount = Math.max(0, finalEnd - k);

              // Estimate memory: 8 bytes per element (pointer size)
              var estimatedSize = fillCount * 8;
              if (estimatedSize > memoryLimit) {
                throw new RangeError('Array.fill would exceed memory limit: ' +
                  Math.round(estimatedSize / 1024 / 1024) + 'MB > ' +
                  Math.round(memoryLimit / 1024 / 1024) + 'MB');
              }
              trackMemory(estimatedSize);
              return originalFill.call(this, value, start, end);
            };

            // Array.from and Array.of build an array of any size in one call: charged for what
            // they built (8 bytes per element), on the realm's own Array, so that the constructor
            // of any array literal is covered as well.
            var RealArray = arrayProto.constructor;
            var apply = Reflect.apply;
            var originalFrom = RealArray.from;
            var originalOf = RealArray.of;
            RealArray.from = function from() {
              var result = apply(originalFrom, this, arguments);
              trackMemory(saneSize(result && result.length) * 8);
              return result;
            };
            RealArray.of = function of() {
              var result = apply(originalOf, this, arguments);
              trackMemory(saneSize(result && result.length) * 8);
              return result;
            };
          })();
        `);
        patchScript.runInContext(baseSandbox);
      }

      // Arrays that grow are accounted for like strings that grow (see ../realm-memory), and the
      // helpers the transformed code calls around an array literal with spreads are defined.
      // Always: without a memory limit the helpers count nothing.
      compileSandboxScript(
        realmArrayAccountingSource(
          memoryTracker && config.memoryLimit && config.memoryLimit > 0 ? config.memoryLimit : 0,
        ),
        { filename: 'array-accounting.js' },
      ).runInContext(baseSandbox);

      // __safe_concat and __safe_template, defined inside the realm by the same code as in the
      // double VM (they read __host_memory_track__, which is why it is still there).
      const shouldHardenStacks = config.sanitizeStackTraces ?? true;
      const blockedProperties = executionContext.secureProxyConfig
        ? buildBlockedPropertiesFromConfig(executionContext.secureProxyConfig)
        : getBlockedPropertiesForLevel(this.securityLevel);
      compileSandboxScript(
        innerRealmRuntimeSource({
          stackTraceHardeningCode: shouldHardenStacks ? STACK_TRACE_HARDENING_CODE : '',
          allowComposites: executionContext.referenceConfig?.allowComposites === true,
          memoryLimit: memoryTracker && config.memoryLimit && config.memoryLimit > 0 ? config.memoryLimit : 0,
          blockedProperties: [...blockedProperties],
        }),
        { filename: 'realm-concat.js' },
      ).runInContext(baseSandbox);

      // Defense-in-depth: Remove host callback from sandbox global after capture
      try {
        delete (baseSandbox as any)['__host_memory_track__'];
      } catch {
        /* ignore */
      }

      // SECURITY HARDENING: prevent leaking host stack traces via error.stack inside the sandbox.
      // Must run BEFORE the safe Object replaces the realm's (it blocks defineProperty).
      if (shouldHardenStacks) {
        try {
          STACK_TRACE_HARDENING_SCRIPT.runInContext(baseSandbox);
        } catch {
          // Ignore if the environment forbids patching (defense-in-depth only)
        }
      }

      // STRICT/SECURE: record code-generation attempts (Function/eval) even if caught.
      // This prevents reconnaissance loops that probe blocked primitives and then "return success".
      const isStrictOrSecure = this.securityLevel === 'STRICT' || this.securityLevel === 'SECURE';
      const policyViolation: { type?: string } = {};
      if (isStrictOrSecure) {
        Object.defineProperty(baseSandbox, '__ag_reportViolation__', {
          // A function of the sandbox realm that calls the host's recorder
          value: realmRuntime.createReporter(
            realmMembrane.wrap((type: string) => {
              if (!policyViolation.type) policyViolation.type = String(type);
            }, false),
          ),
          writable: false,
          configurable: false,
          enumerable: false,
        });
        try {
          CODE_GENERATION_VIOLATION_DETECTOR_SCRIPT.runInContext(baseSandbox);
        } catch {
          // Best-effort only; codeGeneration.strings=false still blocks execution.
        }
      }

      // TOOL BRIDGE (string mode): define __safe_callTool inside the VM realm and
      // communicate with the host tool handler via JSON string envelopes.
      if (config.toolBridge?.mode === 'string') {
        const maxPayloadBytes = config.toolBridge?.maxPayloadBytes ?? 5 * 1024 * 1024;
        // The call is counted, and checked against maxToolCalls, where the script makes it. The
        // bridge itself is started from a microtask (see callBridge below): by then every call
        // of the same tick has been counted, so the bridge neither counts nor compares again.
        const hostToolBridge = createHostToolBridge(executionContext, { updateStats: false, limitChecked: true });
        const limitMessage = toolCallLimitMessage(config.maxToolCalls);
        // Calls that were within the limit when they were made and are not started yet. A start
        // uses one up: the host starts no more calls than it admitted, whatever asks for it.
        let admitted = 0;

        // Both are functions of the realm around the host's (see REALM_GUARD_SCRIPT).
        Object.defineProperty(baseSandbox, '__host_callToolBridge__', {
          value: {
            count: realmMembrane.wrap((): boolean => {
              stats.toolCallCount++;
              if (stats.toolCallCount > config.maxToolCalls) {
                return false;
              }
              admitted++;
              return true;
            }, false),
            start: realmMembrane.wrap(
              (requestJson: string, resolve: (responseJson: string) => void, reject: (error: unknown) => void) => {
                if (admitted <= 0) {
                  resolve(
                    encodeToolBridgeFailure('ToolLimitError', limitMessage, 'MAX_TOOL_CALLS_EXCEEDED', maxPayloadBytes),
                  );
                  return;
                }
                admitted--;
                hostToolBridge(requestJson).then(resolve, (reason: unknown) => {
                  reject(createSafeError(reason instanceof Error ? reason.message : 'Tool bridge failed'));
                });
              },
              false,
            ),
          },
          writable: false,
          configurable: true, // allow deletion after capture
          enumerable: false,
        });

        const bridgeInitScript = compileSandboxScript(`
          (function() {
            var bridge = __host_callToolBridge__;
            var countCall = bridge && bridge.count;
            var startCall = bridge && bridge.start;
            var stringify = JSON.stringify;
            var parse = JSON.parse;
            var hasOwn = Object.prototype.hasOwnProperty;
            var RealmPromise = Promise;
            var promiseThen = Promise.prototype.then;
            var settled = Promise.resolve();
            var reflectApply = Reflect.apply;
            var maxBytes = ${numericLiteral('toolBridge.maxPayloadBytes', maxPayloadBytes)};
            var limitMessage = ${JSON.stringify(limitMessage)};

            // Tool calls whose host bridge has not been started yet.
            var pending = [];
            var scheduled = false;
            function startPending() {
              scheduled = false;
              var calls = pending;
              pending = [];
              for (var i = 0; i < calls.length; i++) {
                try {
                  startCall(calls[i].request, calls[i].resolve, calls[i].reject);
                } catch (e) {
                  calls[i].reject(e);
                }
              }
            }

            // A promise of this realm for the bridge's response, with the host bridge started from
            // a microtask instead of from where the script is. A script can call a tool with the
            // stack nearly full; started there, the host's async bridge failed halfway and left a
            // rejected HOST promise that Node.js kept listed as unhandled, which ends the process.
            function callBridge(requestJson) {
              return new RealmPromise(function (resolve, reject) {
                // Scheduled before it is queued: if this cannot finish because the stack is full,
                // nothing is left in the queue for a later flush to start on the script's behalf.
                if (!scheduled) {
                  reflectApply(promiseThen, settled, [startPending]);
                  scheduled = true;
                }
                pending[pending.length] = { request: requestJson, resolve: resolve, reject: reject };
              });
            }

            // Remove global handle after capture (defense-in-depth)
            try { delete globalThis.__host_callToolBridge__; } catch (e) { /* ignore */ }

            // Whether a payload is larger than the limit in UTF-8 bytes, as the host counts it. A code
            // unit is 1 to 3 bytes (a surrogate pair is 4), so only lengths in between are counted.
            function exceedsPayloadLimit(str) {
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

            function makeError(message, name) {
              var err = new Error(message);
              if (name) err.name = name;
              return err;
            }

            return async function __safe_callTool(toolName, args, options) {
              // callTool options: only { throwOnError: false } changes behavior. Tool failures
              // then resolve to { success: false, error }; the enclave's own refusals still throw.
              var throwOnError = true;
              if (options !== undefined && options !== null) {
                if (typeof options !== 'object') {
                  throw makeError('callTool options must be an object', 'TypeError');
                }
                throwOnError = options.throwOnError !== false;
              }
              if (typeof toolName !== 'string' || !toolName) {
                throw makeError('Tool name must be a non-empty string', 'TypeError');
              }
              if (typeof args !== 'object' || args === null || Array.isArray(args)) {
                throw makeError('Tool arguments must be an object', 'TypeError');
              }
              if (typeof startCall !== 'function' || typeof countCall !== 'function') {
                throw makeError('Tool bridge is not available', 'Error');
              }

              // Defense-in-depth: ensure JSON-serializable input.
              var sanitizedArgs;
              try {
                sanitizedArgs = parse(stringify(args));
              } catch (e) {
                throw makeError('Tool arguments must be JSON-serializable', 'TypeError');
              }

              var requestJson;
              try {
                requestJson = stringify({ v: 1, tool: toolName, args: sanitizedArgs });
              } catch (e) {
                throw makeError('Tool request must be JSON-serializable', 'TypeError');
              }

              if (exceedsPayloadLimit(requestJson)) {
                throw makeError('Tool request exceeds maximum size (' + maxBytes + ' bytes)', 'RangeError');
              }

              // Counted here, where the call is made: the first maxToolCalls calls are the ones
              // that run, also when several are made before any of them is started.
              if (countCall() !== true) {
                throw makeError(limitMessage, 'ToolLimitError');
              }
              var responseJson = await callBridge(requestJson);
              if (typeof responseJson !== 'string') {
                throw makeError('Tool bridge returned invalid response', 'Error');
              }
              // The host refuses an oversized response as a tool failure; this check only backs it
              // up, and reports the same way so { throwOnError: false } resolves it to a result.
              if (exceedsPayloadLimit(responseJson)) {
                var tooLarge = 'Tool response exceeds maximum size (' + maxBytes + ' bytes)';
                if (!throwOnError) {
                  return {
                    __proto__: null,
                    success: false,
                    error: {
                      __proto__: null,
                      name: 'RangeError',
                      message: tooLarge,
                      toolName: toolName,
                      code: 'TOOL_BRIDGE_RESPONSE_TOO_LARGE',
                    },
                  };
                }
                throw makeError(tooLarge, 'RangeError');
              }

              var response;
              try {
                response = parse(responseJson);
              } catch (e) {
                throw makeError('Tool bridge returned invalid JSON', 'Error');
              }

              if (!response || typeof response !== 'object' || Array.isArray(response) || response.v !== 1) {
                throw makeError('Tool bridge returned invalid response', 'Error');
              }

              if (response.ok === true) {
                var value = hasOwn.call(response, 'value') ? response.value : undefined;
                return throwOnError ? value : { __proto__: null, success: true, data: value };
              }

              if (response.ok === false && response.error) {
                var msg = (typeof response.error.message === 'string') ? response.error.message : 'Tool call failed';
                var name = (typeof response.error.name === 'string') ? response.error.name : 'Error';
                if (!throwOnError && response.error.toolError === true) {
                  var info = { __proto__: null, name: name, message: msg, toolName: toolName };
                  if (typeof response.error.code === 'string') info.code = response.error.code;
                  return { __proto__: null, success: false, error: info };
                }
                throw makeError(msg, name);
              }

              throw makeError('Tool bridge returned invalid response', 'Error');
            };
          })()
        `);

        const vmSafeCallTool = bridgeInitScript.runInContext(baseSandbox) as unknown as object;
        const proxiedVmSafeCallTool = createSecureProxy(vmSafeCallTool, {
          levelConfig: executionContext.secureProxyConfig,
        });

        // The secure proxy decides what a script may read off the function and off the promise
        // it returns, but it is a HOST Proxy: handed to the script as it is, its traps were host
        // functions entered straight from script code, and a call at a full stack gave the script
        // a host RangeError. Like every other secure proxy, it goes behind the airlock.
        Object.defineProperty(baseSandbox, '__safe_callTool', {
          value: airlock.toRealm(proxiedVmSafeCallTool),
          writable: false,
          configurable: false,
          enumerable: true,
        });

        // Best-effort cleanup if init script couldn't delete it for any reason.
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          delete (baseSandbox as any).__host_callToolBridge__;
        } catch {
          // ignore
        }
      }

      // The Reflect global of a level that has one: the realm's own namespace without the
      // methods the level does not get. (STRICT has none; removeDangerousGlobals deletes it.)
      // Installed after the tool bridge above: that script captures the realm's own
      // Reflect.apply, which the namespace of SECURE does not have.
      if (this.securityLevel !== 'STRICT') {
        Object.defineProperty(baseSandbox, 'Reflect', {
          value: realmRuntime.createSafeReflect(
            this.securityLevel === 'SECURE' ? 'setPrototypeOf,apply,defineProperty' : 'setPrototypeOf',
          ),
          writable: false,
          configurable: false,
          enumerable: true,
        });
      }

      // Add safe runtime functions to the isolated context as non-writable, non-configurable
      // Security: Prevents runtime override attacks on __safe_* functions
      // Note: 'Object' is installed last, by installSafeObject (with SafeObject)
      for (const [key, value] of Object.entries(safeRuntime)) {
        // Skip what is already defined (the string-mode __safe_callTool above). The direct-mode
        // tool call function is a host function behind a secure proxy: it goes through the airlock.
        if (key in baseSandbox) continue;
        Object.defineProperty(baseSandbox, key, {
          value: airlock.toRealm(value),
          writable: false,
          configurable: false,
          enumerable: true,
        });
      }

      // Add user-provided globals (if any)
      // Security: Wrap ALL custom globals with secure proxy to prevent prototype chain attacks
      // This blocks access to __proto__, constructor, and other dangerous properties
      // SECURITY: Use enumerable: false to prevent Object.assign({}, this) from copying globals
      // This blocks Vector 380 (Bridge-Serialized State Reflection) attack
      // SECURITY: functions are wrapped too, with the global-function gate, so no call into a host
      // function bypasses the limits or hands an unsanitized host value to the script.
      // SECURITY: what the script holds is never the secure proxy itself (a host Proxy with host
      // traps) but a proxy of its own realm in front of it (see ../realm-airlock), which also makes
      // every value from `globals` read-only, as in the double VM.
      if (config.globals) {
        for (const [key, value] of Object.entries(config.globals)) {
          // Only proxy objects and functions, primitives are safe as-is
          const wrappedValue =
            value !== null && (typeof value === 'object' || typeof value === 'function')
              ? airlock.toRealm(
                  createSecureProxy(value as object, {
                    levelConfig: executionContext.secureProxyConfig,
                    callGate: globalFunctionGate,
                    exposeToSandbox: airlock.toRealm,
                    ownedBySandbox: airlock.isRealmValue,
                  }),
                )
              : value;
          // Under its own name and under the name the transformer gives it
          for (const name of [key, `__safe_${key}`]) {
            if (name in baseSandbox) continue;
            Object.defineProperty(baseSandbox, name, {
              value: wrappedValue,
              writable: false,
              configurable: false,
              enumerable: false,
            });
          }
        }
      }

      // Tool namespaces (`mail.list(args)`): realm-local objects whose methods call the gated
      // __safe_callTool, so they are counted, limited and sanitized like any other tool call.
      if (executionContext.toolNamespaces?.length) {
        const callTool = (baseSandbox as Record<string, unknown>)['__safe_callTool'];
        for (const binding of buildToolNamespaceBindings(
          installToolNamespaces,
          callTool,
          executionContext.toolNamespaces,
        )) {
          for (const name of [binding.name, `__safe_${binding.name}`]) {
            Object.defineProperty(baseSandbox, name, {
              value: binding.value,
              writable: false,
              configurable: false,
              enumerable: false,
            });
          }
        }
      }

      // Add __safe_console with rate limiting to prevent I/O flood attacks
      // Security: Limits total output bytes and call count
      // Note: The agentscript transformer converts `console` → `__safe_console` in whitelist mode
      // Skip if user already provided console via globals (already added with the __safe_ prefix above)
      if (!('__safe_console' in baseSandbox)) {
        const consoleStats: ConsoleStats = { totalBytes: 0, callCount: 0 };
        Object.defineProperty(baseSandbox, '__safe_console', {
          value:
            handlerConsole ??
            installConsole?.(
              realmMembrane.wrap(
                createHostConsoleWriter(
                  createSafeConsole(
                    {
                      maxConsoleOutputBytes: config.maxConsoleOutputBytes,
                      maxConsoleCalls: config.maxConsoleCalls,
                    },
                    consoleStats,
                  ),
                ),
                true,
              ),
              ['log', 'error', 'warn', 'info'],
            ),
          writable: false,
          configurable: false,
          enumerable: false,
        });
      }

      // Defense-in-depth: neutralize dangerous methods on the intrinsic Object constructor
      // This must run AFTER all bootstrap/patching but BEFORE user code
      try {
        INTRINSIC_OBJECT_NEUTRALIZATION_SCRIPT.runInContext(baseSandbox);
      } catch {
        /* defense-in-depth */
      }

      // The last setup steps, once the trusted scripts above have captured the intrinsics they need
      // and before any script code runs.
      //
      // 1. Detach the realm's global object from the realm's Object.prototype. Its members are
      //    otherwise in scope as bare identifiers too: `constructor` is the realm's real Object
      //    (not the safe one installed below), `__lookupGetter__` a way around the membrane.
      detachGlobalPrototype();
      // 2. The safe Object global.
      Object.defineProperty(baseSandbox, 'Object', {
        value: realmRuntime.createSafeObject(),
        writable: false,
        configurable: false,
        enumerable: true,
      });
      // 3. Remove the dangerous globals from the sandbox realm.
      removeDangerousGlobals(baseSandbox, this.securityLevel);

      // Wrap sandbox in protective Proxy to catch dynamic assignment attempts
      // Security: Prevents dynamic assignment like `this['__safe_callTool'] = malicious`
      // Note: Cannot use the Proxy as vm.runInContext requires the actual vm.Context
      // The Proxy protection is applied but the underlying context is still used for execution
      const _protectedSandbox = createProtectedSandbox(baseSandbox);

      // Store context reference for disposal
      // Note: Each execute() call creates a fresh context for isolation
      // The stored reference is only used by dispose() for cleanup
      this.context = baseSandbox;

      // Wrap code in async IIFE to handle top-level await
      // Use string concatenation instead of template literals to avoid code injection patterns
      // A strict-mode function, called plainly: `this` is undefined in it and in __ag_main (in
      // sloppy mode a plain call binds `this` to the realm's global object), writes to read-only
      // properties throw instead of being dropped, and `arguments.callee` is unavailable.
      const wrappedCode =
        '(async function () {\n"use strict";\n' +
        code +
        '\nreturn typeof __ag_main === "function" ? await __ag_main() : undefined;\n' +
        '})();';

      // Compile script
      const script = compileSandboxScript(wrappedCode, {
        filename: 'agentscript.js',
      });

      // Execute script with timeout
      // Note: codeGeneration is set in createContext(), not runInContext()
      const resultPromise = script.runInContext(this.context, {
        timeout: config.timeout,
        breakOnSigint: true,
      });

      // Wait for result
      const value = await resultPromise;

      // Update stats
      stats.duration = Date.now() - startTime;
      stats.endTime = Date.now();

      // Capture memory usage if tracking was enabled
      if (memoryTracker) {
        const memSnapshot = memoryTracker.getSnapshot();
        stats.memoryUsage = memSnapshot.peakTrackedBytes;
      }

      // STRICT/SECURE: Fail closed on recorded policy violations even if user code caught them.
      if (isStrictOrSecure && policyViolation.type) {
        return {
          success: false,
          error: {
            name: 'SecurityViolationError',
            message: 'Blocked operation: security policy violation',
            code: 'SECURITY_VIOLATION',
            data: { type: policyViolation.type },
          },
          stats,
        };
      }

      // SECURITY FIX (Vector 340): Check serialized size of return value BEFORE returning.
      // Attacks can create structures with many references to the same large string that
      // appear small in memory (strings are shared by reference) but explode during
      // JSON serialization when each reference becomes a full copy.
      // Example: 500 refs × 5 copies × 10KB = 25MB serialized from ~20KB in-memory
      if (config.memoryLimit && config.memoryLimit > 0 && value !== undefined) {
        // Use memory limit as serialization limit (or a reasonable cap)
        // This prevents the serialization size from exceeding what we'd allow in memory
        const maxSerializedBytes = Math.min(config.memoryLimit, 50 * 1024 * 1024); // Cap at 50MB
        const sizeCheck = checkSerializedSize(value, maxSerializedBytes);

        if (!sizeCheck.ok) {
          return {
            success: false,
            error: {
              name: 'MemoryLimitError',
              message: `Return value serialization would exceed memory limit: ${sizeCheck.error}`,
              code: 'SERIALIZATION_LIMIT_EXCEEDED',
            },
            stats,
          };
        }
      }

      // Sanitize the return value to convert Error objects to { name, message } format
      // This prevents Error objects from serializing to {} and provides useful error info
      // Use security-config-backed values, clamped to allowed ranges (depth: 5-50, properties: 50-1000)
      // Apply sane defaults first to avoid NaN when config values are undefined
      const depthDefaulted = config.maxSanitizeDepth ?? 20;
      const propsDefaulted = config.maxSanitizeProperties ?? 100;
      const clampedDepth = Math.max(5, Math.min(50, depthDefaulted));
      const clampedProperties = Math.max(50, Math.min(1000, propsDefaulted));
      const sanitizedValue = sanitizeValue(value, {
        maxDepth: clampedDepth,
        maxProperties: clampedProperties,
        allowDates: true,
        allowErrors: true,
        // A value of the host that the script returns is read through its target.
        unwrap: unwrapHostValue,
      });

      return {
        success: true,
        value: sanitizedValue as T,
        stats,
      };
    } catch (error: unknown) {
      // What the script threw, as text (see ../thrown-value): nothing below reads the thrown
      // value itself, which may be any object of the sandbox.
      const thrown = describeThrown(error);

      // Update stats
      stats.duration = Date.now() - startTime;
      stats.endTime = Date.now();

      // Capture memory usage even on error
      if (memoryTracker) {
        const memSnapshot = memoryTracker.getSnapshot();
        stats.memoryUsage = memSnapshot.peakTrackedBytes;
      }

      // The memory limit: the host error itself, or the safe error that replaces it wherever it
      // would otherwise have reached the sandbox realm. The safe error only counts where the
      // tracker did refuse an allocation: a script can throw an object that says the same about
      // itself. The figures are the tracker's.
      const isMemoryLimit =
        error instanceof MemoryLimitError ||
        (memoryTracker?.hasExceededLimit() === true && isMemoryLimitPayload(error));
      if (isMemoryLimit) {
        const snapshot = memoryTracker?.getSnapshot();
        return {
          success: false,
          error: {
            name: 'MemoryLimitError',
            message: thrown.message ?? 'Memory limit exceeded',
            code: 'MEMORY_LIMIT_EXCEEDED',
            data: {
              usedBytes: error instanceof MemoryLimitError ? error.usedBytes : (snapshot?.trackedBytes ?? 0),
              limitBytes: error instanceof MemoryLimitError ? error.limitBytes : (config.memoryLimit ?? 0),
            },
          },
          stats,
        };
      }

      // A thrown string is the message itself: the loop iteration limit and the cooperative
      // deadline both throw one, so that the value a script can catch is inert.
      if (typeof error === 'string') {
        return {
          success: false,
          error: {
            name: 'VMExecutionError',
            message: thrown.message ?? '',
            code: 'VM_EXECUTION_ERROR',
          },
          stats,
        };
      }

      // Determine whether to sanitize stack traces based on config
      // Default to true for backwards compatibility if not explicitly set
      const shouldSanitize = config.sanitizeStackTraces ?? true;

      return {
        success: false,
        error: {
          name: thrown.name || 'VMExecutionError',
          message: thrown.message || THROWN_WITHOUT_MESSAGE,
          stack: sanitizeStackTrace(thrown.stack, shouldSanitize),
          code: 'VM_EXECUTION_ERROR',
        },
        stats,
      };
    } finally {
      // The execution is over, whichever way: nothing the script left behind runs on from here
      try {
        endDeadlineChecks?.();
      } catch {
        // The realm is gone
      }
    }
  }

  /**
   * Dispose the VM context and cleanup resources
   */
  dispose(): void {
    // VM contexts are garbage collected automatically
    this.context = undefined;
  }
}
