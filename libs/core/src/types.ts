/**
 * Enclave Types and Interfaces
 *
 * Core types for the AgentScript execution environment.
 *
 * @packageDocumentation
 */

/**
 * Security levels for Enclave configuration
 *
 * These levels provide pre-configured security profiles that balance
 * functionality against security risk. Higher levels are more restrictive.
 *
 * @example
 * ```typescript
 * // Use STRICT for untrusted AI-generated code
 * const enclave = new Enclave({ securityLevel: 'STRICT' });
 *
 * // Use STANDARD for trusted internal tools
 * const enclave = new Enclave({ securityLevel: 'STANDARD' });
 * ```
 */
export type SecurityLevel = 'STRICT' | 'SECURE' | 'STANDARD' | 'PERMISSIVE';

/**
 * AST validation preset for code validation
 *
 * Controls which validation rules are applied to code before execution.
 * Each preset is designed for different security/functionality trade-offs.
 *
 * @example
 * ```typescript
 * // Use agentscript preset for AI-generated tool orchestration (default)
 * const enclave = new Enclave({ preset: 'agentscript' });
 *
 * // Use strict preset for maximum security
 * const enclave = new Enclave({ preset: 'strict' });
 *
 * // Use babel preset for TSX/JSX transformation support
 * const enclave = new Enclave({ preset: 'babel' });
 * ```
 */
export type AstPreset = 'agentscript' | 'strict' | 'secure' | 'standard' | 'permissive' | 'babel';

/**
 * Secure proxy configuration per security level
 *
 * Controls which dangerous properties are blocked at runtime via JavaScript Proxies.
 * This provides defense-in-depth against computed property access attacks that
 * bypass static AST analysis.
 */
export interface SecureProxyLevelConfig {
  /**
   * Whether to block 'constructor' property access
   * Prevents: obj['const' + 'ructor'] attacks for code execution
   * @default true (blocks constructor for security)
   *
   * Set to false in PERMISSIVE mode for development/debugging
   */
  blockConstructor: boolean;

  /**
   * Whether to block prototype access (__proto__, prototype)
   * Prevents: prototype chain manipulation attacks
   * @default true (always recommended to keep true)
   */
  blockPrototype: boolean;

  /**
   * Whether to block legacy getter/setter methods
   * Blocks: __defineGetter__, __defineSetter__, __lookupGetter__, __lookupSetter__
   * @default true
   */
  blockLegacyAccessors: boolean;

  /**
   * Maximum depth for recursive proxying
   * Limits how deep nested objects are wrapped in secure proxies
   * @default 10
   */
  proxyMaxDepth: number;

  /**
   * Whether to throw an error when blocked properties are accessed.
   *
   * Security level defaults:
   * - STRICT/SECURE/STANDARD: `true` (throws error)
   * - PERMISSIVE: `false` (returns undefined)
   *
   * When true, accessing blocked properties like 'constructor', '__proto__',
   * 'prototype' will throw a SecurityError instead of returning undefined.
   * This makes security violations explicit and easier to detect.
   *
   * **Breaking change note**: Prior versions returned undefined for all security levels.
   * Set to `false` for backward compatibility (returns undefined for blocked properties).
   */
  throwOnBlocked: boolean;
}

/**
 * Security level configuration presets
 *
 * Each level adjusts:
 * - Resource limits (timeout, iterations, tool calls)
 * - Validation strictness
 * - Stack trace sanitization
 * - Value sanitization depth
 */
export interface SecurityLevelConfig {
  /**
   * Maximum execution time in milliseconds
   */
  timeout: number;

  /**
   * Maximum number of loop iterations
   */
  maxIterations: number;

  /**
   * Maximum number of tool calls
   */
  maxToolCalls: number;

  /**
   * Maximum depth for value sanitization
   */
  maxSanitizeDepth: number;

  /**
   * Maximum properties per object in sanitized values
   */
  maxSanitizeProperties: number;

  /**
   * Whether to sanitize stack traces (remove file paths, line numbers)
   */
  sanitizeStackTraces: boolean;

  /**
   * Descriptive only: nothing in the runtime reads this value, and setting it changes nothing.
   * What a script can reach of `Date` and timing APIs follows from the realm's globals.
   */
  blockTimingAPIs: boolean;

  /**
   * Descriptive only: nothing in the runtime reads this value, and setting it changes nothing.
   * Which loops a script may use is decided by the AST preset (`preset`).
   */
  allowUnboundedLoops: boolean;

  /**
   * Descriptive only: nothing in the runtime reads this value, and setting it changes nothing.
   * The Unicode checks are those of the pre-scanner preset the validation runs with.
   */
  unicodeSecurityCheck: boolean;

  /**
   * Whether to allow functions in custom globals
   */
  allowFunctionsInGlobals: boolean;

  /**
   * Maximum total console output in bytes
   * Prevents I/O flood attacks via console.log spam
   */
  maxConsoleOutputBytes: number;

  /**
   * Maximum number of console calls (log, warn, error, info)
   * Prevents I/O flood attacks via excessive console calls
   */
  maxConsoleCalls: number;

  /**
   * Secure proxy configuration for runtime property access protection
   * Controls which dangerous properties are blocked via JavaScript Proxies
   */
  secureProxy: SecureProxyLevelConfig;
}

/**
 * Pre-defined security level configurations
 */
