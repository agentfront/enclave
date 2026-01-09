/**
 * VM Adapter - Node.js vm module implementation
 *
 * Uses Node.js built-in vm module for sandboxed code execution.
 * Provides isolated execution context with controlled globals.
 *
 * @packageDocumentation
 */

import * as vm from 'vm';
import type { SandboxAdapter, ExecutionContext, ExecutionResult, SecurityLevel } from '../types';
import { createSafeRuntime } from '../safe-runtime';
import { createSafeReflect, createSecureProxy } from '../secure-proxy';
import { createSafeError } from '../safe-error';
import { MemoryTracker, MemoryLimitError } from '../memory-tracker';
import { createHostToolBridge } from '../tool-bridge';
import { checkSerializedSize, sanitizeValue } from '../value-sanitizer';

/**
 * Sensitive patterns to redact from stack traces
 * Security: Prevents information leakage about host environment
 *
 * Categories covered:
 * - File system paths (Unix, Windows, UNC)
 * - Cloud environment variables and metadata
 * - Container/orchestration paths
 * - CI/CD system paths
 * - User home directories
 * - Secret/credential patterns
 * - Internal hostnames and IPs
 * - Package manager cache paths
 */
const SENSITIVE_STACK_PATTERNS = [
  // Unix file system paths
  /\/Users\/[^/]+\/[^\s):]*/gi, // macOS home directories
  /\/home\/[^/]+\/[^\s):]*/gi, // Linux home directories
  /\/var\/[^\s):]*/gi, // System var directories
  /\/opt\/[^\s):]*/gi, // Optional software
  /\/tmp\/[^\s):]*/gi, // Temporary files
  /\/etc\/[^\s):]*/gi, // System configuration
  /\/root\/[^\s):]*/gi, // Root home directory
  /\/mnt\/[^\s):]*/gi, // Mount points
  /\/srv\/[^\s):]*/gi, // Service data
  /\/data\/[^\s):]*/gi, // Data directories
  /\/app\/[^\s):]*/gi, // Application directories
  /\/proc\/[^\s):]*/gi, // Process information
  /\/sys\/[^\s):]*/gi, // System files

  // Windows paths
  /\\\\[^\s):]*/g, // UNC paths
  /[A-Z]:\\[^\s):]+/gi, // Windows drive paths

  // URL-based paths
  /file:\/\/[^\s):]+/gi, // File URLs
  /webpack:\/\/[^\s):]+/gi, // Webpack paths
  /%2F[^\s):]+/gi, // URL-encoded paths

  // Package managers and node
  /node_modules\/[^\s):]+/gi, // Node modules paths
  /\/nix\/store\/[^\s):]*/gi, // Nix store paths
  /\.npm\/[^\s):]*/gi, // NPM cache
  /\.yarn\/[^\s):]*/gi, // Yarn cache
  /\.pnpm\/[^\s):]*/gi, // PNPM cache

  // Container and orchestration
  /\/run\/secrets\/[^\s):]*/gi, // Docker/K8s secrets
  /\/var\/run\/[^\s):]*/gi, // Runtime directories
  /\/docker\/[^\s):]*/gi, // Docker paths
  /\/containers\/[^\s):]*/gi, // Container paths
  /\/kubelet\/[^\s):]*/gi, // Kubernetes kubelet

  // CI/CD systems
  /\/github\/workspace\/[^\s):]*/gi, // GitHub Actions
  /\/runner\/[^\s):]*/gi, // GitHub/GitLab runner
  /\/builds\/[^\s):]*/gi, // CI builds
  /\/workspace\/[^\s):]*/gi, // Generic workspace
  /\/pipeline\/[^\s):]*/gi, // CI pipelines
  /\/jenkins\/[^\s):]*/gi, // Jenkins
  /\/bamboo\/[^\s):]*/gi, // Bamboo
  /\/teamcity\/[^\s):]*/gi, // TeamCity
  /\/circleci\/[^\s):]*/gi, // CircleCI

  // Cloud providers
  /\/aws\/[^\s):]*/gi, // AWS paths
  /\/gcloud\/[^\s):]*/gi, // Google Cloud
  /\/azure\/[^\s):]*/gi, // Azure paths
  /s3:\/\/[^\s):]+/gi, // S3 URIs
  /gs:\/\/[^\s):]+/gi, // GCS URIs

  // Secrets and credentials (patterns that might appear in paths or errors)
  /[A-Z0-9]{20,}/g, // AWS-style access keys (20+ uppercase chars)
  /sk-[a-zA-Z0-9]{32,}/g, // OpenAI/Stripe-style secret keys
  /ghp_[a-zA-Z0-9]{36,}/g, // GitHub personal access tokens
  /gho_[a-zA-Z0-9]{36,}/g, // GitHub OAuth tokens
  /github_pat_[a-zA-Z0-9_]{22,}/g, // GitHub fine-grained tokens
  /xox[baprs]-[a-zA-Z0-9-]+/g, // Slack tokens
  /Bearer\s+[a-zA-Z0-9._-]+/gi, // Bearer tokens
  /Basic\s+[a-zA-Z0-9+/=]+/gi, // Basic auth

  // Internal network info
  /(?:10|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d+\.\d+/g, // Private IPs
  /[a-z0-9-]+\.internal(?:\.[a-z]+)?/gi, // Internal hostnames
  /localhost:\d+/gi, // Localhost with port
  /127\.0\.0\.1:\d+/gi, // Loopback with port

  // User information
  /\/u\/[^/]+\//gi, // User subdirectories
  /~[a-z_][a-z0-9_-]*/gi, // Unix user home shorthand
];

