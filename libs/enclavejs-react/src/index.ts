/**
 * @enclave-vm/react
 *
 * React hooks and components for the EnclaveJS streaming runtime.
 *
 * @packageDocumentation
 */

// Provider and context
export { EnclaveProvider, useEnclaveClient, useEnclaveContext } from './EnclaveProvider.js';

// Hooks
export { useEnclaveSession } from './useEnclaveSession.js';

// Types
export type {
  SessionState,
  UseEnclaveSessionOptions,
  UseEnclaveSessionReturn,
  EnclaveProviderProps,
  EnclaveContextValue,
} from './types.js';

// Re-export commonly used types from @enclave-vm/client
export type {
  EnclaveClient,
  EnclaveClientConfig,
  SessionResult,
  SessionHandle,
  StreamEvent,
  SessionId,
} from '@enclave-vm/client';
