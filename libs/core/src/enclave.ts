/**
 * Enclave - Safe AgentScript Execution Environment
 *
 * Provides a sandboxed environment for executing AgentScript code with:
 * - AST validation
 * - Code transformation
 * - Runtime safety wrappers
 * - Resource limits (timeout, memory, iterations)
 * - Pass-by-reference support for large data
 *
 * @packageDocumentation
 */

import {
  JSAstValidator,
  createAgentScriptPreset,
  createStrictPreset,
  createSecurePreset,
  createStandardPreset,
  createPermissivePreset,
  createBabelPreset,
  getBabelConfig,
  getAgentScriptGlobals,
  type ValidationIssue,
} from '@enclave-vm/ast';
import {
  createRestrictedBabel,
  transformMultiple,
  type MultiFileInput,
  type MultiFileTransformOptions,
  type MultiFileTransformResult,
} from './babel';
import { transformAgentScript, isWrappedInMain } from '@enclave-vm/ast';
import {
  extractLargeStrings,
  transformConcatenation,
  transformTemplateLiterals,
  guardComputedMemberKeys,
  normalizeToolNamespaces,
  type NormalizedToolNamespace,
} from '@enclave-vm/ast';
import * as acorn from 'acorn';
import { generate } from 'astring';
import type {
  EnclaveConfig,
  CreateEnclaveOptions,
  ExecutionResult,
  ExecutionContext,
  ExecutionStats,
  SandboxAdapter,
  ToolHandler,
  SecurityLevel,
  AstPreset,
  ReferenceSidecarOptions,
  SecureProxyLevelConfig,
  DoubleVmConfig,
  PartialDoubleVmConfig,
  ConsoleHandler,
} from './types';
import type { WorkerPoolConfig } from './adapters/worker-pool';
import { SECURITY_LEVEL_CONFIGS, DEFAULT_DOUBLE_VM_CONFIG } from './types';
import { validateGlobals } from './globals-validator';
import { buildBlockedPropertiesFromConfig } from './secure-proxy';
import { ReferenceSidecar } from './sidecar';
import { REFERENCE_CONFIGS, ReferenceConfig } from './sidecar';
import { ScoringGate, ScoringGateResult } from './scoring';
import { resolveMaxGlobalFunctionCalls } from './global-function-gate';
import { sanitizeStackTrace } from './stack-trace';
import { injectDeadlineChecks } from './deadline-guard';
import { guardSandboxRejections } from './sandbox-rejections';
import { createHostActivity, trackToolCalls } from './execution-deadline';
import { assertNodeVmAvailable } from './node-vm';

/**
 * Default security level
 */
const DEFAULT_SECURITY_LEVEL: SecurityLevel = 'STANDARD';

/**
 * Default maximum tool bridge payload size.
 */
const DEFAULT_TOOL_BRIDGE_MAX_PAYLOAD_BYTES = 5 * 1024 * 1024; // 5MB

/**
 * Get merged configuration from security level and explicit options
 * Explicit options override security level defaults
 */
function getConfigFromSecurityLevel(
  securityLevel: SecurityLevel,
  options: CreateEnclaveOptions,
): {
  timeout: number;
  maxIterations: number;
  maxToolCalls: number;
  sanitizeStackTraces: boolean;
  maxSanitizeDepth: number;
  maxSanitizeProperties: number;
  allowFunctionsInGlobals: boolean;
  maxConsoleOutputBytes: number;
  maxConsoleCalls: number;
  secureProxyConfig: SecureProxyLevelConfig;
} {
  const levelConfig = SECURITY_LEVEL_CONFIGS[securityLevel];

  // Merge secure proxy config: explicit options override level defaults
  const secureProxyConfig: SecureProxyLevelConfig = {
    ...levelConfig.secureProxy,
    ...(options.secureProxyConfig ?? {}),
  };

  return {
    timeout: options.timeout ?? levelConfig.timeout,
    maxIterations: options.maxIterations ?? levelConfig.maxIterations,
    maxToolCalls: options.maxToolCalls ?? levelConfig.maxToolCalls,
    sanitizeStackTraces: options.sanitizeStackTraces ?? levelConfig.sanitizeStackTraces,
    maxSanitizeDepth: options.maxSanitizeDepth ?? levelConfig.maxSanitizeDepth,
    maxSanitizeProperties: options.maxSanitizeProperties ?? levelConfig.maxSanitizeProperties,
    allowFunctionsInGlobals: options.allowFunctionsInGlobals ?? levelConfig.allowFunctionsInGlobals,
    maxConsoleOutputBytes: options.maxConsoleOutputBytes ?? levelConfig.maxConsoleOutputBytes,
    maxConsoleCalls: options.maxConsoleCalls ?? levelConfig.maxConsoleCalls,
    secureProxyConfig,
  };
}

/**
 * Base configuration values (non-security-level dependent)
 */
const BASE_CONFIG = {
  memoryLimit: 1 * 1024 * 1024, // 1 MB - default memory limit for AgentScript execution
  adapter: 'vm' as const,
  allowBuiltins: false,
  globals: {},
  toolHandler: undefined as ToolHandler | undefined,
};

/**
 * Build reference config from security level and sidecar options
 */
