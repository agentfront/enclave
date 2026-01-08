/**
 * Double VM Wrapper
 *
 * Wraps a base sandbox adapter with a double VM layer for enhanced security.
 * User code runs in an Inner VM which is isolated inside a Parent VM,
 * providing defense-in-depth against VM escape attacks.
 *
 * @packageDocumentation
 */

import * as vm from 'vm';
import type { SandboxAdapter, ExecutionContext, ExecutionResult, SecurityLevel } from '../types';
import { sanitizeValue } from '../value-sanitizer';
import { getBlockedPropertiesForLevel, buildBlockedPropertiesFromConfig } from '../secure-proxy';
import { ReferenceResolver } from '../sidecar/reference-resolver';
import { MemoryTracker, MemoryLimitError } from '../memory-tracker';
import type { DoubleVmConfig, SerializableParentValidationConfig } from './types';
import { generateParentVmBootstrap } from './parent-vm-bootstrap';
import { serializePatterns, DEFAULT_SUSPICIOUS_PATTERNS } from './suspicious-patterns';

/**
 * Creates a "safe" error object that cannot be used to escape the sandbox.
 *
 * SECURITY: This function creates error objects with a severed prototype chain
 * to prevent attacks that climb the prototype chain to reach the host Function constructor.
 *
 * Attack vector blocked:
 * - err.constructor.constructor('return process.env.SECRET')()
 * - err.__proto__.constructor.constructor('malicious code')()
 */
function createSafeError(message: string, name = 'Error'): Error {
  // SECURITY: Create a real Error instance but with the constructor property
  // overridden to break the prototype chain escape attack.
  //
  // The key insight is that we need:
  // 1. A real Error instance (for instanceof checks, proper stack traces)
  // 2. But with .constructor pointing to a safe object that can't be used to escape

  // Create the real error
  const error = new Error(message);
  error.name = name;

  // Create a null-prototype object to use as a safe "constructor"
  // This object has no prototype chain to climb
  const SafeConstructor = Object.create(null);
  Object.defineProperties(SafeConstructor, {
    // Make constructor point to itself to break the chain
    constructor: {
      value: SafeConstructor,
      writable: false,
      enumerable: false,
      configurable: false,
    },
    // Block prototype access
    prototype: {
      value: null,
      writable: false,
      enumerable: false,
      configurable: false,
    },
    // Add name for debugging
    name: {
      value: 'SafeError',
      writable: false,
      enumerable: false,
      configurable: false,
    },
  });
  Object.freeze(SafeConstructor);

  // Override the constructor property on the error instance
  // This breaks the prototype chain: err.constructor.constructor no longer reaches Function
  Object.defineProperty(error, 'constructor', {
    value: SafeConstructor,
    writable: false,
    enumerable: false,
    configurable: false,
  });

  // SECURITY: Override __proto__ on the error instance to prevent prototype chain escape
  // Attack vector blocked: err.__proto__.constructor.constructor('malicious code')()
  // By setting __proto__ to null (non-configurable, non-writable, non-enumerable),
  // we sever the link to Error.prototype, preventing attackers from climbing to Function
  Object.defineProperty(error, '__proto__', {
    value: null,
    writable: false,
    enumerable: false,
    configurable: false,
  });

  // SECURITY: Remove the stack property to prevent information leakage
  // Attack vector blocked: Vector 270 - Static-Literal Tool Discovery
  // The stack trace can reveal internal implementation details like function names,
  // file paths, and line numbers which can be used for reconnaissance attacks.
  // By setting stack to undefined, we prevent attackers from extracting this information.
  Object.defineProperty(error, 'stack', {
    value: undefined,
    writable: false,
    enumerable: false,
    configurable: false,
  });

  // Freeze the error to prevent modifications
  Object.freeze(error);

  return error;
}

/**
 * Sensitive patterns to redact from stack traces
 * (Same as vm-adapter for consistency)
 */