export const SECURITY_LEVEL_CONFIGS: Record<SecurityLevel, SecurityLevelConfig> = {
  /**
   * STRICT: Maximum security for untrusted code
   *
   * Use for:
   * - AI-generated code from external sources
   * - User-submitted scripts
   * - Untrusted third-party integrations
   *
   * Characteristics:
   * - Short timeout (5s)
   * - Low iteration limits (1000)
   * - Limited tool calls (10)
   * - Deep value sanitization
   * - Full stack trace sanitization
   */
  STRICT: {
    timeout: 5000,
    maxIterations: 1000,
    maxToolCalls: 10,
    maxSanitizeDepth: 5,
    maxSanitizeProperties: 50,
    sanitizeStackTraces: true,
    blockTimingAPIs: true,
    allowUnboundedLoops: false,
    unicodeSecurityCheck: true,
    allowFunctionsInGlobals: false,
    maxConsoleOutputBytes: 64 * 1024, // 64KB - prevent I/O flood attacks
    maxConsoleCalls: 100,
    secureProxy: {
      blockConstructor: true,
      blockPrototype: true,
      blockLegacyAccessors: true,
      proxyMaxDepth: 5,
      throwOnBlocked: true,
    },
  },

  /**
   * SECURE: High security with more headroom
   *
   * Use for:
   * - AI-generated code from trusted models
   * - Internal automation scripts
   * - Controlled multi-tenant environments
   *
   * Characteristics:
   * - Moderate timeout (15s)
   * - Moderate iteration limits (5000)
   * - Moderate tool calls (50)
   * - Standard value sanitization
   * - Stack trace sanitization
   */
  SECURE: {
    timeout: 15000,
    maxIterations: 5000,
    maxToolCalls: 50,
    maxSanitizeDepth: 10,
    maxSanitizeProperties: 100,
    sanitizeStackTraces: true,
    blockTimingAPIs: false,
    allowUnboundedLoops: false,
    unicodeSecurityCheck: true,
    allowFunctionsInGlobals: false,
    maxConsoleOutputBytes: 256 * 1024, // 256KB
    maxConsoleCalls: 500,
    secureProxy: {
      blockConstructor: true,
      blockPrototype: true,
      blockLegacyAccessors: true,
      proxyMaxDepth: 10,
      throwOnBlocked: true,
    },
  },

  /**
   * STANDARD: Balanced security and functionality (DEFAULT)
   *
   * Use for:
   * - Internal tools and scripts
   * - Development and testing
   * - Trusted environments
   *
   * Characteristics:
   * - Standard timeout (30s)
   * - Standard iteration limits (10000)
   * - Standard tool calls (100)
   * - Basic value sanitization
   * - Minimal stack trace sanitization
   */
  STANDARD: {
    timeout: 30000,
    maxIterations: 10000,
    maxToolCalls: 100,
    maxSanitizeDepth: 20,
    maxSanitizeProperties: 500,
    sanitizeStackTraces: false,
    blockTimingAPIs: false,
    allowUnboundedLoops: true,
    unicodeSecurityCheck: false,
    allowFunctionsInGlobals: false,
    maxConsoleOutputBytes: 1024 * 1024, // 1MB
    maxConsoleCalls: 1000,
    secureProxy: {
      blockConstructor: true,
      blockPrototype: true,
      blockLegacyAccessors: true,
      proxyMaxDepth: 15,
      throwOnBlocked: true,
    },
  },

  /**
   * PERMISSIVE: Minimal restrictions
   *
   * Use for:
   * - Local development only
   * - Debugging
   * - Performance testing
   *
   * WARNING: Not recommended for production use with untrusted code
   *
   * Characteristics:
   * - Long timeout (60s)
   * - High iteration limits (100000)
   * - High tool calls (1000)
   * - Minimal sanitization
   * - No stack trace sanitization
   * - All features enabled
   */
  PERMISSIVE: {
    timeout: 60000,
    maxIterations: 100000,
    maxToolCalls: 1000,
    maxSanitizeDepth: 50,
    maxSanitizeProperties: 1000,
    sanitizeStackTraces: false,
    blockTimingAPIs: false,
    allowUnboundedLoops: true,
    unicodeSecurityCheck: false,
    allowFunctionsInGlobals: true,
    maxConsoleOutputBytes: 10 * 1024 * 1024, // 10MB
    maxConsoleCalls: 10000,
    secureProxy: {
      blockConstructor: false, // Allow constructor access for development/debugging
      blockPrototype: true, // Still block prototype for safety
      blockLegacyAccessors: true,
      proxyMaxDepth: 20,
      throwOnBlocked: false, // Return undefined instead of throwing for development
    },
  },
};

/**
 * Result of executing AgentScript code
 */
export interface ExecutionResult<T = unknown> {
  /**
   * Whether execution was successful
   */
  success: boolean;

  /**
   * Return value from the script (if successful)
   */
  value?: T;

  /**
   * Error that occurred during execution (if failed)
   */
  error?: ExecutionError;

  /**
   * Execution statistics
   */
  stats: ExecutionStats;

  /**
   * AI scoring result (if scoring gate is enabled)
   */
  scoringResult?: ScoringGateResult;
}

/**
 * Execution error details
 */
export interface ExecutionError {
  /**
   * Error message
   */
  message: string;

  /**
   * Error name/type
   */
  name: string;

  /**
   * Stack trace (if available)
   */
  stack?: string;

