/**
 * Broker Session
 *
 * Manages an individual execution session with runtime integration.
 *
 * @packageDocumentation
 */

import type { SessionId, StreamEvent, SessionLimits } from '@enclave-vm/types';
import { generateSessionId, generateCallId, DEFAULT_SESSION_LIMITS } from '@enclave-vm/types';
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

      if (enclaveResult.success) {
        this._state = 'completed';
        this.emitter.emitFinalSuccess(enclaveResult.value, {
          durationMs: stats.duration,
          toolCallCount: this.toolCallCount,
          stdoutBytes: this.stdoutBytes,
        });
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
        this.emitter.emitFinalError(errorInfo, {
          durationMs: stats.duration,
          toolCallCount: this.toolCallCount,
          stdoutBytes: this.stdoutBytes,
        });
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

      this._state = 'failed';
      const errorInfo = {
        code: (err as Error & { code?: string }).code ?? 'EXECUTION_ERROR',
        message: err.message,
      };
      this.emitter.emitFinalError(errorInfo, {
        durationMs: stats.duration,
        toolCallCount: this.toolCallCount,
        stdoutBytes: this.stdoutBytes,
      });
      result = {
        success: false,
        error: {
          message: err.message,
          name: err.name,
          code: errorInfo.code,
        },
        stats,
        finalState: 'failed',
      };
    } finally {
      this.stopHeartbeat();
    }

    return result;
  }

  /**
   * Execute a tool call directly
   */
  private async executeTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const callId = generateCallId();

    // Emit tool call event
    this.emitter.emitToolCall(callId, toolName, args);
    this.toolCallCount++;

    // Execute through registry
    const context: ToolContext = {
      sessionId: this.sessionId,
      callId,
      secrets: {}, // Resolved by registry
      signal: this.abortController.signal,
    };

    const result = await this.toolRegistry.execute(toolName, args, context);

    // Emit tool result event
    this.emitter.emitToolResultApplied(callId);

    if (result.success) {
      return result.value;
    } else {
      const error = new Error(result.error?.message ?? 'Tool call failed');
      (error as Error & { code?: string }).code = result.error?.code;
      throw error;
    }
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
    this.abortController.abort();
    this._state = 'cancelled';

    this.emitter.emitError('SESSION_CANCELLED', reason ?? 'Session was cancelled', false);

    this.emitter.emitFinalError(
      { code: 'SESSION_CANCELLED', message: reason ?? 'Session was cancelled' },
      {
        durationMs: Date.now() - this.createdAt,
        toolCallCount: this.toolCallCount,
        stdoutBytes: this.stdoutBytes,
      },
    );
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
   * Dispose of the session and its resources
   */
  dispose(): void {
    this.stopHeartbeat();
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