function buildReferenceConfig(
  securityLevel: SecurityLevel,
  sidecarOptions?: ReferenceSidecarOptions,
): ReferenceConfig | undefined {
  if (!sidecarOptions?.enabled) {
    return undefined;
  }

  const baseConfig = REFERENCE_CONFIGS[securityLevel];

  return {
    maxTotalSize: sidecarOptions.maxTotalSize ?? baseConfig.maxTotalSize,
    maxReferenceSize: sidecarOptions.maxReferenceSize ?? baseConfig.maxReferenceSize,
    extractionThreshold: sidecarOptions.extractionThreshold ?? baseConfig.extractionThreshold,
    maxResolvedSize: sidecarOptions.maxResolvedSize ?? baseConfig.maxResolvedSize,
    allowComposites: sidecarOptions.allowComposites ?? baseConfig.allowComposites,
    maxReferenceCount: sidecarOptions.maxReferenceCount ?? baseConfig.maxReferenceCount,
    maxResolutionDepth: baseConfig.maxResolutionDepth,
  };
}

/**
 * Enclave - Safe AgentScript Execution Environment
 *
 * @example
 * ```typescript
 * import { Enclave } from '@enclave-vm/core';
 *
 * // Create enclave with tool handler
 * const enclave = new Enclave({
 *   timeout: 5000,
 *   maxToolCalls: 50,
 *   toolHandler: async (toolName, args) => {
 *     // Handle tool calls
 *     return { result: 'data' };
 *   },
 * });
 *
 * // Execute AgentScript code
 * const code = `
 *   const users = await callTool('users:list', {});
 *   return users.items.length;
 * `;
 *
 * const result = await enclave.run(code);
 * console.log(result.value); // Number of users
 * ```
 */
export class Enclave {
  private readonly config: Omit<Required<EnclaveConfig>, 'toolHandler'> & {
    toolHandler?: ToolHandler;
    sanitizeStackTraces: boolean;
    maxSanitizeDepth: number;
    maxSanitizeProperties: number;
    maxConsoleOutputBytes: number;
    maxConsoleCalls: number;
    workerPoolConfig?: Partial<WorkerPoolConfig>;
    secureProxyConfig: SecureProxyLevelConfig;
    maxGlobalFunctionCalls: number;
  };
  private readonly securityLevel: SecurityLevel;
  private readonly validator: JSAstValidator;
  private readonly validateCode: boolean;
  private readonly transformCode: boolean;
  private readonly referenceConfig?: ReferenceConfig;
  private readonly scoringGate?: ScoringGate;
  private readonly doubleVmConfig: DoubleVmConfig;
  private readonly customGlobalNames: string[];
  private readonly toolNamespaces: readonly NormalizedToolNamespace[];
  private readonly sandboxAdapter?: SandboxAdapter;
  private readonly consoleHandler?: ConsoleHandler;
  /** How long after the deadline a host call still in flight may take to deliver (see ./execution-deadline) */
  private readonly toolCallGraceMs: number;
  /** Global names the script's realm may hold (`realmGlobals: 'allowlist'`); absent otherwise. */
  private readonly realmGlobalAllowlist?: readonly string[];
  private adapter?: SandboxAdapter;
  /** The adapter while it is being created: executions that start at once share it */
  private adapterCreation?: Promise<SandboxAdapter>;

