/**
 * @enclave-vm/types - Stream event definitions
 *
 * All event types that can be sent over the streaming protocol.
 */

import type { ProtocolVersion, SessionId, CallId, ErrorInfo, LogLevel } from './protocol.js';

// ============================================================================
// Rich Error Types (inspired by gRPC google.rpc.Status)
// ============================================================================

/**
 * Typed error details for structured error reporting.
 */
export type ErrorDetail =
  | { type: 'retry_info'; retryDelayMs: number }
  | { type: 'upstream_info'; statusCode: number; url: string }
  | { type: 'validation_info'; field: string; reason: string }
  | { type: 'quota_info'; limit: number; used: number };

/**
 * Rich error payload following gRPC error model.
 * Supports per-path errors with typed details.
 */
export interface ErrorPayload {
  /** Machine-readable error code (e.g., 'TOOL_TIMEOUT', 'VALIDATION_ERROR') */
  code: string;
  /** Human-readable error message */
  message: string;
  /** Path to the failing operation (like GraphQL path) */
  path?: string[];
  /** Typed error details for programmatic handling */
  details?: ErrorDetail[];
}

/**
 * Base event structure shared by all stream events.
 */
export interface BaseEvent {
  /** Protocol version for compatibility checking */
  protocolVersion: ProtocolVersion;
  /** Session identifier */
  sessionId: SessionId;
  /** Monotonically increasing sequence number */
  seq: number;
}

/**
 * Event type discriminator.
 */
export const EventType = {
  /** Session initialization */
  SessionInit: 'session_init',
  /** Standard output chunk */
  Stdout: 'stdout',
  /** Log message */
  Log: 'log',
  /** Tool call request from runtime */
  ToolCall: 'tool_call',
  /** Tool result acknowledgment */
  ToolResultApplied: 'tool_result_applied',
  /** Session completed */
  Final: 'final',
  /** Keep-alive heartbeat */
  Heartbeat: 'heartbeat',
  /** Error event */
  Error: 'error',
  /** Encrypted envelope (wraps other events) */
  Encrypted: 'enc',
  /** Partial result (GraphQL-inspired, data+errors coexist) */
  PartialResult: 'partial_result',
  /** Tool execution progress */
  ToolProgress: 'tool_progress',
  /** Deadline exceeded for execution */
  DeadlineExceeded: 'deadline_exceeded',
  /** Action catalog changed (for long-lived connections) */
  CatalogChanged: 'catalog_changed',
} as const;

export type EventType = (typeof EventType)[keyof typeof EventType];

// ============================================================================
// Session Init Event
// ============================================================================

/**
 * Encryption configuration in session init.
 */
export interface EncryptionConfig {
  /** Whether encryption is enabled for this session */
  enabled: boolean;
  /** Key ID for the session encryption key */
  keyId?: string;
}

/**
 * Session initialization event payload.
 */
export interface SessionInitPayload {
  /** URL to cancel the session */
  cancelUrl: string;
  /** Session expiration timestamp (ISO 8601) */
  expiresAt: string;
  /** Encryption configuration */
  encryption: EncryptionConfig;
  /** Optional replay URL for reconnection */
  replayUrl?: string;
}

/**
 * Session initialization event.
 * First event sent after session creation.
 */
export interface SessionInitEvent extends BaseEvent {
  type: typeof EventType.SessionInit;
  payload: SessionInitPayload;
}

// ============================================================================
// Stdout Event
// ============================================================================

/**
 * Stdout event payload.
 */
export interface StdoutPayload {
  /** Output chunk (text) */
  chunk: string;
}

/**
 * Standard output event.
 * Emitted when runtime code writes to stdout.
 */
export interface StdoutEvent extends BaseEvent {
  type: typeof EventType.Stdout;
  payload: StdoutPayload;
}

// ============================================================================
// Log Event
// ============================================================================

/**
 * Log event payload.
 */
export interface LogPayload {
  /** Log level */
  level: LogLevel;
  /** Log message */
  message: string;
  /** Additional structured data */
  data?: Record<string, unknown>;
}

/**
 * Log event.
 * Emitted for console.log/warn/error calls.
 */
export interface LogEvent extends BaseEvent {
  type: typeof EventType.Log;
  payload: LogPayload;
}

// ============================================================================
// Tool Call Event
// ============================================================================

/**
 * Tool call event payload.
 */
export interface ToolCallPayload {
  /** Unique identifier for this tool call */
  callId: CallId;
  /** Name of the tool to invoke */
  toolName: string;
  /** Arguments to pass to the tool */
  args: unknown;
}

/**
 * Tool call event.
 * Emitted when runtime code calls `callTool()`.
 */
export interface ToolCallEvent extends BaseEvent {
  type: typeof EventType.ToolCall;
  payload: ToolCallPayload;
}

// ============================================================================
// Tool Result Applied Event
// ============================================================================

/**
 * Tool result applied event payload.
 */