const SENSITIVE_STACK_PATTERNS = [
  /\/Users\/[^/]+\/[^\s):]*/gi,
  /\/home\/[^/]+\/[^\s):]*/gi,
  /\/var\/[^\s):]*/gi,
  /node_modules\/[^\s):]+/gi,
];

/**
 * Sanitize stack trace by removing host file system paths
 */
function sanitizeStackTrace(stack: string | undefined, sanitize = true): string | undefined {
  if (!stack || !sanitize) return stack;

  let sanitized = stack;
  for (const pattern of SENSITIVE_STACK_PATTERNS) {
    pattern.lastIndex = 0;
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }

  // Remove line/column numbers
  sanitized = sanitized.replace(/at\s+([^\s]+)\s+\([^)]*:\d+:\d+\)/g, 'at $1 ([REDACTED])');
  sanitized = sanitized.replace(/at\s+[^\s]+:\d+:\d+/g, 'at [REDACTED]');

  return sanitized;
}

/**
 * Double VM Wrapper
 *
 * Creates a nested VM structure:
 * - Parent VM: Security barrier with enhanced validation
 * - Inner VM: Where user code actually executes
 */
export class DoubleVmWrapper implements SandboxAdapter {
  private parentContext?: vm.Context;

  constructor(
    private readonly config: DoubleVmConfig,
    private readonly securityLevel: SecurityLevel,
  ) {}

  /**
   * Execute code in the double VM structure
   */
  async execute<T = unknown>(code: string, executionContext: ExecutionContext): Promise<ExecutionResult<T>> {
    const { stats, config } = executionContext;
    const startTime = Date.now();
    const isStrictOrSecure = this.securityLevel === 'STRICT' || this.securityLevel === 'SECURE';
    const policyViolation: { type?: string } = {};

    // Create memory tracker if memory limit is configured
    const memoryTracker =
      config.memoryLimit && config.memoryLimit > 0
        ? new MemoryTracker({
            memoryLimit: config.memoryLimit,
            trackStrings: true,
            trackArrays: true,
            trackObjects: false,
          })
        : undefined;

    // Start tracking before execution
    memoryTracker?.start();

    try {
      // Create parent VM context with memory tracker
      const parentContext = this.createParentContext(executionContext, memoryTracker, (type: string) => {
        if (!policyViolation.type) policyViolation.type = String(type);
      });
      this.parentContext = parentContext;

      // Generate the parent VM bootstrap script
      const parentScript = this.buildParentScript(code, executionContext);

      // Compile and execute in parent VM
      const script = new vm.Script(parentScript, {
        filename: 'parent-vm.js',
      });

      // Parent VM timeout = inner VM timeout + buffer
      const parentTimeout = config.timeout + this.config.parentTimeoutBuffer;

      const resultPromise = script.runInContext(parentContext, {
        timeout: parentTimeout,
        breakOnSigint: true,
      });

      // Wait for result
      const value = await resultPromise;

      // Update stats
      stats.duration = Date.now() - startTime;
      stats.endTime = Date.now();

      // Report memory usage if tracking was enabled
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

      return {
        success: true,
        value: value as T,
        stats,
      };
    } catch (error: unknown) {
      // Update stats
      stats.duration = Date.now() - startTime;
      stats.endTime = Date.now();

      // Report memory usage if tracking was enabled
      let memSnapshot: ReturnType<MemoryTracker['getSnapshot']> | undefined;
      if (memoryTracker) {
        memSnapshot = memoryTracker.getSnapshot();
        stats.memoryUsage = memSnapshot.peakTrackedBytes;
      }

      // Handle memory limit errors specially (host Error or sandbox-safe payload)
      if (
        error instanceof MemoryLimitError ||
        (error && typeof error === 'object' && (error as any).code === 'MEMORY_LIMIT_EXCEEDED')
      ) {
        const payload = error as { message?: unknown; usedBytes?: unknown; limitBytes?: unknown };
        const usedBytes = typeof payload.usedBytes === 'number' ? payload.usedBytes : (memSnapshot?.trackedBytes ?? 0);
        const limitBytes = typeof payload.limitBytes === 'number' ? payload.limitBytes : (config.memoryLimit ?? 0);

        return {
          success: false,
          error: {
            name: 'MemoryLimitError',
            message: typeof payload.message === 'string' ? payload.message : 'Memory limit exceeded',
            code: 'MEMORY_LIMIT_EXCEEDED',
            data: { usedBytes, limitBytes },
          },
          stats,
        };
      }

      // Determine whether to sanitize stack traces
      const shouldSanitize = config.sanitizeStackTraces ?? true;

      // Handle thrown strings (e.g., iteration limit exceeded throws a string literal)
      if (typeof error === 'string') {
        return {
          success: false,
          error: {
            name: 'DoubleVMExecutionError',
            message: error,
            code: 'DOUBLE_VM_EXECUTION_ERROR',
          },
          stats,
        };
      }

      const err = error as Error;
      return {
        success: false,
        error: {
          name: err.name || 'DoubleVMExecutionError',
          message: err.message || 'Unknown double VM execution error',
          stack: sanitizeStackTrace(err.stack, shouldSanitize),
          code: 'DOUBLE_VM_EXECUTION_ERROR',
        },
        stats,
      };
    }
  }

