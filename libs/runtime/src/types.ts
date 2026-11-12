/**
 * Runtime Types
 *
 * Types for the standalone runtime worker.
 *
 * @packageDocumentation
 */

import type { SessionId, SessionLimits, StreamEvent, RuntimeChannelMessage } from '@enclave-vm/types';

/**
 * Runtime configuration
 *
 * `port`, `host` and `wsPath` are kept for compatibility and are not used: this package
 * starts no server and opens no port.
 */
export interface RuntimeConfig {
  /**
   * Not used (no server is started)
   * @default 3001
   */
  port?: number;

  /**
   * Not used (no server is started)
   * @default '127.0.0.1'
   */
  host?: string;

  /**
   * Not used (no server is started)
   * @default '/ws'
   */
  wsPath?: string;

  /**
   * Maximum concurrent sessions per runtime. A positive integer.
   * @default 10
   */
  maxSessions?: number;

  /**
   * Default session limits
   */
  defaultLimits?: Partial<SessionLimits>;

  /**
   * Enable debug logging
   * @default false
   */
  debug?: boolean;

  /**
   * Heartbeat interval in milliseconds
   * @default 15000
   */
  heartbeatIntervalMs?: number;

  /**
   * Connection timeout in milliseconds
   * @default 30000
   */
  connectionTimeoutMs?: number;
}

/**
 * Execution request from broker
 */
export interface ExecuteRequest {
  type: 'execute';
  sessionId: SessionId;
  code: string;
  limits?: Partial<SessionLimits>;
}

/**
 * Cancel request from broker
 */
export interface CancelRequest {
  type: 'cancel';
  sessionId: SessionId;
  reason?: string;
}

/**
 * Tool result from broker
 */
export interface ToolResultRequest {
  type: 'tool_result';
  sessionId: SessionId;
  callId: string;
  success: boolean;
  value?: unknown;
  error?: {
    code?: string;
    message: string;
  };
}

/**
 * Ping request for health checks
 */
export interface PingRequest {
  type: 'ping';
  timestamp: number;
}

/**
 * All possible runtime channel messages
 */
export type RuntimeRequest = ExecuteRequest | CancelRequest | ToolResultRequest | PingRequest;

/**
 * Runtime worker state
 */
export type RuntimeState = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped';

/**
 * Session state within runtime
 */
export interface RuntimeSession {
  sessionId: SessionId;
  state: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * Runtime statistics
 */
export interface RuntimeStats {
  /**
   * Runtime state
   */
  state: RuntimeState;

  /**
   * Number of active sessions
   */
  activeSessions: number;

  /**
   * Total sessions executed since start
   */
  totalSessions: number;

  /**
   * Runtime start time
   */
  startedAt: number;

  /**
   * Uptime in milliseconds
   */
  uptimeMs: number;

  /**
   * Memory usage
   */
  memoryUsage: {
    heapUsed: number;
    heapTotal: number;
    rss: number;
  };
}

/**
 * Event handler for runtime events
 */
export type RuntimeEventHandler = (event: StreamEvent) => void;

/**
 * Connection handler for WebSocket connections
 */
export type ConnectionHandler = (
  sessionId: SessionId,
  sendEvent: (event: StreamEvent) => void,
) => {
  onMessage: (message: RuntimeChannelMessage) => void;
  onClose: () => void;
};

/**
 * Runtime worker interface
 */
export interface RuntimeWorker {
  /**
   * Start the runtime worker
   */
  start(): Promise<void>;

  /**
   * Stop the runtime worker
   */
  stop(): Promise<void>;

  /**
   * Get runtime statistics
   */
  getStats(): RuntimeStats;

  /**
   * Get active sessions
   */
  getSessions(): RuntimeSession[];

  /**
   * Check if runtime is running
   */
  readonly isRunning: boolean;
}

/**
 * WebSocket server interface (platform-agnostic)
 */
export interface WebSocketServer {
  /**
   * Start listening
   */
  listen(): Promise<void>;

  /**
   * Stop the server
   */
  close(): Promise<void>;

  /**
   * Handle new connections
   */
  onConnection(handler: ConnectionHandler): void;
}

/**
 * Channel abstraction for communication
 */
export interface RuntimeChannel {
  /**
   * Send a stream event
   */
  send(event: StreamEvent): void;

  /**
   * Receive messages
   */
  onMessage(handler: (message: RuntimeChannelMessage) => void): () => void;

  /**
   * Close the channel
   */
  close(): void;

  /**
   * Whether the channel is open
   */
  readonly isOpen: boolean;
}
