/**
 * Session Types for Streaming Runtime
 *
 * Types for running Enclave in session mode, which supports:
 * - Continuous execution with streaming events
 * - Async tool calls with "waiting for tool" state
 * - Session lifecycle management
 *
 * @packageDocumentation
 */

import type {
  SessionId,
  CallId,
  SessionLimits,
  StreamEvent,
  ToolCallPayload,
  RuntimeChannelMessage,
} from '@enclave-vm/types';
import type { CreateEnclaveOptions, ExecutionStats } from './types';

/**
 * Session state machine states
 *
 * The session progresses through these states:
 * - starting: Session created, runtime initializing
 * - running: Code is executing
 * - waiting_for_tool: Blocked on async tool call
 * - completed: Execution finished successfully
 * - cancelled: Session was cancelled externally
 * - failed: Execution failed with error
 */
export type SessionStateValue = 'starting' | 'running' | 'waiting_for_tool' | 'completed' | 'cancelled' | 'failed';

/**
 * Session configuration
 *
 * Extends standard Enclave options with session-specific settings.
 */
export interface SessionConfig extends CreateEnclaveOptions {
  /**
   * Session resource limits
   * Overrides individual config values when provided
   */
  limits?: Partial<SessionLimits>;

  /**
   * Heartbeat interval in milliseconds
   * Set to 0 to disable heartbeats
   * @default 15000
   */
  heartbeatIntervalMs?: number;

  /**
   * Enable encryption for streaming events
   * @default false
   */
  encryption?: boolean;
}

/**
 * Pending tool call information
 *
 * Represents a tool call that the runtime is waiting for.
 */
export interface PendingToolCall {
  /**
   * Unique call identifier
   */
  callId: CallId;

  /**
   * Name of the tool being called
   */
  toolName: string;

  /**
   * Arguments passed to the tool (may contain refs)
   */
  args: Record<string, unknown>;

  /**
   * Timestamp when the call was initiated
   */
  timestamp: number;
}

/**
 * Async tool handler for session mode
 *
 * Unlike the synchronous ToolHandler, this returns void and the result
 * is submitted separately via the session's submitToolResult method.
 * This allows for long-running tool calls that don't block the session.
 */
export type AsyncToolHandler = (
  callId: CallId,
  toolName: string,
  args: Record<string, unknown>,
) => void | Promise<void>;

/**
 * Tool result to submit back to the session
 */
export interface ToolResult {
  /**
   * The call ID this result is for
   */
  callId: CallId;

  /**
   * Whether the tool call succeeded
   */
  success: boolean;

  /**
   * Result value (if successful)
   */
  value?: unknown;

  /**
   * Error information (if failed)
   */
  error?: {
    message: string;
    code?: string;
    data?: Record<string, unknown>;
  };
}

/**
 * Session event emitter interface
 *
 * Provides typed event emission for session lifecycle.
 */
export interface SessionEventEmitter {
  /**
   * Emit a stream event
   */
  emit(event: StreamEvent): void;

  /**
   * Subscribe to stream events
   */
  on(handler: (event: StreamEvent) => void): () => void;

  /**
   * Get all emitted events (for testing/debugging)
   */
  getEmittedEvents(): StreamEvent[];
}

/**
 * Session instance interface
 *
 * Represents an active execution session that can receive tool results
 * and emit streaming events.
 */
export interface Session {
  /**
   * Unique session identifier
   */
  readonly sessionId: SessionId;

  /**
   * Current session state
   */
  readonly state: SessionStateValue;

  /**
   * Current sequence number for events
   */
  readonly seq: number;

  /**
   * Pending tool call (when in waiting_for_tool state)
   */
  readonly pendingToolCall: PendingToolCall | null;

  /**
   * Session creation timestamp
   */
  readonly createdAt: number;

  /**
   * Session expiration timestamp
   */
  readonly expiresAt: number;

  /**
   * Event emitter for this session
   */
  readonly events: SessionEventEmitter;