  /**
   * Create the parent VM context
   *
   * The parent VM gets controlled access to:
   * - The vm module (to create inner VM)
   * - A tool call proxy to the host
   * - Stats and config references
   * - Memory tracking callback (when memoryLimit is set)
   */
  private createParentContext(
    executionContext: ExecutionContext,
    memoryTracker: MemoryTracker | undefined,
    reportViolation: (type: string) => void,
  ): vm.Context {
    const { stats, config } = executionContext;

    // Create isolated context for parent VM
    // codeGeneration.strings=false disables new Function() and eval() from strings
    // This prevents sandbox escape via constructor chain in both parent and inner VMs
    const parentContext = vm.createContext(
      {},
      {
        codeGeneration: { strings: false, wasm: false },
      },
    );

    // Inject controlled vm module access
    // CRITICAL: Only expose createContext and Script, nothing else
    // NOTE: configurable: true allows parent-vm-bootstrap.ts to delete this
    // reference after use, preventing access if child VM escapes to parent context
    const safeVm = {
      createContext: vm.createContext.bind(vm),
      Script: vm.Script,
    };

    Object.defineProperty(parentContext, '__host_vm_module__', {
      value: safeVm,
      writable: false,
      configurable: true, // Allow deletion after use for defense-in-depth
    });

    // Inject tool call proxy to host
    const hostCallTool = this.createHostCallToolProxy(executionContext);
    Object.defineProperty(parentContext, '__host_callTool__', {
      value: hostCallTool,
      writable: false,
      configurable: false,
    });

    // Inject mutable stats reference so parent can update counts
    Object.defineProperty(parentContext, '__host_stats__', {
      value: stats,
      writable: false,
      configurable: false,
    });

    // Inject abort check function
    Object.defineProperty(parentContext, '__host_abort_check__', {
      value: () => executionContext.aborted,
      writable: false,
      configurable: false,
    });

    // Inject policy-violation reporter (used for STRICT/SECURE fail-closed behavior)
    Object.defineProperty(parentContext, '__host_reportViolation__', {
      value: reportViolation,
      writable: false,
      configurable: false,
    });

    // Inject config (for globals, console limits, and memory limit)
    Object.defineProperty(parentContext, '__host_config__', {
      value: {
        globals: config.globals,
        maxConsoleOutputBytes: config.maxConsoleOutputBytes,
        maxConsoleCalls: config.maxConsoleCalls,
        memoryLimit: config.memoryLimit, // Required for pre-allocation checks in inner VM
      },
      writable: false,
      configurable: false,
    });

    // Inject memory tracking callback (when memoryLimit is set)
    // This is called by innerConcat to track string allocation memory
    if (memoryTracker) {
      Object.defineProperty(parentContext, '__host_memory_track__', {
        value: (bytes: number) => {
          try {
            memoryTracker.track(bytes);
          } catch (err) {
            // SECURITY: Never throw host Error instances into the sandbox realm.
            // Convert MemoryLimitError into a null-prototype payload that cannot be
            // used for prototype chain escape attacks.
            if (err instanceof MemoryLimitError) {
              const safeError = Object.freeze(
                Object.assign(Object.create(null), {
                  name: 'MemoryLimitError',
                  message: err.message,
                  code: err.code,
                  usedBytes: err.usedBytes,
                  limitBytes: err.limitBytes,
                }),
              );
              throw safeError;
            }
            throw err;
          }
        },
        writable: false,
        configurable: false,
      });
    } else {
      // No-op when memory tracking is disabled
      Object.defineProperty(parentContext, '__host_memory_track__', {
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        value: () => {},
        writable: false,
        configurable: false,
      });
    }

    // Add console for parent VM (for debugging only, not a security risk since
    // user code runs in the inner VM, not the parent VM)
    Object.defineProperty(parentContext, 'console', {
      value: console,
      writable: false,
      configurable: false,
    });

    return parentContext;
  }