  constructor(options: CreateEnclaveOptions = {}) {
    // Determine security level (default: STANDARD)
    this.securityLevel = options.securityLevel ?? DEFAULT_SECURITY_LEVEL;

    // Get configuration from security level, with explicit options overriding
    const securityConfig = getConfigFromSecurityLevel(this.securityLevel, options);

    // Validate custom globals before use
    // Security: Prevents function injection, getters/setters, and dangerous patterns
    if (options.globals) {
      validateGlobals(options.globals, {
        maxDepth: 10,
        allowFunctions: securityConfig.allowFunctionsInGlobals,
        allowGettersSetters: false,
        // Where the membrane lets a script read `constructor`, the class of an instance is a
        // function in globals
        classConstructorsReachable: !securityConfig.secureProxyConfig.blockConstructor,
      });
      // The sandbox installs its own `Object`, without the methods that redefine properties. A
      // custom global of that name would either replace it or make every run fail at setup.
      if (Object.hasOwn(options.globals, 'Object')) {
        throw new TypeError('A custom global cannot be named "Object": the sandbox provides its own Object');
      }
    }

    if (options.consoleHandler !== undefined) {
      if (typeof options.consoleHandler !== 'function') {
        throw new TypeError('consoleHandler must be a function');
      }
      if (options.globals && Object.hasOwn(options.globals, 'console')) {
        throw new TypeError('consoleHandler cannot be combined with a custom `console` global');
      }
    }
    this.consoleHandler = options.consoleHandler;

    // Normalize tool bridge configuration (defaults + validation)
    const normalizedToolBridge = {
      mode: options.toolBridge?.mode ?? 'string',
      maxPayloadBytes: options.toolBridge?.maxPayloadBytes ?? DEFAULT_TOOL_BRIDGE_MAX_PAYLOAD_BYTES,
      acknowledgeInsecureDirect: options.toolBridge?.acknowledgeInsecureDirect ?? false,
    };

    if (normalizedToolBridge.mode !== 'string' && normalizedToolBridge.mode !== 'direct') {
      throw new TypeError(`Invalid toolBridge.mode: ${String(normalizedToolBridge.mode)}`);
    }

    if (!Number.isFinite(normalizedToolBridge.maxPayloadBytes) || normalizedToolBridge.maxPayloadBytes <= 0) {
      throw new TypeError('toolBridge.maxPayloadBytes must be a positive, finite number');
    }

    if (normalizedToolBridge.mode === 'direct' && normalizedToolBridge.acknowledgeInsecureDirect !== true) {
      throw new Error(
        `toolBridge.mode='direct' is insecure; set toolBridge.acknowledgeInsecureDirect=true to enable it explicitly.`,
      );
    }

    // Build initial globals from base config and user options
    const initialGlobals: Record<string, unknown> = {
      ...BASE_CONFIG.globals,
      ...options.globals,
    };

    // Add Babel global when preset is 'babel'
    // Creates a restricted Babel.transform() and Babel.transformMultiple() API
    // with security-level-aware limits
    const presetName: AstPreset = options.preset ?? 'agentscript';
    if (presetName === 'babel') {
      const babelConfig = getBabelConfig(this.securityLevel);
      const restrictedBabel = createRestrictedBabel({
        maxInputSize: babelConfig.maxInputSize,
        maxOutputSize: babelConfig.maxOutputSize,
        allowedPresets: babelConfig.allowedPresets,
        transformTimeout: babelConfig.transformTimeout,
      });

      // Multi-file limits from security level
      const multiFileLimits = {
        maxFiles: babelConfig.maxFiles,
        maxTotalInputSize: babelConfig.maxTotalInputSize,
        maxTotalOutputSize: babelConfig.maxTotalOutputSize,
        transformTimeout: babelConfig.transformTimeout,
      };

      // Create combined Babel global with both transform and transformMultiple
      initialGlobals['Babel'] = {
        // Single file transform
        transform: restrictedBabel.transform,

        // Multi-file transform
        transformMultiple: (
          files: MultiFileInput,
          transformOptions?: MultiFileTransformOptions,
        ): MultiFileTransformResult => {
          return transformMultiple(files, transformOptions ?? {}, multiFileLimits, restrictedBabel.transform);
        },
      };
    }

    // Tool namespaces: validated once here so an unsafe name fails at construction. A namespace
    // may not collide with a custom global (including the Babel global of the babel preset).
    this.toolNamespaces = normalizeToolNamespaces(options.toolNamespaces, {
      reservedNames: Object.keys(initialGlobals),
    });

    if (
      options.maxGlobalFunctionCalls !== undefined &&
      !(Number.isInteger(options.maxGlobalFunctionCalls) && options.maxGlobalFunctionCalls >= 0)
    ) {
      throw new TypeError('maxGlobalFunctionCalls must be a non-negative integer');
    }

    if (
      options.toolCallGraceMs !== undefined &&
      !(typeof options.toolCallGraceMs === 'number' && options.toolCallGraceMs >= 0)
    ) {
      throw new TypeError('toolCallGraceMs must be a non-negative number (Infinity to wait without limit)');
    }
    // As long again as the timeout unless the host says otherwise: run() takes at most twice `timeout`
    this.toolCallGraceMs = options.toolCallGraceMs ?? securityConfig.timeout;

    // Merge with defaults, applying security level configuration
    // Note: We explicitly set secureProxyConfig AFTER spreading options to ensure
    // the merged config from securityConfig takes precedence over partial options
    this.config = {
      ...BASE_CONFIG,
      timeout: securityConfig.timeout,
      maxIterations: securityConfig.maxIterations,
      maxToolCalls: securityConfig.maxToolCalls,
      sanitizeStackTraces: securityConfig.sanitizeStackTraces,
      maxSanitizeDepth: securityConfig.maxSanitizeDepth,
      maxSanitizeProperties: securityConfig.maxSanitizeProperties,
      maxConsoleOutputBytes: securityConfig.maxConsoleOutputBytes,
      maxConsoleCalls: securityConfig.maxConsoleCalls,
      ...options,
      toolBridge: normalizedToolBridge,
      // secureProxyConfig must come AFTER options spread to use the merged config
      secureProxyConfig: securityConfig.secureProxyConfig,
      globals: initialGlobals,
      maxGlobalFunctionCalls: resolveMaxGlobalFunctionCalls({
        maxToolCalls: securityConfig.maxToolCalls,
        maxGlobalFunctionCalls: options.maxGlobalFunctionCalls,
      }),
    };

    // Create validator with custom globals
    // Extract custom global names from the final globals (includes Babel if preset='babel')
    // plus the tool namespace names. Store for use in transformation (so these globals aren't
    // transformed to __safe_ prefix)
    this.customGlobalNames = [...Object.keys(initialGlobals), ...this.toolNamespaces.map((ns) => ns.name)];

    // For each custom global, we need to whitelist both:
    // 1. The original name (customValue)
    // 2. The transformed name (__safe_customValue)
    const customAllowedGlobals = this.customGlobalNames.flatMap((name) => [name, `__safe_${name}`]);

    // The globals that are objects of the host: the tool namespaces, and every custom global
    // that is not a string. A method named `search` or `match` on one of those is the host's; on
    // a string global it would be the string method that compiles its argument into a pattern.
    const hostObjectGlobals = [
      ...Object.keys(initialGlobals).filter((name) => typeof initialGlobals[name] !== 'string'),
      ...this.toolNamespaces.map((ns) => ns.name),
    ];

    // Create validator based on selected preset
    // Note: presetName is defined earlier (before config) for Babel global injection
    this.validator = this.createValidator(presetName, customAllowedGlobals, hostObjectGlobals);

    // Configuration flags
    this.validateCode = options.validate !== false; // Default: true
    this.transformCode = options.transform !== false; // Default: true

    // Realm globals: by default the script's realm holds exactly the names its validator accepts.
    // That only holds when this validator is the one checking the script (an allowlist preset,
    // validation on); otherwise a script may legitimately name other standard globals.
    const realmGlobals =
      options.realmGlobals ??
      ((presetName === 'agentscript' || presetName === 'babel') && this.validateCode ? 'allowlist' : 'security-level');
    if (realmGlobals !== 'allowlist' && realmGlobals !== 'security-level') {
      throw new TypeError(`Invalid realmGlobals: ${String(realmGlobals)}`);
    }
    this.realmGlobalAllowlist =
      realmGlobals === 'allowlist' ? this.buildAllowedGlobals(customAllowedGlobals) : undefined;

    // Build reference config if sidecar is enabled
    this.referenceConfig = buildReferenceConfig(this.securityLevel, options.sidecar);

    // Initialize scoring gate if configured
    if (options.scoringGate && options.scoringGate.scorer !== 'disabled') {
      this.scoringGate = new ScoringGate(options.scoringGate);
    }

    // Build double VM config (default enabled for all adapters)
    this.doubleVmConfig = this.buildDoubleVmConfig(options.doubleVm);

    if (options.sandboxAdapter !== undefined && !isSandboxAdapter(options.sandboxAdapter)) {
      throw new TypeError('sandboxAdapter must have execute(code, context) and dispose() methods');
    }
    this.sandboxAdapter = options.sandboxAdapter;

    // Adapter will be lazy-loaded based on config.adapter
  }