export interface ToolResultAppliedPayload {
  /** Call ID of the completed tool call */
  callId: CallId;
}

/**
 * Tool result applied event.
 * Acknowledgment that a tool result was received and applied.
 */
export interface ToolResultAppliedEvent extends BaseEvent {
  type: typeof EventType.ToolResultApplied;
  payload: ToolResultAppliedPayload;
}

// ============================================================================
// Final Event
// ============================================================================

/**
 * Final event payload.
 * Supports mixed results (GraphQL-inspired): data and errors can coexist.
 */
export interface FinalPayload {
  /** Whether all operations completed successfully */
  ok: boolean;
  /** Execution result (full aggregated result) */
  result?: unknown;
  /** Error information (if ok is false, legacy single error) */
  error?: ErrorInfo;
  /** Per-path errors (GraphQL-style errors array) */
  errors?: ErrorPayload[];
  /** Execution statistics */
  stats?: SessionStats;
}

/**
 * Session statistics included in final event.
 */
export interface SessionStats {
  /** Total execution time in milliseconds */
  durationMs: number;
  /** Number of tool calls made */
  toolCallCount: number;
  /** Total bytes output to stdout */
  stdoutBytes: number;
}

/**
 * Final event.
 * Last event sent when session completes (success or failure).
 */
export interface FinalEvent extends BaseEvent {
  type: typeof EventType.Final;
  payload: FinalPayload;
}

// ============================================================================
// Heartbeat Event
// ============================================================================

/**
 * Heartbeat event payload.
 */
export interface HeartbeatPayload {
  /** Timestamp of the heartbeat (ISO 8601) */
  ts: string;
}

/**
 * Heartbeat event.
 * Sent periodically to keep connection alive and detect stale sessions.
 */
export interface HeartbeatEvent extends BaseEvent {
  type: typeof EventType.Heartbeat;
  payload: HeartbeatPayload;
}

// ============================================================================
// Error Event
// ============================================================================

/**
 * Error event payload.
 */
export interface ErrorEventPayload {
  /** Error message */
  message: string;
  /** Error code */
  code?: string;
  /** Whether the error is recoverable */
  recoverable?: boolean;
}

/**
 * Error event.
 * Emitted for non-fatal errors during session execution.
 */
export interface ErrorEvent extends BaseEvent {
  type: typeof EventType.Error;
  payload: ErrorEventPayload;
}

// ============================================================================
// Partial Result Event (GraphQL-inspired)
// ============================================================================

/**
 * Partial result event payload.
 * When code fans out to multiple APIs, results arrive incrementally.
 */
export interface PartialResultPayload {
  /** Path to where this result slots in (like GraphQL path) */
  path: string[];
  /** The partial data (if this path succeeded) */
  data?: unknown;
  /** The error for this path (if this path failed) */
  error?: ErrorPayload;
  /** Whether more partial results are coming */
  hasNext: boolean;
}

/**
 * Partial result event.
 * Emitted when individual parts of a fan-out execution complete.
 */
export interface PartialResultEvent extends BaseEvent {
  type: typeof EventType.PartialResult;
  payload: PartialResultPayload;
}

// ============================================================================
// Tool Progress Event (gRPC server streaming inspired)
// ============================================================================

/**
 * Tool progress phase.
 */
export type ToolProgressPhase = 'connecting' | 'sending' | 'receiving' | 'processing';

/**
 * Tool progress event payload.
 * Reports progress for long-running tool calls.
 */
export interface ToolProgressPayload {
  /** Call ID of the tool call */
  callId: CallId;
  /** Current phase of execution */
  phase: ToolProgressPhase;
  /** Bytes received so far */
  bytesReceived?: number;
  /** Total bytes expected (if Content-Length known) */
  totalBytes?: number;
  /** Elapsed time in milliseconds */
  elapsedMs: number;
}

/**
 * Tool progress event.
 * Emitted during long-running tool calls to report progress.
 */
export interface ToolProgressEvent extends BaseEvent {
  type: typeof EventType.ToolProgress;
  payload: ToolProgressPayload;
}

// ============================================================================
// Deadline Exceeded Event (gRPC-inspired)
// ============================================================================

/**
 * Deadline exceeded event payload.
 */
export interface DeadlineExceededPayload {
  /** Total elapsed time in milliseconds */
  elapsedMs: number;
  /** The deadline budget that was exceeded in milliseconds */
  budgetMs: number;
}

/**
 * Deadline exceeded event.
 * Emitted when execution exceeds the configured deadline.
 */
export interface DeadlineExceededEvent extends BaseEvent {
  type: typeof EventType.DeadlineExceeded;
  payload: DeadlineExceededPayload;
}

// ============================================================================
// Catalog Changed Event
// ============================================================================

/**
 * Catalog changed event payload.
 * Notifies clients that the available action catalog has changed.
 */
