/**
 * Broker Session
 *
 * Manages an individual execution session with runtime integration.
 *
 * @packageDocumentation
 */

import type { SessionId, StreamEvent, SessionLimits, ErrorPayload } from '@enclave-vm/types';
import {
  generateSessionId,
  generateCallId,
  DEFAULT_SESSION_LIMITS,
  EventType,
  PROTOCOL_VERSION,
} from '@enclave-vm/types';
import { SessionEmitter, createSessionEmitter, Enclave } from '@enclave-vm/core';
import type { SessionStateValue, SessionFinalResult, CreateEnclaveOptions, ExecutionStats } from '@enclave-vm/core';
import type { ToolRegistry, ToolContext } from './tool-registry';

/**
 * Broker session configuration
 */
export interface BrokerSessionConfig {
  /**
   * Session ID (generated if not provided)
   */
  sessionId?: SessionId;

  /**
   * Session resource limits
   */
  limits?: Partial<SessionLimits>;

  /**
   * Enclave configuration
   */
  enclaveConfig?: CreateEnclaveOptions;

  /**
   * Heartbeat interval in milliseconds
   * @default 15000
   */
  heartbeatIntervalMs?: number;
}

/**
 * Broker Session
 *
 * Manages code execution with tool calls and streaming events.
 * Uses Enclave for sandboxed execution and emits stream events.
 */
export class BrokerSession {
  readonly sessionId: SessionId;
  readonly createdAt: number;
  readonly expiresAt: number;

  private readonly emitter: SessionEmitter;
  private readonly toolRegistry: ToolRegistry;
  private readonly enclave: Enclave;
  private readonly abortController: AbortController;
  private readonly limits: Required<SessionLimits>;
  private _state: SessionStateValue = 'starting';
  private executionPromise: Promise<SessionFinalResult> | null = null;
  private toolCallCount = 0;
  private stdoutBytes = 0;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private _deadlineExceeded = false;
  private readonly partialErrors: ErrorPayload[] = [];

  constructor(toolRegistry: ToolRegistry, config: BrokerSessionConfig = {}) {
    this.sessionId = config.sessionId ?? generateSessionId();
    this.createdAt = Date.now();
    this.toolRegistry = toolRegistry;
    this.abortController = new AbortController();

    // Merge limits (DEFAULT_SESSION_LIMITS provides all required values)
    this.limits = {
      ...DEFAULT_SESSION_LIMITS,
      ...config.limits,
    } as Required<SessionLimits>;

    this.expiresAt = this.createdAt + this.limits.sessionTtlMs;

    // Create event emitter
    this.emitter = createSessionEmitter(this.sessionId, {
      expiresAt: new Date(this.expiresAt),
    });

    // Create enclave for runtime execution
    this.enclave = new Enclave({
      ...config.enclaveConfig,
      timeout: this.limits.toolTimeoutMs,
      maxToolCalls: this.limits.maxToolCalls,
    });
  }

  /**
   * Get current session state
   */
  get state(): SessionStateValue {
    return this._state;
  }

  /**
   * Get current sequence number
   */
  get seq(): number {
    return this.emitter.getSeq();
  }

  /**
   * Get the event emitter
   */
  get events(): SessionEmitter {
    return this.emitter;
  }

  /**
   * Subscribe to stream events
   */
  onEvent(handler: (event: StreamEvent) => void): () => void {
    return this.emitter.on(handler);
  }

  /**
   * Get all emitted events
   */
  getEvents(): StreamEvent[] {
    return this.emitter.getEmittedEvents();
  }

