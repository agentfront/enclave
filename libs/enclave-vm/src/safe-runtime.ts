/**
 * Safe Runtime Wrappers
 *
 * These functions are injected into the AgentScript sandbox to provide
 * safe implementations of tool calls, loops, and other operations.
 *
 * @packageDocumentation
 */

import type { ExecutionContext, SecureProxyLevelConfig } from './types';
import { sanitizeValue } from './value-sanitizer';
import { createSafeError, createSafeTypeError } from './safe-error';
import { ReferenceSidecar } from './sidecar/reference-sidecar';
import { ReferenceResolver, ResolutionLimitError } from './sidecar/reference-resolver';
import { ReferenceConfig, isReferenceId } from './sidecar/reference-config';
import { createSecureProxy, wrapGlobalsWithSecureProxy, SecureProxyOptions } from './secure-proxy';
import { MemoryTracker } from './memory-tracker';
import { createTrackedString, createTrackedArray } from './memory-proxy';

/**
 * Options for safe runtime creation
 */
export interface SafeRuntimeOptions {
  /**
   * Reference sidecar for pass-by-reference support
   * If not provided, reference resolution is disabled
   */
  sidecar?: ReferenceSidecar;

  /**
   * Reference configuration for resolver
   * Required when sidecar is provided
   */
  referenceConfig?: ReferenceConfig;

  /**
   * Secure proxy configuration from security level
   * Controls which properties are blocked by the proxy
   */
  secureProxyConfig?: SecureProxyLevelConfig;

  /**
   * Memory tracker for allocation monitoring
   * If provided, String/Array constructors are wrapped to track allocations
   * and enforce memory limits
   */
  memoryTracker?: MemoryTracker;
}

/**
 * Create safe runtime context with all __safe_* functions
 *
 * @param context Execution context
 * @param options Optional runtime options (sidecar, referenceConfig)
 * @returns Object containing all safe runtime functions
 */