export interface CatalogChangedPayload {
  /** New catalog version hash */
  version: string;
  /** Names of newly added actions */
  addedActions: string[];
  /** Names of removed actions */
  removedActions: string[];
}

/**
 * Catalog changed event.
 * Emitted when the action catalog is updated (tools added/removed via OpenAPI polling).
 */
export interface CatalogChangedEvent extends BaseEvent {
  type: typeof EventType.CatalogChanged;
  payload: CatalogChangedPayload;
}

// ============================================================================
// Stream Event Union
// ============================================================================

/**
 * Union of all stream event types (excluding encrypted envelope).
 */
export type StreamEvent =
  | SessionInitEvent
  | StdoutEvent
  | LogEvent
  | ToolCallEvent
  | ToolResultAppliedEvent
  | FinalEvent
  | HeartbeatEvent
  | ErrorEvent
  | PartialResultEvent
  | ToolProgressEvent
  | DeadlineExceededEvent
  | CatalogChangedEvent;

/**
 * Get the event type from a stream event.
 */
export function getEventType(event: StreamEvent): EventType {
  return event.type;
}

/**
 * Type guard for session init event.
 */
export function isSessionInitEvent(event: StreamEvent): event is SessionInitEvent {
  return event.type === EventType.SessionInit;
}

/**
 * Type guard for stdout event.
 */
export function isStdoutEvent(event: StreamEvent): event is StdoutEvent {
  return event.type === EventType.Stdout;
}

/**
 * Type guard for log event.
 */
export function isLogEvent(event: StreamEvent): event is LogEvent {
  return event.type === EventType.Log;
}

/**
 * Type guard for tool call event.
 */
export function isToolCallEvent(event: StreamEvent): event is ToolCallEvent {
  return event.type === EventType.ToolCall;
}

/**
 * Type guard for tool result applied event.
 */
export function isToolResultAppliedEvent(event: StreamEvent): event is ToolResultAppliedEvent {
  return event.type === EventType.ToolResultApplied;
}

/**
 * Type guard for final event.
 */
export function isFinalEvent(event: StreamEvent): event is FinalEvent {
  return event.type === EventType.Final;
}

/**
 * Type guard for heartbeat event.
 */
export function isHeartbeatEvent(event: StreamEvent): event is HeartbeatEvent {
  return event.type === EventType.Heartbeat;
}

/**
 * Type guard for error event.
 */
export function isErrorEvent(event: StreamEvent): event is ErrorEvent {
  return event.type === EventType.Error;
}

/**
 * Type guard for partial result event.
 */
export function isPartialResultEvent(event: StreamEvent): event is PartialResultEvent {
  return event.type === EventType.PartialResult;
}

/**
 * Type guard for tool progress event.
 */
export function isToolProgressEvent(event: StreamEvent): event is ToolProgressEvent {
  return event.type === EventType.ToolProgress;
}

/**
 * Type guard for deadline exceeded event.
 */
export function isDeadlineExceededEvent(event: StreamEvent): event is DeadlineExceededEvent {
  return event.type === EventType.DeadlineExceeded;
}

/**
 * Type guard for catalog changed event.
 */
export function isCatalogChangedEvent(event: StreamEvent): event is CatalogChangedEvent {
  return event.type === EventType.CatalogChanged;
}

// ============================================================================
// Runtime Channel Messages (Middleware <-> Runtime)
// ============================================================================

/**
 * Message types for the internal middleware <-> runtime channel.
 */
export const RuntimeChannelMessageType = {
  /** Tool result submission from broker to runtime */
  ToolResultSubmit: 'tool_result_submit',
  /** Cancel session request */
  Cancel: 'cancel',
} as const;

export type RuntimeChannelMessageType = (typeof RuntimeChannelMessageType)[keyof typeof RuntimeChannelMessageType];

/**
 * Tool result submit message payload.
 */
export interface ToolResultSubmitPayload {
  /** Call ID this result is for */
  callId: CallId;
  /** Whether the tool execution succeeded */
  ok: boolean;
  /** Tool result (if ok is true) */
  result?: unknown;
  /** Error information (if ok is false) */
  error?: ErrorInfo;
}

/**
 * Tool result submit message.
 * Sent from middleware/broker to runtime.
 */
export interface ToolResultSubmitMessage {
  protocolVersion: ProtocolVersion;
  sessionId: SessionId;
  type: typeof RuntimeChannelMessageType.ToolResultSubmit;
  payload: ToolResultSubmitPayload;
}

/**
 * Cancel message payload.
 */
export interface CancelPayload {
  /** Reason for cancellation */
  reason?: string;
}

/**
 * Cancel message.
 * Sent to terminate a running session.
 */
export interface CancelMessage {
  protocolVersion: ProtocolVersion;
  sessionId: SessionId;
  type: typeof RuntimeChannelMessageType.Cancel;
  payload: CancelPayload;
}

/**
 * Union of runtime channel messages.
 */
export type RuntimeChannelMessage = ToolResultSubmitMessage | CancelMessage;
