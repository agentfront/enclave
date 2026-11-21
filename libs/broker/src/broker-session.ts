/**
 * Broker Session
 *
 * Manages an individual execution session with runtime integration.
 *
 * @packageDocumentation
 */

import type { SessionId, StreamEvent, SessionLimits, ErrorPayload } from '@enclave-vm/types';
import { generateSessionId, generateCallId, EventType, PROTOCOL_VERSION } from '@enclave-vm/types';
import { SessionEmitter, Enclave, REFERENCE_CONFIGS } from '@enclave-vm/core';
import type { SessionStateValue, SessionFinalResult, CreateEnclaveOptions, ExecutionStats } from '@enclave-vm/core';
import type { ToolRegistry, ToolContext, ToolExecutionResult } from './tool-registry';
import { resolveSessionLimits, timerDelay } from './limits';
import { BoundedSessionEmitter } from './session-history';
import type { SessionHistoryLimits } from './session-history';

/**
 * What the sandbox allows for one tool request or response when the embedder sets nothing
 * (`toolBridge.maxPayloadBytes` of the Enclave options).
 */
const DEFAULT_BRIDGE_PAYLOAD_BYTES = 5 * 1024 * 1024;

/**
 * Whether a tool result is plain data: primitives, arrays, and objects whose prototype is the
 * plain object's or null, all the way down, without the keys the bridge's copy leaves out. The
 * bridge copies a result before it measures it, and only of plain data is that copy the result's
 * own JSON text; anything else (an Error, a Map, a Date, an instance of a class) the session
 * leaves to the bridge.
 */
function isPlainData(value: unknown): boolean {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current !== 'object') continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      // By index, as the bridge's copy reads it: an array's own iterator is not called
      const length = current.length;
      for (let index = 0; index < length; index++) pending.push(current[index]);
      continue;
    }
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) return false;
    for (const key of Object.keys(current)) {
      if (key === '__proto__' || key === 'constructor') return false;
      pending.push((current as Record<string, unknown>)[key]);
    }
  }
  return true;
}

/** The bytes the string bridge's response adds around a result: `{"v":1,"ok":true,"value":` and `}`. */
const BRIDGE_RESPONSE_ENVELOPE_BYTES = JSON.stringify({ v: 1, ok: true, value: 0 }).length - 1;

/**
 * Broker session configuration
 */
export interface BrokerSessionConfig {
  /**
   * Session ID (generated if not provided)
   */
  sessionId?: SessionId;

  /**
   * Session resource limits. A field that is not given keeps the value of the broker's
   * configuration, or the package default.
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

  /**
   * Bounds of the events the session keeps for a replay. When a bound is reached the oldest
   * events are dropped.
   * @default { maxEvents: 10000, maxBytes: 4194304 }
   */
  history?: SessionHistoryLimits;

  /**
   * The caller this session belongs to. The HTTP routes set it from their `identify` hook and
   * answer for a session only to its owner. A session created in process has no owner unless
   * one is given here, and is then not reachable over routes that identify their callers.
   */
  owner?: string;
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
  /**
   * The caller this session belongs to, if any.
   */
  readonly owner?: string;

  private readonly emitter: BoundedSessionEmitter;
  private readonly toolRegistry: ToolRegistry;
  private readonly enclave: Enclave;
  private readonly abortController: AbortController;
  private readonly limits: Required<SessionLimits>;
  private readonly checkResultSize: boolean;
  /** The payload limit of the sandbox's string bridge; undefined when the bridge is not used. */
  private readonly bridgePayloadBytes: number | undefined;
  /**
   * The size from which the sandbox's sidecar holds a string result as a reference (measured by
   * the bridge after that); undefined without a sidecar.
   */
  private readonly sidecarExtractionBytes: number | undefined;
  private _state: SessionStateValue = 'starting';
  private executionPromise: Promise<SessionFinalResult> | null = null;
  private toolCallCount = 0;
  private stdoutBytes = 0;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private lifetimeTimer: ReturnType<typeof setTimeout> | null = null;
  private _deadlineExceeded = false;
  private readonly partialErrors: ErrorPayload[] = [];