export function createSafeRuntime(context: ExecutionContext, options?: SafeRuntimeOptions) {
  const { config, stats } = context;
  const sidecar = options?.sidecar;
  const referenceConfig = options?.referenceConfig;
  const secureProxyConfig = options?.secureProxyConfig;
  const memoryTracker = options?.memoryTracker;
  const resolver = sidecar && referenceConfig ? new ReferenceResolver(sidecar, referenceConfig) : undefined;

  // Build proxy options from config for consistent usage
  const proxyOptions: SecureProxyOptions = secureProxyConfig ? { levelConfig: secureProxyConfig } : {};

  /**
   * Safe callTool implementation
   * - Tracks tool call count
   * - Enforces max tool call limit
   * - Resolves reference IDs before calling tool
   * - Lifts large results back to sidecar
   * - Delegates to user-provided tool handler
   */
  async function __safe_callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    // Check if aborted
    // SECURITY: Use createSafeError to prevent prototype chain escape attacks
    if (context.aborted) {
      throw createSafeError('Execution aborted');
    }

    // Increment tool call count
    stats.toolCallCount++;

    // Check tool call limit
    if (stats.toolCallCount > config.maxToolCalls) {
      throw createSafeError(
        `Maximum tool call limit exceeded (${config.maxToolCalls}). ` + `This limit prevents runaway script execution.`,
      );
    }

    // Validate inputs
    if (typeof toolName !== 'string' || !toolName) {
      throw createSafeTypeError('Tool name must be a non-empty string');
    }

    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      throw createSafeTypeError('Tool arguments must be an object');
    }

    // Check for tool handler
    if (!context.toolHandler) {
      throw createSafeError('No tool handler configured. Cannot execute tool calls.');
    }

    // Resolve references if sidecar is available
    let resolvedArgs = args;
    if (resolver && resolver.containsReferences(args)) {
      // Predictive check - fail fast before allocation
      if (resolver.wouldExceedLimit(args)) {
        throw createSafeError(
          `Tool arguments would exceed maximum resolved size when references are expanded. ` +
            `Reduce the amount of data being passed to the tool.`,
        );
      }

      try {
        resolvedArgs = resolver.resolve(args) as Record<string, unknown>;
      } catch (error: unknown) {
        if (error instanceof ResolutionLimitError) {
          throw createSafeError(`Failed to resolve references in tool arguments: ${error.message}`);
        }
        // SECURITY: Wrap unknown errors in safe error to prevent prototype chain escape
        const err = error as Error;
        throw createSafeError(`Reference resolution failed: ${err.message || 'Unknown error'}`);
      }
    }

    // Execute the tool call
    try {
      const result = await context.toolHandler(toolName, resolvedArgs);

      // Sanitize the return value to prevent:
      // - Function injection
      // - Symbol injection
      // - Prototype pollution (__proto__, constructor)
      // - Deeply nested objects (DoS)
      // - Large object graphs (DoS)
      const sanitized = sanitizeValue(result, {
        maxDepth: 20,
        maxProperties: 10000,
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
          } catch {
            // If storage fails (limits), return original value
            return sanitized;
          }
        }
      }

      return sanitized;
    } catch (error: unknown) {
      // SECURITY: Re-throw with safe error to prevent prototype chain escape attacks
      // This is critical - the original error from the tool handler could expose
      // the host Function constructor via error.constructor.constructor
      const err = error as Error;
      throw createSafeError(`Tool call failed: ${toolName} - ${err.message || 'Unknown error'}`);
    }
  }

  /**
   * Safe for-of iterator
   * - Enforces iteration limit per loop
   * - Tracks total iteration count
   */
  function* __safe_forOf<T>(iterable: Iterable<T>): Iterable<T> {
    let iterations = 0;

    for (const item of iterable) {
      // Check if aborted
      // SECURITY: Use createSafeError to prevent prototype chain escape attacks
      if (context.aborted) {
        throw createSafeError('Execution aborted');
      }

      // Increment iteration count
      iterations++;
      stats.iterationCount++;

      // Check iteration limit
      if (iterations > config.maxIterations) {
        throw createSafeError(
          `Maximum iteration limit exceeded (${config.maxIterations}). ` + `This limit prevents infinite loops.`,
        );
      }

      yield item;
    }
  }

  /**
   * Safe for loop wrapper
   * - Enforces iteration limit
   * - Tracks iteration count
   */
  function __safe_for(init: () => void, test: () => boolean, update: () => void, body: () => void): void {
    let iterations = 0;

    // Execute init
    init();

    // Execute loop
    while (test()) {
      // Check if aborted
      // SECURITY: Use createSafeError to prevent prototype chain escape attacks
      if (context.aborted) {
        throw createSafeError('Execution aborted');
      }

      // Increment iteration count
      iterations++;
      stats.iterationCount++;

      // Check iteration limit
      if (iterations > config.maxIterations) {
        throw createSafeError(
          `Maximum iteration limit exceeded (${config.maxIterations}). ` + `This limit prevents infinite loops.`,
        );
      }

      // Execute body
      body();

      // Execute update
      update();
    }
  }

  /**
   * Safe while loop wrapper
   * - Enforces iteration limit
   * - Tracks iteration count
   */
  function __safe_while(test: () => boolean, body: () => void): void {
    let iterations = 0;

    while (test()) {
      // Check if aborted
      // SECURITY: Use createSafeError to prevent prototype chain escape attacks
      if (context.aborted) {
        throw createSafeError('Execution aborted');
      }

      // Increment iteration count
      iterations++;
      stats.iterationCount++;

      // Check iteration limit
      if (iterations > config.maxIterations) {
        throw createSafeError(
          `Maximum iteration limit exceeded (${config.maxIterations}). ` + `This limit prevents infinite loops.`,
        );
      }

      // Execute body
      body();
    }
  }

  /**
   * Safe addition/concatenation operator
   *
   * Replaces the `+` operator to support:
   * 1. Numeric addition when both operands are numbers
   * 2. String concatenation with memory tracking
   * 3. Reference ID handling for sidecar support
   *
   * Follows JavaScript's ToPrimitive algorithm for objects.
   */
  function __safe_concat(left: unknown, right: unknown): unknown {
    // Fast path: both are numbers - do numeric addition
    if (typeof left === 'number' && typeof right === 'number') {
      return left + right;
    }

    // Fast path: both are strings - do string concatenation with memory tracking
    if (typeof left === 'string' && typeof right === 'string') {
      // Store length BEFORE isReferenceId calls (TypeScript type guard causes narrowing issues)
      const rightLen = right.length;

      const leftIsRef = isReferenceId(left);
      const rightIsRef = isReferenceId(right);

      if (!leftIsRef && !rightIsRef) {
        // Both are regular strings - concatenate and track
        if (memoryTracker) {
          const growthBytes = rightLen * 2; // UTF-16
          memoryTracker.track(growthBytes);
        }
        return left + right;
      }

      // References detected
      // SECURITY: Use createSafeError to prevent prototype chain escape attacks
      if (!resolver) {
        throw createSafeError(
          'Cannot concatenate reference IDs: reference system not configured. ' +
            'Pass references directly to callTool arguments instead.',
        );
      }
      return resolver.createComposite([left, right]);
    }

    // For mixed types (one string, one non-string), use native + for ToPrimitive
    // but check for references in string operands first
    if (typeof left === 'string' || typeof right === 'string') {
      // Check if the string operand(s) are references BEFORE coercion
      const leftIsRef = typeof left === 'string' && isReferenceId(left);
      const rightIsRef = typeof right === 'string' && isReferenceId(right);

      if (leftIsRef || rightIsRef) {
        // Reference detected - need special handling
        // SECURITY: Use createSafeError to prevent prototype chain escape attacks
        if (!resolver) {
          throw createSafeError(
            'Cannot concatenate reference IDs: reference system not configured. ' +
              'Pass references directly to callTool arguments instead.',
          );
        }
        // Convert both to strings for composite
        const leftStr = String(left);
        const rightStr = String(right);
        return resolver.createComposite([leftStr, rightStr]);
      }
    }

    // For all other cases (objects, booleans, null, undefined, or strings without refs),
    // use JavaScript's default + behavior which will call ToPrimitive correctly
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (left as any) + (right as any);

    // Track if result is a string (string concatenation occurred)
    if (typeof result === 'string' && memoryTracker) {
      // Estimate the growth - we track the full result since we don't know original sizes
      memoryTracker.track(result.length * 2); // UTF-16
    }

    return result;
  }

  /**
   * Safe template literal interpolation
   *
   * Handles template literals with expressions like `Hello ${name}!`
   * Detects reference IDs and creates composite handles when allowed.
   *
   * Also tracks memory allocation when memoryTracker is provided.
   *
   * @param quasis - The static string parts
   * @param values - The interpolated values
   */
  function __safe_template(quasis: string[], ...values: unknown[]): unknown {
    // Convert all values to strings
    const stringValues = values.map((v) => String(v));

    // Check if any values are references
    const hasReferences = stringValues.some((v) => isReferenceId(v));

    // If no references, just join normally
    if (!hasReferences) {
      let result = quasis[0];
      for (let i = 0; i < stringValues.length; i++) {
        result += stringValues[i] + quasis[i + 1];
      }

      // Track memory allocation for the resulting string
      if (memoryTracker) {
        const resultBytes = result.length * 2; // UTF-16
        memoryTracker.track(resultBytes);
      }

      return result;
    }

    // References detected - need resolver
    // SECURITY: Use createSafeError to prevent prototype chain escape attacks
    if (!resolver) {
      throw createSafeError(
        'Cannot interpolate reference IDs in template literals: reference system not configured. ' +
          'Pass references directly to callTool arguments instead.',
      );
    }

    // Build parts array for composite
    const parts: string[] = [];
    for (let i = 0; i < quasis.length; i++) {
      if (quasis[i]) {
        parts.push(quasis[i]);
      }
      if (i < stringValues.length) {
        parts.push(stringValues[i]);
      }
    }

    // Use resolver to create composite (will throw if not allowed)
    return resolver.createComposite(parts);
  }

  /**
   * Safe parallel execution wrapper
   *
   * Executes multiple async functions in parallel while:
   * - Respecting the shared tool call limit (all parallel calls share the limit)
   * - Enforcing a maximum concurrency limit to prevent resource exhaustion
   * - Handling timeouts and cancellation properly
   *
   * @param fns - Array of async functions to execute in parallel
   * @param options - Optional configuration { maxConcurrency?: number }
   * @returns Array of results in the same order as inputs
   */
  async function __safe_parallel<T>(fns: Array<() => Promise<T>>, options?: { maxConcurrency?: number }): Promise<T[]> {
    // Check if aborted
    // SECURITY: Use createSafeError to prevent prototype chain escape attacks
    if (context.aborted) {
      throw createSafeError('Execution aborted');
    }

    // Validate inputs
    if (!Array.isArray(fns)) {
      throw createSafeTypeError('__safe_parallel requires an array of functions');
    }

    if (fns.length === 0) {
      return [];
    }

    // Enforce maximum array size to prevent DoS
    const MAX_PARALLEL_ITEMS = 100;
    if (fns.length > MAX_PARALLEL_ITEMS) {
      throw createSafeError(
        `Cannot execute more than ${MAX_PARALLEL_ITEMS} operations in parallel. ` + `Split into smaller batches.`,
      );
    }

    // Validate all items are functions
    for (let i = 0; i < fns.length; i++) {
      if (typeof fns[i] !== 'function') {
        throw createSafeTypeError(`Item at index ${i} is not a function`);
      }
    }

    // Get concurrency limit (default: 10, max: 20)
    const MAX_CONCURRENCY = 20;
    const concurrency = Math.min(Math.max(1, options?.maxConcurrency ?? 10), MAX_CONCURRENCY);

    // Track results in original order
    const results: T[] = new Array(fns.length);
    const errors: Array<{ index: number; error: Error }> = [];

    // Process in batches with concurrency limit
    let currentIndex = 0;

    async function runNext(): Promise<void> {
      while (currentIndex < fns.length) {
        // Check if aborted before starting new work
        if (context.aborted) {
          throw createSafeError('Execution aborted');
        }

        const index = currentIndex++;
        const fn = fns[index];

        try {
          const result = await fn();
          results[index] = result;
        } catch (error) {
          // SECURITY: Wrap caught errors in safe error to prevent prototype chain escape
          const errMsg =
            error && typeof error === 'object'
              ? typeof (error as { message?: unknown }).message === 'string'
                ? (error as { message: string }).message
                : Object.prototype.toString.call(error)
              : String(error);
          errors.push({
            index,
            error: createSafeError(errMsg) as Error,
          });
        }
      }
    }

    // Start workers up to concurrency limit
    const workers = Array.from({ length: Math.min(concurrency, fns.length) }, () => runNext());

    // Wait for all workers to complete
    await Promise.all(workers);

    // If any errors occurred, throw an aggregate error
    // SECURITY: Use createSafeError to prevent prototype chain escape attacks
    if (errors.length > 0) {
      const errorMessages = errors.map((e) => `[${e.index}]: ${e.error.message}`).join('\n');
      throw createSafeError(`${errors.length} of ${fns.length} parallel operations failed:\n${errorMessages}`);
    }

    return results;
  }

  /**
   * Safe do-while loop wrapper
   * - Enforces iteration limit
   * - Tracks iteration count
   */
  function __safe_doWhile(body: () => void, test: () => boolean): void {
    let iterations = 0;

    do {
      // Check if aborted
      // SECURITY: Use createSafeError to prevent prototype chain escape attacks
      if (context.aborted) {
        throw createSafeError('Execution aborted');
      }

      // Increment iteration count
      iterations++;
      stats.iterationCount++;

      // Check iteration limit
      if (iterations > config.maxIterations) {
        throw createSafeError(
          `Maximum iteration limit exceeded (${config.maxIterations}). ` + `This limit prevents infinite loops.`,
        );
      }

      // Execute body
      body();
    } while (test());
  }

  // Prepare custom globals with __safe_ prefix
  // Wrap all custom globals with secure proxies to block constructor access
  const customGlobalsWithPrefix: Record<string, unknown> = {};
  if (config.globals) {
    const wrappedCustomGlobals = wrapGlobalsWithSecureProxy(config.globals, proxyOptions);
    for (const [key, value] of Object.entries(wrappedCustomGlobals)) {
      customGlobalsWithPrefix[`__safe_${key}`] = value;
    }
  }

  // Create secure proxies for standard library objects
  // This blocks access to dangerous properties like 'constructor', '__proto__'
  // even when accessed via computed property names like obj['const'+'ructor']
  //
  // When memory tracking is enabled, use tracked versions of String/Array
  // that monitor allocations and enforce memory limits
  const StringConstructor = memoryTracker ? createTrackedString(memoryTracker) : String;
  const ArrayConstructor = memoryTracker ? createTrackedArray(memoryTracker) : Array;

  const secureStdLib = wrapGlobalsWithSecureProxy(
    {
      Math,
      JSON,
      Array: ArrayConstructor,
      Object,
      String: StringConstructor,
      Number,
      Date,
    },
    proxyOptions,
  );

  // Wrap the safe runtime functions themselves with secure proxies
  // This prevents attacks like: callTool['const'+'ructor']
  const safeCallToolProxy = createSecureProxy(__safe_callTool, proxyOptions);
  const safeForOfProxy = createSecureProxy(__safe_forOf, proxyOptions);
  const safeForProxy = createSecureProxy(__safe_for, proxyOptions);
  const safeWhileProxy = createSecureProxy(__safe_while, proxyOptions);
  const safeDoWhileProxy = createSecureProxy(__safe_doWhile, proxyOptions);
  const safeConcatProxy = createSecureProxy(__safe_concat, proxyOptions);
  const safeTemplateProxy = createSecureProxy(__safe_template, proxyOptions);
  const safeParallelProxy = createSecureProxy(__safe_parallel, proxyOptions);

  // Return safe runtime object with all values protected by secure proxies
  return {
    // Safe runtime functions (proxied to block constructor access)
    __safe_callTool: safeCallToolProxy,
    __safe_forOf: safeForOfProxy,
    __safe_for: safeForProxy,
    __safe_while: safeWhileProxy,
    __safe_doWhile: safeDoWhileProxy,
    __safe_concat: safeConcatProxy,
    __safe_template: safeTemplateProxy,
    __safe_parallel: safeParallelProxy,

    // Iteration limit for loop transformation (used by injected counter checks)
    __maxIterations: config.maxIterations,

    // Whitelisted safe globals (proxied to block constructor access)
    ...secureStdLib,

    // Primitives don't need proxying
    NaN: NaN,
    Infinity: Infinity,
    undefined: undefined,
    isNaN: isNaN,
    isFinite: isFinite,
    parseInt: parseInt,
    parseFloat: parseFloat,

    // Custom globals (with __safe_ prefix, already proxied)
    ...customGlobalsWithPrefix,
  };
}