  /**
   * Build double VM configuration from user options
   *
   * Merges user options with defaults, handling nested validation config.
   */
  private buildDoubleVmConfig(options?: PartialDoubleVmConfig): DoubleVmConfig {
    if (!options) {
      return { ...DEFAULT_DOUBLE_VM_CONFIG };
    }

    return {
      enabled: options.enabled ?? DEFAULT_DOUBLE_VM_CONFIG.enabled,
      parentTimeoutBuffer: options.parentTimeoutBuffer ?? DEFAULT_DOUBLE_VM_CONFIG.parentTimeoutBuffer,
      parentValidation: {
        ...DEFAULT_DOUBLE_VM_CONFIG.parentValidation,
        ...options.parentValidation,
        // User-provided custom patterns (default patterns from DEFAULT_SUSPICIOUS_PATTERNS
        // are automatically added by DoubleVmWrapper during bootstrap)
        suspiciousPatterns: [...(options.parentValidation?.suspiciousPatterns ?? [])],
      },
    };
  }

  /**
   * Initialize async components (scoring gate, etc.)
   *
   * Call this before run() if using scorers that require initialization
   * (e.g., local-llm needs to download the model)
   */
  async initialize(): Promise<void> {
    await this.scoringGate?.initialize();
  }

  /**
   * Execute AgentScript code
   *
   * Every error returned obeys `sanitizeStackTraces`, whichever stage raised it.
   *
   * @param code AgentScript code to execute
   * @param toolHandler Optional tool handler (overrides constructor config)
   * @returns Execution result
   */
  async run<T = unknown>(code: string, toolHandler?: ToolHandler): Promise<ExecutionResult<T>> {
    const result = await this.execute<T>(code, toolHandler);
    return this.applyStackTracePolicy(result);
  }

  /**
   * Single exit for returned errors: with `sanitizeStackTraces` on, strip host paths, file
   * locations and frames from the stack, whichever stage (validation, transform, compile,
   * execution, tool call) and adapter produced the error.
   */
  private applyStackTracePolicy<T>(result: ExecutionResult<T>): ExecutionResult<T> {
    if (result.success || !result.error?.stack || !this.config.sanitizeStackTraces) {
      return result;
    }
    return { ...result, error: { ...result.error, stack: sanitizeStackTrace(result.error.stack, true) } };
  }

