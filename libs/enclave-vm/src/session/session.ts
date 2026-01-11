/**
 * Session Implementation
 *
 * Represents an active execution session with streaming events.
 *
 * @packageDocumentation
 */

import type { SessionId, CallId, SessionStats } from '@enclavejs/types';
import { generateCallId, generateSessionId, DEFAULT_SESSION_LIMITS } from '@enclavejs/types';
import type {
  Session as ISession,
  SessionStateValue,
  SessionConfig,
  PendingToolCall,
  ToolResult,
  SessionFinalResult,
  AsyncToolHandler,
} from '../session-types';
import type { ExecutionStats } from '../types';
import { SessionEmitter, createSessionEmitter } from './session-emitter';
import { SessionStateMachine, createSessionStateMachine } from './session-state-machine';

/**
 * Session creation options
 */
export interface SessionOptions {
  /**
   * Session configuration
   */
  config?: SessionConfig;

  /**
   * Async tool handler
   */
  toolHandler?: AsyncToolHandler;

  /**
   * Session ID (generated if not provided)
   */
  sessionId?: SessionId;

  /**
   * TTL in milliseconds
   */
  ttlMs?: number;
}

/**
 * Session class
 *
 * Manages an execution session with streaming events and async tool calls.
 */
export class Session implements ISession {
  readonly sessionId: SessionId;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly events: SessionEmitter;

  private readonly stateMachine: SessionStateMachine;
  private readonly config: SessionConfig;
  private readonly toolHandler?: AsyncToolHandler;
  private _pendingToolCall: PendingToolCall | null = null;
  private readonly stats: ExecutionStats;
  private stdoutBytes: number;
  private resolveWait: ((result: SessionFinalResult) => void) | null = null;
  private rejectWait: ((error: Error) => void) | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  constructor(options: SessionOptions = {}) {
    this.sessionId = options.sessionId ?? generateSessionId();
    this.createdAt = Date.now();
    this.config = options.config ?? {};
    this.toolHandler = options.toolHandler;

    // Calculate expiration
    const ttlMs = options.ttlMs ?? this.config.limits?.sessionTtlMs ?? DEFAULT_SESSION_LIMITS.sessionTtlMs;
    this.expiresAt = this.createdAt + ttlMs;

    // Initialize stats
    this.stats = {
      duration: 0,
      toolCallCount: 0,
      iterationCount: 0,
      startTime: this.createdAt,
      endTime: 0,
    };

    // Track stdout bytes separately (not in ExecutionStats)
    this.stdoutBytes = 0;

    // Create event emitter
    this.events = createSessionEmitter(this.sessionId, {
      expiresAt: new Date(this.expiresAt),
    });

    // Create state machine
    this.stateMachine = createSessionStateMachine('starting');

    // Set up state transition handling
    this.stateMachine.onTransition((from, to, event) => {
      this.handleStateTransition(from, to, event);
    });
  }

  /**
   * Get current state
   */
  get state(): SessionStateValue {
    return this.stateMachine.getState();
  }

  /**
   * Get current sequence number
   */
  get seq(): number {
    return this.events.getSeq();
  }

  /**
   * Get pending tool call
   */
  get pendingToolCall(): PendingToolCall | null {
    return this._pendingToolCall;
  }

  /**
   * Start the session
   *
   * Emits session_init event and transitions to running.
   */
  start(): void {
    if (this.state !== 'starting') {
      throw new Error(`Cannot start session in state: ${this.state}`);
    }

    // Emit session init event
    this.events.emitSessionInit();

    // Start heartbeat if configured
    const heartbeatMs = this.config.heartbeatIntervalMs ?? DEFAULT_SESSION_LIMITS.heartbeatIntervalMs;
    if (heartbeatMs > 0) {
      this.startHeartbeat(heartbeatMs);
    }

    // Transition to running
    this.stateMachine.transition({ type: 'running' });
  }

  /**
   * Emit stdout output
   */
  emitStdout(chunk: string): void {
    if (this.stateMachine.isTerminal()) {
      return; // Ignore after session ends
    }
    this.stdoutBytes += Buffer.byteLength(chunk, 'utf8');
    this.events.emitStdout(chunk);
  }

