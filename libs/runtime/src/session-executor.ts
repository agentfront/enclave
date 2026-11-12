/**
 * Session Executor
 *
 * Wraps an enclave-vm session and forwards its events to a runtime channel.
 *
 * It does not execute code: no execution engine is wired into this package. `execute()`
 * says so (see `RuntimeNotImplementedError`).
 *
 * @packageDocumentation
 */

import type { SessionId, CallId, SessionLimits } from '@enclave-vm/types';
import { createSession, Session } from '@enclave-vm/core';
import type { RuntimeChannel, RuntimeSession } from './types';

/**
 * Thrown by the operations of this package that are not implemented.
 *
 * `@enclave-vm/runtime` has the session bookkeeping and the channels of a runtime worker, but
 * nothing in it runs a script. Scripts are run by `@enclave-vm/broker` (sessions, tools and
 * streaming over HTTP) and `@enclave-vm/core` (the sandbox).
 */
export class RuntimeNotImplementedError extends Error {
  readonly code = 'NOT_IMPLEMENTED';

  constructor(operation: string) {
    super(
      `${operation} is not implemented: @enclave-vm/runtime does not execute code. ` +
        'Run scripts with @enclave-vm/broker or @enclave-vm/core.',
    );
    this.name = 'RuntimeNotImplementedError';
  }
}

/**
 * Session executor options
 */
export interface SessionExecutorOptions {
  /**
   * Session ID
   */
  sessionId?: SessionId;

  /**
   * Code of the session. It is kept and never run: see `SessionExecutor.execute()`.
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
 * Holds one session and forwards its events to the runtime channel. Cancelling and tool
 * results go to the session; executing the session's code is not implemented.
 */
export class SessionExecutor {
  readonly sessionId: SessionId;
  private readonly session: Session;
  private readonly channel: RuntimeChannel;
  private readonly code: string;
  private readonly debug: boolean;
  private unsubscribe: (() => void) | null = null;

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
   * Execute the code: not implemented.
   *
   * Nothing in this package runs a script. Rather than report a running session that never
   * finishes, the session is ended with the error code `NOT_IMPLEMENTED` (the channel
   * receives its `final` event) and the returned promise rejects.
   *
   * @throws RuntimeNotImplementedError always
   */
  async execute(): Promise<void> {
    const error = new RuntimeNotImplementedError('SessionExecutor.execute()');

    if (!this.isTerminal) {
      this.log(`Session ${this.sessionId} cannot be executed: ${error.message} (${this.code.length} characters)`);

      // A well-formed session for the other end of the channel: init, then the final error
      if (this.session.state === 'starting') {
        this.session.start();
      }
      this.session.fail(error);
    }

    throw error;
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