  /**
   * Submit a tool result to resume execution
   *
   * @param result - The tool result to submit
   * @throws Error if session is not in waiting_for_tool state
   * @throws Error if result callId doesn't match pending call
   */
  submitToolResult(result: ToolResult): Promise<void>;

  /**
   * Cancel the session
   *
   * @param reason - Optional cancellation reason
   */
  cancel(reason?: string): Promise<void>;

  /**
   * Wait for the session to complete
   *
   * @returns Final execution result
   */
  wait(): Promise<SessionFinalResult>;

  /**
   * Get current execution statistics
   */
  getStats(): ExecutionStats;
}

/**
 * Final result when session completes
 */
export interface SessionFinalResult {
  /**
   * Whether execution was successful
   */
  success: boolean;

  /**
   * Return value from the script (if successful)
   */
  value?: unknown;

  /**
   * Error that occurred (if failed)
   */
  error?: {
    message: string;
    name: string;
    code?: string;
    data?: Record<string, unknown>;
  };

  /**
   * Execution statistics
   */
  stats: ExecutionStats;

  /**
   * Final session state
   */
  finalState: 'completed' | 'cancelled' | 'failed';
}

/**
 * Runtime channel abstraction
 *
 * Provides bidirectional communication between the broker and runtime.
 * Different implementations support embedded (in-process) and remote
 * (WebSocket) runtime execution.
 */
export interface RuntimeChannel {
  /**
   * Send a message to the runtime
   */
  send(message: RuntimeChannelMessage): void;

  /**
   * Subscribe to messages from the runtime
   */
  onMessage(handler: (event: StreamEvent) => void): () => void;

  /**
   * Close the channel
   */
  close(): void;

  /**
   * Whether the channel is open
   */
  readonly isOpen: boolean;
}

/**
 * Embedded runtime channel configuration
 *
 * For in-process execution where the Enclave runs in the same process.
 */
export interface EmbeddedChannelConfig {
  type: 'embedded';
}

/**
 * WebSocket runtime channel configuration
 *
 * For remote execution where the runtime is in a separate process/worker.
 */
export interface WebSocketChannelConfig {
  type: 'websocket';

  /**
   * WebSocket URL to connect to
   */
  url: string;

  /**
   * Reconnection options
   */
  reconnect?: {
    maxRetries?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
  };
}

/**
 * Runtime channel configuration union
 */
export type RuntimeChannelConfig = EmbeddedChannelConfig | WebSocketChannelConfig;

/**
 * Session manager interface
 *
 * Manages multiple concurrent sessions.
 */
export interface SessionManager {
  /**
   * Create a new session
   *
   * @param code - Code to execute
   * @param config - Session configuration
   * @param toolHandler - Handler for tool calls
   * @returns Created session
   */
  createSession(code: string, config?: SessionConfig, toolHandler?: AsyncToolHandler): Promise<Session>;

  /**
   * Get an existing session by ID
   */
  getSession(sessionId: SessionId): Session | undefined;

  /**
   * List all active sessions
   */
  listSessions(): Session[];

  /**
   * Terminate a session
   */
  terminateSession(sessionId: SessionId, reason?: string): Promise<void>;

  /**
   * Dispose of the manager and all sessions
   */
  dispose(): Promise<void>;
}

/**
 * Type guard for checking if an object is a Session
 */
export function isSession(obj: unknown): obj is Session {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'sessionId' in obj &&
    'state' in obj &&
    'submitToolResult' in obj &&
    typeof (obj as Session).submitToolResult === 'function'
  );
}

/**
 * Type guard for waiting_for_tool state
 */
export function isWaitingForTool(session: Session): boolean {
  return session.state === 'waiting_for_tool' && session.pendingToolCall !== null;
}

/**
 * Type guard for terminal states
 */
export function isTerminalState(state: SessionStateValue): boolean {
  return state === 'completed' || state === 'cancelled' || state === 'failed';
}
