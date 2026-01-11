/**
 * @enclavejs/types - Protocol definitions
 *
 * Core protocol constants and base types for the EnclaveJS streaming runtime.
 */

/**
 * Current protocol version.
 * Increment when making breaking changes to the wire format.
 */
export const PROTOCOL_VERSION = 1 as const;

/**
 * Protocol version type for type-safe versioning.
 */
export type ProtocolVersion = typeof PROTOCOL_VERSION;

/**
 * Session ID prefix for identification and debugging.
 */
export const SESSION_ID_PREFIX = 's_' as const;

/**
 * Call ID prefix for tool call identification.
 */
export const CALL_ID_PREFIX = 'c_' as const;

/**
 * Reference ID prefix for sidecar references.
 */
export const REF_ID_PREFIX = 'ref_' as const;

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
export function generateSessionId(): SessionId {
  return `${SESSION_ID_PREFIX}${crypto.randomUUID()}`;
}

/**
 * Generate a unique call ID.
 */
export function generateCallId(): CallId {
  return `${CALL_ID_PREFIX}${crypto.randomUUID()}`;
}

/**
 * Generate a unique reference ID.
 */
export function generateRefId(): RefId {
  return `${REF_ID_PREFIX}${crypto.randomUUID()}`;
}

/**
 * Check if a string is a valid session ID.
 */
export function isSessionId(value: string): value is SessionId {
  return value.startsWith(SESSION_ID_PREFIX);
}

/**
 * Check if a string is a valid call ID.
 */
export function isCallId(value: string): value is CallId {
  return value.startsWith(CALL_ID_PREFIX);
}

/**
 * Check if a string is a valid reference ID.
 */
export function isRefId(value: string): value is RefId {
  return value.startsWith(REF_ID_PREFIX);
}

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
export const DEFAULT_SESSION_LIMITS: Required<SessionLimits> = {
  sessionTtlMs: 60000,
  maxToolCalls: 50,
  maxStdoutBytes: 262144,
  maxToolResultBytes: 5242880,
  toolTimeoutMs: 30000,
  heartbeatIntervalMs: 15000,
};

/**
 * Session state enumeration.
 */
export const SessionState = {
  /** Session is starting up */
  Starting: 'starting',
  /** Session is actively running code */
  Running: 'running',
  /** Session is waiting for a tool result */
  WaitingForTool: 'waiting_for_tool',
  /** Session completed successfully */
  Completed: 'completed',
  /** Session was cancelled */
  Cancelled: 'cancelled',
  /** Session failed with an error */
  Failed: 'failed',
} as const;

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
export function isRefToken(value: unknown): value is RefToken {
  return (
    typeof value === 'object' &&
    value !== null &&
    '$ref' in value &&
    typeof (value as RefToken).$ref === 'object' &&
    (value as RefToken).$ref !== null &&
    'id' in (value as RefToken).$ref &&
    typeof (value as RefToken).$ref.id === 'string' &&
    isRefId((value as RefToken).$ref.id)
  );
}

/**
 * Create a reference token from a ref ID.
 */
export function createRefToken(id: RefId): RefToken {
  return { $ref: { id } };
}

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
export const LogLevel = {
  Debug: 'debug',
  Info: 'info',
  Warn: 'warn',
  Error: 'error',
} as const;

export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];
