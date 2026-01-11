/**
 * Client Types
 *
 * Types for the EnclaveJS client SDK.
 *
 * @packageDocumentation
 */

import type { SessionId, StreamEvent, SessionLimits } from '@enclavejs/types';

/**
 * Client configuration
 */
export interface EnclaveClientConfig {
  /**
   * Middleware base URL (e.g., 'https://api.example.com')
   */
  baseUrl: string;

  /**
   * Default headers to include in all requests
   */
  headers?: Record<string, string>;

  /**
   * Request timeout in milliseconds
   * @default 60000
   */
  timeout?: number;

  /**
   * Enable automatic reconnection on disconnect
   * @default true
   */
  autoReconnect?: boolean;

  /**
   * Maximum reconnection attempts
   * @default 3
   */
  maxReconnectAttempts?: number;

  /**
   * Reconnection delay in milliseconds
   * @default 1000
   */
  reconnectDelay?: number;

  /**
   * Custom fetch implementation (for Node.js or testing)
   */
  fetch?: typeof fetch;
}

/**
 * Session execution options
 */
export interface ExecuteOptions {
  /**
   * Optional session ID (generated if not provided)
   */
  sessionId?: SessionId;

  /**
   * Session limits configuration
   */
  limits?: Partial<SessionLimits>;

  /**
   * Abort signal for cancellation
   */
  signal?: AbortSignal;
}

/**
 * Event handler types
 */
export type EventHandler<T extends StreamEvent = StreamEvent> = (event: T) => void;

/**
 * Session event handlers
 */
export interface SessionEventHandlers {
  /**
   * Called for every event
   */
  onEvent?: EventHandler;

  /**
   * Called when session initializes
   */
  onSessionInit?: EventHandler;

  /**
   * Called for stdout output
   */
  onStdout?: (chunk: string) => void;

  /**
   * Called for log messages
   */
  onLog?: (level: string, message: string, data?: Record<string, unknown>) => void;

  /**
   * Called when a tool is being called
   */
  onToolCall?: (callId: string, toolName: string, args: unknown) => void;

  /**
   * Called when a tool result is applied
   */
  onToolResultApplied?: (callId: string) => void;

  /**
   * Called on heartbeat
   */
  onHeartbeat?: () => void;

  /**
   * Called on non-fatal error
   */
  onError?: (code: string, message: string) => void;
}

/**
 * Session execution result
 */
export interface SessionResult<T = unknown> {
  /**
   * Whether execution succeeded
   */
  success: boolean;

  /**
   * Session ID
   */
  sessionId: SessionId;

  /**
   * Result value (if success)
   */
  value?: T;

  /**
   * Error information (if failed)
   */
  error?: {
    code?: string;
    message: string;
  };

  /**
   * Execution statistics
   */
  stats?: {
    durationMs: number;
    toolCallCount: number;
    stdoutBytes: number;
  };

  /**
   * All events received during execution
   */
  events: StreamEvent[];
}

/**
 * Active session handle
 */
export interface SessionHandle {
  /**
   * Session ID
   */
  sessionId: SessionId;

  /**
   * Wait for session to complete
   */
  wait(): Promise<SessionResult>;

  /**
   * Cancel the session
   */
  cancel(reason?: string): Promise<void>;

  /**
   * Get events received so far
   */
  getEvents(): StreamEvent[];

  /**
   * Check if session is still active
   */
  isActive(): boolean;
}

/**
 * Session info from the API
 */
export interface SessionInfo {
  sessionId: SessionId;
  state: string;
  createdAt: number;
  expiresAt: number;
  stats: {
    duration: number;
    toolCallCount: number;
  };
}

/**
 * Client error types
 */
export type ClientErrorCode =
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'PARSE_ERROR'
  | 'SESSION_ERROR'
  | 'CANCELLED'
  | 'RECONNECT_FAILED';

/**
 * Client error
 */
export class EnclaveClientError extends Error {
  readonly code: ClientErrorCode;
  readonly cause?: Error;

  constructor(code: ClientErrorCode, message: string, cause?: Error) {
    super(message);
    this.name = 'EnclaveClientError';
    this.code = code;
    this.cause = cause;
  }
}