  /**
   * Error code (for structured errors)
   */
  code?: string;

  /**
   * Additional error data
   */
  data?: Record<string, unknown>;
}

/**
 * Execution statistics
 */
export interface ExecutionStats {
  /**
   * Execution duration in milliseconds
   */
  duration: number;

  /**
   * Peak tracked memory usage in bytes
   *
   * When `memoryLimit` is configured, this reports the peak memory usage
   * tracked during execution. Tracking monitors String and Array allocations.
   *
   * Note: This is an estimate based on allocation tracking, not actual V8 heap usage.
   * Where the engine's own bound is needed, use the `worker_threads` adapter: each worker has a
   * heap limit of the engine (`workerPoolConfig.memoryLimitPerWorker`). Do not set the process
   * flag `--max-old-space-size` for that: it replaces the limits of the workers.
   */
  memoryUsage?: number;

  /**
   * Number of tool calls made
   */
  toolCallCount: number;

  /**
   * Number of loop iterations executed
   */
  iterationCount: number;

  /**
   * Timestamp when execution started
   */
  startTime: number;

  /**
   * Timestamp when execution ended
   */
  endTime: number;
}

/**
 * Configuration for Enclave execution
 */
export type ToolBridgeMode = 'string' | 'direct';

/**
 * Tool bridge configuration between the sandbox and host runtime.
 *
 * By default, tool calls use a JSON string request/response envelope to avoid
 * leaking host-realm objects (Errors, Promises, Functions) into the sandbox.
 *
 * SECURITY WARNING: `mode: 'direct'` disables the string bridge and passes
 * objects directly across realms. This is riskier and requires an explicit
 * acknowledgement.
 */
export interface ToolBridgeConfig {
  /**
   * Bridge mode.
   * @default 'string'
   */
  mode?: ToolBridgeMode;

  /**
   * Maximum size (in bytes) of a tool request or response payload.
   * @default 5 * 1024 * 1024 (5MB)
   */
  maxPayloadBytes?: number;

  /**
   * Required acknowledgement to enable insecure direct bridging.
   *
   * When `mode` is set to `'direct'`, enclave construction throws unless this
   * field is explicitly set to `true`.
   */
  acknowledgeInsecureDirect?: boolean;
}

export interface EnclaveConfig {
  /**
   * Maximum execution time in milliseconds. A tool call in progress when it passes is not cut
   * off and its result is delivered; the script's next tool call then fails with "Execution
   * aborted". How long it may still take is `toolCallGraceMs`; after that, and at once for a
   * script that is waiting for anything else (a thenable that never calls back, a promise nobody
   * settles), the execution ends with the timeout error.
   * Default: 30000 (30 seconds)
   */
  timeout?: number;

  /**
   * Maximum memory usage in bytes
   *
   * When set, the VM adapter tracks String and Array allocations and throws
   * a MemoryLimitError if the limit is exceeded. Tracking adds ~5-10% overhead.
   *
   * Note: This is enforced via allocation tracking, not V8 heap limits. It counts the
   * operations that make text and arrays grow; a copy is not charged, and objects, Maps and
   * Sets are not counted. For the engine's own limit, use the worker_threads adapter.
   *
   * Default: 1 * 1024 * 1024 (1 MB); 0 switches the tracking off
   */
  memoryLimit?: number;

  /**
   * Maximum number of tool calls allowed
   * Default: 100
   */
  maxToolCalls?: number;

  /**
   * Maximum number of loop iterations (per loop)
   * Default: 10000
   */
  maxIterations?: number;

  /**
   * Where the sandbox runs.
   *
   * - `'vm'` (default): in this process. The script runs in the double VM (or in a single VM
   *   with `doubleVm: { enabled: false }`).
   * - `'worker_threads'`: in a pool of worker threads. Inside the worker the script runs in the
   *   same sandbox as with `'vm'` (the double VM by default); the worker adds a heap limit that
   *   the engine enforces (`workerPoolConfig.memoryLimitPerWorker`) and a hard stop: a script
   *   that does not end is terminated with its worker. Custom globals reach a worker as JSON
   *   data, so functions in `globals` are not available there.
   * - `'isolated-vm'`: reserved, not implemented.
   *
   * To run scripts with an adapter of your own, pass `sandboxAdapter`.
   * Default: 'vm'
   */
  adapter?: 'vm' | 'isolated-vm' | 'worker_threads';

  /**
   * Whether to allow access to Node.js built-ins
   * Default: false
   */
  allowBuiltins?: boolean;

  /**
   * Custom globals to inject into the sandbox
   */
  globals?: Record<string, unknown>;

  /**
   * Tool call handler
   * This function is called when the script calls __safe_callTool
   */
  toolHandler?: ToolHandler;

  /**
   * Tool bridge configuration between the sandbox and host.
   *
   * Default: `{ mode: 'string', maxPayloadBytes: 5MB }`
   */
  toolBridge?: ToolBridgeConfig;

  /**
   * Maximum total console output in bytes
   * Default: Determined by securityLevel (1MB for STANDARD)
   * Prevents I/O flood attacks via console.log spam
   */
  maxConsoleOutputBytes?: number;

  /**
   * Maximum number of console calls (log, warn, error, info)
   * Default: Determined by securityLevel (1000 for STANDARD)
   * Prevents I/O flood attacks via excessive console calls
   */
  maxConsoleCalls?: number;
}

