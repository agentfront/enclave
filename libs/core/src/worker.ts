// file: libs/core/src/worker.ts
//
// WORKER-SAFE ENTRY POINT — `@enclave-vm/core/worker`.
//
// Exposes ONLY the dependency-free execute path: the AgentScript interpreter
// and its `SandboxAdapter`. It pulls in NO Node built-ins (`node:vm`,
// `worker_threads`, `child_process`), no QuickJS/WASM, and no Babel. That makes
// it safe to bundle for V8 isolates — Cloudflare Workers, Deno Deploy, Bun, and
// the browser — where the default `@enclave-vm/core` barrel cannot be bundled
// because it also exports the Node-only WorkerPool/VM adapters.
//
// Pair it with the AgentScript transformer from `@enclave-vm/ast`, invoked with
// `{ transformLoops: false }` (the interpreter enforces its own step budget, so
// the loop-rewrite runtime helpers are redundant and unavailable in its global
// scope). See `__tests__/interpreter-transform-integration.spec.ts`.

export { InterpreterAdapter } from './adapters/interpreter-adapter';
export type { InterpreterAdapterOptions } from './adapters/interpreter-adapter';
export { Interpreter, InterpreterError, StepLimitError } from './interpreter/interpreter';
export type { InterpreterOptions } from './interpreter/interpreter';
export type {
  ExecutionContext,
  ExecutionResult,
  ExecutionError,
  ExecutionStats,
  ToolHandler,
} from './types';