/**
 * Serialize safe runtime code as a string for injection
 * This is used by sandbox adapters that need to inject the runtime as code
 *
 * @returns JavaScript code string containing the safe runtime
 */
export function serializeSafeRuntime(): string {
  return `
    // Safe callTool implementation
    async function __safe_callTool(toolName, args) {
      if (typeof toolName !== 'string' || !toolName) {
        throw new TypeError('Tool name must be a non-empty string');
      }
      if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        throw new TypeError('Tool arguments must be an object');
      }

      // This will be replaced by the sandbox adapter with actual implementation
      if (typeof __internal_callTool === 'function') {
        return await __internal_callTool(toolName, args);
      }
      throw new Error('Tool handler not available');
    }

    // Safe for-of iterator
    function* __safe_forOf(iterable) {
      let iterations = 0;
      const maxIterations = __internal_maxIterations || 10000;

      for (const item of iterable) {
        iterations++;
        if (iterations > maxIterations) {
          throw new Error('Maximum iteration limit exceeded (' + maxIterations + ')');
        }
        yield item;
      }
    }

    // Safe for loop
    function __safe_for(init, test, update, body) {
      let iterations = 0;
      const maxIterations = __internal_maxIterations || 10000;

      init();
      while (test()) {
        iterations++;
        if (iterations > maxIterations) {
          throw new Error('Maximum iteration limit exceeded (' + maxIterations + ')');
        }
        body();
        update();
      }
    }

    // Safe while loop
    function __safe_while(test, body) {
      let iterations = 0;
      const maxIterations = __internal_maxIterations || 10000;

      while (test()) {
        iterations++;
        if (iterations > maxIterations) {
          throw new Error('Maximum iteration limit exceeded (' + maxIterations + ')');
        }
        body();
      }
    }

    // Safe string concatenation
    // Detects reference IDs and throws or creates composite handles
    function __safe_concat(left, right) {
      const leftStr = String(left);
      const rightStr = String(right);

      // Reference detection pattern: __REF_[uuid]__
      const refPattern = /^__REF_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}__$/i;
      const leftIsRef = refPattern.test(leftStr);
      const rightIsRef = refPattern.test(rightStr);

      if (!leftIsRef && !rightIsRef) {
        return leftStr + rightStr;
      }

      // References detected - use internal handler if available
      if (typeof __internal_handleConcat === 'function') {
        return __internal_handleConcat(leftStr, rightStr);
      }

      throw new Error('Cannot concatenate reference IDs: reference system not configured.');
    }

    // Safe template literal interpolation
    function __safe_template(quasis, ...values) {
      const stringValues = values.map(v => String(v));
      const refPattern = /^__REF_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}__$/i;
      const hasReferences = stringValues.some(v => refPattern.test(v));

      if (!hasReferences) {
        let result = quasis[0];
        for (let i = 0; i < stringValues.length; i++) {
          result += stringValues[i] + quasis[i + 1];
        }
        return result;
      }

      // References detected - use internal handler if available
      if (typeof __internal_handleTemplate === 'function') {
        return __internal_handleTemplate(quasis, stringValues);
      }

      throw new Error('Cannot interpolate reference IDs in template literals: reference system not configured.');
    }

    // Safe parallel execution
    async function __safe_parallel(fns, options) {
      if (!Array.isArray(fns)) {
        throw new TypeError('__safe_parallel requires an array of functions');
      }

      if (fns.length === 0) {
        return [];
      }

      const MAX_PARALLEL_ITEMS = 100;
      if (fns.length > MAX_PARALLEL_ITEMS) {
        throw new Error('Cannot execute more than ' + MAX_PARALLEL_ITEMS + ' operations in parallel.');
      }

      for (let i = 0; i < fns.length; i++) {
        if (typeof fns[i] !== 'function') {
          throw new TypeError('Item at index ' + i + ' is not a function');
        }
      }

      const MAX_CONCURRENCY = 20;
      const concurrency = Math.min(Math.max(1, (options && options.maxConcurrency) || 10), MAX_CONCURRENCY);

      const results = new Array(fns.length);
      const errors = [];
      let currentIndex = 0;

      async function runNext() {
        while (currentIndex < fns.length) {
          const index = currentIndex++;
          try {
            results[index] = await fns[index]();
          } catch (error) {
            errors.push({ index: index, error: error });
          }
        }
      }

      const workers = [];
      for (let i = 0; i < Math.min(concurrency, fns.length); i++) {
        workers.push(runNext());
      }

      await Promise.all(workers);

      if (errors.length > 0) {
        const msgs = errors.map(function(e) { return '[' + e.index + ']: ' + (e.error && e.error.message || e.error); }).join('\\n');
        throw new Error(errors.length + ' of ' + fns.length + ' parallel operations failed:\\n' + msgs);
      }

      return results;
    }

    // Whitelisted globals (already available)
    // Math, JSON, Array, Object, String, Number, Date, etc.
  `.trim();
}
