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
 */
const NODEJS_24_DANGEROUS_GLOBALS: Record<SecurityLevel, string[]> = {
  STRICT: [
    'Iterator',
    'AsyncIterator',
    'ShadowRealm',
    'WeakRef',
    'FinalizationRegistry',
    'Reflect',
    'Proxy',
    'performance',
    'Temporal',
  ],
  SECURE: ['Iterator', 'AsyncIterator', 'ShadowRealm', 'WeakRef', 'FinalizationRegistry', 'Proxy'],
  STANDARD: ['ShadowRealm', 'WeakRef', 'FinalizationRegistry'],
  PERMISSIVE: ['ShadowRealm'],
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
  const hostConfig = __host_config__;

  // Validation configuration
  const validationConfig = ${JSON.stringify({
    validateOperationNames: validationConfig.validateOperationNames,
    maxOperationsPerSecond: validationConfig.maxOperationsPerSecond,
    blockSuspiciousSequences: validationConfig.blockSuspiciousSequences,
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

        // Block dangerous properties - but respect proxy invariants
        if (blockedPropertiesSet.has(propName)) {
          // For non-configurable properties, we MUST return the actual value
          // (JavaScript proxy invariant - can't hide non-configurable properties)
          if (isNonConfigurable) {
            return Reflect.get(target, property, receiver);
          }
          if (throwOnBlocked) {
            throw new Error(
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
            throw new Error(
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
            throw new Error(
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
            throw new Error(
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
      throw new Error('Operation rate limit exceeded (' + validationConfig.maxOperationsPerSecond + ' operations/second)');
    }

    // Operation name format validation
    if (typeof operationName !== 'string' || !operationName) {
      throw new TypeError('Operation name must be a non-empty string');
    }

    // Operation name pattern validation (whitelist)
    if (validationConfig.validateOperationNames && typeof allowedOperationPattern !== 'undefined') {
      if (!allowedOperationPattern.test(operationName)) {
        throw new Error('Operation "' + operationName + '" does not match allowed pattern');
      }
    }

    // Operation name pattern validation (blacklist)
    if (typeof blockedOperationPatterns !== 'undefined') {
      for (var i = 0; i < blockedOperationPatterns.length; i++) {
        if (blockedOperationPatterns[i].test(operationName)) {
          throw new Error('Operation "' + operationName + '" matches blocked pattern');
        }
      }
    }

    // Suspicious sequence detection
    if (validationConfig.blockSuspiciousSequences) {
      for (var j = 0; j < suspiciousPatterns.length; j++) {
        var pattern = suspiciousPatterns[j];
        try {
          if (pattern.detect(operationName, args, operationHistory)) {
            var patternError = new Error('Suspicious pattern detected: ' + pattern.description + ' [' + pattern.id + ']');
            patternError.__suspiciousPatternError = true;
            throw patternError;
          }
        } catch (e) {
          // Only propagate errors from our own pattern detection (using marker property)
          if (e.__suspiciousPatternError === true) {
            throw e;
          }
          // Ignore detection errors from user-provided patterns - they may have bugs
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
      throw new Error('Execution aborted');
    }

    // Increment count and check limit
    toolCallCount++;
    if (toolCallCount > ${maxToolCalls}) {
      throw new Error('Maximum tool call limit exceeded (${maxToolCalls}). This limit prevents runaway script execution.');
    }

    // Validate args
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      throw new TypeError('Tool arguments must be an object');
    }

    // Double sanitization (defense in depth)
    var sanitizedArgs;
    try {
      sanitizedArgs = JSON.parse(JSON.stringify(args));
    } catch (e) {
      throw new Error('Tool arguments must be JSON-serializable');
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
    var promise = hostCallTool(toolName, sanitizedArgs);

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
        throw new Error('Execution aborted');
      }
      iterations++;
      hostStats.iterationCount++;
      if (iterations > ${maxIterations}) {
        throw new Error('Maximum iteration limit exceeded (${maxIterations}). This limit prevents infinite loops.');
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
        throw new Error('Execution aborted');
      }
      iterations++;
      hostStats.iterationCount++;
      if (iterations > ${maxIterations}) {
        throw new Error('Maximum iteration limit exceeded (${maxIterations}). This limit prevents infinite loops.');
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
        throw new Error('Execution aborted');
      }
      iterations++;
      hostStats.iterationCount++;
      if (iterations > ${maxIterations}) {
        throw new Error('Maximum iteration limit exceeded (${maxIterations}). This limit prevents infinite loops.');
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
        throw new Error('Execution aborted');
      }
      iterations++;
      hostStats.iterationCount++;
      if (iterations > ${maxIterations}) {
        throw new Error('Maximum iteration limit exceeded (${maxIterations}). This limit prevents infinite loops.');
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
        throw new Error(
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
          throw new Error(
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
      throw new Error(
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
      throw new TypeError('parallel() requires an array');
    }
    if (items.length > 100) {
      throw new Error('parallel() is limited to 100 items');
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
        throw new Error('Console call limit exceeded (max: ' + maxConsoleCalls + '). This limit prevents I/O flood attacks.');
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
        throw new Error('Console output size limit exceeded (max: ' + maxConsoleBytes + ' bytes). This limit prevents I/O flood attacks.');
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
  var innerContext = vm.createContext({});

  // Remove dangerous globals from inner VM
  ${sanitizeContextCode}

  // Inject safe runtime functions (non-writable, non-configurable)
  // Wrap with secure proxy to block dangerous property access
  var safeRuntime = {
    __safe_callTool: createSecureProxy(innerCallTool),
    __safe_forOf: createSecureProxy(innerForOf),
    __safe_for: createSecureProxy(innerFor),
    __safe_while: createSecureProxy(innerWhile),
    __safe_doWhile: createSecureProxy(innerDoWhile),
    __safe_concat: createSecureProxy(innerConcat),
    __safe_template: createSecureProxy(innerTemplate),
    __safe_parallel: createSecureProxy(innerParallel),
    __safe_console: createSecureProxy(innerConsole),
    callTool: createSecureProxy(innerCallTool),
    parallel: createSecureProxy(innerParallel)
  };

  for (var key in safeRuntime) {
    if (safeRuntime.hasOwnProperty(key)) {
      Object.defineProperty(innerContext, key, {
        value: safeRuntime[key],
        writable: false,
        configurable: false,
        enumerable: true
      });
    }
  }

  // Add safe standard globals wrapped with secure proxy
  var safeGlobals = {
    Math: createSecureProxy(Math),
    JSON: createSecureProxy(JSON),
    Array: createSecureProxy(Array),
    Object: createSecureProxy(Object),
    String: createSecureProxy(String),
    Number: createSecureProxy(Number),
    Date: createSecureProxy(Date),
    Boolean: createSecureProxy(Boolean),
    RegExp: createSecureProxy(RegExp),
    Error: createSecureProxy(Error),
    TypeError: createSecureProxy(TypeError),
    RangeError: createSecureProxy(RangeError),
    Promise: createSecureProxy(Promise),
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

  // Define safeGlobals as non-writable for consistency with safeRuntime
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
        enumerable: true
      });
    }
  }

  // Add user-provided globals if any (also wrapped with secure proxy and non-writable)
  if (hostConfig.globals) {
    for (var uKey in hostConfig.globals) {
      if (hostConfig.globals.hasOwnProperty(uKey)) {
        var wrappedGlobal = createSecureProxy(hostConfig.globals[uKey]);
        Object.defineProperty(innerContext, uKey, {
          value: wrappedGlobal,
          writable: false,
          configurable: false,
          enumerable: true
        });
        // Also add __safe_ prefixed version
        Object.defineProperty(innerContext, '__safe_' + uKey, {
          value: wrappedGlobal,
          writable: false,
          configurable: false,
          enumerable: true
        });
      }
    }
  }

  // ============================================================
  // Execute User Code
  // ============================================================

  var userCode = ${JSON.stringify(userCode)};
  var wrappedCode = '(async function() { ' + userCode + ' return typeof __ag_main === "function" ? await __ag_main() : undefined; })()';

  var script = new vm.Script(wrappedCode, { filename: 'inner-agentscript.js' });
  var result = await script.runInContext(innerContext, {
    timeout: ${innerTimeout},
    breakOnSigint: true
  });

  return result;
})();
`.trim();
}