/**
 * Tool call handler function
 *
 * Called for every `callTool(name, args)` and every `toolNamespaces` method call that passes the
 * enclave's checks. The script's `callTool` options (see {@link CallToolOptions}) are applied
 * inside the enclave and are not passed to the handler.
 */
export type ToolHandler = (toolName: string, args: Record<string, unknown>) => Promise<unknown>;

/**
 * Options a script may pass as the third argument of `callTool(name, args, options)`, or as the
 * second argument of a `toolNamespaces` method (`mail.send(args, options)`).
 */
export interface CallToolOptions {
  /**
   * When `false`, a failing tool does not throw into the script: the call resolves to
   * `{ success: false, error }` instead, and a successful call resolves to `{ success: true, data }`
   * (see {@link ToolCallResult}). A failing tool is one whose handler threw or rejected, or whose
   * result could not be delivered (unsafe or oversized). Refusals by the enclave itself (abort,
   * `maxToolCalls`, rate limit, operation-name and suspicious-sequence checks, invalid or oversized
   * arguments) always throw.
   *
   * @default true
   */
  throwOnError?: boolean;
}

/**
 * Error details a script receives for a failing tool when `throwOnError` is `false`.
 * Plain data created inside the sandbox: no stack, no host object.
 */
export interface ToolCallErrorInfo {
  name: string;
  message: string;
  /** Error code reported by the tool, when it is a string */
  code?: string;
  /** Name of the tool that failed */
  toolName: string;
}

/**
 * What `callTool(name, args, { throwOnError: false })` resolves to inside the sandbox.
 */
export type ToolCallResult<T = unknown> = { success: true; data: T } | { success: false; error: ToolCallErrorInfo };

/**
 * Safe runtime context provided to AgentScript code
 */
export interface SafeRuntimeContext {
  /**
   * Safe tool call function
   * Tracks calls, enforces limits, and delegates to the tool handler
   */
  __safe_callTool: (toolName: string, args: Record<string, unknown>, options?: CallToolOptions) => Promise<unknown>;

  /**
   * Safe for-of loop iterator
   * Enforces iteration limits
   */
  __safe_forOf: <T>(iterable: Iterable<T>) => Iterable<T>;

  /**
   * Safe for loop wrapper
   * Enforces iteration limits
   */
  __safe_for: (init: () => void, test: () => boolean, update: () => void, body: () => void) => void;

  /**
   * Safe while loop wrapper
   * Enforces iteration limits
   */
  __safe_while: (test: () => boolean, body: () => void) => void;

  /**
   * Safe do-while loop wrapper
   * Enforces iteration limits
   */
  __safe_doWhile: (body: () => void, test: () => boolean) => void;

  /**
   * Safe string concatenation
   * Detects reference IDs and handles them appropriately
   */
  __safe_concat: (left: unknown, right: unknown) => unknown;

  /**
   * Safe template literal interpolation
   * Detects reference IDs in interpolated values
   */
  __safe_template: (quasis: string[], ...values: unknown[]) => unknown;

  /**
   * Whitelisted safe globals
   */
  Math: typeof Math;
  JSON: typeof JSON;
  Array: typeof Array;
  Object: typeof Object;
  String: typeof String;
  Number: typeof Number;
  Date: typeof Date;
  NaN: typeof NaN;
  Infinity: typeof Infinity;
  undefined: typeof undefined;
  isNaN: typeof isNaN;
  isFinite: typeof isFinite;
  parseInt: typeof parseInt;
  parseFloat: typeof parseFloat;
}

// Forward reference - imported at runtime to avoid circular dependency
import type { ReferenceSidecar } from './sidecar/reference-sidecar';
import type { ReferenceConfig } from './sidecar/reference-config';
import type { ScoringGateConfig, ScoringGateResult } from './scoring/types';
import type { WorkerPoolConfig } from './adapters/worker-pool/config';
import type { DoubleVmConfig, PartialDoubleVmConfig, ParentValidationConfig } from './double-vm/types';
import type {
  NormalizedToolNamespace,
  PartialPreScannerConfig,
  PreScannerPresetLevel,
  ToolNamespaces,
} from '@enclave-vm/ast';
import type { ConsoleHandler, ConsoleLevel } from './console-handler';
import type { HostActivity } from './execution-deadline';

/**
 * Internal execution context (tracks state during execution)
 */
export interface ExecutionContext {
  /**
   * Configuration
   */
  config: Omit<Required<EnclaveConfig>, 'toolHandler'> & {
    toolHandler?: ToolHandler;
    sanitizeStackTraces: boolean;
    maxSanitizeDepth: number;
    maxSanitizeProperties: number;
    /**
     * Cap on calls into host functions passed in `globals`
     * (defaults to 10 × `maxToolCalls` when absent)
     */
    maxGlobalFunctionCalls?: number;
  };

  /**
   * Validated tool namespaces to bind in the sandbox (see `CreateEnclaveOptions.toolNamespaces`)
   */
  toolNamespaces?: readonly NormalizedToolNamespace[];

  /**
   * The global names that may exist in the script's realm (see `CreateEnclaveOptions.realmGlobals`).
   * When set, the adapter removes every other standard global from the realm before the script
   * runs. Absent means the security level's list of dangerous globals is removed instead.
   */
  realmGlobalAllowlist?: readonly string[];

  /**
   * Statistics tracker
   */
  stats: ExecutionStats;

