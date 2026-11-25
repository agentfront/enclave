/**
 * enclave-vm - Safe AgentScript Execution Environment
 *
 * Provides sandboxed execution for AgentScript code with:
 * - AST validation using ast-guard
 * - Code transformation (whitelist-based)
 * - Runtime safety wrappers (__safe_* functions)
 * - Resource limits (timeout, memory, iterations, tool calls)
 * - VM sandbox adapter (Node.js vm module)
 *
 * @packageDocumentation
 */

// Main Enclave class
export { Enclave, runAgentScript } from './enclave';
export type { EnclaveRunOptions } from './enclave';
export type { StatementEventOptions } from './statement-events';
export type { KeptReferenceOptions } from './kept-references';
export { ENCLAVE_RUN_FEATURES } from './replayed-calls';
export type { ReplayedCall, ReplayedCallOptions } from './replayed-calls';
export type { RefusedCall, RefusedCallCode } from './refused-call';

// Unhandled promise rejections of scripts (see the module for what it does to the process)
export { disableSandboxRejectionGuard, isHostPromise } from './sandbox-rejections';

// Types and interfaces
export type {
  ExecutionResult,
  ExecutionError,
  ExecutionStats,
  EnclaveConfig,
  CreateEnclaveOptions,
  ToolHandler,
  ToolCall,
  HostToolHandler,
  ToolResultOrder,
  StatementEvent,
  SafeRuntimeContext,
  ExecutionContext,
  SandboxAdapter,
  SecurityLevel,
  AstPreset,
  SecurityLevelConfig,
  SecureProxyLevelConfig,
  ReferenceSidecarOptions,
  WorkerPoolConfig,
  PartialDoubleVmConfig,
  CallToolOptions,
  ToolCallResult,
  ToolCallErrorInfo,
  ToolNamespaces,
  NormalizedToolNamespace,
  ConsoleHandler,
  ConsoleLevel,
} from './types';

// Security level configurations
export { SECURITY_LEVEL_CONFIGS } from './types';

// Static analysis of a script's tool calls, for hosts that review scripts
export { analyzeScript, ScriptAnalysisError } from './analysis/script-analysis';
export type {
  ScriptAnalysis,
  ScriptAnalysisOptions,
  ScriptFlow,
  ScriptLocation,
  ScriptLoopBound,
  ScriptToolCall,
} from './analysis/script-analysis';

// Review hooks: types, error codes, and the scoring gate as a reviewer
export { scoringReviewer } from './review/scoring-reviewer';
export { REVIEW_ERROR_CODES } from './review/types';
export { functionReviewer, providerReviewer } from './review/reviewers';
export type { ProviderReviewerOptions, ReviewerOptions, ReviewerRequest, ReviewerTool } from './review/reviewers';
export { ReviewerError } from './review/review-session';
export type {
  PostReviewAction,
  PostReviewInput,
  PreReviewInput,
  ReviewContext,
  ReviewDecision,
  ReviewFinding,
  ReviewOptions,
  ReviewPhase,
  ReviewRecord,
  ReviewReport,
} from './review/types';

// AI Scoring Gate
export {
  // Main orchestrator
  ScoringGate,
  ScoringGateError,
  createScoringGate,
  // Feature extraction
  FeatureExtractor,
  FeatureExtractionError,
  // Cache
  ScoringCache,
  // Scorer interface and base class
  BaseScorer,
  // Scorer implementations
  DisabledScorer,
  RuleBasedScorer,
  ExternalApiScorer,
  ExternalApiScorerError,
  // Constants
  DEFAULT_SCORING_CONFIG,
  RULE_THRESHOLDS,
} from './scoring';

export type {
  // Scorer interface
  Scorer,
  // Core types
  ScorerType,
  RiskLevel,
  SensitiveCategory,
  RuleId,
  // Feature types
  ExtractedFeatures,
  ExtractedToolCall,
  PatternSignals,
  NumericSignals,
  SensitiveAccess,
  ExtractionMeta,
  // Scoring types
  RiskSignal,
  ScoringResult,
  ScoringGateResult,
  // Configuration types
  ScoringGateConfig,
  ScoringCacheConfig,
  LocalLlmConfig,
  ExternalApiConfig,
} from './scoring';

// Safe runtime utilities
export { createSafeRuntime, serializeSafeRuntime, SafeRuntimeOptions } from './safe-runtime';

