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

import type { SerializableParentValidationConfig, SerializableSuspiciousPattern } from './types';
import type { SecurityLevel } from '../types';

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
 * Generate code to sanitize the inner VM context
 */
function generateSanitizeContextCode(securityLevel: SecurityLevel): string {
  const globalsToRemove = NODEJS_24_DANGEROUS_GLOBALS[securityLevel];

  return globalsToRemove
    .map(
      (g) => `
  if ('${g}' in innerContext) {
    try { delete innerContext['${g}']; } catch (e) {
      try { innerContext['${g}'] = undefined; } catch (e2) {}
    }
  }`,
    )
    .join('\n');
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
  } = options;

  const sanitizeContextCode = generateSanitizeContextCode(securityLevel);
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
  const innerRealmSafeConcatAndTemplateCode = `
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
  var __ag_allowComposites = ${allowComposites};
  var __ag_memoryLimit = ${memoryLimit};
  var __ag_track = (typeof __host_memory_track__ === 'function') ? __host_memory_track__ : null;

	  // Best-effort secure proxy to block dangerous property access on these runtime helpers.
	  // This mirrors the "constructor/__proto__/prototype" defense-in-depth used elsewhere.
	  var __ag_blocked = new Set(${JSON.stringify(blockedProperties)});
	  function __ag_createSecureProxy(obj, depth) {
	    if (depth === undefined) depth = 0;
	    if (!__ag_Proxy || !__ag_Reflect) return obj;
	    if (depth > 10) return obj;
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
        }
        return __ag_createSecureProxy(value, depth + 1);
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
    // Get injected references from host
    const vm = __host_vm_module__;
    const hostCallTool = __host_callTool__;
    const hostStats = __host_stats__;
    const hostAbortCheck = __host_abort_check__;
    const hostReportViolation = __host_reportViolation__;
    const hostConfig = __host_config__;
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

  function createSafeError(message, name) {
    if (name === undefined) name = 'Error';

    // Create the real error
    var error = new Error(message);
    // NOTE: Use Object.defineProperty instead of direct assignment because
    // Error.prototype.name is frozen, and in strict mode direct assignment fails.
    Object.defineProperty(error, 'name', {
      value: name,
      writable: true,
      enumerable: false,
      configurable: true
    });

    // CRITICAL: sever the *actual* prototype chain (native getters / Object.getPrototypeOf).
    // A shadowing __proto__ data property is not sufficient.
    Object.setPrototypeOf(error, null);

    // Create a null-prototype object to use as a safe "constructor"
    // This object has no prototype chain to climb
    var SafeConstructor = Object.create(null);
    Object.defineProperties(SafeConstructor, {
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
    Object.freeze(SafeConstructor);

    // Override the constructor property on the error instance
    // This breaks the prototype chain: err.constructor.constructor no longer reaches Function
    Object.defineProperty(error, 'constructor', {
      value: SafeConstructor,
      writable: false,
      enumerable: false,
      configurable: false
    });

    // SECURITY: Override __proto__ on the error instance to prevent prototype chain escape
    // Attack vector blocked: err.__proto__.constructor.constructor('malicious code')()
    Object.defineProperty(error, '__proto__', {
      value: null,
      writable: false,
      enumerable: false,
      configurable: false
    });

    // SECURITY: Remove the stack property to prevent information leakage (Vector 1230)
    // The stack trace can reveal internal implementation details like function names,
    // file paths, and line numbers which can be used for reconnaissance attacks.
    Object.defineProperty(error, 'stack', {
      value: undefined,
      writable: false,
      enumerable: false,
      configurable: false
    });

    // Add a unique marker to identify this as a safe error from our runtime
    // This is used by suspicious pattern detection to distinguish our errors from user errors
    Object.defineProperty(error, SAFE_ERROR_MARKER, {
      value: true,
      writable: false,
      enumerable: false,
      configurable: false
    });

    // Freeze the error to prevent modifications
    Object.freeze(error);

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

  // Blocked properties for secure proxy (from security level)
  const blockedPropertiesSet = new Set(${JSON.stringify(blockedProperties)});

  // Whether to throw errors instead of returning undefined for blocked properties
  const throwOnBlocked = ${throwOnBlocked};

  // Whether composite reference handles are allowed (for string concatenation)
  const allowComposites = ${allowComposites};

  // Memory limit in bytes (0 = unlimited)
  const memoryLimit = ${memoryLimit};

  // Reference ID pattern for detecting sidecar references
  const refIdPattern = /^__REF_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}__$/i;

  // Proxy cache to avoid infinite recursion and duplicate wrapping
  const proxyCache = new WeakMap();

  /**
   * Create a secure proxy that blocks access to dangerous properties
   * Defense-in-depth against attacks like: callTool['const' + 'ructor']
   *
   * IMPORTANT: Must respect JavaScript proxy invariants:
   * - Non-configurable properties must return their actual value
   * - Non-configurable non-writable properties cannot be hidden
   */
  function createSecureProxy(obj, depth) {
    if (depth === undefined) depth = 0;
    if (depth > 10) return obj; // Max depth to prevent infinite recursion

    // Skip primitives and null
    if (obj === null || typeof obj !== 'object' && typeof obj !== 'function') {
      return obj;
    }

    // Check cache
    if (proxyCache.has(obj)) {
      return proxyCache.get(obj);
    }

    var proxy = new Proxy(obj, {
      get: function(target, property, receiver) {
        var propName = String(property);

        // Check if property is non-configurable (proxy invariant requires returning actual value)
        var descriptor = Object.getOwnPropertyDescriptor(target, property);
        var isNonConfigurable = descriptor && !descriptor.configurable;

        // Proxy invariant: if the target has a non-configurable, non-writable data property,
        // the proxy must return the exact same value (cannot wrap/bind/proxy it).
        // This matters for hardened properties like Error.prepareStackTrace.
        if (descriptor && isNonConfigurable && 'value' in descriptor && descriptor.writable === false) {
          return descriptor.value;
        }

        // Block dangerous properties - but respect proxy invariants
        if (blockedPropertiesSet.has(propName)) {
          // For non-configurable properties, we MUST return the actual value
          // (JavaScript proxy invariant - can't hide non-configurable properties)
          if (isNonConfigurable) {
            return Reflect.get(target, property, receiver);
          }
          if (throwOnBlocked) {
            throw createSafeError(
              "Security violation: Access to '" + propName + "' is blocked. " +
              "This property can be used for sandbox escape attacks."
            );
          }
          return undefined;
        }

        var value = Reflect.get(target, property, receiver);

        // For function values, bind to target first (preserves internal slot access for Promises, etc.)
        // Then recursively proxy the bound function to block constructor access
        if (typeof value === 'function') {
          var boundMethod = value.bind(target);
          return createSecureProxy(boundMethod, depth + 1);
        }

        // Recursively proxy nested objects to maintain security barrier
        // This prevents attacks like: process.env.__proto__.constructor
        if (value !== null && typeof value === 'object') {
          return createSecureProxy(value, depth + 1);
        }

        return value;
      },
      set: function(target, property, value, receiver) {
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
        return Reflect.set(target, property, value, receiver);
      },
      defineProperty: function(target, property, descriptor) {
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
        return Reflect.defineProperty(target, property, descriptor);
      },
      getOwnPropertyDescriptor: function(target, property) {
        var propName = String(property);
        var descriptor = Reflect.getOwnPropertyDescriptor(target, property);

        // Must return actual descriptor for non-configurable properties (proxy invariant)
        if (descriptor && !descriptor.configurable) {
          return descriptor;
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
        return descriptor;
      },
      ownKeys: function(target) {
        var keys = Reflect.ownKeys(target);
        return keys.filter(function(key) {
          var keyStr = String(key);
          // Keep non-blocked properties
          if (!blockedPropertiesSet.has(keyStr)) {
            return true;
          }
          // Must keep non-configurable properties (proxy invariant)
          var descriptor = Object.getOwnPropertyDescriptor(target, key);
          if (descriptor && !descriptor.configurable) {
            return true;
          }
          // Filter out blocked configurable properties
          return false;
        });
      },
      getPrototypeOf: function(target) {
        // Return null to hide prototype chain
        return null;
      }
    });

    proxyCache.set(obj, proxy);
    return proxy;
  }

  /**
   * Validate an operation before forwarding to host
   */
  function validateOperation(operationName, args) {
    // Rate limiting check with sliding window cleanup
    const now = Date.now();
    // Clean up old entries to prevent unbounded growth (keep only last 2 seconds)
    while (operationHistory.length > 0 && now - operationHistory[0].timestamp > 2000) {
      operationHistory.shift();
    }
    const recentOperations = operationHistory.filter(function(h) { return now - h.timestamp < 1000; });
    if (recentOperations.length >= validationConfig.maxOperationsPerSecond) {
      throw createSafeError('Operation rate limit exceeded (' + validationConfig.maxOperationsPerSecond + ' operations/second)');
    }

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
   * Inner VM's callTool function
   * Proxies through parent VM with validation
   */
  function innerCallTool(toolName, args) {
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

      // Conservative byte estimate: UTF-8 is at most 4 bytes per code unit.
      if (requestJson && (requestJson.length * 4) > toolBridgeMaxPayloadBytes) {
        throw createSafeError('Tool request exceeds maximum size (' + toolBridgeMaxPayloadBytes + ' bytes)');
      }

      promise = hostCallTool(requestJson).then(function(responseJson) {
        if (typeof responseJson !== 'string') {
          throw createSafeError('Tool bridge returned non-string response');
        }

        if ((responseJson.length * 4) > toolBridgeMaxPayloadBytes) {
          throw createSafeError('Tool response exceeds maximum size (' + toolBridgeMaxPayloadBytes + ' bytes)');
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
          if (Object.prototype.hasOwnProperty.call(response, 'value')) {
            return response.value;
          }
          return undefined;
        }

        if (response.ok === false) {
          var err = response.error;
          var msg = (err && typeof err.message === 'string') ? err.message : 'Tool call failed';
          var name = (err && typeof err.name === 'string') ? err.name : 'Error';
          throw createSafeError(msg, name);
        }

        throw createSafeError('Tool bridge returned invalid response');
      });
    } else {
      promise = hostCallTool(toolName, sanitizedArgs);
    }

    // Create a secure promise that wraps both the promise object and its result
    // Note: We can't just wrap the promise because Promise.then/catch/finally must work
    // Instead, we chain the promise to wrap the result
    return createSecureProxy(promise.then(function(result) {
      return createSecureProxy(result);
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
          __host_memory_track__(rightLen * 2); // UTF-16 encoding
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
      __host_memory_track__(result.length * 2);
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
    if (items.length > 100) {
      throw createSafeError('parallel() is limited to 100 items');
    }
    return await Promise.all(items.map(fn));
  }

  /**
   * Rate-limited console for inner VM
   */
  var consoleStats = { totalBytes: 0, callCount: 0 };
  var maxConsoleBytes = hostConfig.maxConsoleOutputBytes || 65536;
  var maxConsoleCalls = hostConfig.maxConsoleCalls || 100;

  function createSafeConsoleMethod(method) {
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
      method.apply(console, arguments);
    };
  }

  var innerConsole = {
    log: createSafeConsoleMethod(console.log.bind(console)),
    error: createSafeConsoleMethod(console.error.bind(console)),
    warn: createSafeConsoleMethod(console.warn.bind(console)),
    info: createSafeConsoleMethod(console.info.bind(console))
  };

  // ============================================================
  // Create Inner VM
  // ============================================================

  // Create completely isolated context
  // codeGeneration.strings=false disables new Function() and eval() from strings
  // This prevents sandbox escape via constructor chain: [][c][c]('malicious code')
  var innerContext = vm.createContext({}, {
    codeGeneration: { strings: false, wasm: false }
  });

  // STRICT/SECURE: record code-generation attempts (Function/eval) even if user code catches them.
  if (${securityLevel === 'STRICT' || securityLevel === 'SECURE'}) {
    try {
      Object.defineProperty(innerContext, '__ag_reportViolation__', {
        value: __ag_reportViolation,
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
      Object.defineProperty(innerContext, '__host_memory_track__', {
        value: __host_memory_track__,
        writable: false,
        configurable: false,
        enumerable: false
      });

      // Run the patching code in innerContext
      var patchCode = '(function() {' +
        'var memoryLimit = ' + memoryLimit + ';' +
        'var trackMemory = __host_memory_track__;' +
        // Get the ACTUAL prototype used by literals in this realm
        'var stringProto = Object.getPrototypeOf("");' +
        'var arrayProto = Object.getPrototypeOf([]);' +
        // Patch string repeat
        'var originalRepeat = stringProto.repeat;' +
        'stringProto.repeat = function(count) {' +
        '  var estimatedSize = this.length * count * 2;' +
        '  if (estimatedSize > memoryLimit) {' +
        '    throw new RangeError("String.repeat would exceed memory limit: " +' +
        '      Math.round(estimatedSize / 1024 / 1024) + "MB > " +' +
        '      Math.round(memoryLimit / 1024 / 1024) + "MB");' +
        '  }' +
        '  trackMemory(estimatedSize);' +
        '  return originalRepeat.call(this, count);' +
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
        '  estimatedSize *= 2;' +
        '  if (estimatedSize > memoryLimit) {' +
        '    throw new RangeError("Array.join would exceed memory limit: " +' +
        '      Math.round(estimatedSize / 1024 / 1024) + "MB > " +' +
        '      Math.round(memoryLimit / 1024 / 1024) + "MB");' +
        '  }' +
        '  trackMemory(estimatedSize);' +
        '  return originalJoin.call(this, separator);' +
        '};' +
        // Patch string padStart/padEnd
        'var originalPadStart = stringProto.padStart;' +
        'var originalPadEnd = stringProto.padEnd;' +
        'stringProto.padStart = function(targetLength, padString) {' +
        '  var estimatedSize = Math.max(this.length, targetLength) * 2;' +
        '  if (estimatedSize > memoryLimit) {' +
        '    throw new RangeError("String.padStart would exceed memory limit");' +
        '  }' +
        '  trackMemory(estimatedSize);' +
        '  return originalPadStart.call(this, targetLength, padString);' +
        '};' +
        'stringProto.padEnd = function(targetLength, padString) {' +
        '  var estimatedSize = Math.max(this.length, targetLength) * 2;' +
        '  if (estimatedSize > memoryLimit) {' +
        '    throw new RangeError("String.padEnd would exceed memory limit");' +
        '  }' +
        '  trackMemory(estimatedSize);' +
        '  return originalPadEnd.call(this, targetLength, padString);' +
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
        '})();';
      var patchScript = new vm.Script(patchCode);
      patchScript.runInContext(innerContext);
    }
  })();

  // Remove dangerous globals from inner VM (AFTER memory patching)
  ${sanitizeContextCode}

  // Freeze built-in prototypes to prevent prototype pollution
  // and cut off constructor chain access for sandbox escape prevention
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
  Object.freeze(Promise.prototype);

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
      'Object.freeze(Promise.prototype);';
    var freezeScript = new vm.Script(freezeCode);
    freezeScript.runInContext(innerContext);
  })();

  // Inject safe runtime functions (non-writable, non-configurable)
  // Wrap with secure proxy to block dangerous property access
  var safeRuntime = {
    __safe_callTool: createSecureProxy(innerCallTool),
    __safe_forOf: createSecureProxy(innerForOf),
    __safe_for: createSecureProxy(innerFor),
    __safe_while: createSecureProxy(innerWhile),
    __safe_doWhile: createSecureProxy(innerDoWhile),
    __safe_parallel: createSecureProxy(innerParallel),
    __safe_console: createSecureProxy(innerConsole),
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
      '  JSON: JSON ' +
      '})';
    var script = new vm.Script(getIntrinsicsCode);
    return script.runInContext(innerContext);
  })();

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
    isNaN: isNaN,
    isFinite: isFinite,
    parseInt: parseInt,
    parseFloat: parseFloat,
    encodeURI: encodeURI,
    decodeURI: decodeURI,
    encodeURIComponent: encodeURIComponent,
    decodeURIComponent: decodeURIComponent
  };

  // SECURITY FIX (Vector 640): Use enumerable: false for defense-in-depth
  // While standard globals (Math, JSON, etc.) are less sensitive than internal functions,
  // making them non-enumerable prevents Object.values(this) from revealing sandbox structure.
  // Skip globals that the user is providing their own version of
  for (var gKey in safeGlobals) {
    if (safeGlobals.hasOwnProperty(gKey)) {
      // If user provides this global, skip so their version takes precedence
      if (hostConfig.globals && hostConfig.globals.hasOwnProperty(gKey)) {
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
  if (hostConfig.globals) {
    for (var uKey in hostConfig.globals) {
      if (hostConfig.globals.hasOwnProperty(uKey)) {
        var wrappedGlobal = createSecureProxy(hostConfig.globals[uKey]);
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

  var userCode = ${JSON.stringify(userCode)};
  // IMPORTANT: For stack overflow errors (RangeError: Maximum call stack size exceeded),
  // Node/V8 may ignore Error.prepareStackTrace when it was installed by a different Script
  // than the one that triggered the overflow. To make stack sanitization reliable,
  // we also prepend the hardening code into the same Script that executes user code.
  var __ag_stackHardenPrefix = sanitizeStackTraces ? (${stackTraceHardeningCodeJson} + '\\n') : '';
  var wrappedCode =
    '(async function() { ' +
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

  // Note: codeGeneration is set in createContext(), not runInContext()
  var result = await script.runInContext(innerContext, {
    timeout: ${innerTimeout},
    breakOnSigint: true
  });

  return result;
})();
`.trim();
}
