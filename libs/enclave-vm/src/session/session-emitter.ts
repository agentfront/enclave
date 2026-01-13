/**
 * Session Event Emitter
 *
 * Manages event emission for streaming sessions.
 *
 * @packageDocumentation
 */

import type {
  SessionId,
  StreamEvent,
  SessionInitEvent,
  StdoutEvent,
  LogEvent,
  ToolCallEvent,
  ToolResultAppliedEvent,
  FinalEvent,
  HeartbeatEvent,
  ErrorEvent,
  EncryptionConfig,
  SessionStats,
  CallId,
  LogPayload,
  ErrorInfo,
} from '@enclavejs/types';
import { PROTOCOL_VERSION, EventType, LogLevel } from '@enclavejs/types';
import type { SessionEventEmitter } from '../session-types';

/**
 * Configuration for SessionEmitter
 */
export interface SessionEmitterConfig {
  /**
   * Session ID for all events
   */
  sessionId: SessionId;

  /**
   * Cancel URL for the session
   */
  cancelUrl: string;

  /**
   * Expiration timestamp (ISO string)
   */
  expiresAt: string;

  /**
   * Encryption configuration
   */
  encryption?: EncryptionConfig;

  /**
   * Initial sequence number
   * @default 0
   */
  initialSeq?: number;
}

/**
 * Session Event Emitter implementation
 *
 * Provides typed event creation and emission for session lifecycle.
 * Automatically manages sequence numbers and timestamps.
 */
export class SessionEmitter implements SessionEventEmitter {
  private readonly sessionId: SessionId;
  private readonly cancelUrl: string;
  private readonly expiresAt: string;
  private readonly encryption: EncryptionConfig;
  private seq: number;
  private readonly handlers: Set<(event: StreamEvent) => void>;
  private readonly emittedEvents: StreamEvent[];

  constructor(config: SessionEmitterConfig) {
    this.sessionId = config.sessionId;
    this.cancelUrl = config.cancelUrl;
    this.expiresAt = config.expiresAt;
    this.encryption = config.encryption ?? { enabled: false };
    this.seq = config.initialSeq ?? 0;
    this.handlers = new Set();
    this.emittedEvents = [];
  }

  /**
   * Get current sequence number
   */
  getSeq(): number {
    return this.seq;
  }

  /**
   * Emit a stream event
   */
  emit(event: StreamEvent): void {
    this.emittedEvents.push(event);
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // Ignore handler errors
      }
    }
  }

  /**
   * Subscribe to stream events
   */
  on(handler: (event: StreamEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /**
   * Get all emitted events
   */
  getEmittedEvents(): StreamEvent[] {
    return [...this.emittedEvents];
  }

  /**
   * Create and emit a session_init event
   */
  emitSessionInit(): SessionInitEvent {
    const event: SessionInitEvent = {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: this.sessionId,
      seq: ++this.seq,
      type: EventType.SessionInit,
      payload: {
        cancelUrl: this.cancelUrl,
        expiresAt: this.expiresAt,
        encryption: this.encryption,
      },
    };
    this.emit(event);
    return event;
  }

  /**
   * Create and emit a stdout event
   */
  emitStdout(chunk: string): StdoutEvent {
    const event: StdoutEvent = {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: this.sessionId,
      seq: ++this.seq,
      type: EventType.Stdout,
      payload: { chunk },
    };
    this.emit(event);
    return event;
  }

  /**
   * Create and emit a log event
   */
  emitLog(level: LogPayload['level'], message: string, data?: Record<string, unknown>): LogEvent {
    const event: LogEvent = {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: this.sessionId,
      seq: ++this.seq,
      type: EventType.Log,
      payload: {
        level,
        message,
        ...(data && { data }),
      },
    };
    this.emit(event);
    return event;
  }

  /**
   * Create and emit a tool_call event
   */
  emitToolCall(callId: CallId, toolName: string, args: Record<string, unknown>): ToolCallEvent {
    const event: ToolCallEvent = {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: this.sessionId,
      seq: ++this.seq,
      type: EventType.ToolCall,
      payload: {
        callId,
        toolName,
        args,
      },
    };
    this.emit(event);
    return event;
  }

  /**
   * Create and emit a tool_result_applied event
   */
  emitToolResultApplied(callId: CallId): ToolResultAppliedEvent {
    const event: ToolResultAppliedEvent = {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: this.sessionId,
      seq: ++this.seq,
      type: EventType.ToolResultApplied,
      payload: {
        callId,
      },
    };
    this.emit(event);
    return event;
  }

  /**
   * Create and emit a final event (success)
   */
  emitFinalSuccess(result: unknown, stats: SessionStats): FinalEvent {
    const event: FinalEvent = {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: this.sessionId,
      seq: ++this.seq,
      type: EventType.Final,
      payload: {
        ok: true,
        result,
        stats,
      },
    };
    this.emit(event);
    return event;
  }

  /**
   * Create and emit a final event (failure)
   */
  emitFinalError(error: ErrorInfo, stats: SessionStats): FinalEvent {
    const event: FinalEvent = {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: this.sessionId,
      seq: ++this.seq,
      type: EventType.Final,
      payload: {
        ok: false,
        error,
        stats,
      },
    };
    this.emit(event);
    return event;
  }

  /**
   * Create and emit a heartbeat event
   */
  emitHeartbeat(): HeartbeatEvent {
    const event: HeartbeatEvent = {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: this.sessionId,
      seq: ++this.seq,
      type: EventType.Heartbeat,
      payload: {
        ts: new Date().toISOString(),
      },
    };
    this.emit(event);
    return event;
  }

  /**
   * Create and emit an error event
   */
  emitError(code: string, message: string, recoverable: boolean, details?: Record<string, unknown>): ErrorEvent {
    const event: ErrorEvent = {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: this.sessionId,
      seq: ++this.seq,
      type: EventType.Error,
      payload: {
        code,
        message,
        recoverable,
        ...(details && { details }),
      },
    };
    this.emit(event);
    return event;
  }

  /**
   * Clear all handlers
   */
  clearHandlers(): void {
    this.handlers.clear();
  }

  /**
   * Clear emitted events history
   */
  clearHistory(): void {
    this.emittedEvents.length = 0;
  }
}

/**
 * Create a session emitter for a new session
 */
export function createSessionEmitter(
  sessionId: SessionId,
  options: {
    cancelUrl?: string;
    expiresAt?: Date;
    encryption?: EncryptionConfig;
  } = {},
): SessionEmitter {
  const cancelUrl = options.cancelUrl ?? `/sessions/${sessionId}/cancel`;
  const expiresAt = options.expiresAt ?? new Date(Date.now() + 60000);

  return new SessionEmitter({
    sessionId,
    cancelUrl,
    expiresAt: expiresAt.toISOString(),
    encryption: options.encryption,
  });
}
