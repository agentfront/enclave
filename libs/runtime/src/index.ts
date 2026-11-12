/**
 * @enclave-vm/runtime
 *
 * Building blocks of a runtime worker for EnclaveJS: session bookkeeping and the channels
 * between a worker and a broker.
 *
 * This package is not a runnable service. It does not execute code (an `execute` request ends
 * with `RuntimeNotImplementedError`), it starts no server and opens no port, and it has no
 * authentication. To run scripts use `@enclave-vm/broker` or `@enclave-vm/core`.
 *
 * @example
 * ```typescript
 * import { createRuntimeWorker, createMemoryChannel } from '@enclave-vm/runtime';
 *
 * const worker = createRuntimeWorker({ maxSessions: 10 });
 * await worker.start(); // marks the worker as running; nothing is listening
 *
 * const channel = createMemoryChannel();
 * await worker.handleRequest({ type: 'ping', timestamp: Date.now() }, channel);
 * ```
 *
 * @packageDocumentation
 */

// Types
export type {
  RuntimeConfig,
  RuntimeState,
  RuntimeStats,
  RuntimeSession,
  RuntimeWorker,
  RuntimeChannel,
  RuntimeRequest,
  ExecuteRequest,
  CancelRequest,
  ToolResultRequest,
  PingRequest,
  RuntimeEventHandler,
  ConnectionHandler,
  WebSocketServer,
} from './types';

// Runtime worker
export { RuntimeWorker as RuntimeWorkerImpl, createRuntimeWorker } from './runtime-worker';

// Session executor
export {
  SessionExecutor,
  createSessionExecutor,
  RuntimeNotImplementedError,
  type SessionExecutorOptions,
} from './session-executor';

// Channels
export {
  MemoryChannel,
  createMemoryChannel,
  createMemoryChannelPair,
  WebSocketChannel,
  createWebSocketChannel,
  type WebSocketChannelConfig,
  type WebSocketChannelState,
} from './channels';
