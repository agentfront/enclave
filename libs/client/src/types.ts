/**
 * Client Types
 *
 * Types for the EnclaveJS client SDK.
 *
 * @packageDocumentation
 */

import type { SessionId, StreamEvent, SessionLimits, ErrorPayload, ToolProgressPhase } from '@enclave-vm/types';

/**
 * Client configuration
 *
 * These are all the options there are. The constructor refuses any other key: the client has
 * no `encryption` and no `auth` option. Requests and events travel as plain JSON, so use an
 * `https:` base URL, and send credentials with `headers`.
 */
export interface EnclaveClientConfig {
  /**
   * Middleware base URL (e.g., 'https://api.example.com')
   */
  baseUrl: string;

  /**
   * Default headers to include in all requests (for example `Authorization`)
   */
  headers?: Record<string, string>;

  /**
   * How long the client waits for the server, in milliseconds: for the answer to a request,
   * and for the next event on an open stream. On a stream the wait is never shorter than two
   * heartbeat intervals of the session (15 seconds each unless `limits.heartbeatIntervalMs`
   * asks for another). When it runs out the connection counts as lost: the client reconnects
   * if `autoReconnect` allows it, otherwise the session fails with `TIMEOUT`.
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
   * Largest event the client accepts, in characters of its JSON line. A longer event ends the
   * session with `PARSE_ERROR`.
   * @default 8388608 (8 MiB)
   */
  maxEventLength?: number;

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
   * Abort signal for cancellation. Aborting it does what `SessionHandle.cancel()` does.
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
   * Called on non-fatal error: an `error` event of the session, or, with the code
   * `CANCEL_FAILED`, a cancellation that the server did not confirm (the script may still
   * be running)
   */
  onError?: (code: string, message: string) => void;

  /**
   * Called when a partial result arrives
   */
  onPartialResult?: (path: string[], data?: unknown, error?: ErrorPayload, hasNext?: boolean) => void;

  /**
   * Called when tool progress is reported
   */
  onToolProgress?: (callId: string, phase: ToolProgressPhase, elapsedMs: number) => void;

  /**
   * Called when deadline is exceeded
   */
  onDeadlineExceeded?: (elapsedMs: number, budgetMs: number) => void;

  /**
   * Called when the action catalog changes
   */
  onCatalogChanged?: (version: string, addedActions: string[], removedActions: string[]) => void;
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
   * Per-path errors (GraphQL-style)
   */
  errors?: Array<{
    code: string;
    message: string;
    path?: string[];
  }>;

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
   * Cancel the session: it ends as `CANCELLED` here, and the server is asked to end it.
   * Does not reject; a stop that the server did not confirm is reported to `onError`
   * with the code `CANCEL_FAILED`.
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