  /**
   * Abort controller for cancellation
   */
  abortController: AbortController;

  /**
   * Whether execution has been aborted
   */
  aborted: boolean;

  /**
   * Tool handler
   */
  toolHandler?: ToolHandler;

  /**
   * What the host has in flight for this execution: tool calls and async functions from
   * `globals` (see ./execution-deadline). Set by the enclave, which ends the execution once the
   * deadline has passed and nothing is in flight; the gate for host functions reports to it.
   */
  hostActivity?: HostActivity;

  /**
   * Set when the host of this execution is on another thread (the worker pool sets it inside a
   * worker): the function that carries a tool request, in the string tool-bridge format, to the
   * host thread and resolves with its response. An adapter then relays tool calls through it
   * instead of calling `toolHandler`, which does not exist on this side.
   */
  hostToolBridge?: (requestJson: string) => Promise<string>;

  /**
   * Receives the script's console calls (see `CreateEnclaveOptions.consoleHandler`)
   */
  consoleHandler?: ConsoleHandler;

  /**
   * Reference sidecar for pass-by-reference support (per-execution)
   * Created and disposed by the Enclave for each run
   */
  sidecar?: ReferenceSidecar;

  /**
   * Reference configuration for sidecar
   */
  referenceConfig?: ReferenceConfig;

  /**
   * Secure proxy configuration for runtime property blocking
   */
  secureProxyConfig?: SecureProxyLevelConfig;
}

/**
 * Sandbox adapter interface
 * Different sandboxing strategies (isolated-vm, vm2, worker_threads) implement this
 */
export interface SandboxAdapter {
  /**
   * Execute code in the sandbox
   *
   * @param code Transformed AgentScript code to execute
   * @param context Execution context
   * @returns Execution result
   */
  execute<T = unknown>(code: string, context: ExecutionContext): Promise<ExecutionResult<T>>;

  /**
   * Cleanup the sandbox
   */
  dispose(): void;
}

/**
 * Options for reference sidecar (pass-by-reference) support
 */
export interface ReferenceSidecarOptions {
  /**
   * Enable pass-by-reference support
   * When enabled, large strings are automatically lifted to a sidecar
   * and replaced with reference IDs.
   * @default false
   */
  enabled: boolean;

  /**
   * Maximum total size of all stored references in bytes
   * Prevents memory exhaustion from excessive data storage
   * @default Determined by securityLevel
   */
  maxTotalSize?: number;

  /**
   * Maximum size of a single reference in bytes
   * @default Determined by securityLevel
   */
  maxReferenceSize?: number;

  /**
   * Threshold in bytes to trigger extraction from source code
   * Strings larger than this are lifted to the sidecar
   * @default Determined by securityLevel
   */
  extractionThreshold?: number;

  /**
   * Maximum expanded size when resolving references for tool calls
   * @default Determined by securityLevel
   */
  maxResolvedSize?: number;

  /**
   * Maximum size, in bytes, of everything one execution resolves for its tool calls in total.
   * A stored value counts once, a concatenation of references every time it is built.
   * @default Twice `maxTotalSize`
   */
  maxTotalResolvedSize?: number;

  /**
   * Whether to allow composite handles from string concatenation
   * If false, concatenating references throws an error
   * @default Determined by securityLevel (false for STRICT/SECURE)
   */
  allowComposites?: boolean;

  /**
   * Maximum number of references in a single execution
   * @default Determined by securityLevel
   */
  maxReferenceCount?: number;
}

/**
 * Options for creating an Enclave instance
 */
export interface CreateEnclaveOptions extends EnclaveConfig {
  /**
   * Security level preset
   *
   * Pre-configured security profiles that balance functionality against risk.
   * Individual options (timeout, maxIterations, etc.) override the preset values.
   *
   * Levels:
   * - STRICT: Maximum security for untrusted AI-generated code
   * - SECURE: High security with more headroom for trusted AI code
   * - STANDARD: Balanced security and functionality (DEFAULT)
   * - PERMISSIVE: Minimal restrictions (development only)
   *
   * @default 'STANDARD'
   *
   * @example
   * ```typescript
   * // Use STRICT for untrusted code
   * const enclave = new Enclave({ securityLevel: 'STRICT' });
   *
   * // Override specific values from the preset
   * const enclave = new Enclave({
   *   securityLevel: 'SECURE',
   *   timeout: 20000,  // Override SECURE's 15s default
   * });
   * ```
   */
  securityLevel?: SecurityLevel;

  /**
   * AST validation preset to use for code validation
   *
   * Controls which validation rules are applied to code before execution.
   * All presets support custom globals via the `globals` option.
   *
   * Presets:
   * - agentscript: Specialized for AI agent tool orchestration (DEFAULT)
   * - strict: Bank-grade security, blocks almost everything
   * - secure: High security with reasonable flexibility
   * - standard: Balanced security for most use cases
   * - permissive: Minimal restrictions for trusted code
   *
   * @default 'agentscript'
   *
   * @example
   * ```typescript
   * // Use agentscript preset (default)
   * const enclave = new Enclave({ preset: 'agentscript' });
   *
   * // Use strict preset for maximum security
   * const enclave = new Enclave({ preset: 'strict' });
   * ```
   */
  preset?: AstPreset;