  /**
   * Transform, validate and execute. `run` applies the stack-trace policy to what this returns.
   */
  private async execute<T>(code: string, toolHandler?: ToolHandler): Promise<ExecutionResult<T>> {
    const startTime = Date.now();

    // Initialize stats
    const stats: ExecutionStats = {
      duration: 0,
      toolCallCount: 0,
      iterationCount: 0,
      startTime,
      endTime: 0,
    };

    // Create sidecar for this execution if enabled
    const sidecar = this.referenceConfig ? new ReferenceSidecar(this.referenceConfig) : undefined;

    // Set once the execution context exists: ends what the script can still do through the host
    let endExecution: (() => void) | undefined;

    try {
      // Step 1: Transform (if enabled) - MUST happen before validation
      // because AgentScript allows top-level return, await, etc. which are only
      // valid after wrapping in async function __ag_main()
      let transformedCode = code;
      if (this.transformCode) {
        // Check if already wrapped
        const needsWrapping = !isWrappedInMain(code);

        transformedCode = transformAgentScript(code, {
          wrapInMain: needsWrapping,
          transformCallTool: true,
          transformLoops: true,
          // Pass custom global names so they aren't transformed to __safe_ prefix
          additionalIdentifiers: this.customGlobalNames,
        });
      }

      // Step 1.5: Validate (if enabled) - validate BEFORE memory transforms
      // This catches malicious patterns like constructor obfuscation BEFORE
      // they get transformed to __safe_concat calls (which would bypass detection)
      if (this.validateCode) {
        const validationResult = await this.validator.validate(transformedCode);
        if (!validationResult.valid) {
          // Format errors with location info and deduplicate
          const errorMessages = this.formatValidationErrors(validationResult.issues);

          return {
            success: false,
            error: {
              name: 'ValidationError',
              message: `AgentScript validation failed:\n${errorMessages}`,
              code: 'VALIDATION_ERROR',
              data: { issues: validationResult.issues },
            },
            stats: {
              ...stats,
              duration: Date.now() - startTime,
              endTime: Date.now(),
            },
          };
        }
      }

      // Step 2: Apply sidecar transforms if enabled
      // These transforms extract large strings and convert concatenation to safe calls
      if (sidecar && this.referenceConfig) {
        transformedCode = this.applySidecarTransforms(transformedCode, sidecar);
      } else if (this.config.memoryLimit && this.config.memoryLimit > 0) {
        // Step 2.1: Apply memory tracking transforms when memoryLimit is set
        // This transforms concatenation to use __safe_concat for memory tracking
        transformedCode = this.applyMemoryTrackingTransforms(transformedCode);
      }

      // Step 2.15: Cooperative deadline checks. vm's timeout stops watching at the script's first
      // `await`; these make the script itself check the clock at every function entry and loop
      // iteration, so synchronous work is stopped at the deadline whatever it awaited before.
      // Runs AFTER validation (the injected helper uses the reserved `__ag_` prefix) and before the
      // computed-key guard, so that guard's own helper is not instrumented.
      if (this.transformCode) {
        transformedCode = this.applyDeadlineGuard(transformedCode);
      }

      // Step 2.2: Runtime computed-key guard (defense-in-depth for weakness 1).
      // Runs AFTER validation so it neither masks the static rules nor trips them on its injected
      // helper. Wraps dynamic computed member keys so `obj[expr]` checks the RESOLVED key at
      // runtime, catching dangerous names built via `String.fromCharCode(...)`, concatenation,
      // etc. that static analysis cannot resolve.
      if (this.transformCode) {
        transformedCode = this.applyComputedKeyGuard(transformedCode);
      }

      // Step 2.5: AI Scoring Gate (if configured)
      // This runs AFTER AST validation but BEFORE code execution
      let scoringResult: ScoringGateResult | undefined;
      if (this.scoringGate) {
        scoringResult = await this.scoringGate.evaluate(transformedCode);

        if (!scoringResult.allowed) {
          const signalSummary =
            scoringResult.signals?.map((s) => `${s.id}: ${s.description}`).join('; ') ?? 'Unknown risk';

          return {
            success: false,
            error: {
              name: 'ScoringGateError',
              message: `Script blocked by AI scoring (score: ${scoringResult.totalScore}): ${signalSummary}`,
              code: 'SCORING_BLOCKED',
              data: {
                totalScore: scoringResult.totalScore,
                riskLevel: scoringResult.riskLevel,
                signals: scoringResult.signals,
              },
            },
            stats: {
              ...stats,
              duration: Date.now() - startTime,
              endTime: Date.now(),
            },
            scoringResult,
          };
        }
      }

      // Step 3: Create execution context
      //
      // `aborted` is what every abort check reads (tool calls, guarded loops, calls into host
      // functions). The timer below sets it, but a timer only fires between jobs: a script doing
      // synchronous work after an `await` never lets it fire, so the flag alone would stay false
      // for as long as the script kept the thread. Reading the clock makes the checks hold from
      // the deadline on, timer or not.
      //
      // The clock starts when the sandbox is ready (see below), not here: creating the adapter is
      // the host's work, done once, and with the worker pool it starts the worker threads.
      let deadline = Number.POSITIVE_INFINITY;
      let abortRequested = false;
      // What the host has in flight for the script (tool calls, async host functions). A script
      // that is still waiting at the deadline, with nothing of the host's in flight, can only be
      // waiting for something of its own that will never happen; one that is waiting for the host
      // gets `toolCallGraceMs` more: see ./execution-deadline.
      const hostActivity = createHostActivity(this.toolCallGraceMs);
      const hostToolHandler = toolHandler || this.config.toolHandler;
      // Once run() has returned, the script's execution is over for the host as well. A script
      // can leave work behind (a tool call it did not await, a `then` on one): when that wakes up
      // it finds every tool call and host function refused, and its console lines are dropped.
      let returned = false;
      const hostConsoleHandler = this.consoleHandler;
      const context: ExecutionContext = {
        config: this.config,
        stats,
        abortController: new AbortController(),
        get aborted(): boolean {
          return abortRequested || Date.now() >= deadline;
        },
        set aborted(value: boolean) {
          abortRequested = value;
        },
        toolHandler: hostToolHandler ? trackToolCalls(hostToolHandler, hostActivity) : undefined,
        hostActivity,
        consoleHandler: hostConsoleHandler
          ? (level, message) => (returned ? undefined : hostConsoleHandler(level, message))
          : undefined,
        sidecar,
        referenceConfig: this.referenceConfig,
        secureProxyConfig: this.config.secureProxyConfig,
        toolNamespaces: this.toolNamespaces,
        realmGlobalAllowlist: this.realmGlobalAllowlist,
      };

      endExecution = () => {
        returned = true;
        abortRequested = true;
        context.abortController.abort();
      };

      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const ONLY_WAITING = Symbol('only waiting');

      try {
        // Step 4: Execute in sandbox
        const adapter = await this.getAdapter();
        // Set up timeout. From here on the time is the script's: with a pool that was still
        // starting its workers, a short timeout would otherwise be over before the script began,
        // and a script is never started once its deadline has passed.
        deadline = Date.now() + this.config.timeout;
        timeoutId = setTimeout(() => {
          context.aborted = true;
          context.abortController.abort();
          hostActivity.deadlinePassed();
        }, this.config.timeout);
        // A promise rejection the script leaves unhandled must not end the host process (the
        // built-in adapters do this themselves; a host-supplied adapter may not)
        guardSandboxRejections();
        // Not with the worker pool: from this thread a script that waits in a worker looks the
        // same as one that keeps its worker busy, and the pool ends both itself, five seconds
        // after the deadline, by terminating the worker.
        const execution = adapter.execute<T>(transformedCode, context);
        const outcome =
          this.config.adapter === 'worker_threads'
            ? await execution
            : await Promise.race([execution, hostActivity.over.then(() => ONLY_WAITING)]);

        // Clear timeout
        clearTimeout(timeoutId);
        // Tool calls and host functions that had not settled when the execution was ended
        const pendingHostCalls = hostActivity.inFlight;
        hostActivity.close();

        if (outcome === ONLY_WAITING) {
          // Past the deadline, and the script is waiting: for something that is not the host's to
          // deliver, or for the host longer than `toolCallGraceMs`. The adapter's own promise
          // stays pending and is left behind; the script can do nothing more through this context
          // (every abort check refuses from the deadline on). When host calls were abandoned the
          // error says how many: they are still running, and the host may want to know before it
          // lets anybody repeat them.
          return {
            success: false,
            error: {
              name: 'VMExecutionError',
              message: `Script execution timed out after ${this.config.timeout}ms`,
              code: 'VM_EXECUTION_ERROR',
              ...(pendingHostCalls > 0 ? { data: { pendingHostCalls } } : {}),
            },
            stats: {
              ...stats,
              duration: Date.now() - startTime,
              endTime: Date.now(),
            },
            ...(scoringResult ? { scoringResult } : {}),
          };
        }
        const result = outcome as ExecutionResult<T>;

        // Include scoring result in successful execution
        if (scoringResult) {
          return { ...result, scoringResult };
        }

        return result;
      } catch (error: unknown) {
        // Clear timeout
        clearTimeout(timeoutId);
        hostActivity.close();

        const err = error as Error;
        return {
          success: false,
          error: {
            name: err.name || 'ExecutionError',
            message: err.message || 'Unknown execution error',
            stack: err.stack,
            code: 'EXECUTION_ERROR',
          },
          stats: {
            ...stats,
            duration: Date.now() - startTime,
            endTime: Date.now(),
          },
        };
      }
    } catch (error: unknown) {
      const err = error as Error;
      return {
        success: false,
        error: {
          name: err.name || 'EnclaveError',
          message: err.message || 'Unknown enclave error',
          stack: err.stack,
          code: 'ENCLAVE_ERROR',
        },
        stats: {
          ...stats,
          duration: Date.now() - startTime,
          endTime: Date.now(),
        },
      };
    } finally {
      // Whatever the script left behind can no longer reach the host (see `returned` above)
      endExecution?.();
      // Always dispose the sidecar to prevent memory leaks
      if (sidecar) {
        sidecar.dispose();
      }
    }
  }