/**
 * Sanitize stack trace by removing host file system paths
 * Security: Prevents information leakage about host environment
 *
 * When enabled (sanitize=true):
 * - Removes file paths from all supported platforms
 * - Redacts potential secrets and credentials
 * - Strips internal hostnames and IPs
 * - Removes line/column numbers for full anonymization
 *
 * @param stack Original stack trace
 * @param sanitize Whether to sanitize (defaults to true)
 * @returns Sanitized stack trace (or original if sanitize=false)
 */
function sanitizeStackTrace(stack: string | undefined, sanitize = true): string | undefined {
  if (!stack) return stack;

  // Return unsanitized stack if disabled
  if (!sanitize) return stack;

  let sanitized = stack;

  // Apply all sensitive patterns
  for (const pattern of SENSITIVE_STACK_PATTERNS) {
    // Reset lastIndex for global patterns to ensure consistent behavior
    pattern.lastIndex = 0;
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }

  // Additional: Remove line and column numbers from stack frames
  // Format: "at functionName (file:line:column)" -> "at functionName ([REDACTED])"
  sanitized = sanitized.replace(/at\s+([^\s]+)\s+\([^)]*:\d+:\d+\)/g, 'at $1 ([REDACTED])');

  // Format: "at file:line:column" -> "at [REDACTED]"
  sanitized = sanitized.replace(/at\s+[^\s]+:\d+:\d+/g, 'at [REDACTED]');

  return sanitized;
}

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

const STACK_TRACE_HARDENING_SCRIPT = new vm.Script(STACK_TRACE_HARDENING_CODE);

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

const CODE_GENERATION_VIOLATION_DETECTOR_SCRIPT = new vm.Script(CODE_GENERATION_VIOLATION_DETECTOR_CODE);

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

      // Safe to call the real console method
      method(...args);
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
 * Dangerous Object STATIC methods that allow property manipulation attacks
 * These methods can be used for:
 * - Serialization hijacking (defineProperty with toJSON)
 * - Prototype pollution (setPrototypeOf)
 * - Getter/setter injection (defineProperty, defineProperties)
 *
 * Note: __defineGetter__ etc. are on Object.prototype (instance methods),
 * not static methods on Object constructor. Those are blocked separately
 * on Object.prototype if needed.
 */
const DANGEROUS_OBJECT_STATIC_METHODS = [
  'defineProperty',
  'defineProperties',
  'setPrototypeOf',
  'getOwnPropertyDescriptor', // Can retrieve defineProperty reference
  'getOwnPropertyDescriptors', // Same
] as const;

/**
 * Create a safe Object global that removes dangerous methods
 * Prevents attacks like:
 * - ATK-DATA-02: Serialization Hijack via defineProperty('toJSON')
 * - Prototype pollution via setPrototypeOf
 * - Getter/setter injection
 *
 * @param originalObject The original Object constructor from VM context
 * @returns Safe Object with dangerous methods removed
 */
