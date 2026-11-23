/**
 * Validated AgentScript execution for hosts without Node's VM modules.
 * This entry point deliberately imports neither the Node VM nor its process hooks.
 */

import {
  JSAstValidator,
  PreScanner,
  ValidationSeverity,
  createAgentScriptPreset,
  extractLargeStrings,
  getAgentScriptGlobals,
  isWrappedInMain,
  normalizeToolNamespaces,
  transformAgentScript,
  transformConcatenation,
  transformTemplateLiterals,
  type NormalizedToolNamespace,
  type ValidationIssue,
} from '@enclave-vm/ast';
import * as acorn from 'acorn';
import { generate } from 'astring';

import { InterpreterAdapter, type InterpreterAdapterOptions } from './adapters/interpreter-adapter';
import { DEFAULT_DOUBLE_VM_CONFIG, SECURITY_LEVEL_CONFIGS } from './types';
import type { CreateEnclaveOptions, ExecutionContext, ExecutionResult, ExecutionStats, ToolHandler } from './types';
import { normalizeEnclaveOptions } from './enclave-options';
import { copyPortableGlobals } from './portable-globals';
import { createSafeGlobals } from './interpreter/safe-globals';
import { ReferenceSidecar, REFERENCE_CONFIGS, type ReferenceConfig } from './sidecar';
import { DEFAULT_SUSPICIOUS_PATTERNS } from './double-vm/suspicious-patterns';
import type { OperationHistory, ParentValidationConfig } from './double-vm/types';
import { refuseDynamicImport } from './dynamic-import';
import { hostClockReaders } from './realm-clock';
import { numberToolCalls } from './tool-call-order';
import {
  assertReviewContext,
  normalizeReviewOptions,
  REVIEW_HALTED,
  ReviewSession,
  type NormalizedReviewOptions,
} from './review/review-session';
import type { ReviewContext } from './review/types';

const MAX_SCRIPT_LENGTH = 5 * 1024 * 1024;
const MAX_PORTABLE_ALLOCATION_BYTES = 64 * 1024 * 1024;
const MAX_PORTABLE_STEPS = 20_000_000;
const MAX_PORTABLE_PENDING_CALLS = 4096;
const MAX_PORTABLE_CALL_DEPTH = 1024;
const DEFAULT_BRIDGE_BYTES = 5 * 1024 * 1024;

export interface PortableEnclaveOptions extends CreateEnclaveOptions {
  /** Interpreter work budgets; every value is finite and capped at construction. */
  interpreter?: InterpreterAdapterOptions;
}

export interface PortableRunOptions {
  maxToolResultBytes?: number;
  onToolBridgeFailure?: () => void;
  /** Passed to the review hooks of this run */
  reviewContext?: ReviewContext;
}

function boundedInteger(name: string, value: unknown, max: number): void {
  if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max)) {
    throw new TypeError(`${name} must be an integer from 1 to ${max}`);
  }
}

function referenceConfig(
  level: keyof typeof REFERENCE_CONFIGS,
  sidecar: CreateEnclaveOptions['sidecar'],
): ReferenceConfig | undefined {
  if (!sidecar?.enabled) return undefined;
  const base = REFERENCE_CONFIGS[level];
  return {
    maxTotalSize: sidecar.maxTotalSize ?? base.maxTotalSize,
    maxReferenceSize: sidecar.maxReferenceSize ?? base.maxReferenceSize,
    extractionThreshold: sidecar.extractionThreshold ?? base.extractionThreshold,
    maxResolvedSize: sidecar.maxResolvedSize ?? base.maxResolvedSize,
    maxTotalResolvedSize: sidecar.maxTotalResolvedSize ?? base.maxTotalResolvedSize,
    allowComposites: sidecar.allowComposites ?? base.allowComposites,
    maxReferenceCount: sidecar.maxReferenceCount ?? base.maxReferenceCount,
    maxResolutionDepth: base.maxResolutionDepth,
  };
}