  /**
   * The pre-scanner (layer 0): what is checked in the text of a script before anything parses
   * it. Its size, the length and number of its lines, how deep it nests, its regular-expression
   * and string literals, and Unicode that hides code.
   *
   * By default it runs with the pre-scanner preset named like the AST preset (`preset`):
   * `agentscript`, `strict`, `secure`, `standard` or `permissive`. The `babel` preset runs with
   * `standard`. The `agentscript` pre-scanner takes scripts of up to 100 KB in at most 1,000
   * lines of at most 2,000 characters, string literals of up to 10 KB each, no
   * regular-expression literal, and no bidirectional or invisible control character.
   *
   * - `preset` picks another pre-scanner preset.
   * - `config` changes single limits of the preset in force (see `PreScannerConfig` of
   *   `@enclave-vm/ast`); the pre-scanner's own absolute maximums still hold.
   *
   * A host that stores large string literals in the reference sidecar, or that runs scripts
   * above these sizes, sets the limits it needs here. With `validate: false` the pre-scanner
   * does not run; the maximum size of a script (5,242,880 characters) holds in any case.
   *
   * @example
   * ```typescript
   * // The limits enclaves had before 2.19.2, whatever the AST preset
   * const enclave = new Enclave({ preScan: { preset: 'standard' } });
   *
   * // The agentscript pre-scanner with room for larger string literals
   * const enclave = new Enclave({
   *   preScan: { config: { maxInputSize: 1024 * 1024, maxLineLength: 100000, maxStringLength: 512 * 1024 } },
   * });
   * ```
   */
  preScan?: {
    preset?: PreScannerPresetLevel;
    config?: PartialPreScannerConfig;
  };

  /**
   * Whether to validate AgentScript code before execution
   * Default: true
   */
  validate?: boolean;

  /**
   * Whether to transform AgentScript code before execution
   * Default: true
   */
  transform?: boolean;

  /**
   * Which standard globals exist in the realm the script runs in.
   *
   * - `'allowlist'`: only the names a validated script may use exist: the AgentScript globals of
   *   the security level (`Math`, `JSON`, `Array`, `Object`, `String`, `Number`, `Date`, ...), the
   *   enclave's own runtime helpers, your `globals` and your `toolNamespaces`. Every other
   *   standard global (`Function`, `eval`, `globalThis`, `Proxy`, `Reflect`, `Symbol`, `Promise`,
   *   `RegExp`, `WebAssembly`, ...) is removed from the realm before the script runs, and regular
   *   expressions cannot be executed there. The validator already refuses those names; this makes
   *   the realm agree with it, so a gap in the static rules does not hand the script a global.
   * - `'security-level'`: only the dangerous globals listed for the security level are removed.
   *
   * Applies to the double VM (the default), also inside a `worker_threads` worker.
   *
   * Default: `'allowlist'` with the `agentscript` or `babel` preset while `validate` is on,
   * `'security-level'` otherwise (other presets, or `validate: false`, let a script name
   * standard globals that the allowlist would remove).
   */
  realmGlobals?: 'allowlist' | 'security-level';

  /**
   * Whether to allow functions in custom globals
   * Default: Determined by securityLevel (false for STRICT/SECURE/STANDARD)
   *
   * Every call the script makes into such a function goes through the enclave's gate: it is
   * refused once the execution is aborted, counts toward {@link maxGlobalFunctionCalls} (not
   * `maxToolCalls`), shares the double VM's operation rate limit
   * (`doubleVm.parentValidation.maxOperationsPerSecond`) with tool calls, and its return value is
   * sanitized like a tool result (functions, symbols and values beyond the sanitize limits are
   * refused; the script receives a plain-data copy). Errors it throws reach the script as plain
   * errors without the host stack, and calling it with `new` is refused.
   * The suspicious-sequence detectors only look at tool calls: expose tools with
   * {@link toolNamespaces} or `callTool()`, not as functions.
   * The `worker_threads` adapter never passes functions into the sandbox.
   *
   * Functions (and objects with methods, such as class instances) are refused inside arrays,
   * Maps and Sets in `globals`, whatever this option says: the built-in methods of those
   * collections (forEach, iteration, get) hand elements to the script directly, which would skip
   * the gate. Promises, WeakMaps, iterators and generators are refused anywhere in `globals`.
   *
   * Security Warning: Functions can leak host scope via closures.
   * Only enable if you understand the security implications.
   */
  allowFunctionsInGlobals?: boolean;

  /**
   * How long, after `timeout` has passed, a tool call (or an async function from `globals`) that
   * was in progress at that moment may still take to deliver its result, in milliseconds. When
   * it runs out the execution ends with the timeout error, whatever is still in progress; the
   * handler's own promise is left to settle and its result is dropped.
   *
   * 0 ends every execution at the deadline. `Infinity` waits for the handler however long it
   * takes, which was the behaviour up to 2.18: a handler that never settles then keeps `run()`
   * from settling. Not used by the `worker_threads` adapter, which ends an execution at the
   * deadline.
   *
   * Default: the value of `timeout`, so `run()` takes at most twice `timeout`.
   */
  toolCallGraceMs?: number;

  /**
   * Maximum number of calls the script may make into functions passed in `globals`
   * (including functions nested in objects), per execution.
   *
   * Default: 10 × `maxToolCalls`
   */
  maxGlobalFunctionCalls?: number;

