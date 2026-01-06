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
  type ValidationIssue,
} from 'ast-guard';
import { transformAgentScript, isWrappedInMain } from 'ast-guard';
import { extractLargeStrings, transformConcatenation, transformTemplateLiterals } from 'ast-guard';
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
} from './types';
import type { WorkerPoolConfig } from './adapters/worker-pool';
import { SECURITY_LEVEL_CONFIGS, DEFAULT_DOUBLE_VM_CONFIG } from './types';
import { validateGlobals } from './globals-validator';
import { ReferenceSidecar } from './sidecar';
import { REFERENCE_CONFIGS, ReferenceConfig } from './sidecar';
import { ScoringGate, ScoringGateResult } from './scoring';

/**
 * Default security level
 */
const DEFAULT_SECURITY_LEVEL: SecurityLevel = 'STANDARD';

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
 * import { Enclave } from 'enclave-vm';
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
  };
  private readonly securityLevel: SecurityLevel;
  private readonly validator: JSAstValidator;
  private readonly validateCode: boolean;
  private readonly transformCode: boolean;
  private readonly referenceConfig?: ReferenceConfig;
  private readonly scoringGate?: ScoringGate;
  private readonly doubleVmConfig: DoubleVmConfig;
  private adapter?: SandboxAdapter;

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
      });
    }

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
      // secureProxyConfig must come AFTER options spread to use the merged config
      secureProxyConfig: securityConfig.secureProxyConfig,
      globals: {
        ...BASE_CONFIG.globals,
        ...options.globals,
      },
    };

    // Create validator with custom globals
    // Extract custom global names from options
    const customGlobalNames = options.globals ? Object.keys(options.globals) : [];

    // For each custom global, we need to whitelist both:
    // 1. The original name (customValue)
    // 2. The transformed name (__safe_customValue)
    const customAllowedGlobals = customGlobalNames.flatMap((name) => [name, `__safe_${name}`]);

    // Select preset based on options (default: agentscript)
    const presetName: AstPreset = options.preset ?? 'agentscript';

    // Create validator based on selected preset
    this.validator = this.createValidator(presetName, customAllowedGlobals);

    // Configuration flags
    this.validateCode = options.validate !== false; // Default: true
    this.transformCode = options.transform !== false; // Default: true

    // Build reference config if sidecar is enabled
    this.referenceConfig = buildReferenceConfig(this.securityLevel, options.sidecar);

    // Initialize scoring gate if configured
    if (options.scoringGate && options.scoringGate.scorer !== 'disabled') {
      this.scoringGate = new ScoringGate(options.scoringGate);
    }

    // Build double VM config (default enabled for all adapters)
    this.doubleVmConfig = this.buildDoubleVmConfig(options.doubleVm);

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
   * @param code AgentScript code to execute
   * @param toolHandler Optional tool handler (overrides constructor config)
   * @returns Execution result
   */
  async run<T = unknown>(code: string, toolHandler?: ToolHandler): Promise<ExecutionResult<T>> {
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
        });
      }

      // Step 1.5: Apply sidecar transforms if enabled
      // These transforms extract large strings and convert concatenation to safe calls
      if (sidecar && this.referenceConfig) {
        transformedCode = this.applySidecarTransforms(transformedCode, sidecar);
      } else if (this.config.memoryLimit && this.config.memoryLimit > 0) {
        // Step 1.6: Apply memory tracking transforms when memoryLimit is set
        // This transforms concatenation to use __safe_concat for memory tracking
        transformedCode = this.applyMemoryTrackingTransforms(transformedCode);
      }

      // Step 2: Validate (if enabled) - validate TRANSFORMED code
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
      const context: ExecutionContext = {
        config: this.config,
        stats,
        abortController: new AbortController(),
        aborted: false,
        toolHandler: toolHandler || this.config.toolHandler,
        sidecar,
        referenceConfig: this.referenceConfig,
        secureProxyConfig: this.config.secureProxyConfig,
      };

      // Set up timeout
      const timeoutId = setTimeout(() => {
        context.aborted = true;
        context.abortController.abort();
      }, this.config.timeout);

      try {
        // Step 4: Execute in sandbox
        const adapter = await this.getAdapter();
        const result = await adapter.execute<T>(transformedCode, context);

        // Clear timeout
        clearTimeout(timeoutId);

        // Include scoring result in successful execution
        if (scoringResult) {
          return { ...result, scoringResult };
        }

        return result;
      } catch (error: unknown) {
        // Clear timeout
        clearTimeout(timeoutId);

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
   * When double VM is enabled (default), the base adapter is wrapped
   * with a double VM layer that provides:
   * - Nested VM isolation (Parent VM + Inner VM)
   * - Enhanced tool call validation
   * - Suspicious pattern detection
   * - Defense-in-depth against VM escape attacks
   */
  private async getAdapter(): Promise<SandboxAdapter> {
    if (this.adapter) {
      return this.adapter;
    }

    // If double VM is enabled, use the double VM wrapper directly
    // The double VM wrapper creates its own VM structure
    if (this.doubleVmConfig.enabled) {
      const { wrapWithDoubleVm } = await import('./double-vm/index.js');
      // Pass undefined as base adapter since DoubleVmWrapper creates its own VMs
      this.adapter = wrapWithDoubleVm(undefined, this.doubleVmConfig, this.securityLevel);
      return this.adapter;
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

      case 'worker_threads': {
        const { WorkerPoolAdapter } = await import('./adapters/worker-pool/index.js');
        baseAdapter = new WorkerPoolAdapter(this.config.workerPoolConfig, this.securityLevel);
        await (baseAdapter as { initialize?: () => Promise<void> }).initialize?.();
        break;
      }

      default:
        throw new Error(`Unknown adapter: ${this.config.adapter}`);
    }

    // This will log a security warning and return the base adapter unchanged
    this.adapter = wrapWithDoubleVm(baseAdapter, this.doubleVmConfig, this.securityLevel);
    return this.adapter;
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
  } {
    return {
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
   * Create a validator based on the selected preset
   *
   * @param presetName The preset to use
   * @param customAllowedGlobals Custom globals to whitelist
   * @returns A configured JSAstValidator
   */
  private createValidator(presetName: AstPreset, customAllowedGlobals: string[]): JSAstValidator {
    // Base globals that are always available in the AgentScript runtime
    const baseAgentScriptGlobals = [
      'callTool',
      'parallel',
      'Math',
      'JSON',
      'Array',
      'Object',
      'String',
      'Number',
      'Date',
      'console',
      // Safe standard globals
      'undefined',
      'NaN',
      'Infinity',
      // Safe runtime wrappers
      '__safe_callTool',
      '__safe_forOf',
      '__safe_for',
      '__safe_while',
      '__safe_doWhile',
      '__safe_concat',
      '__safe_template',
      '__safe_parallel',
      '__safe_console',
      // Loop transformation runtime support
      '__maxIterations', // Used by transformed loops for iteration limit
    ];

    switch (presetName) {
      case 'agentscript':
        // AgentScript preset has allowedGlobals option
        return new JSAstValidator(
          createAgentScriptPreset({
            allowedGlobals: [...baseAgentScriptGlobals, ...customAllowedGlobals],
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