function validateReferenceConfig(config: ReferenceConfig | undefined): void {
  if (!config) return;
  for (const key of [
    'maxTotalSize',
    'maxReferenceSize',
    'extractionThreshold',
    'maxResolvedSize',
    'maxTotalResolvedSize',
    'maxReferenceCount',
    'maxResolutionDepth',
  ] as const) {
    const value = config[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new TypeError(`sidecar.${key} must be a positive finite integer`);
    }
  }
  if (config.maxReferenceSize > config.maxTotalSize || config.extractionThreshold > config.maxReferenceSize) {
    throw new TypeError('sidecar size limits must be ordered: threshold <= reference <= total');
  }
}

/** The parent VM's tool policy, applied to copied arguments before the portable bridge runs. */
class PortableOperationPolicy {
  private readonly history: OperationHistory[] = [];
  private readonly globalCallTimes: number[] = [];

  constructor(private readonly config: ParentValidationConfig) {}

  private rate(now: number): void {
    while (this.history.length && now - this.history[0].timestamp > 60_000) this.history.shift();
    while (this.globalCallTimes.length && now - this.globalCallTimes[0] > 2000) this.globalCallTimes.shift();
    const recentTools = this.history.filter((entry) => now - entry.timestamp < 1000).length;
    const recentGlobals = this.globalCallTimes.filter((at) => now - at < 1000).length;
    if (recentTools + recentGlobals >= this.config.maxOperationsPerSecond) {
      throw new Error(`Operation rate limit exceeded (${this.config.maxOperationsPerSecond} operations/second)`);
    }
  }

  globalCall(): void {
    const now = Date.now();
    this.rate(now);
    this.globalCallTimes.push(now);
  }

  toolCall(name: string, args: Record<string, unknown>): void {
    const now = Date.now();
    this.rate(now);
    if (typeof name !== 'string' || name.length === 0) throw new TypeError('Operation name must be a non-empty string');
    if (this.config.validateOperationNames) {
      const allowed = this.config.allowedOperationPattern;
      if (allowed) {
        allowed.lastIndex = 0;
        if (!allowed.test(name)) throw new Error(`Operation "${name}" does not match allowed pattern`);
      }
      for (const blocked of this.config.blockedOperationPatterns ?? []) {
        blocked.lastIndex = 0;
        if (blocked.test(name)) throw new Error(`Operation "${name}" matches blocked pattern`);
      }
    }
    if (this.config.blockSuspiciousSequences) {
      const override = Object.hasOwn(this.config.rapidEnumerationOverrides, name)
        ? this.config.rapidEnumerationOverrides[name]
        : undefined;
      const threshold = override ?? this.config.rapidEnumerationThreshold;
      const recentSame = this.history.filter((entry) => entry.operationName === name && now - entry.timestamp < 5000);
      if (recentSame.length >= threshold) {
        throw new Error('Suspicious pattern detected: Rapid enumeration of resources [RAPID_ENUMERATION]');
      }
      for (const pattern of DEFAULT_SUSPICIOUS_PATTERNS) {
        if (pattern.id === 'RAPID_ENUMERATION') continue;
        let detected = false;
        try {
          detected = pattern.detect(name, args, this.history);
        } catch {
          // A detector never grants access; the bridge still validates and bounds the call.
        }
        if (detected) throw new Error(`Suspicious pattern detected: ${pattern.description} [${pattern.id}]`);
      }
    }
    this.history.push({ operationName: name, timestamp: now, argKeys: Object.keys(args) });
  }
}

/**
 * Runs the same raw-source pre-scan and AgentScript validation before handing code to the
 * interpreter. Only the AgentScript preset and the string tool bridge are supported.
 */