  /**
   * Create the tool call proxy function that runs in the HOST
   *
   * This is called BY the parent VM's innerCallTool function
   * when it wants to forward a validated call to the actual host.
   *
   * The proxy handles:
   * - Sidecar reference resolution (args with __REF_...__ are resolved)
   * - Large result lifting (strings > threshold are stored in sidecar)
   * - Value sanitization
   */
  private createHostCallToolProxy(executionContext: ExecutionContext) {
    const { config, toolHandler, sidecar, referenceConfig } = executionContext;

    // Create resolver for sidecar references if available
    const resolver = sidecar && referenceConfig ? new ReferenceResolver(sidecar, referenceConfig) : undefined;

    return async (toolName: string, args: Record<string, unknown>): Promise<unknown> => {
      // Double check abort status
      // SECURITY: Use createSafeError to prevent prototype chain escape attacks
      if (executionContext.aborted) {
        throw createSafeError('Execution aborted');
      }

      // Check for tool handler
      if (!toolHandler) {
        throw createSafeError('No tool handler configured. Cannot execute tool calls.');
      }

      // Resolve sidecar references if present
      let resolvedArgs = args;
      if (resolver && resolver.containsReferences(args)) {
        // Predictive check - fail fast before allocation
        if (resolver.wouldExceedLimit(args)) {
          throw createSafeError(
            `Arguments would exceed maximum resolved size when references are expanded. ` +
              `Pass large data directly to tool arguments instead of constructing them.`,
          );
        }
        // Resolve all references to actual data
        resolvedArgs = resolver.resolve(args) as Record<string, unknown>;
      }

      // Execute the tool call
      try {
        const result = await toolHandler(toolName, resolvedArgs);

        // Sanitize the return value using configured limits from security level
        const sanitized = sanitizeValue(result, {
          maxDepth: config.maxSanitizeDepth,
          maxProperties: config.maxSanitizeProperties,
          allowDates: true,
          allowErrors: true,
        });

        // Lift large string results to sidecar if configured
        if (sidecar && referenceConfig && typeof sanitized === 'string') {
          const size = Buffer.byteLength(sanitized, 'utf-8');
          if (size >= referenceConfig.extractionThreshold) {
            try {
              const refId = sidecar.store(sanitized, 'tool-result', { origin: toolName });
              return refId;
            } catch (storageError) {
              // If storage fails (e.g., sidecar limits reached), log and return original value
              if (process.env['NODE_ENV'] !== 'production') {
                console.debug(
                  `[DoubleVmWrapper] Sidecar storage failed for tool "${toolName}": ${(storageError as Error).message}`,
                );
              }
              return sanitized;
            }
          }
        }

        return sanitized;
      } catch (error: unknown) {
        // SECURITY: Use createSafeError to prevent prototype chain escape attacks
        // This is critical - the original error from the tool handler could expose
        // the host Function constructor via error.constructor.constructor
        const err = error as Error;
        throw createSafeError(`Tool call failed: ${toolName} - ${err.message || 'Unknown error'}`);
      }
    };
  }