  /**
   * Execute code in this session
   *
   * @param code - Code to execute
   * @returns Promise that resolves when execution completes
   */
  async execute(code: string): Promise<SessionFinalResult> {
    if (this.executionPromise) {
      throw new Error('Session is already executing');
    }

    // Emit session init
    this.emitter.emitSessionInit();

    // Start heartbeat
    const heartbeatMs = this.limits.heartbeatIntervalMs;
    if (heartbeatMs > 0) {
      this.heartbeatInterval = setInterval(() => {
        if (!this.isTerminal()) {
          this.emitter.emitHeartbeat();
        }
      }, heartbeatMs);
    }

    // Set up deadline timer if configured (compute remaining from createdAt epoch)
    const deadlineMs = this.limits.deadlineMs;
    if (deadlineMs > 0) {
      const remaining = deadlineMs - (Date.now() - this.createdAt);
      if (remaining > 0) {
        this.deadlineTimer = setTimeout(() => {
          this._deadlineExceeded = true;
          this.cancel(`Deadline exceeded: ${deadlineMs}ms budget`);
        }, remaining);
      } else {
        // Deadline already passed before execution started
        this._deadlineExceeded = true;
        this.stopHeartbeat();
        this._state = 'failed';
        const elapsed = Date.now() - this.createdAt;
        this.emitter.emit(
          this.makeCustomEvent(EventType.DeadlineExceeded, { elapsedMs: elapsed, budgetMs: deadlineMs }),
        );
        this.emitter.emitFinalError(
          { code: 'DEADLINE_EXCEEDED', message: 'Deadline exceeded before execution' },
          { durationMs: elapsed, toolCallCount: 0, stdoutBytes: 0 },
        );
        const finalResult: SessionFinalResult = {
          success: false,
          error: {
            message: 'Deadline exceeded before execution',
            name: 'Error',
            code: 'DEADLINE_EXCEEDED',
          },
          stats: {
            duration: elapsed,
            toolCallCount: 0,
            iterationCount: 0,
            startTime: this.createdAt,
            endTime: Date.now(),
          },
          finalState: 'failed',
        };
        this.executionPromise = Promise.resolve(finalResult);
        return finalResult;
      }
    }

    // Transition to running
    this._state = 'running';

    // Create execution promise
    this.executionPromise = this.runExecution(code);

    return this.executionPromise;
  }

  /**
   * Run the actual execution
   */
  private async runExecution(code: string): Promise<SessionFinalResult> {
    const startTime = Date.now();
    let result: SessionFinalResult;

    try {
      // Execute in enclave with direct tool handler
      const enclaveResult = await this.enclave.run(code, async (toolName, args) => {
        // Check if cancelled
        if (this.abortController.signal.aborted) {
          throw new Error('Session cancelled');
        }

        return this.executeTool(toolName, args as Record<string, unknown>);
      });

      const endTime = Date.now();
      const stats = this.buildStats(startTime, endTime);
      const eventStats = {
        durationMs: stats.duration,
        toolCallCount: this.toolCallCount,
        stdoutBytes: this.stdoutBytes,
      };

      // Session was cancelled/terminated while enclave was running
      if (this.isTerminal()) {
        if (this._deadlineExceeded) {
          this.emitter.emit(
            this.makeCustomEvent(EventType.DeadlineExceeded, {
              elapsedMs: Date.now() - this.createdAt,
              budgetMs: this.limits.deadlineMs,
            }),
          );
        }
        const cancelError = {
          code: this._deadlineExceeded ? 'DEADLINE_EXCEEDED' : 'SESSION_CANCELLED',
          message: this._deadlineExceeded ? 'Deadline exceeded' : 'Session was cancelled',
        };
        this.emitter.emitFinalError(cancelError, eventStats, this.getPartialErrors());
        result = {
          success: false,
          error: { message: cancelError.message, name: 'Error', code: cancelError.code },
          stats,
          finalState: this._deadlineExceeded ? 'failed' : 'cancelled',
        };
      } else if (enclaveResult.success) {
        this._state = 'completed';
        this.emitter.emitFinalSuccess(enclaveResult.value, eventStats, this.getPartialErrors());
        result = {
          success: true,
          value: enclaveResult.value,
          stats,
          finalState: 'completed',
        };
      } else {
        this._state = 'failed';
        const errorInfo = {
          code: enclaveResult.error?.code ?? 'EXECUTION_ERROR',
          message: enclaveResult.error?.message ?? 'Execution failed',
        };
        this.emitter.emitFinalError(errorInfo, eventStats, this.getPartialErrors());
        result = {
          success: false,
          error: {
            message: errorInfo.message,
            name: enclaveResult.error?.name ?? 'Error',
            code: errorInfo.code,
          },
          stats,
          finalState: 'failed',
        };
      }
    } catch (error) {
      const endTime = Date.now();
      const stats = this.buildStats(startTime, endTime);
      const err = error instanceof Error ? error : new Error(String(error));
      const eventStats = {
        durationMs: stats.duration,
        toolCallCount: this.toolCallCount,
        stdoutBytes: this.stdoutBytes,
      };

      // Emit deadline exceeded if that's why we were cancelled
      if (this._deadlineExceeded) {
        this.emitter.emit(
          this.makeCustomEvent(EventType.DeadlineExceeded, {
            elapsedMs: Date.now() - this.createdAt,
            budgetMs: this.limits.deadlineMs,
          }),
        );
      }

      if (!this.isTerminal()) {
        this._state = 'failed';
      }

      const isCancelled = this._state === 'cancelled';
      const errorInfo = {
        code: isCancelled
          ? this._deadlineExceeded
            ? 'DEADLINE_EXCEEDED'
            : 'SESSION_CANCELLED'
          : ((err as Error & { code?: string }).code ?? 'EXECUTION_ERROR'),
        message: err.message,
      };
      this.emitter.emitFinalError(errorInfo, eventStats, this.getPartialErrors());
      result = {
        success: false,
        error: {
          message: err.message,
          name: err.name,
          code: errorInfo.code,
        },
        stats,
        finalState: isCancelled ? 'cancelled' : 'failed',
      };
    } finally {
      this.stopHeartbeat();
      this.stopDeadline();
    }

    return result;
  }