// Secure Proxy - Runtime property access protection
export {
  createSecureProxy,
  wrapGlobalsWithSecureProxy,
  createSecureStandardLibrary,
  isSecureProxy,
  createSafeReflect,
  buildBlockedPropertiesFromConfig,
  getBlockedPropertiesForLevel,
  BLOCKED_PROPERTY_CATEGORIES,
  DEFAULT_SECURE_PROXY_CONFIG,
  SecureProxyOptions,
  BlockedPropertyCategory,
} from './secure-proxy';

// Memory Tracking and Limit Enforcement
export {
  MemoryTracker,
  MemoryLimitError,
  MemoryTrackerConfig,
  MemoryUsageSnapshot,
  estimateStringSize,
  estimateArraySize,
  estimateObjectSize,
} from './memory-tracker';

// Reference Sidecar (pass-by-reference support)
export {
  // Configuration
  ReferenceConfig,
  REFERENCE_CONFIGS,
  REF_ID_PREFIX,
  REF_ID_SUFFIX,
  REF_ID_PATTERN,
  isReferenceId,
  getReferenceConfig,
  getMaxTotalResolvedSize,
  // Sidecar
  ReferenceSidecar,
  ReferenceSource,
  ReferenceMetadata,
  ReferenceEntry,
  SidecarLimitError,
  ReferenceNotFoundError,
  // Resolver
  ReferenceResolver,
  ResolutionLimitError,
  CompositeHandle,
  isCompositeHandle,
} from './sidecar';

// Interpreter Adapter — dependency-free, runtime-agnostic execute path (no
// QuickJS / WASM / node:vm); the worker-safe sandbox.
export { InterpreterAdapter } from './adapters/interpreter-adapter';
export type { InterpreterAdapterOptions } from './adapters/interpreter-adapter';
export {
  Interpreter,
  InterpreterError,
  StatementHookError,
  StepLimitError,
  DeadlineError,
} from './interpreter/interpreter';
export type { InterpreterOptions } from './interpreter/interpreter';

// Worker Pool Adapter (a worker thread per script, with the engine's heap limit)
export {
  // Main adapter
  WorkerPoolAdapter,
  // Configuration
  WorkerSlotStatus,
  ResourceUsage,
  WorkerPoolMetrics,
  DEFAULT_WORKER_POOL_CONFIG,
  WORKER_POOL_PRESETS,
  buildWorkerPoolConfig,
  // Errors
  WorkerPoolError,
  WorkerTimeoutError,
  WorkerMemoryError,
  WorkerCrashedError,
  WorkerPoolDisposedError,
  QueueFullError,
  QueueTimeoutError,
  ExecutionAbortedError,
  MessageFloodError,
  MessageValidationError,
  MessageSizeError,
  WorkerStartupError,
  TooManyPendingCallsError,
  // Utility classes
  WorkerSlot,
  ExecutionQueue,
  QueueStats,
  MemoryMonitor,
  MemoryMonitorStats,
} from './adapters/worker-pool';

// Session support (streaming runtime)
export {
  // Session class and factory
  Session,
  createSession,
  // Event emitter
  SessionEmitter,
  createSessionEmitter,
  // State machine
  SessionStateMachine,
  createSessionStateMachine,
  // Runtime channels
  EmbeddedChannel,
  createEmbeddedChannelPair,
} from './session';

export type {
  SessionOptions,
  SessionEmitterConfig,
  StateTransitionEvent,
  StateTransitionHandler,
  EmbeddedChannelOptions,
} from './session';

// Session types
export type {
  SessionStateValue,
  SessionConfig,
  PendingToolCall,
  AsyncToolHandler,
  ToolResult,
  SessionFinalResult,
  RuntimeChannel,
  EmbeddedChannelConfig,
  WebSocketChannelConfig,
  RuntimeChannelConfig,
  SessionManager,
  SessionEventEmitter,
} from './session-types';

export { isSession, isWaitingForTool, isTerminalState } from './session-types';

// Babel Transform Support (for TSX/JSX transformation in sandbox)
export { createRestrictedBabel, getAvailableBabelPresets, transformMultiple } from './babel';

export type {
  SafeTransformOptions,
  SafeTransformResult,
  BabelWrapperConfig,
  MultiFileInput,
  MultiFileTransformOptions,
  MultiFileTransformResult,
  MultiFileLimits,
} from './babel';

// Re-export ImportRewriteConfig from @enclave-vm/ast for convenience
export type { ImportRewriteConfig, ImportRewriteResult } from '@enclave-vm/ast';