  /**
   * Build the parent VM script with embedded user code
   */
  private buildParentScript(code: string, executionContext: ExecutionContext): string {
    const { config, secureProxyConfig, referenceConfig } = executionContext;

    // Serialize validation config for passing to parent VM
    const serializableConfig = this.serializeValidationConfig();

    // Get all suspicious patterns (defaults + custom)
    const allPatterns = [...DEFAULT_SUSPICIOUS_PATTERNS, ...(this.config.parentValidation.suspiciousPatterns || [])];
    const serializedPatterns = serializePatterns(allPatterns);

    // Get blocked properties for secure proxy
    // Use explicit secureProxyConfig override if available, otherwise use security level defaults
    let blockedPropertiesSet: Set<string>;
    let throwOnBlocked: boolean;
    if (secureProxyConfig) {
      blockedPropertiesSet = buildBlockedPropertiesFromConfig(secureProxyConfig);
      throwOnBlocked = secureProxyConfig.throwOnBlocked ?? true;
    } else {
      blockedPropertiesSet = getBlockedPropertiesForLevel(this.securityLevel);
      // Get throwOnBlocked from security level config
      // Import the security level configs to get the throwOnBlocked setting
      const SECURITY_LEVEL_CONFIGS: Record<string, { throwOnBlocked: boolean }> = {
        STRICT: { throwOnBlocked: true },
        SECURE: { throwOnBlocked: true },
        STANDARD: { throwOnBlocked: true },
        PERMISSIVE: { throwOnBlocked: false },
      };
      throwOnBlocked = SECURITY_LEVEL_CONFIGS[this.securityLevel]?.throwOnBlocked ?? true;
    }
    const blockedProperties = Array.from(blockedPropertiesSet);

    // Whether composite reference handles are allowed
    const allowComposites = referenceConfig?.allowComposites ?? false;

    return generateParentVmBootstrap({
      userCode: code,
      innerTimeout: config.timeout,
      maxIterations: config.maxIterations,
      maxToolCalls: config.maxToolCalls,
      sanitizeStackTraces: config.sanitizeStackTraces ?? true,
      securityLevel: this.securityLevel,
      validationConfig: serializableConfig,
      suspiciousPatterns: serializedPatterns,
      blockedProperties,
      allowComposites,
      memoryLimit: config.memoryLimit,
      throwOnBlocked,
    });
  }

  /**
   * Serialize validation config for passing to parent VM
   *
   * RegExp objects cannot be passed across VM boundaries,
   * so we extract their source and flags.
   */
  private serializeValidationConfig(): SerializableParentValidationConfig {
    const pv = this.config.parentValidation;

    return {
      validateOperationNames: pv.validateOperationNames,
      allowedOperationPatternSource: pv.allowedOperationPattern?.source,
      allowedOperationPatternFlags: pv.allowedOperationPattern?.flags,
      blockedOperationPatternSources: pv.blockedOperationPatterns?.map((p) => p.source),
      blockedOperationPatternFlags: pv.blockedOperationPatterns?.map((p) => p.flags),
      maxOperationsPerSecond: pv.maxOperationsPerSecond,
      blockSuspiciousSequences: pv.blockSuspiciousSequences,
      rapidEnumerationThreshold: pv.rapidEnumerationThreshold,
      rapidEnumerationOverrides: pv.rapidEnumerationOverrides,
      suspiciousPatterns: [], // Will be populated separately
    };
  }

  /**
   * Dispose resources
   */
  dispose(): void {
    this.parentContext = undefined;
  }
}
