/**
 * Session Executor
 *
 * Wraps enclave-vm session for runtime execution.
 *
 * @packageDocumentation
 */

import type { SessionId, CallId, SessionLimits } from '@enclavejs/types';
import { createSession, Session } from 'enclave-vm';
import type { RuntimeChannel, RuntimeSession } from './types';

/**
 * Session executor options
 */
export interface SessionExecutorOptions {
  /**
   * Session ID
   */
  sessionId?: SessionId;

  /**
   * Code to execute
   */
  code: string;

  /**
   * Session limits
   */
  limits?: Partial<SessionLimits>;

  /**
   * Communication channel
   */
  channel: RuntimeChannel;

  /**
   * Debug mode
   */
  debug?: boolean;
}

/**
 * Session executor
 *
 * Manages execution of a single session, handling communication
 * between the enclave-vm session and the runtime channel.
 */
export class SessionExecutor {
  readonly sessionId: SessionId;
  private readonly session: Session;
  private readonly channel: RuntimeChannel;
  private readonly code: string;
  private readonly debug: boolean;
  private unsubscribe: (() => void) | null = null;
  private executing = false;

  constructor(options: SessionExecutorOptions) {
    const { code, channel, limits, debug = false } = options;

    this.code = code;
    this.channel = channel;
    this.debug = debug;

    // Create session with provided ID
    this.session = createSession({
      sessionId: options.sessionId,
      ttlMs: limits?.sessionTtlMs,
      config: {
        limits,
      },
      toolHandler: async (callId, toolName, args) => {
        // Tool calls are forwarded via events
        // The broker will handle them and send back results
        this.log(`Tool call: ${toolName}(${JSON.stringify(args)})`);
      },
    });

    this.sessionId = this.session.sessionId;

    // Forward session events to channel
    this.unsubscribe = this.session.events.on((event) => {
      if (this.channel.isOpen) {
        this.channel.send(event);
      }
    });
  }

  /**
   * Get session info
   */
  getInfo(): RuntimeSession {
    return {
      sessionId: this.sessionId,
      state: this.session.state,
      createdAt: this.session.createdAt,
      expiresAt: this.session.expiresAt,
    };
  }

  /**
   * Get current state
   */
  get state(): string {
    return this.session.state;
  }

  /**
   * Check if session is in terminal state
   */
  get isTerminal(): boolean {
    const state = this.session.state;
    return state === 'completed' || state === 'cancelled' || state === 'failed';
  }

  /**
   * Execute the code
   */
  async execute(): Promise<void> {
    if (this.executing) {
      throw new Error('Session is already executing');
    }

    this.executing = true;

    try {
      this.log(`Starting execution for session ${this.sessionId}`);

      // Start the session
      this.session.start();

      // Note: In a real implementation, we would need to:
      // 1. Parse and execute the code in the enclave
      // 2. Handle tool calls by waiting for tool_result messages
      //
      // For now, we simulate basic execution
      // The actual execution is handled by enclave-vm internally

      // Wait for completion
      const result = await this.session.wait();

      this.log(`Session ${this.sessionId} completed: ${result.finalState}`);
    } catch (error) {
      this.log(`Session ${this.sessionId} error: ${error}`);
      throw error;
    } finally {
      this.executing = false;
    }
  }

  /**
   * Submit a tool result
   */
  async submitToolResult(
    callId: CallId,
    success: boolean,
    value?: unknown,
    error?: { code?: string; message: string },
  ): Promise<void> {
    await this.session.submitToolResult({
      callId,
      success,
      value,
      error,
    });
  }

  /**
   * Cancel the session
   */
  async cancel(reason?: string): Promise<void> {
    await this.session.cancel(reason);
  }

  /**
   * Dispose of the executor
   */
  dispose(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  /**
   * Log debug message
   */
  private log(message: string): void {
    if (this.debug) {
      console.log(`[SessionExecutor] ${message}`);
    }
  }
}

/**
 * Create a session executor
 */
export function createSessionExecutor(options: SessionExecutorOptions): SessionExecutor {
  return new SessionExecutor(options);
}