  /**
   * Tool namespaces: expose tools to the script as namespaced functions.
   *
   * With `{ mail: ['list', 'send'] }`, `await mail.list(args, options)` inside the sandbox is exactly
   * `await callTool('mail.list', args, options)`: it counts toward `maxToolCalls`, is rate-limited
   * and pattern-checked, its result is sanitized, and it reaches the `toolHandler`. A method can
   * name its tool explicitly: `{ users: { list: 'users:list' } }`. `args` defaults to `{}`.
   *
   * Each namespace is a frozen, null-prototype object created inside the sandbox, so aliasing
   * (`const m = mail; m.list()`) and destructuring work and no host object is exposed.
   *
   * The constructor throws a `TypeError` for names that are not identifiers, prototype keys,
   * names starting with `__`, reserved words and sandbox globals used as namespaces, identifiers
   * the AgentScript validator refuses, namespaces that collide with a custom global, duplicated
   * methods, and empty tool names.
   *
   * @example
   * ```typescript
   * const enclave = new Enclave({
   *   toolHandler,
   *   toolNamespaces: { mail: ['list', 'send'], users: { get: 'users:get' } },
   * });
   * await enclave.run(`
   *   const inbox = await mail.list({ unread: true });
   *   const r = await users.get({ id: inbox[0].from }, { throwOnError: false });
   *   return r.success ? r.data.name : r.error.message;
   * `);
   * ```
   */
  toolNamespaces?: ToolNamespaces;

  /**
   * Receives the script's `console.log/info/warn/error/debug` calls instead of the host console.
   *
   * With a handler, scripts may use `console` at every security level. Each call is formatted as
   * the built-in console formats it (arguments joined by spaces, objects JSON-serialized) and
   * handed over as `(level, message)` strings, once `maxConsoleCalls` and `maxConsoleOutputBytes`
   * have allowed it; past a limit the script's call throws and the handler is not called. The
   * handler's return value is ignored and anything it throws or rejects with is swallowed. The
   * script's `console` is a frozen, null-prototype object built inside the sandbox, so it leads
   * to neither the handler nor any host object.
   *
   * Without a handler nothing changes: `console` is allowed only at PERMISSIVE and writes to the
   * host process console.
   *
   * Supported by the double VM (default), the `vm` adapter and the `worker_threads` adapter. A
   * `sandboxAdapter` receives the handler as `ExecutionContext.consoleHandler`; the built-in
   * `InterpreterAdapter` gives the script a `console` when a handler is set, and none without one.
   *
   * @example
   * ```typescript
   * const enclave = new Enclave({
   *   consoleHandler: (level, message) => logger[level](message),
   * });
   * ```
   */
  consoleHandler?: ConsoleHandler;

  /**
   * Whether to sanitize stack traces in error messages
   * Default: Determined by securityLevel (true for STRICT/SECURE)
   *
   * When enabled, file paths and line numbers are removed from stack traces
   * to prevent information leakage about the host system. This applies to every
   * error `run()` returns, whichever stage raised it (validation, transformation,
   * compilation, execution, tool calls) and on every adapter: stack frames become
   * `at [REDACTED]` and paths in the remaining lines are redacted.
   */
  sanitizeStackTraces?: boolean;

  /**
   * Maximum depth for value sanitization in tool responses
   * Default: Determined by securityLevel
   */
  maxSanitizeDepth?: number;

  /**
   * Maximum properties per object in sanitized values
   * Default: Determined by securityLevel
   */
  maxSanitizeProperties?: number;

  /**
   * Reference sidecar (pass-by-reference) configuration
   *
   * When enabled, the enclave:
   * - Extracts large strings from code and stores them in a sidecar
   * - Transforms concatenation to detect reference IDs
   * - Resolves references at the callTool boundary
   * - Stores a tool result that is one large string in the sidecar and hands the script its
   *   reference (a string inside an object or an array is not stored)
   *
   * A script can pass such data (videos, PDFs, images) from one tool to another, and concatenate
   * references where the level allows it, without the data entering the JavaScript sandbox. It
   * cannot read or change the data: nothing is resolved for the script itself.
   *
   * @example
   * ```typescript
   * const enclave = new Enclave({
   *   securityLevel: 'STRICT',
   *   sidecar: {
   *     enabled: true,
   *     extractionThreshold: 64 * 1024, // 64KB
   *   },
   * });
   * ```
   */
  sidecar?: ReferenceSidecarOptions;

  /**
   * AI Scoring Gate configuration
   *
   * A heuristic that scores what a script's tool calls look like, as a signal on top of the
   * AST validation, not a boundary:
   * - Data exfiltration patterns (list→send)
   * - Excessive access (high limits, wildcards)
   * - Fan-out (tool calls in loops)
   * - Sensitive data access (passwords, tokens)
   *
   * Runs AFTER AST validation but BEFORE code execution.
   *
   * @example
   * ```typescript
   * // Rule-based scorer (~1ms, zero dependencies)
   * const enclave = new Enclave({
   *   scoringGate: {
   *     scorer: 'rule-based',
   *     blockThreshold: 70,
   *   },
   * });
   *
   * // External API scorer (the score is whatever the service returns)
   * const enclave = new Enclave({
   *   scoringGate: {
   *     scorer: 'external-api',
   *     externalApi: {
   *       endpoint: 'https://api.example.com/score',
   *       apiKey: process.env.SCORING_API_KEY,
   *     },
   *   },
   * });
   * ```
   */
  scoringGate?: ScoringGateConfig;

