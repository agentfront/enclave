/**
 * @enclave-vm/types - Stream event definitions
 *
 * All event types that can be sent over the streaming protocol.
 */
import type { ProtocolVersion, SessionId, CallId, ErrorInfo, LogLevel } from './protocol.js';
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
export declare const EventType: {
  /** Session initialization */
  readonly SessionInit: 'session_init';
  /** Standard output chunk */
  readonly Stdout: 'stdout';
  /** Log message */
  readonly Log: 'log';
  /** Tool call request from runtime */
  readonly ToolCall: 'tool_call';
  /** Tool result acknowledgment */
  readonly ToolResultApplied: 'tool_result_applied';
  /** Session completed */
  readonly Final: 'final';
  /** Keep-alive heartbeat */
  readonly Heartbeat: 'heartbeat';
  /** Error event */
  readonly Error: 'error';
  /** Encrypted envelope (wraps other events) */
  readonly Encrypted: 'enc';
};
export type EventType = (typeof EventType)[keyof typeof EventType];
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
/**
 * Final event payload.
 */
export interface FinalPayload {
  /** Whether execution completed successfully */
  ok: boolean;
  /** Execution result (if ok is true) */
  result?: unknown;
  /** Error information (if ok is false) */
  error?: ErrorInfo;
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
  | ErrorEvent;
/**
 * Get the event type from a stream event.
 */
export declare function getEventType(event: StreamEvent): EventType;
/**
 * Type guard for session init event.
 */
export declare function isSessionInitEvent(event: StreamEvent): event is SessionInitEvent;
/**
 * Type guard for stdout event.
 */
export declare function isStdoutEvent(event: StreamEvent): event is StdoutEvent;
/**
 * Type guard for log event.
 */
export declare function isLogEvent(event: StreamEvent): event is LogEvent;
/**
 * Type guard for tool call event.
 */
export declare function isToolCallEvent(event: StreamEvent): event is ToolCallEvent;
/**
 * Type guard for tool result applied event.
 */
export declare function isToolResultAppliedEvent(event: StreamEvent): event is ToolResultAppliedEvent;
/**
 * Type guard for final event.
 */
export declare function isFinalEvent(event: StreamEvent): event is FinalEvent;
/**
 * Type guard for heartbeat event.
 */
export declare function isHeartbeatEvent(event: StreamEvent): event is HeartbeatEvent;
/**
 * Type guard for error event.
 */
export declare function isErrorEvent(event: StreamEvent): event is ErrorEvent;
/**
 * Message types for the internal middleware <-> runtime channel.
 */
export declare const RuntimeChannelMessageType: {
  /** Tool result submission from broker to runtime */
  readonly ToolResultSubmit: 'tool_result_submit';
  /** Cancel session request */
  readonly Cancel: 'cancel';
};
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
