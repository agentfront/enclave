// file: libs/core/src/worker.ts
//
// WORKER-SAFE ENTRY POINT — `@enclave-vm/core/worker`.
//
// Exposes the AgentScript interpreter and a validated, transformed runner. It pulls in
// no Node VM, worker-thread or child-process modules, nor QuickJS/WASM or Babel. The
// high-level runner is exercised in Node and Cloudflare Workers with `nodejs_compat`;
// the default `@enclave-vm/core` barrel also exports Node-only VM adapters.
//
// Use AgentScriptRunner for untrusted source. InterpreterAdapter is the lower-level
// execute path and does not validate or transform a script on its own.

export { InterpreterAdapter } from './adapters/interpreter-adapter';
export type { InterpreterAdapterOptions } from './adapters/interpreter-adapter';
export { PortableEnclave, AgentScriptRunner } from './portable-enclave';
export type { PortableEnclaveOptions, PortableRunOptions, AgentScriptRunnerOptions } from './portable-enclave';
export { Interpreter, InterpreterError, StatementHookError, StepLimitError } from './interpreter/interpreter';
export type { InterpreterOptions } from './interpreter/interpreter';
export type {
  ExecutionContext,
  ExecutionResult,
  ExecutionError,
  ExecutionStats,
  ToolHandler,
  ToolCall,
  ToolResultOrder,
  StatementEvent,
} from './types';
export type { StatementEventOptions } from './statement-events';
export { analyzeScript, ScriptAnalysisError } from './analysis/script-analysis';
export type {
  ScriptAnalysis,
  ScriptAnalysisOptions,
  ScriptFlow,
  ScriptLocation,
  ScriptLoopBound,
  ScriptToolCall,
} from './analysis/script-analysis';
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