  /**
   * Apply memory tracking transforms to code
   *
   * Transforms concatenation operations to use __safe_concat for memory tracking.
   * This is used when memoryLimit is set but no sidecar is configured.
   *
   * @param code The code to transform
   * @returns The transformed code
   */
  private applyComputedKeyGuard(code: string): string {
    // Mirror the runtime membrane's policy for this security level: refuse the same keys, and
    // yield undefined instead of throwing when the level does not throw on blocked access.
    const proxyConfig = this.config.secureProxyConfig;
    const blockedKeys = [...buildBlockedPropertiesFromConfig(proxyConfig)];
    if (blockedKeys.length === 0) {
      return code;
    }
    const throwOnBlocked = proxyConfig.throwOnBlocked ?? true;

    const parseModule = (source: string): acorn.Node =>
      acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' }) as unknown as acorn.Node;

    const ast = parseModule(code);
    const { guardedCount } = guardComputedMemberKeys(ast, parseModule, { blockedKeys, throwOnBlocked });
    if (guardedCount === 0) {
      return code;
    }
    return generate(ast);
  }

  /**
   * Insert cooperative deadline checks (see ./deadline-guard).
   *
   * @param code The validated, transformed code
   * @returns The code with a deadline check at the start of every function and loop body
   */
  private applyDeadlineGuard(code: string): string {
    const parseModule = (source: string): acorn.Node =>
      acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' }) as unknown as acorn.Node;

    const ast = parseModule(code);
    const { guardedCount } = injectDeadlineChecks(ast, parseModule);
    if (guardedCount === 0) {
      return code;
    }
    return generate(ast);
  }

  private applyMemoryTrackingTransforms(code: string): string {
    // Parse the code into an AST
    const ast = acorn.parse(code, {
      ecmaVersion: 'latest',
      sourceType: 'module',
    });

    // Transform concatenation operations (a + b -> __safe_concat(a, b))
    // This allows the runtime to track memory allocations for string concatenation
    transformConcatenation(ast);

    // Transform template literals (`Hello ${name}` -> __safe_template(['Hello ', ''], name))
    // This also enables memory tracking for template string creation
    transformTemplateLiterals(ast);

    // Generate code from the transformed AST
    return generate(ast);
  }

  /**
   * Apply sidecar transforms to code
   *
   * Extracts large strings and transforms concatenation to use safe functions.
   *
   * @param code The code to transform
   * @param sidecar The sidecar to store extracted strings
   * @returns The transformed code
   */
  private applySidecarTransforms(code: string, sidecar: ReferenceSidecar): string {
    // Parse the code into an AST
    const ast = acorn.parse(code, {
      ecmaVersion: 'latest',
      sourceType: 'module',
    });

    // Extract large strings (if extraction threshold is set)
    if (this.referenceConfig?.extractionThreshold) {
      extractLargeStrings(ast, {
        threshold: this.referenceConfig.extractionThreshold,
        onExtract: (value) => {
          return sidecar.store(value, 'extraction');
        },
      });
    }

    // Transform concatenation operations (a + b -> __safe_concat(a, b))
    transformConcatenation(ast);

    // Transform template literals (`Hello ${name}` -> __safe_template(['Hello ', ''], name))
    transformTemplateLiterals(ast);

    // Generate code from the transformed AST
    return generate(ast);
  }

