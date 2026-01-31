/**
 * React Types
 *
 * Types for the EnclaveJS React hooks and components.
 *
 * @packageDocumentation
 */

import type { EnclaveClient, EnclaveClientConfig, SessionResult, StreamEvent, SessionId } from '@enclave-vm/client';

/**
 * Session state enum
 */
export type SessionState = 'idle' | 'running' | 'completed' | 'error' | 'cancelled';

/**
 * useEnclaveSession hook options
 */
export interface UseEnclaveSessionOptions {
  /**
   * Custom session ID (generated if not provided)
   */
  sessionId?: SessionId;

  /**
   * Session timeout in milliseconds
   */
  timeoutMs?: number;

  /**
   * Maximum number of tool calls
   */
  maxToolCalls?: number;

  /**
   * Heartbeat interval in milliseconds
   */
  heartbeatIntervalMs?: number;

  /**
   * Callback when session starts
   */
  onStart?: () => void;

  /**
   * Callback for stdout output
   */
  onStdout?: (chunk: string) => void;

  /**
   * Callback for log messages
   */
  onLog?: (level: string, message: string, data?: Record<string, unknown>) => void;

  /**
   * Callback for tool calls
   */
  onToolCall?: (callId: string, toolName: string, args: unknown) => void;

  /**
   * Callback when tool result is applied
   */
  onToolResultApplied?: (callId: string) => void;

  /**
   * Callback on completion
   */
  onComplete?: (result: SessionResult) => void;

  /**
   * Callback on error
   */
  onError?: (error: { code?: string; message: string }) => void;
}

/**
 * useEnclaveSession hook return type
 */
export interface UseEnclaveSessionReturn<T = unknown> {
  /**
   * Execute code in the enclave
   */
  execute: (code: string) => Promise<SessionResult<T>>;

  /**
   * Cancel the current session
   */
  cancel: (reason?: string) => Promise<void>;

  /**
   * Current session state
   */
  state: SessionState;

  /**
   * Whether a session is currently running
   */
  isRunning: boolean;

  /**
   * Current session ID (if running)
   */
  sessionId: SessionId | null;

  /**
   * Result of the last execution (if completed)
   */
  result: SessionResult<T> | null;

  /**
   * Error from the last execution (if failed)
   */
  error: { code?: string; message: string } | null;

  /**
   * Stdout output accumulated during execution
   */
  stdout: string;

  /**
   * Events received during execution
   */
  events: StreamEvent[];

  /**
   * Reset the hook state
   */
  reset: () => void;
}

/**
 * EnclaveProvider props
 */
export interface EnclaveProviderProps {
  /**
   * Client configuration
   */
  config: EnclaveClientConfig;

  /**
   * Pre-created client instance (alternative to config)
   */
  client?: EnclaveClient;

  /**
   * Children to render
   */
  children: React.ReactNode;
}

/**
 * Enclave context value
 */
export interface EnclaveContextValue {
  /**
   * The EnclaveClient instance
   */
  client: EnclaveClient;

  /**
   * Client configuration
   */
  config: EnclaveClientConfig;
}
