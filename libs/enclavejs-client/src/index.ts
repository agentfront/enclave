/**
 * @enclavejs/client
 *
 * Browser and Node.js client SDK for the EnclaveJS streaming runtime.
 *
 * @packageDocumentation
 */

// Client exports
export { EnclaveClient } from './client.js';

// Type exports
export {
  EnclaveClientError,
  type EnclaveClientConfig,
  type ExecuteOptions,
  type EventHandler,
  type SessionEventHandlers,
  type SessionResult,
  type SessionHandle,
  type SessionInfo,
  type ClientErrorCode,
} from './types.js';

// Re-export commonly used types from @enclavejs/types
export type {
  SessionId,
  SessionLimits,
  StreamEvent,
  SessionInitEvent,
  StdoutEvent,
  LogEvent,
  ToolCallEvent,
  ToolResultAppliedEvent,
  FinalEvent,
  HeartbeatEvent,
  ErrorEvent,
} from '@enclavejs/types';

// Re-export connection state for checking session status
export { ConnectionState } from '@enclavejs/stream';