  /**
   * Worker Pool Adapter configuration
   *
   * Only used when adapter is set to 'worker_threads'.
   * Runs each script in a worker thread: an isolate of the engine with its own heap limit, in
   * the same process (not a boundary of the operating system), with:
   * - Pool management (min/max workers, scaling)
   * - Memory monitoring and enforcement
   * - Hard halt capability via worker.terminate()
   * - Rate limiting for message flood protection
   * - Dual-layer sandbox (worker thread + VM context)
   *
   * @example
   * ```typescript
   * const enclave = new Enclave({
   *   adapter: 'worker_threads',
   *   workerPoolConfig: {
   *     minWorkers: 2,
   *     maxWorkers: 8,
   *     memoryLimitPerWorker: 256 * 1024 * 1024, // 256MB
   *   },
   * });
   * ```
   */
  workerPoolConfig?: Partial<WorkerPoolConfig>;

  /**
   * Run scripts with this adapter instead of the double VM and the `adapter` option, for hosts
   * without `node:vm` (a browser worker, an edge runtime): for example an `InterpreterAdapter`,
   * or an adapter that hands the script to `@enclave-vm/browser`.
   *
   * The enclave still validates and transforms every script first, but isolation is then the
   * adapter's job: it receives the transformed code and the `ExecutionContext` (limits, tool
   * handler, stats, abort signal) and must enforce them. The caller owns the adapter:
   * `Enclave.dispose()` does not dispose it, so one adapter can serve several enclaves.
   *
   * @example
   * ```typescript
   * import { Enclave, InterpreterAdapter } from '@enclave-vm/core';
   *
   * const enclave = new Enclave({ sandboxAdapter: new InterpreterAdapter() });
   * ```
   */
  sandboxAdapter?: SandboxAdapter;

  /**
   * Secure proxy configuration override
   *
   * Override individual secure proxy settings from the security level preset.
   * If not provided, uses the security level defaults.
   *
   * @example
   * ```typescript
   * // Use STRICT but allow constructor access for debugging
   * const enclave = new Enclave({
   *   securityLevel: 'STRICT',
   *   secureProxyConfig: { blockConstructor: false },
   * });
   * ```
   */
  secureProxyConfig?: Partial<SecureProxyLevelConfig>;

  /**
   * Double VM configuration for enhanced security isolation
   *
   * When enabled (default), user code runs inside a nested VM structure:
   * - Parent VM: Security barrier with enhanced validation
   * - Inner VM: Where user code actually executes
   *
   * This provides defense-in-depth: even if malicious code exploits a VM
   * vulnerability, it only escapes to another sandboxed VM rather than
   * the host process.
   *
   * The parent VM provides additional security:
   * - Operation name validation (whitelist/blacklist patterns)
   * - Rate limiting (max operations per second)
   * - Suspicious pattern detection (exfiltration, enumeration)
   * - Double sanitization of operation arguments
   *
   * @default { enabled: true }
   *
   * @example
   * ```typescript
   * // Use with custom validation (default is enabled)
   * const enclave = new Enclave({
   *   doubleVm: {
   *     parentValidation: {
   *       allowedOperationPattern: /^[a-z]+:[a-z]+$/i,
   *       maxOperationsPerSecond: 50,
   *     },
   *   },
   * });
   *
   * // SECURITY WARNING: Disable (not recommended for production)
   * const enclave = new Enclave({
   *   doubleVm: { enabled: false },
   * });
   * ```
   */
  doubleVm?: PartialDoubleVmConfig;
}

/**
 * Re-exported scoring types for convenience
 * @see {@link ScoringGateConfig} Configuration for the AI scoring gate
 * @see {@link ScoringGateResult} Result from scoring gate evaluation
 */
export type { ScoringGateConfig, ScoringGateResult };

/**
 * Re-exported worker pool configuration type
 * @see {@link WorkerPoolConfig} Configuration for worker pool adapter
 */
export type { WorkerPoolConfig };

/**
 * Re-exported double VM types for convenience
 * @see {@link DoubleVmConfig} Full configuration for double VM layer
 * @see {@link PartialDoubleVmConfig} Partial configuration with defaults
 * @see {@link ParentValidationConfig} Parent VM validation settings
 */
export type { DoubleVmConfig, PartialDoubleVmConfig, ParentValidationConfig };

/**
 * Re-exported tool namespace types
 * @see {@link ToolNamespaces} The `toolNamespaces` configuration
 * @see {@link NormalizedToolNamespace} A validated namespace
 */
export type { ToolNamespaces, NormalizedToolNamespace };

/**
 * Re-exported console handler types
 * @see {@link ConsoleHandler} The `consoleHandler` option
 * @see {@link ConsoleLevel} A console method a script can call
 */
export type { ConsoleHandler, ConsoleLevel };

/**
 * Default double VM configuration
 *
 * Double VM is enabled by default for all adapters.
 * This provides defense-in-depth security through nested VM isolation.
 */
export const DEFAULT_DOUBLE_VM_CONFIG: DoubleVmConfig = {
  enabled: true,
  parentTimeoutBuffer: 1000,
  parentValidation: {
    validateOperationNames: true,
    maxOperationsPerSecond: 100,
    blockSuspiciousSequences: true,
    rapidEnumerationThreshold: 30,
    rapidEnumerationOverrides: {},
    suspiciousPatterns: [], // Default patterns added at runtime
  },
};