function createSafeObject(originalObject: ObjectConstructor): ObjectConstructor {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const SafeObject: any = function (this: unknown, value?: unknown) {
    // Support both Object() and new Object() calls
    if (value === null || value === undefined) {
      return {};
    }
    return Object(value);
  };

  // Copy all safe static methods from original Object
  const safeStaticMethods = [
    'keys',
    'values',
    'entries',
    'fromEntries',
    'assign',
    'is',
    'hasOwn',
    'freeze',
    'isFrozen',
    'seal',
    'isSealed',
    'preventExtensions',
    'isExtensible',
    'getOwnPropertyNames',
    'getOwnPropertySymbols',
    'getPrototypeOf', // Read-only, safe
  ];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const origObj = originalObject as any;
  for (const method of safeStaticMethods) {
    if (method in origObj) {
      SafeObject[method] = origObj[method];
    }
  }

  // Provide a safe Object.create that only allows null or object as prototype
  // and does NOT allow property descriptors (second argument)
  SafeObject.create = function (proto: object | null, propertiesObject?: PropertyDescriptorMap) {
    if (propertiesObject !== undefined) {
      throw createSafeError(
        'Object.create with property descriptors is not allowed (security restriction)',
        'SecurityError',
      );
    }
    return Object.create(proto);
  };

  // Copy prototype reference
  SafeObject.prototype = origObj.prototype;

  // Add blocked methods that throw helpful errors
  for (const method of DANGEROUS_OBJECT_STATIC_METHODS) {
    SafeObject[method] = function () {
      throw createSafeError(
        `Object.${method} is not allowed (security restriction: prevents property manipulation attacks)`,
        'SecurityError',
      );
    };
  }

  return SafeObject as ObjectConstructor;
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
 * Sanitize VM context by removing dangerous Node.js 24 globals
 * Security: Prevents escape via new APIs like Iterator helpers, ShadowRealm, etc.
 *
 * @param context The VM context to sanitize
 * @param securityLevel The security level to determine which globals to remove
 */
function sanitizeVmContext(context: vm.Context, securityLevel: SecurityLevel): void {
  const globalsToRemove = NODEJS_24_DANGEROUS_GLOBALS[securityLevel];

  for (const global of globalsToRemove) {
    // Delete the global if it exists in the context
    if (global in context) {
      try {
        delete context[global];
      } catch {
        // Some globals may be non-configurable, set to undefined instead
        try {
          context[global] = undefined;
        } catch {
          // Ignore if we can't modify it
        }
      }
    }
  }

  // For security levels that allow Reflect, provide a safe version
  if (securityLevel !== 'STRICT') {
    const safeReflect = createSafeReflect(securityLevel);
    if (safeReflect) {
      Object.defineProperty(context, 'Reflect', {
        value: safeReflect,
        writable: false,
        configurable: false,
        enumerable: true,
      });
    }
  }

  // Add safe Object to the context that blocks dangerous methods
  // Security: Prevents ATK-DATA-02 (Serialization Hijack via defineProperty)
  // Note: We use the global Object to create SafeObject, then add it to context
  // This shadows the internal V8 Object global with our safe version
  const safeObject = createSafeObject(Object);
  Object.defineProperty(context, 'Object', {
    value: safeObject,
    writable: false,
    configurable: false,
    enumerable: true,
  });
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

    try {
      // Create safe runtime context with optional sidecar support and proxy config
      const safeRuntime = createSafeRuntime(executionContext, {
        sidecar: executionContext.sidecar,
        referenceConfig: executionContext.referenceConfig,
        secureProxyConfig: executionContext.secureProxyConfig,
        memoryTracker, // Pass tracker for allocation monitoring
      });

      // Create sandbox context with safe globals only
      // IMPORTANT: Use empty object to get NEW isolated prototypes
      // codeGeneration.strings=false disables new Function() and eval() from strings
      // This prevents sandbox escape via constructor chain: [][c][c]('malicious code')
      const baseSandbox = vm.createContext(
        {},
        {
          codeGeneration: { strings: false, wasm: false },
        },
      );

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
          value: (bytes: number) => {
            memoryTracker.track(bytes);
          },
          writable: false,
          configurable: false,
          enumerable: false,
        });

        const patchScript = new vm.Script(`
          (function() {
            var memoryLimit = ${config.memoryLimit};
            var trackMemory = __host_memory_track__;

            // Get the ACTUAL prototype used by string literals in this realm
            // Using Object.getPrototypeOf('') gets the intrinsic String.prototype
            var stringProto = Object.getPrototypeOf('');
            var arrayProto = Object.getPrototypeOf([]);

            // Patch string repeat - primary attack vector for string bombs
            var originalRepeat = stringProto.repeat;
            stringProto.repeat = function(count) {
              // Pre-check: estimate size BEFORE allocation
              var estimatedSize = this.length * count * 2; // 2 bytes per char (UTF-16)
              // Check single allocation limit
              if (estimatedSize > memoryLimit) {
                throw new RangeError('String.repeat would exceed memory limit: ' +
                  Math.round(estimatedSize / 1024 / 1024) + 'MB > ' +
                  Math.round(memoryLimit / 1024 / 1024) + 'MB');
              }
              // Track cumulative memory BEFORE allocation (throws if limit exceeded)
              trackMemory(estimatedSize);
              return originalRepeat.call(this, count);
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
              estimatedSize *= 2; // UTF-16

              // Check single allocation limit
              if (estimatedSize > memoryLimit) {
                throw new RangeError('Array.join would exceed memory limit: ' +
                  Math.round(estimatedSize / 1024 / 1024) + 'MB > ' +
                  Math.round(memoryLimit / 1024 / 1024) + 'MB');
              }
              // Track cumulative memory BEFORE allocation (throws if limit exceeded)
              trackMemory(estimatedSize);
              return originalJoin.call(this, separator);
            };

            // Patch string padStart/padEnd - can pad to huge sizes
            var originalPadStart = stringProto.padStart;
            var originalPadEnd = stringProto.padEnd;

            stringProto.padStart = function(targetLength, padString) {
              var estimatedSize = Math.max(this.length, targetLength) * 2;
              if (estimatedSize > memoryLimit) {
                throw new RangeError('String.padStart would exceed memory limit');
              }
              // Track cumulative memory BEFORE allocation (throws if limit exceeded)
              trackMemory(estimatedSize);
              return originalPadStart.call(this, targetLength, padString);
            };

            stringProto.padEnd = function(targetLength, padString) {
              var estimatedSize = Math.max(this.length, targetLength) * 2;
              if (estimatedSize > memoryLimit) {
                throw new RangeError('String.padEnd would exceed memory limit');
              }
              // Track cumulative memory BEFORE allocation (throws if limit exceeded)
              trackMemory(estimatedSize);
              return originalPadEnd.call(this, targetLength, padString);
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
              // For objects/arrays as fill value, each creates a reference
              var estimatedSize = fillCount * 8;

              // Check single allocation limit
              if (estimatedSize > memoryLimit) {
                throw new RangeError('Array.fill would exceed memory limit: ' +
                  Math.round(estimatedSize / 1024 / 1024) + 'MB > ' +
                  Math.round(memoryLimit / 1024 / 1024) + 'MB');
              }
              // Track cumulative memory BEFORE allocation (throws if limit exceeded)
              trackMemory(estimatedSize);
              return originalFill.call(this, value, start, end);
            };
          })();
        `);
        patchScript.runInContext(baseSandbox);
      }

      // SECURITY HARDENING: prevent leaking host stack traces via error.stack inside the sandbox.
      // Must run BEFORE sanitizeVmContext() replaces Object with SafeObject (which blocks defineProperty).
      const shouldHardenStacks = config.sanitizeStackTraces ?? true;
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
          value: (type: string) => {
            if (!policyViolation.type) policyViolation.type = String(type);
          },
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

      // Sanitize the VM context by removing dangerous Node.js 24 globals
      // Security: Prevents escape via Iterator helpers, ShadowRealm, etc.
      sanitizeVmContext(baseSandbox, this.securityLevel);

      // TOOL BRIDGE (string mode): define __safe_callTool inside the VM realm and
      // communicate with the host tool handler via JSON string envelopes.
      if (config.toolBridge?.mode === 'string') {
        const maxPayloadBytes = config.toolBridge?.maxPayloadBytes ?? 5 * 1024 * 1024;
        const hostToolBridge = createHostToolBridge(executionContext, { updateStats: true });

        Object.defineProperty(baseSandbox, '__host_callToolBridge__', {
          value: hostToolBridge,
          writable: false,
          configurable: true, // allow deletion after capture
          enumerable: false,
        });

        const bridgeInitScript = new vm.Script(`
          (function() {
            var bridge = __host_callToolBridge__;
            var stringify = JSON.stringify;
            var parse = JSON.parse;
            var hasOwn = Object.prototype.hasOwnProperty;
            var maxBytes = ${maxPayloadBytes};

            // Remove global handle after capture (defense-in-depth)
            try { delete globalThis.__host_callToolBridge__; } catch (e) { /* ignore */ }

            function estimateBytes(str) {
              // Conservative: UTF-8 can be up to 4 bytes per code unit.
              return str.length * 4;
            }

            function makeError(message, name) {
              var err = new Error(message);
              if (name) err.name = name;
              return err;
            }

            return async function __safe_callTool(toolName, args) {
              if (typeof toolName !== 'string' || !toolName) {
                throw makeError('Tool name must be a non-empty string', 'TypeError');
              }
              if (typeof args !== 'object' || args === null || Array.isArray(args)) {
                throw makeError('Tool arguments must be an object', 'TypeError');
              }
              if (typeof bridge !== 'function') {
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

              if (estimateBytes(requestJson) > maxBytes) {
                throw makeError('Tool request exceeds maximum size (' + maxBytes + ' bytes)', 'RangeError');
              }

              var responseJson = await bridge(requestJson);
              if (typeof responseJson !== 'string') {
                throw makeError('Tool bridge returned invalid response', 'Error');
              }
              if (estimateBytes(responseJson) > maxBytes) {
                throw makeError('Tool response exceeds maximum size (' + maxBytes + ' bytes)', 'RangeError');
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
                if (hasOwn.call(response, 'value')) return response.value;
                return undefined;
              }

              if (response.ok === false && response.error) {
                var msg = (typeof response.error.message === 'string') ? response.error.message : 'Tool call failed';
                var name = (typeof response.error.name === 'string') ? response.error.name : 'Error';
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

        Object.defineProperty(baseSandbox, '__safe_callTool', {
          value: proxiedVmSafeCallTool,
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

      // Add safe runtime functions to the isolated context as non-writable, non-configurable
      // Security: Prevents runtime override attacks on __safe_* functions
      // Note: Skip 'Object' if already added by sanitizeVmContext (with SafeObject)
      for (const [key, value] of Object.entries(safeRuntime)) {
        // Skip if property is already defined (e.g., Object was added by sanitizeVmContext)
        if (key in baseSandbox) continue;
        Object.defineProperty(baseSandbox, key, {
          value: value,
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
      if (config.globals) {
        for (const [key, value] of Object.entries(config.globals)) {
          // Only proxy objects, primitives are safe as-is
          const wrappedValue =
            value !== null && typeof value === 'object'
              ? createSecureProxy(value as object, {
                  levelConfig: executionContext.secureProxyConfig,
                })
              : value;
          Object.defineProperty(baseSandbox, key, {
            value: wrappedValue,
            writable: false,
            configurable: false,
            enumerable: false,
          });
        }
      }

      // Add __safe_console with rate limiting to prevent I/O flood attacks
      // Security: Limits total output bytes and call count
      // Note: The agentscript transformer converts `console` → `__safe_console` in whitelist mode
      // Skip if user already provided console via globals (already added with __safe_ prefix by safeRuntime)
      if (!('__safe_console' in safeRuntime)) {
        const consoleStats: ConsoleStats = { totalBytes: 0, callCount: 0 };
        Object.defineProperty(baseSandbox, '__safe_console', {
          value: createSafeConsole(
            {
              maxConsoleOutputBytes: config.maxConsoleOutputBytes,
              maxConsoleCalls: config.maxConsoleCalls,
            },
            consoleStats,
          ),
          writable: false,
          configurable: false,
          enumerable: true,
        });
      }

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
      const wrappedCode = `
        (async () => {
          ${code}
          return typeof __ag_main === 'function' ? await __ag_main() : undefined;
        })();
      `;

      // Compile script
      const script = new vm.Script(wrappedCode, {
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
      const clampedDepth = Math.max(5, Math.min(50, config.maxSanitizeDepth));
      const clampedProperties = Math.max(50, Math.min(1000, config.maxSanitizeProperties));
      const sanitizedValue = sanitizeValue(value, {
        maxDepth: clampedDepth,
        maxProperties: clampedProperties,
        allowDates: true,
        allowErrors: true,
      });

      return {
        success: true,
        value: sanitizedValue as T,
        stats,
      };
    } catch (error: unknown) {
      const err = error as Error;

      // Update stats
      stats.duration = Date.now() - startTime;
      stats.endTime = Date.now();

      // Capture memory usage even on error
      if (memoryTracker) {
        const memSnapshot = memoryTracker.getSnapshot();
        stats.memoryUsage = memSnapshot.peakTrackedBytes;
      }

      // Handle memory limit errors specially
      if (err instanceof MemoryLimitError) {
        return {
          success: false,
          error: {
            name: 'MemoryLimitError',
            message: err.message,
            code: 'MEMORY_LIMIT_EXCEEDED',
            data: {
              usedBytes: err.usedBytes,
              limitBytes: err.limitBytes,
            },
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
          name: err.name || 'VMExecutionError',
          message: err.message || 'Unknown VM execution error',
          stack: sanitizeStackTrace(err.stack, shouldSanitize),
          code: 'VM_EXECUTION_ERROR',
        },
        stats,
      };
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
