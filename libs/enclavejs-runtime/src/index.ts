/**
 * @enclavejs/runtime
 *
 * Standalone runtime worker for EnclaveJS.
 * Can be deployed as a separate process/worker for distributed execution.
 *
 * @example
 * ```typescript
 * import { createRuntimeWorker } from '@enclavejs/runtime';
 *
 * const worker = createRuntimeWorker({
 *   port: 3001,
 *   maxSessions: 10,
 *   debug: true,
 * });
 *
 * await worker.start();
 * console.log('Runtime is ready!');
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
export { SessionExecutor, createSessionExecutor, type SessionExecutorOptions } from './session-executor';

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