  /**
   * Get or create the sandbox adapter
   *
   * A host-supplied `sandboxAdapter` is used as is. Otherwise, when double VM is enabled
   * (default), the base adapter is wrapped
   * with a double VM layer that provides:
   * - Nested VM isolation (Parent VM + Inner VM)
   * - Enhanced tool call validation
   * - Suspicious pattern detection
   * - Defense-in-depth against VM escape attacks
   */
  private getAdapter(): Promise<SandboxAdapter> {
    if (this.sandboxAdapter) {
      return Promise.resolve(this.sandboxAdapter);
    }
    if (this.adapter) {
      return Promise.resolve(this.adapter);
    }

    // Executions that start before the adapter exists share one creation. Each of them used to
    // create its own: with worker threads that was one pool per execution, each with its warm
    // workers, and dispose() knew only the last one.
    if (!this.adapterCreation) {
      const creation: Promise<SandboxAdapter> = this.createAdapter().then(
        (adapter) => {
          if (this.adapterCreation === creation) {
            this.adapterCreation = undefined;
            this.adapter = adapter;
          } else {
            // dispose() was called while the adapter was being created
            adapter.dispose();
          }
          return adapter;
        },
        (error: unknown) => {
          if (this.adapterCreation === creation) {
            this.adapterCreation = undefined;
          }
          throw error;
        },
      );
      this.adapterCreation = creation;
    }
    return this.adapterCreation;
  }

  /**
   * Create the sandbox adapter this enclave is configured for (see {@link getAdapter}, which
   * keeps it)
   */
  private async createAdapter(): Promise<SandboxAdapter> {
    if (this.doubleVmConfig.enabled || this.config.adapter === 'vm') {
      assertNodeVmAvailable();
    }

    // Worker threads compose with the double VM: the pool runs each script in a worker, and
    // inside the worker in the sandbox this enclave is configured for (the double VM by default,
    // a single VM when it is disabled). The worker adds a heap limit and a hard stop; it is not a
    // sandbox by itself.
    if (this.config.adapter === 'worker_threads') {
      const [{ WorkerPoolAdapter }, { wrapWithDoubleVm }] = await Promise.all([
        import('./adapters/worker-pool/index.js'),
        import('./double-vm/index.js'),
      ]);
      const pool = new WorkerPoolAdapter(this.config.workerPoolConfig, this.securityLevel, this.doubleVmConfig);
      try {
        await pool.initialize();
      } catch (error) {
        // The pool is not kept, so dispose() of this enclave would never reach it
        pool.dispose();
        throw error;
      }
      // With the double VM disabled this logs the same security warning as for the in-process
      // single VM, and returns the pool unchanged.
      return this.doubleVmConfig.enabled ? pool : wrapWithDoubleVm(pool, this.doubleVmConfig, this.securityLevel);
    }

    // If double VM is enabled, use the double VM wrapper directly
    // The double VM wrapper creates its own VM structure
    if (this.doubleVmConfig.enabled) {
      const { wrapWithDoubleVm } = await import('./double-vm/index.js');
      // Pass undefined as base adapter since DoubleVmWrapper creates its own VMs
      return wrapWithDoubleVm(undefined, this.doubleVmConfig, this.securityLevel);
    }

    // Double VM disabled - use base adapter with security warning
    // (warning is logged by wrapWithDoubleVm when enabled=false)
    const { wrapWithDoubleVm } = await import('./double-vm/index.js');

    let baseAdapter: SandboxAdapter;

    // Lazy-load adapter based on configuration
    switch (this.config.adapter) {
      case 'vm': {
        const { VmAdapter } = await import('./adapters/vm-adapter.js');
        baseAdapter = new VmAdapter(this.securityLevel);
        break;
      }

      case 'isolated-vm':
        throw new Error('isolated-vm adapter not yet implemented');

      default:
        throw new Error(`Unknown adapter: ${this.config.adapter}`);
    }

    // This will log a security warning and return the base adapter unchanged
    return wrapWithDoubleVm(baseAdapter, this.doubleVmConfig, this.securityLevel);
  }

  /**
   * Get the current security level
   *
   * @returns The security level this enclave was configured with
   */
  getSecurityLevel(): SecurityLevel {
    return this.securityLevel;
  }

  /**
   * Get the effective configuration
   *
   * Useful for debugging and understanding what settings are active
   *
   * @returns A copy of the current configuration
   */
  getEffectiveConfig(): {
    securityLevel: SecurityLevel;
    timeout: number;
    maxIterations: number;
    maxToolCalls: number;
    sanitizeStackTraces: boolean;
    maxSanitizeDepth: number;
    maxSanitizeProperties: number;
    memoryLimit: number;
    realmGlobals: 'allowlist' | 'security-level';
  } {
    return {
      realmGlobals: this.realmGlobalAllowlist ? 'allowlist' : 'security-level',
      securityLevel: this.securityLevel,
      timeout: this.config.timeout,
      maxIterations: this.config.maxIterations,
      maxToolCalls: this.config.maxToolCalls,
      sanitizeStackTraces: this.config.sanitizeStackTraces,
      maxSanitizeDepth: this.config.maxSanitizeDepth,
      maxSanitizeProperties: this.config.maxSanitizeProperties,
      memoryLimit: this.config.memoryLimit,
    };
  }

