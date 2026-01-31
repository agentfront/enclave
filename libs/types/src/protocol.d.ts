/**
 * @enclave-vm/types - Protocol definitions
 *
 * Core protocol constants and base types for the EnclaveJS streaming runtime.
 */
/**
 * Current protocol version.
 * Increment when making breaking changes to the wire format.
 */
export declare const PROTOCOL_VERSION: 1;
/**
 * Protocol version type for type-safe versioning.
 */
export type ProtocolVersion = typeof PROTOCOL_VERSION;
/**
 * Session ID prefix for identification and debugging.
 */
export declare const SESSION_ID_PREFIX: 's_';
/**
 * Call ID prefix for tool call identification.
 */
export declare const CALL_ID_PREFIX: 'c_';
/**
 * Reference ID prefix for sidecar references.
 */
export declare const REF_ID_PREFIX: 'ref_';
/**
 * Session identifier type.
 */
export type SessionId = `${typeof SESSION_ID_PREFIX}${string}`;
/**
 * Tool call identifier type.
 */
export type CallId = `${typeof CALL_ID_PREFIX}${string}`;
/**
 * Reference identifier type.
 */
export type RefId = `${typeof REF_ID_PREFIX}${string}`;
/**
 * Generate a unique session ID.
 */
export declare function generateSessionId(): SessionId;
/**
 * Generate a unique call ID.
 */
export declare function generateCallId(): CallId;
/**
 * Generate a unique reference ID.
 */
export declare function generateRefId(): RefId;
/**
 * Check if a string is a valid session ID.
 */
export declare function isSessionId(value: string): value is SessionId;
/**
 * Check if a string is a valid call ID.
 */
export declare function isCallId(value: string): value is CallId;
/**
 * Check if a string is a valid reference ID.
 */
export declare function isRefId(value: string): value is RefId;
/**
 * Session limits configuration.
 */
export interface SessionLimits {
  /**
   * Maximum session duration in milliseconds.
   * @default 60000 (1 minute)
   */
  sessionTtlMs?: number;
  /**
   * Maximum number of tool calls allowed in a session.
   * @default 50
   */
  maxToolCalls?: number;
  /**
   * Maximum stdout/output bytes.
   * @default 262144 (256KB)
   */
  maxStdoutBytes?: number;
  /**
   * Maximum size of a single tool result in bytes.
   * @default 5242880 (5MB)
   */
  maxToolResultBytes?: number;
  /**
   * Individual tool execution timeout in milliseconds.
   * @default 30000 (30 seconds)
   */
  toolTimeoutMs?: number;
  /**
   * Heartbeat interval in milliseconds.
   * @default 15000 (15 seconds)
   */
  heartbeatIntervalMs?: number;
}
/**
 * Default session limits.
 */
export declare const DEFAULT_SESSION_LIMITS: Required<SessionLimits>;
/**
 * Session state enumeration.
 */
export declare const SessionState: {
  /** Session is starting up */
  readonly Starting: 'starting';
  /** Session is actively running code */
  readonly Running: 'running';
  /** Session is waiting for a tool result */
  readonly WaitingForTool: 'waiting_for_tool';
  /** Session completed successfully */
  readonly Completed: 'completed';
  /** Session was cancelled */
  readonly Cancelled: 'cancelled';
  /** Session failed with an error */
  readonly Failed: 'failed';
};
export type SessionState = (typeof SessionState)[keyof typeof SessionState];
/**
 * Tool configuration for timeout and retry behavior.
 */
export interface ToolConfig {
  /**
   * Tool execution timeout in milliseconds.
   * Overrides session-level toolTimeoutMs.
   */
  timeout?: number;
  /**
   * Whether the tool can be retried on failure.
   * @default false
   */
  retryable?: boolean;
  /**
   * Maximum number of retries if retryable is true.
   * @default 3
   */
  maxRetries?: number;
  /**
   * Whether the tool result can be read by runtime code.
   * If false, result is always stored as a reference.
   * @default true
   */
  runtimeReadable?: boolean;
}
/**
 * Reference token for pass-by-reference values.
 * Used to avoid transmitting large/sensitive values through the runtime.
 */
export interface RefToken {
  $ref: {
    id: RefId;
  };
}
/**
 * Check if a value is a reference token.
 */
export declare function isRefToken(value: unknown): value is RefToken;
/**
 * Create a reference token from a ref ID.
 */
export declare function createRefToken(id: RefId): RefToken;
/**
 * Error information structure.
 */
export interface ErrorInfo {
  /** Human-readable error message */
  message: string;
  /** Machine-readable error code */
  code?: string;
  /** Stack trace (only in development/debug mode) */
  stack?: string;
}
/**
 * Log levels for session logging.
 */
export declare const LogLevel: {
  readonly Debug: 'debug';
  readonly Info: 'info';
  readonly Warn: 'warn';
  readonly Error: 'error';
};
export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];