  /**
   * Emit log message
   */
  emitLog(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>): void {
    if (this.stateMachine.isTerminal()) {
      return;
    }
    this.events.emitLog(level, message, data);
  }

  /**
   * Request a tool call
   *
   * Transitions to waiting_for_tool state and emits tool_call event.
   *
   * @returns Promise that resolves when tool result is submitted
   */
  async requestToolCall(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.state !== 'running') {
      throw new Error(`Cannot request tool call in state: ${this.state}`);
    }

    const callId = generateCallId();
    const timestamp = Date.now();

    // Store pending tool call
    this._pendingToolCall = {
      callId,
      toolName,
      args,
      timestamp,
    };

    // Emit tool call event
    this.events.emitToolCall(callId, toolName, args);

    // Transition to waiting_for_tool
    this.stateMachine.transition({
      type: 'tool_call',
      callId,
      toolName,
    });

    // Increment tool call count
    this.stats.toolCallCount++;

    // Notify tool handler if provided
    if (this.toolHandler) {
      await this.toolHandler(callId, toolName, args);
    }

    // Return a promise that will be resolved when submitToolResult is called
    return new Promise((resolve, reject) => {
      // Store resolvers on the pending call for later resolution
      (
        this._pendingToolCall as PendingToolCall & {
          resolve: (value: unknown) => void;
          reject: (error: Error) => void;
        }
      ).resolve = resolve;
      (
        this._pendingToolCall as PendingToolCall & {
          resolve: (value: unknown) => void;
          reject: (error: Error) => void;
        }
      ).reject = reject;
    });
  }

  /**
   * Submit a tool result
   */
  async submitToolResult(result: ToolResult): Promise<void> {
    if (this.state !== 'waiting_for_tool') {
      throw new Error(`Cannot submit tool result in state: ${this.state}`);
    }

    if (!this._pendingToolCall) {
      throw new Error('No pending tool call');
    }

    if (this._pendingToolCall.callId !== result.callId) {
      throw new Error(`Tool result callId mismatch: expected ${this._pendingToolCall.callId}, got ${result.callId}`);
    }

    // Get the stored resolvers
    const pendingCall = this._pendingToolCall as PendingToolCall & {
      resolve?: (value: unknown) => void;
      reject?: (error: Error) => void;
    };

    // Clear pending call before resolving
    this._pendingToolCall = null;

    // Emit tool result applied event
    this.events.emitToolResultApplied(result.callId);

    // Transition back to running
    this.stateMachine.transition({
      type: 'tool_result',
      callId: result.callId,
    });

    // Resolve or reject the tool call promise
    if (result.success) {
      pendingCall.resolve?.(result.value);
    } else {
      const error = new Error(result.error?.message ?? 'Tool call failed');
      (error as Error & { code?: string }).code = result.error?.code;
      pendingCall.reject?.(error);
    }
  }

  /**
   * Complete the session successfully
   */
  complete(value?: unknown): void {
    if (this.stateMachine.isTerminal()) {
      return;
    }

    this.stopHeartbeat();
    this.stats.endTime = Date.now();
    this.stats.duration = this.stats.endTime - this.stats.startTime;

    // Emit final event
    this.events.emitFinalSuccess(value, this.toSessionStats());

    // Transition to completed
    this.stateMachine.transition({ type: 'complete', value });

    // Resolve wait promise
    this.resolveWaitPromise({
      success: true,
      value,
      stats: { ...this.stats },
      finalState: 'completed',
    });
  }

  /**
   * Fail the session with an error
   */
  fail(error: Error): void {
    if (this.stateMachine.isTerminal()) {
      return;
    }

    this.stopHeartbeat();
    this.stats.endTime = Date.now();
    this.stats.duration = this.stats.endTime - this.stats.startTime;

    const errorInfo = {
      code: (error as Error & { code?: string }).code ?? 'EXECUTION_ERROR',
      message: error.message,
    };

    // Emit final event
    this.events.emitFinalError(errorInfo, this.toSessionStats());

    // Transition to failed
    this.stateMachine.transition({ type: 'error', error });

    // Resolve wait promise
    this.resolveWaitPromise({
      success: false,
      error: {
        message: error.message,
        name: error.name,
        code: errorInfo.code,
      },
      stats: { ...this.stats },
      finalState: 'failed',
    });
  }

  /**
   * Cancel the session
   */
  async cancel(reason?: string): Promise<void> {
    if (this.stateMachine.isTerminal()) {
      return;
    }

    this.stopHeartbeat();
    this.stats.endTime = Date.now();
    this.stats.duration = this.stats.endTime - this.stats.startTime;

    // Emit error event for cancellation
    this.events.emitError('SESSION_CANCELLED', reason ?? 'Session was cancelled', false);

    // Emit final event
    this.events.emitFinalError(
      {
        code: 'SESSION_CANCELLED',
        message: reason ?? 'Session was cancelled',
      },
      this.toSessionStats(),
    );

    // Reject pending tool call if any
    if (this._pendingToolCall) {
      const pendingCall = this._pendingToolCall as PendingToolCall & {
        reject?: (error: Error) => void;
      };
      pendingCall.reject?.(new Error('Session cancelled'));
      this._pendingToolCall = null;
    }

    // Transition to cancelled
    this.stateMachine.transition({ type: 'cancel', reason });

    // Resolve wait promise
    this.resolveWaitPromise({
      success: false,
      error: {
        message: reason ?? 'Session was cancelled',
        name: 'CancellationError',
        code: 'SESSION_CANCELLED',
      },
      stats: { ...this.stats },
      finalState: 'cancelled',
    });
  }

  /**
   * Wait for the session to complete
   */
  wait(): Promise<SessionFinalResult> {
    // If already terminal, return immediately
    if (this.stateMachine.isTerminal()) {
      const state = this.state as 'completed' | 'cancelled' | 'failed';
      if (state === 'completed') {
        return Promise.resolve({
          success: true,
          value: this.stateMachine.getCompletionValue(),
          stats: { ...this.stats },
          finalState: state,
        });
      } else if (state === 'failed') {
        const error = this.stateMachine.getError();
        return Promise.resolve({
          success: false,
          error: error
            ? {
                message: error.message,
                name: error.name,
              }
            : undefined,
          stats: { ...this.stats },
          finalState: state,
        });
      } else {
        return Promise.resolve({
          success: false,
          error: {
            message: this.stateMachine.getCancelReason() ?? 'Session cancelled',
            name: 'CancellationError',
            code: 'SESSION_CANCELLED',
          },
          stats: { ...this.stats },
          finalState: state,
        });
      }
    }

    // Return existing promise if already waiting
    return new Promise((resolve, reject) => {
      this.resolveWait = resolve;
      this.rejectWait = reject;
    });
  }

  /**
   * Get current execution statistics
   */
  getStats(): ExecutionStats {
    const now = Date.now();
    return {
      ...this.stats,
      duration: this.stateMachine.isTerminal() ? this.stats.duration : now - this.stats.startTime,
      endTime: this.stateMachine.isTerminal() ? this.stats.endTime : now,
    };
  }

  /**
   * Convert to SessionStats for protocol
   */
  private toSessionStats(): SessionStats {
    return {
      durationMs: this.stats.duration || Date.now() - this.stats.startTime,
      toolCallCount: this.stats.toolCallCount,
      stdoutBytes: this.stdoutBytes,
    };
  }

  /**
   * Handle state transitions
   */
  private handleStateTransition(from: SessionStateValue, to: SessionStateValue, _event: unknown): void {
    // Log state transitions if in debug mode
    if (process.env['NODE_ENV'] === 'development') {
      console.debug(`Session ${this.sessionId}: ${from} -> ${to}`);
    }
  }

  /**
   * Start heartbeat timer
   */
  private startHeartbeat(intervalMs: number): void {
    this.heartbeatInterval = setInterval(() => {
      if (!this.stateMachine.isTerminal()) {
        this.events.emitHeartbeat();
      }
    }, intervalMs);
  }

  /**
   * Stop heartbeat timer
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Resolve the wait promise
   */
  private resolveWaitPromise(result: SessionFinalResult): void {
    if (this.resolveWait) {
      this.resolveWait(result);
      this.resolveWait = null;
      this.rejectWait = null;
    }
  }
}

/**
 * Create a new session
 */
export function createSession(options?: SessionOptions): Session {
  return new Session(options);
}