  /**
   * The global names a script of this enclave may use: the AgentScript globals of the security
   * level, the enclave's runtime helpers, `console` when it is available, and the custom globals
   * and tool namespaces (each under its own name and its `__safe_` name).
   *
   * One list serves two purposes: the validator refuses every other free identifier, and with
   * `realmGlobals: 'allowlist'` the sandbox removes every other global from the script's realm.
   *
   * @param customAllowedGlobals Names of custom globals and tool namespaces, with their `__safe_` forms
   */
  private buildAllowedGlobals(customAllowedGlobals: string[]): string[] {
    // Get base globals from ast-guard based on security level
    // This ensures AST validation matches worker sandbox restrictions
    const securityLevelGlobals = getAgentScriptGlobals(this.securityLevel);

    // Additional enclave-specific globals (for memory transforms and parallel execution)
    const enclaveSpecificGlobals = [
      'parallel', // Parallel execution API
      '__safe_parallel', // Transformed parallel
      '__safe_concat', // Memory-safe string concatenation
      '__safe_template', // Memory-safe template literals
    ];

    // With a consoleHandler, console is allowed at every security level
    const consoleGlobals = this.consoleHandler ? ['console', '__safe_console'] : [];

    // Combine: security-level globals + enclave-specific + custom
    return [...securityLevelGlobals, ...enclaveSpecificGlobals, ...consoleGlobals, ...customAllowedGlobals];
  }

  /**
   * Create a validator based on the selected preset
   *
   * @param presetName The preset to use
   * @param customAllowedGlobals Custom globals to whitelist
   * @returns A configured JSAstValidator
   */
  private createValidator(
    presetName: AstPreset,
    customAllowedGlobals: string[],
    hostObjectGlobals: string[],
  ): JSAstValidator {
    const allAllowedGlobals = this.buildAllowedGlobals(customAllowedGlobals);

    switch (presetName) {
      case 'agentscript':
        // AgentScript preset with security-level-aware globals
        // Enable allowDynamicArrayFill when memoryLimit is configured
        // because runtime Array.prototype.fill patching provides protection
        return new JSAstValidator(
          createAgentScriptPreset({
            securityLevel: this.securityLevel,
            allowedGlobals: allAllowedGlobals,
            hostObjectGlobals,
            allowDynamicArrayFill: this.config.memoryLimit > 0,
          }),
        );

      case 'strict':
        // Other presets don't have allowedGlobals option - they use their own rules
        // Note: custom globals are still available at runtime, just not validated at AST level
        return new JSAstValidator(createStrictPreset());

      case 'secure':
        return new JSAstValidator(createSecurePreset());

      case 'standard':
        return new JSAstValidator(createStandardPreset());

      case 'permissive':
        return new JSAstValidator(createPermissivePreset());

      case 'babel':
        // Babel preset uses security level for all limits
        // Extends AgentScript preset with Babel.transform() support
        return new JSAstValidator(
          createBabelPreset({
            securityLevel: this.securityLevel,
            allowedGlobals: allAllowedGlobals,
            allowDynamicArrayFill: this.config.memoryLimit > 0,
          }),
        );

      default: {
        // TypeScript exhaustiveness check
        const _exhaustiveCheck: never = presetName;
        throw new Error(`Unknown preset: ${_exhaustiveCheck}`);
      }
    }
  }

  /**
   * Dispose the enclave and cleanup resources
   */
  dispose(): void {
    // An adapter that is still being created is disposed as soon as it exists (see getAdapter)
    this.adapterCreation = undefined;
    if (this.adapter) {
      this.adapter.dispose();
      this.adapter = undefined;
    }
    this.scoringGate?.dispose();
  }

  /**
   * Get scoring gate statistics (if configured)
   */
  getScoringStats(): ReturnType<ScoringGate['getCacheStats']> | null {
    return this.scoringGate?.getCacheStats() ?? null;
  }

  /**
   * Format validation errors with line numbers and deduplication
   *
   * @param issues Array of validation issues
   * @returns Formatted error message string
   */
  private formatValidationErrors(issues: ValidationIssue[]): string {
    // Create unique key for each error to deduplicate
    const seen = new Set<string>();
    const uniqueErrors: string[] = [];

    for (const issue of issues) {
      // Build location string if available
      const locationStr = issue.location ? `:${issue.location.line}:${issue.location.column}` : '';

      // Create unique key for deduplication (code + message + location)
      const key = `${issue.code}|${issue.message}|${locationStr}`;

      if (!seen.has(key)) {
        seen.add(key);

        // Format: "CODE (line:col): message" or "CODE: message" if no location
        const formattedLocation = issue.location ? ` (line ${issue.location.line})` : '';
        uniqueErrors.push(`${issue.code}${formattedLocation}: ${issue.message}`);
      }
    }

    return uniqueErrors.join('\n');
  }
}

function isSandboxAdapter(value: unknown): value is SandboxAdapter {
  const candidate = value as Partial<SandboxAdapter> | null;
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof candidate.execute === 'function' &&
    typeof candidate.dispose === 'function'
  );
}

/**
 * Convenience function to create an enclave and run code in one step
 *
 * @param code AgentScript code to execute
 * @param options Enclave configuration options
 * @returns Execution result
 */
export async function runAgentScript<T = unknown>(
  code: string,
  options: CreateEnclaveOptions = {},
): Promise<ExecutionResult<T>> {
  const enclave = new Enclave(options);
  try {
    return await enclave.run<T>(code);
  } finally {
    enclave.dispose();
  }
}