export class PortableEnclave {
  private readonly options: PortableEnclaveOptions;
  private readonly config: ExecutionContext['config'];
  private readonly preScanner: PreScanner;
  private readonly validator: JSAstValidator;
  private readonly adapter: InterpreterAdapter;
  private readonly namespaces: readonly NormalizedToolNamespace[];
  private readonly references?: ReferenceConfig;
  private readonly policyConfig: ParentValidationConfig;
  private readonly customNames: string[];
  private readonly review?: NormalizedReviewOptions;
  private disposed = false;

  constructor(rawOptions: PortableEnclaveOptions = {}) {
    const { interpreter, ...rawEnclaveOptions } = rawOptions;
    const options = normalizeEnclaveOptions(rawEnclaveOptions) as PortableEnclaveOptions;
    const level = options.securityLevel ?? 'STANDARD';
    if (level === 'PERMISSIVE') throw new TypeError('Portable AgentScript requires STANDARD, SECURE or STRICT');
    if (options.preset !== undefined && options.preset !== 'agentscript') {
      throw new TypeError('PortableEnclave supports the AgentScript preset only');
    }
    if (options.validate === false || options.transform === false) {
      throw new TypeError('PortableEnclave requires validation, transformation and pre-scan');
    }
    if (options.preScan?.preset !== undefined && options.preScan.preset !== 'agentscript') {
      throw new TypeError('PortableEnclave requires the AgentScript pre-scan preset');
    }
    if (options.preScan?.config !== undefined) {
      throw new TypeError('PortableEnclave does not allow pre-scan overrides');
    }
    if (options.toolBridge?.mode === 'direct') throw new TypeError('PortableEnclave requires the string tool bridge');
    if (options.toolBridge?.acknowledgeInsecureDirect === true) {
      throw new TypeError('PortableEnclave does not support direct bridge acknowledgement');
    }
    if (options.adapter || options.sandboxAdapter || options.workerPoolConfig || options.scoringGate) {
      throw new TypeError('PortableEnclave does not support VM adapters or scoring gates');
    }
    if (options.allowBuiltins === true || options.toolCallGraceMs !== undefined) {
      throw new TypeError('PortableEnclave does not support VM builtin or tool grace overrides');
    }
    if (options.secureProxyConfig || options.realmGlobals === 'security-level') {
      throw new TypeError('PortableEnclave does not support VM realm proxy overrides');
    }
    if (
      options.doubleVm?.enabled === false ||
      options.doubleVm?.parentTimeoutBuffer !== undefined ||
      options.doubleVm?.parentValidation?.suspiciousPatterns?.length
    ) {
      throw new TypeError('PortableEnclave cannot disable or replace its tool policy');
    }
    boundedInteger('interpreter.maxSteps', interpreter?.maxSteps, MAX_PORTABLE_STEPS);
    boundedInteger('interpreter.maxCallDepth', interpreter?.maxCallDepth, MAX_PORTABLE_CALL_DEPTH);
    boundedInteger('interpreter.maxPendingCalls', interpreter?.maxPendingCalls, MAX_PORTABLE_PENDING_CALLS);
    boundedInteger('interpreter.maxAllocationBytes', interpreter?.maxAllocationBytes, MAX_PORTABLE_ALLOCATION_BYTES);
    const memoryLimit = options.memoryLimit ?? 1024 * 1024;
    boundedInteger('memoryLimit', memoryLimit, MAX_PORTABLE_ALLOCATION_BYTES);
    const maxPayloadBytes = options.toolBridge?.maxPayloadBytes ?? DEFAULT_BRIDGE_BYTES;
    boundedInteger('toolBridge.maxPayloadBytes', maxPayloadBytes, MAX_PORTABLE_ALLOCATION_BYTES);
    const security = SECURITY_LEVEL_CONFIGS[level];
    const maxToolCalls = options.maxToolCalls ?? security.maxToolCalls;
    if (maxToolCalls > 100_000) throw new TypeError('maxToolCalls cannot exceed 100000 in PortableEnclave');
    if ((options.maxIterations ?? security.maxIterations) > MAX_PORTABLE_STEPS) {
      throw new TypeError(`maxIterations cannot exceed ${MAX_PORTABLE_STEPS} in PortableEnclave`);
    }
    if ((options.maxSanitizeDepth ?? security.maxSanitizeDepth) > 100) {
      throw new TypeError('maxSanitizeDepth cannot exceed 100 in PortableEnclave');
    }
    if ((options.maxSanitizeProperties ?? security.maxSanitizeProperties) > 20_000) {
      throw new TypeError('maxSanitizeProperties cannot exceed 20000 in PortableEnclave');
    }
    const maxGlobalFunctionCalls = options.maxGlobalFunctionCalls ?? Math.max(10, maxToolCalls * 10);
    boundedInteger('maxGlobalFunctionCalls', maxGlobalFunctionCalls, 1_000_000);
    options.globals = copyPortableGlobals(options.globals, options.allowFunctionsInGlobals === true, maxPayloadBytes);
    const standardNames = new Set([...Object.keys(createSafeGlobals().globals), 'callTool', 'parallel', 'console']);
    for (const name of Object.keys(options.globals)) {
      if (standardNames.has(name)) throw new TypeError(`PortableEnclave cannot replace standard global ${name}`);
    }
    this.namespaces = normalizeToolNamespaces(options.toolNamespaces, {
      reservedNames: Object.keys(options.globals ?? {}),
    });
    this.customNames = [...Object.keys(options.globals ?? {}), ...this.namespaces.map((entry) => entry.name)];
    const allowed = [
      ...getAgentScriptGlobals(level),
      'parallel',
      '__safe_parallel',
      '__safe_concat',
      '__safe_template',
      ...(options.consoleHandler ? ['console', '__safe_console'] : []),
      ...this.customNames.flatMap((name) => [name, `__safe_${name}`]),
    ];
    const hostObjects = [
      ...Object.keys(options.globals ?? {}).filter((name) => typeof options.globals?.[name] !== 'string'),
      ...this.namespaces.map((entry) => entry.name),
    ];
    this.preScanner = new PreScanner({
      preset: options.preScan?.preset ?? 'agentscript',
      config: options.preScan?.config,
    });
    this.validator = new JSAstValidator(
      createAgentScriptPreset({
        securityLevel: level,
        allowedGlobals: allowed,
        hostObjectGlobals: hostObjects,
        allowDynamicArrayFill: true,
      }),
    );
    this.references = referenceConfig(level, options.sidecar);
    validateReferenceConfig(this.references);
    this.policyConfig = {
      ...DEFAULT_DOUBLE_VM_CONFIG.parentValidation,
      ...options.doubleVm?.parentValidation,
      rapidEnumerationOverrides: { ...options.doubleVm?.parentValidation?.rapidEnumerationOverrides },
      blockedOperationPatterns: [...(options.doubleVm?.parentValidation?.blockedOperationPatterns ?? [])],
      suspiciousPatterns: [],
    };
    this.config = {
      timeout: options.timeout ?? security.timeout,
      maxIterations: options.maxIterations ?? security.maxIterations,
      maxToolCalls,
      memoryLimit,
      maxSanitizeDepth: options.maxSanitizeDepth ?? security.maxSanitizeDepth,
      maxSanitizeProperties: options.maxSanitizeProperties ?? security.maxSanitizeProperties,
      maxConsoleCalls: options.maxConsoleCalls ?? security.maxConsoleCalls,
      maxConsoleOutputBytes: options.maxConsoleOutputBytes ?? security.maxConsoleOutputBytes,
      sanitizeStackTraces: options.sanitizeStackTraces ?? true,
      maxGlobalFunctionCalls,
      toolBridge: { mode: 'string', maxPayloadBytes },
      globals: options.globals ?? {},
      toolHandler: options.toolHandler,
    } as ExecutionContext['config'];
    this.adapter = new InterpreterAdapter({
      maxSteps: interpreter?.maxSteps,
      maxCallDepth: interpreter?.maxCallDepth,
      maxPendingCalls: interpreter?.maxPendingCalls,
      maxAllocationBytes: interpreter?.maxAllocationBytes,
    });
    this.review = normalizeReviewOptions(options.review);
    this.options = options;
  }