  /**
   * Emit a tool progress event.
   */
  emitToolProgress(
    callId: string,
    phase: 'connecting' | 'sending' | 'receiving' | 'processing',
    elapsedMs: number,
    bytesReceived?: number,
    totalBytes?: number,
  ): void {
    this.emitter.emit(
      this.makeCustomEvent(EventType.ToolProgress, {
        callId,
        phase,
        elapsedMs,
        bytesReceived,
        totalBytes,
      }),
    );
  }

  /**
   * Emit a partial result event.
   */
  emitPartialResult(path: string[], data?: unknown, error?: ErrorPayload, hasNext = true): void {
    if (error) {
      this.partialErrors.push(error);
    }
    this.emitter.emit(
      this.makeCustomEvent(EventType.PartialResult, {
        path,
        data,
        error,
        hasNext,
      }),
    );
  }

  /**
   * Get accumulated partial errors.
   */
  getPartialErrors(): ErrorPayload[] {
    return [...this.partialErrors];
  }

  /**
   * Execute a tool call directly
   */
  private async executeTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const callId = generateCallId();
    const toolStartTime = Date.now();

    // Check session deadline before emitting any events
    if (this.limits.deadlineMs > 0) {
      const elapsed = Date.now() - this.createdAt;
      const remaining = this.limits.deadlineMs - elapsed;
      if (remaining <= 0) {
        this._deadlineExceeded = true;
        const err = new Error('Deadline exceeded before tool execution');
        (err as Error & { code?: string }).code = 'DEADLINE_EXCEEDED';
        throw err;
      }
    }

    // Emit tool call event
    this.emitter.emitToolCall(callId, toolName, args);
    this.toolCallCount++;

    // Emit initial progress
    this.emitToolProgress(callId, 'connecting', 0);

    // Compute per-tool timeout, capped by remaining session budget
    let toolTimeout = this.limits.perToolDeadlineMs;
    if (this.limits.deadlineMs > 0) {
      const remaining = this.limits.deadlineMs - (Date.now() - this.createdAt);
      toolTimeout = Math.min(toolTimeout, remaining);
    }

    // Create per-tool AbortController that races the session signal and a timer
    const toolAbort = new AbortController();
    let toolTimer: ReturnType<typeof setTimeout> | null = null;
    if (toolTimeout > 0) {
      toolTimer = setTimeout(() => toolAbort.abort(), toolTimeout);
    }
    // Propagate session-level abort to per-tool controller
    const onSessionAbort = () => toolAbort.abort();
    this.abortController.signal.addEventListener('abort', onSessionAbort);
    if (this.abortController.signal.aborted) {
      toolAbort.abort();
    }

    // Execute through registry
    const context: ToolContext = {
      sessionId: this.sessionId,
      callId,
      secrets: {}, // Resolved by registry
      signal: toolAbort.signal,
    };

