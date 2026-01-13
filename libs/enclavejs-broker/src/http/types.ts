/**
 * HTTP Types for Broker API
 *
 * Framework-agnostic types for HTTP request/response handling.
 *
 * @packageDocumentation
 */

import type { SessionId, EventFilterConfig } from '@enclavejs/types';

/**
 * HTTP request abstraction
 */
export interface BrokerRequest {
  /**
   * Request method
   */
  method: string;

  /**
   * Request path
   */
  path: string;

  /**
   * URL parameters (e.g., :sessionId)
   */
  params: Record<string, string>;

  /**
   * Query parameters
   */
  query: Record<string, string>;

  /**
   * Request body (parsed JSON)
   */
  body: unknown;

  /**
   * Request headers
   */
  headers: Record<string, string | string[] | undefined>;

  /**
   * Abort signal for cancellation
   */
  signal?: AbortSignal;
}

/**
 * HTTP response abstraction
 */
export interface BrokerResponse {
  /**
   * Set HTTP status code
   */
  status(code: number): BrokerResponse;

  /**
   * Send JSON response
   */
  json(data: unknown): void;

  /**
   * Set response header
   */
  setHeader(name: string, value: string): BrokerResponse;

  /**
   * Write data to response stream
   */
  write(data: string): void;

  /**
   * End the response
   */
  end(): void;

  /**
   * Flush the response buffer (for streaming)
   */
  flush?(): void;
}

/**
 * Create session request body
 */
export interface CreateSessionRequest {
  /**
   * Code to execute
   */
  code: string;

  /**
   * Optional session ID (generated if not provided)
   */
  sessionId?: SessionId;

  /**
   * Session configuration
   */
  config?: {
    /**
     * Maximum execution time in milliseconds
     */
    maxExecutionMs?: number;

    /**
     * Maximum tool calls
     */
    maxToolCalls?: number;

    /**
     * Heartbeat interval in milliseconds
     */
    heartbeatIntervalMs?: number;
  };

  /**
   * Event filter configuration (server-side filtering).
   * Controls which events are sent to the client.
   */
  filter?: EventFilterConfig;
}

/**
 * Session info response
 */
export interface SessionInfoResponse {
  /**
   * Session ID
   */
  sessionId: SessionId;

  /**
   * Current session state
   */
  state: string;

  /**
   * Creation timestamp
   */
  createdAt: number;

  /**
   * Expiration timestamp
   */
  expiresAt: number;

  /**
   * Session statistics
   */
  stats: {
    duration: number;
    toolCallCount: number;
  };
}

/**
 * List sessions response
 */
export interface ListSessionsResponse {
  /**
   * Active sessions
   */
  sessions: SessionInfoResponse[];

  /**
   * Total count
   */
  total: number;
}

/**
 * Error response
 */
export interface ErrorResponse {
  /**
   * Error code
   */
  code: string;

  /**
   * Error message
   */
  message: string;

  /**
   * Optional error details
   */
  details?: unknown;
}

/**
 * Stream options for session execution
 */
export interface StreamOptions {
  /**
   * Resume from sequence number (for reconnection)
   */
  fromSeq?: number;

  /**
   * Include heartbeats in stream
   */
  heartbeats?: boolean;

  /**
   * Event filter configuration (server-side filtering).
   * Controls which events are sent to the client.
   */
  filter?: EventFilterConfig;
}