  constructor(toolRegistry: ToolRegistry, config: BrokerSessionConfig = {}) {
    this.sessionId = config.sessionId ?? generateSessionId();
    if (config.owner !== undefined) {
      if (typeof config.owner !== 'string' || config.owner.length === 0) {
        throw new TypeError('Session owner must be a non-empty string');
      }
      this.owner = config.owner;
    }
    this.createdAt = Date.now();
    this.toolRegistry = toolRegistry;
    this.abortController = new AbortController();

    // The given limits over the package defaults; a limit of the wrong type is refused here,
    // before it reaches a timer or the configuration of the sandbox.
    this.limits = resolveSessionLimits(config.limits);

    // The sandbox bounds a tool result by its own payload limit. The session checks the size
    // itself only where its limit is the lower one, or where the sandbox does not serialize.
    const bridge = config.enclaveConfig?.toolBridge;
    this.checkResultSize =
      (bridge?.mode ?? 'string') !== 'string' ||
      this.limits.maxToolResultBytes < (bridge?.maxPayloadBytes ?? DEFAULT_BRIDGE_PAYLOAD_BYTES);
    this.bridgePayloadBytes =
      (bridge?.mode ?? 'string') === 'string' ? (bridge?.maxPayloadBytes ?? DEFAULT_BRIDGE_PAYLOAD_BYTES) : undefined;
    const sidecar = config.enclaveConfig?.sidecar;
    this.sidecarExtractionBytes = sidecar?.enabled
      ? (sidecar.extractionThreshold ??
        REFERENCE_CONFIGS[config.enclaveConfig?.securityLevel ?? 'STANDARD'].extractionThreshold)
      : undefined;

    this.expiresAt = this.createdAt + this.limits.sessionTtlMs;

    // Create event emitter; it keeps a bounded history for replays
    this.emitter = new BoundedSessionEmitter(
      {
        sessionId: this.sessionId,
        cancelUrl: `/sessions/${this.sessionId}/cancel`,
        expiresAt: new Date(this.expiresAt).toISOString(),
      },
      config.history,
    );

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
   * Get the events the session keeps: all of them, or the most recent ones once a bound of
   * the history was reached (see `firstReplayableSeq`)
   */
  getEvents(): StreamEvent[] {
    return this.emitter.getEmittedEvents();
  }

  /**
   * The lowest sequence number from which every event is still kept. It is 1 until the history
   * reaches a bound; from then on, events below it cannot be replayed.
   */
  get firstReplayableSeq(): number {
    return this.emitter.firstReplayableSeq;
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

    // A listener may have cancelled the session on its first event: nothing is started then
    if (this.executionPromise) {
      return this.executionPromise;
    }

    // Start heartbeat
    const heartbeatMs = this.limits.heartbeatIntervalMs;
    if (heartbeatMs > 0) {
      this.heartbeatInterval = setInterval(() => {
        if (!this.isTerminal()) {
          this.emitter.emitHeartbeat();
        }
      }, timerDelay(heartbeatMs));
    }

    // The lifetime of the session (sessionTtlMs; for an HTTP session, the maxExecutionMs of its
    // request) ends work that is still running when it is reached, not only at the next cleanup
    // Set up deadline timer if configured (compute remaining from createdAt epoch)
    const deadlineMs = this.limits.deadlineMs;
    if (deadlineMs > 0) {
      const remaining = deadlineMs - (Date.now() - this.createdAt);
      if (remaining > 0) {
        this.deadlineTimer = setTimeout(() => {
          this._deadlineExceeded = true;
          this.cancel(`Deadline exceeded: ${deadlineMs}ms budget`);
        }, timerDelay(remaining));
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

    const lifetimeLeft = this.expiresAt - Date.now();
    this.lifetimeTimer = setTimeout(
      () => {
        if (!this.isTerminal()) this.cancel('Session lifetime exceeded');
      },
      timerDelay(Math.max(0, lifetimeLeft)),
    );

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
      const enclaveResult = await this.enclave.run(
        code,
        async (toolName, args) => {
          // Check if cancelled
          if (this.abortController.signal.aborted) {
            throw new Error('Session cancelled');
          }

          return this.executeTool(toolName, args as Record<string, unknown>);
        },
        {
          maxToolResultBytes:
            this.checkResultSize &&
            Number.isFinite(this.limits.maxToolResultBytes) &&
            this.limits.maxToolResultBytes > 0
              ? this.limits.maxToolResultBytes
              : undefined,
          onToolBridgeFailure: () => {
            if (this.limits.cancelOnFirstError) this.abortController.abort();
          },
        },
      );

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

    // Emit tool call event. The event holds its own copy of the arguments: it is what was
    // sent, whatever the handler does with the object it is given.
    const snapshot = snapshotArguments(args);
    this.emitter.nextEventSize = snapshot.size + TOOL_CALL_EVENT_OVERHEAD_BYTES;
    this.emitter.emitToolCall(callId, toolName, snapshot.copy);
    this.toolCallCount++;

    // Emit initial progress
    this.emitToolProgress(callId, 'connecting', 0);

    // Compute per-tool timeout: the session's default or the tool's own (`ToolConfig.timeout`),
    // whichever is lower, capped by remaining session budget
    let toolTimeout = this.limits.perToolDeadlineMs;
    const ownTimeout = this.toolRegistry.get(toolName)?.config?.timeout;
    if (typeof ownTimeout === 'number' && ownTimeout > 0) {
      toolTimeout = toolTimeout > 0 ? Math.min(toolTimeout, ownTimeout) : ownTimeout;
    }
    if (this.limits.deadlineMs > 0) {
      const remaining = this.limits.deadlineMs - (Date.now() - this.createdAt);
      toolTimeout = Math.min(toolTimeout, remaining);
    }

    // Create per-tool AbortController that races the session signal and a timer
    const toolAbort = new AbortController();
    let toolTimer: ReturnType<typeof setTimeout> | null = null;
    if (toolTimeout > 0) {
      toolTimer = setTimeout(() => toolAbort.abort(), timerDelay(toolTimeout));
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

    let result: ToolExecutionResult;
    try {
      result = await this.toolRegistry.execute(toolName, args, context);
    } finally {
      if (toolTimer) clearTimeout(toolTimer);
      this.abortController.signal.removeEventListener('abort', onSessionAbort);
    }

    // A result above the session's limit, or above what the sandbox's bridge carries, is a failed
    // call. The second is seen here as well, so that cancelOnFirstError applies to it: the bridge
    // would refuse the result after this method returned, where the session does not see it.
    if (result.success) {
      const refusal = this.resultRefusal(result.value);
      if (refusal) {
        result = { success: false, error: refusal, durationMs: result.durationMs };
      }
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
   * Why a tool result is refused, or undefined: over `limits.maxToolResultBytes`, or over the
   * payload limit of the sandbox's string bridge (with the bytes of its response envelope),
   * measured as serialized JSON.
   */
  private resultRefusal(value: unknown): { code: string; message: string } | undefined {
    const limit = this.limits.maxToolResultBytes;
    const checkOwn = this.checkResultSize && limit > 0 && limit !== Infinity;
    if (!checkOwn && this.bridgePayloadBytes === undefined) return undefined;
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(value);
    } catch {
      // Not serializable: the sandbox's own bridge decides what happens to it.
      return undefined;
    }
    if (serialized === undefined) return undefined;
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (checkOwn && bytes > limit) {
      return { code: 'TOOL_RESULT_TOO_LARGE', message: `Tool result exceeds the limit of ${limit} bytes` };
    }
    // A string the sidecar holds as a reference crosses the bridge as the reference: the bridge
    // measures it after that, and so is not asked here.
    const heldBySidecar =
      typeof value === 'string' &&
      this.sidecarExtractionBytes !== undefined &&
      Buffer.byteLength(value, 'utf8') >= this.sidecarExtractionBytes;
    if (
      !heldBySidecar &&
      this.bridgePayloadBytes !== undefined &&
      bytes + BRIDGE_RESPONSE_ENVELOPE_BYTES > this.bridgePayloadBytes &&
      isPlainData(value)
    ) {
      return {
        code: 'TOOL_BRIDGE_RESPONSE_TOO_LARGE',
        message: `Tool response exceeds maximum size (${this.bridgePayloadBytes} bytes)`,
      };
    }
    return undefined;
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
    if (this.lifetimeTimer) {
      clearTimeout(this.lifetimeTimer);
      this.lifetimeTimer = null;
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
 * Serialized size of a tool call event without its arguments (an upper estimate).
 */
const TOOL_CALL_EVENT_OVERHEAD_BYTES = 256;

/**
 * A copy of tool arguments as they appear in an event, with its serialized size. Arguments
 * that cannot be serialized appear as an empty object.
 */
function snapshotArguments(args: unknown): { copy: Record<string, unknown>; size: number } {
  try {
    const serialized = JSON.stringify(args);
    if (serialized !== undefined) {
      return {
        copy: JSON.parse(serialized) as Record<string, unknown>,
        size: Buffer.byteLength(serialized, 'utf8'),
      };
    }
  } catch {
    // Not serializable
  }
  return { copy: {}, size: 2 };
}

/**
 * Create a new broker session
 */
export function createBrokerSession(toolRegistry: ToolRegistry, config?: BrokerSessionConfig): BrokerSession {
  return new BrokerSession(toolRegistry, config);
}