    // Emit processing progress
    this.emitToolProgress(callId, 'processing', Date.now() - toolStartTime);

    let result;
    try {
      result = await this.toolRegistry.execute(toolName, args, context);
    } finally {
      if (toolTimer) clearTimeout(toolTimer);
      this.abortController.signal.removeEventListener('abort', onSessionAbort);
    }

    // Emit tool result event
    this.emitter.emitToolResultApplied(callId);

    if (result.success) {
      return result.value;
    } else {
      // Check cancelOnFirstError
      if (this.limits.cancelOnFirstError) {
        this.abortController.abort();
      }

      const error = new Error(result.error?.message ?? 'Tool call failed');
      (error as Error & { code?: string }).code = result.error?.code;
      throw error;
    }
  }

  /**
   * Create a custom event with proper base fields and unique sequence number.
   */
  private makeCustomEvent(type: string, payload: Record<string, unknown>): StreamEvent {
    return {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: this.sessionId,
      seq: this.emitter.nextSeq(),
      type,
      payload,
    } as unknown as StreamEvent;
  }

  /**
   * Build execution stats
   */
  private buildStats(startTime: number, endTime: number): ExecutionStats {
    return {
      duration: endTime - startTime,
      toolCallCount: this.toolCallCount,
      iterationCount: 0,
      startTime,
      endTime,
    };
  }

  /**
   * Cancel the session
   */
  async cancel(reason?: string): Promise<void> {
    if (this.isTerminal()) {
      return;
    }

    this.stopHeartbeat();
    this.stopDeadline();
    this.abortController.abort();
    this._state = 'cancelled';

    // When execution is running, runExecution() will emit the final event
    // after catching the abort. Only emit directly if no execution is in progress.
    if (!this.executionPromise) {
      this.emitter.emitError('SESSION_CANCELLED', reason ?? 'Session was cancelled', false);
      this.emitter.emitFinalError(
        { code: 'SESSION_CANCELLED', message: reason ?? 'Session was cancelled' },
        {
          durationMs: Date.now() - this.createdAt,
          toolCallCount: this.toolCallCount,
          stdoutBytes: this.stdoutBytes,
        },
        this.getPartialErrors(),
      );
      this.executionPromise = Promise.resolve({
        success: false,
        error: {
          message: reason ?? 'Session was cancelled',
          name: 'Error',
          code: 'SESSION_CANCELLED',
        },
        stats: {
          duration: Date.now() - this.createdAt,
          toolCallCount: this.toolCallCount,
          iterationCount: 0,
          startTime: this.createdAt,
          endTime: Date.now(),
        },
        finalState: 'cancelled',
      });
    }
  }

  /**
   * Wait for the session to complete
   */
  async wait(): Promise<SessionFinalResult> {
    if (this.executionPromise) {
      return this.executionPromise;
    }
    throw new Error('Session has not started execution');
  }

  /**
   * Check if session is expired
   */
  isExpired(): boolean {
    return Date.now() > this.expiresAt;
  }

  /**
   * Check if session is in terminal state
   */
  isTerminal(): boolean {
    return this._state === 'completed' || this._state === 'cancelled' || this._state === 'failed';
  }

  /**
   * Get session statistics
   */
  getStats(): ExecutionStats {
    const now = Date.now();
    return {
      duration: this.isTerminal() ? now - this.createdAt : now - this.createdAt,
      toolCallCount: this.toolCallCount,
      iterationCount: 0,
      startTime: this.createdAt,
      endTime: this.isTerminal() ? now : 0,
    };
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
   * Stop deadline timer
   */
  private stopDeadline(): void {
    if (this.deadlineTimer) {
      clearTimeout(this.deadlineTimer);
      this.deadlineTimer = null;
    }
  }

  /**
   * Dispose of the session and its resources
   */
  dispose(): void {
    this.stopHeartbeat();
    this.stopDeadline();
    this.abortController.abort();
    this.enclave.dispose();
  }
}

/**
 * Create a new broker session
 */
export function createBrokerSession(toolRegistry: ToolRegistry, config?: BrokerSessionConfig): BrokerSession {
  return new BrokerSession(toolRegistry, config);
}