  async run<T = unknown>(
    code: string,
    toolHandler?: ToolHandler,
    runOptions: PortableRunOptions = {},
  ): Promise<ExecutionResult<T>> {
    if (this.disposed) throw new Error('PortableEnclave has been disposed');
    boundedInteger('maxToolResultBytes', runOptions.maxToolResultBytes, MAX_PORTABLE_ALLOCATION_BYTES);
    assertReviewContext(runOptions.reviewContext);
    const startTime = Date.now();
    const stats: ExecutionStats = { duration: 0, startTime, endTime: startTime, toolCallCount: 0, iterationCount: 0 };
    const failure = (name: string, message: string, code: string, issues?: ValidationIssue[]): ExecutionResult<T> => ({
      success: false,
      error: { name, message, code, ...(issues ? { data: { issues } } : {}) },
      stats: { ...stats, duration: Date.now() - startTime, endTime: Date.now() },
    });
    if (typeof code !== 'string' || code.length > MAX_SCRIPT_LENGTH) {
      return failure('ValidationError', 'The script must be a string of at most 5 MiB', 'VALIDATION_ERROR');
    }
    if (code.length > 0) {
      const scanned = this.preScanner.scan(code);
      if (!scanned.success) {
        const issues: ValidationIssue[] = scanned.issues.map((issue) => ({
          code: issue.code,
          severity:
            issue.severity === 'error'
              ? ValidationSeverity.ERROR
              : issue.severity === 'warning'
                ? ValidationSeverity.WARNING
                : ValidationSeverity.INFO,
          message: issue.message,
          location: issue.line === undefined ? undefined : { line: issue.line, column: issue.column ?? 0 },
          data: issue.data,
        }));
        return failure('ValidationError', 'AgentScript pre-scan failed', 'VALIDATION_ERROR', issues);
      }
    }

    let transformed: string;
    try {
      transformed = transformAgentScript(code, {
        wrapInMain: !isWrappedInMain(code),
        transformCallTool: true,
        transformLoops: true,
        maxIterations: this.config.maxIterations,
        additionalIdentifiers: this.customNames,
      });
    } catch (error: unknown) {
      const message = (error as { message?: unknown } | null)?.message;
      return failure(
        'ValidationError',
        typeof message === 'string' ? message.slice(0, 2048) : 'AgentScript parse failed',
        'VALIDATION_ERROR',
      );
    }
    const validation = await this.validator.validate(transformed, { preScan: { enabled: false } });
    if (!validation.valid) {
      return failure('ValidationError', 'AgentScript validation failed', 'VALIDATION_ERROR', validation.issues);
    }
    if (refuseDynamicImport(transformed)) {
      return failure('SecurityError', 'Dynamic imports are unavailable', 'SECURITY_VIOLATION');
    }
    const review = this.review ? new ReviewSession(this.review, runOptions.reviewContext) : undefined;
    if (
      review &&
      (await review.reviewScript(code, { toolNamespaces: this.namespaces, callBudget: this.config.maxToolCalls }))
    ) {
      return review.finish<T>(REVIEW_HALTED, stats);
    }

    const sidecar = this.references ? new ReferenceSidecar(this.references) : undefined;
    try {
      if (sidecar && this.references) {
        const ast = acorn.parse(transformed, { ecmaVersion: 'latest', sourceType: 'script' }) as acorn.Node;
        extractLargeStrings(ast, {
          threshold: this.references.extractionThreshold,
          onExtract: (value) => sidecar.store(value, 'extraction'),
        });
        transformConcatenation(ast, { arraySpread: false });
        transformTemplateLiterals(ast);
        transformed = generate(ast);
      }
      const policy = new PortableOperationPolicy(this.policyConfig);
      const hostToolHandler = toolHandler ?? this.options.toolHandler;
      let closed = false;
      const deadline = Date.now() + this.config.timeout;
      const abortController = new AbortController();
      const context: ExecutionContext = {
        config: this.config,
        stats,
        abortController,
        get aborted() {
          return closed || abortController.signal.aborted || Date.now() >= deadline;
        },
        set aborted(value: boolean) {
          if (value) abortController.abort();
        },
        toolHandler: hostToolHandler
          ? numberToolCalls(review?.wrapToolHandler(hostToolHandler) ?? hostToolHandler, this.options.toolResultOrder)
          : undefined,
        ...hostClockReaders(this.options),
        toolNamespaces: this.namespaces,
        beforeToolCall: (name, args) => {
          policy.toolCall(name, args);
          return true;
        },
        beforeGlobalCall: () => {
          policy.globalCall();
          return true;
        },
        maxToolResultBytes: runOptions.maxToolResultBytes,
        onToolBridgeFailure: runOptions.onToolBridgeFailure,
        sidecar,
        referenceConfig: this.references,
        consoleHandler: this.options.consoleHandler,
      };
      try {
        const execution = this.adapter.execute<T>(transformed, context);
        if (!review) return await execution;
        const outcome = await Promise.race([execution, review.halted]);
        closed = true;
        abortController.abort();
        return await review.finish(outcome, stats);
      } finally {
        closed = true;
        abortController.abort();
      }
    } catch (error: unknown) {
      const message = (error as { message?: unknown } | null)?.message;
      const failed = failure(
        'ExecutionError',
        typeof message === 'string' ? message.slice(0, 2048) : 'Portable execution failed',
        'EXECUTION_ERROR',
      );
      return review ? review.finish(failed, stats) : failed;
    } finally {
      sidecar?.dispose();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.adapter.dispose();
  }
}

/** The worker entry's CodeCall-facing contract for one validated AgentScript run. */
export interface AgentScriptRunnerOptions extends Omit<
  PortableEnclaveOptions,
  'interpreter' | 'globals' | 'doubleVm' | 'maxGlobalFunctionCalls'
> {
  /** Each callback keeps its own parameter types; arguments are validated at the host boundary. */
  hostFunctions: Readonly<Record<string, (...args: never[]) => unknown>>;
  maxHostFunctionCalls: number;
  maxSteps?: number;
  maxCallDepth?: number;
  maxPendingCalls?: number;
  rapidEnumeration?: { threshold?: number; overrides?: Record<string, number> };
}

/** A narrow adapter for CodeCall's worker-safe runtime selection. */
export class AgentScriptRunner extends PortableEnclave {
  static readonly capabilities = Object.freeze([
    'validated-agentscript',
    'host-functions',
    'tool-namespaces',
    'sidecar',
    'console',
    'rapid-enumeration',
    'review',
    'replay',
  ]);

  constructor(options: AgentScriptRunnerOptions) {
    const {
      hostFunctions,
      maxHostFunctionCalls,
      maxSteps,
      maxCallDepth,
      maxPendingCalls,
      rapidEnumeration,
      ...enclaveOptions
    } = options;
    super({
      ...enclaveOptions,
      allowFunctionsInGlobals: true,
      globals: { ...hostFunctions },
      maxGlobalFunctionCalls: maxHostFunctionCalls,
      doubleVm: {
        parentValidation: {
          ...(rapidEnumeration?.threshold !== undefined && { rapidEnumerationThreshold: rapidEnumeration.threshold }),
          ...(rapidEnumeration?.overrides !== undefined && { rapidEnumerationOverrides: rapidEnumeration.overrides }),
        },
      },
      interpreter: { maxSteps, maxCallDepth, maxPendingCalls },
    });
  }
}
