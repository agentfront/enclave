/**
 * EnclaveClient
 *
 * Browser and Node.js client SDK for connecting to the EnclaveJS streaming runtime.
 *
 * @packageDocumentation
 */

import type { SessionId, SessionLimits, StreamEvent, FinalEvent } from '@enclave-vm/types';
import {
  generateSessionId,
  isFinalEvent,
  isSessionInitEvent,
  isStdoutEvent,
  isLogEvent,
  isToolCallEvent,
  isToolResultAppliedEvent,
  isHeartbeatEvent,
  isErrorEvent,
} from '@enclave-vm/types';
import { parseNdjsonStream, ReconnectionStateMachine, HeartbeatMonitor } from '@enclave-vm/stream';

import type {
  EnclaveClientConfig,
  ExecuteOptions,
  SessionEventHandlers,
  SessionResult,
  SessionHandle,
  SessionInfo,
} from './types.js';
import { EnclaveClientError } from './types.js';

/**
 * Default configuration values.
 */
const DEFAULT_CONFIG = {
  timeout: 60000,
  autoReconnect: true,
  maxReconnectAttempts: 3,
  reconnectDelay: 1000,
  heartbeatTimeoutMs: 30000,
} as const;

/**
 * Internal session state.
 */
interface ActiveSession {
  sessionId: SessionId;
  events: StreamEvent[];
  abortController: AbortController;
  resolve: (result: SessionResult) => void;
  reject: (error: Error) => void;
  handlers: SessionEventHandlers;
  startTime: number;
  toolCallCount: number;
  stdoutBytes: number;
  reconnectState: ReconnectionStateMachine;
  heartbeatMonitor: HeartbeatMonitor;
  lastSequence: number;
}

/**
 * EnclaveClient provides a high-level API for executing code in the EnclaveJS runtime.
 *
 * @example
 * ```ts
 * const client = new EnclaveClient({
 *   baseUrl: 'https://api.example.com',
 * });
 *
 * const result = await client.execute('return 1 + 1');
 * console.log(result.value); // 2
 * ```
 */
export class EnclaveClient {
  private readonly config: Required<Omit<EnclaveClientConfig, 'headers'>> & {
    headers?: Record<string, string>;
  };
  private readonly activeSessions = new Map<SessionId, ActiveSession>();

  /**
   * Create a new EnclaveClient instance.
   */
  constructor(config: EnclaveClientConfig) {
    // Normalize baseUrl (remove trailing slash)
    const baseUrl = config.baseUrl.replace(/\/$/, '');

    this.config = {
      baseUrl,
      headers: config.headers,
      timeout: config.timeout ?? DEFAULT_CONFIG.timeout,
      autoReconnect: config.autoReconnect ?? DEFAULT_CONFIG.autoReconnect,
      maxReconnectAttempts: config.maxReconnectAttempts ?? DEFAULT_CONFIG.maxReconnectAttempts,
      reconnectDelay: config.reconnectDelay ?? DEFAULT_CONFIG.reconnectDelay,
      fetch: config.fetch ?? globalThis.fetch.bind(globalThis),
    };
  }

  /**
   * Execute code and return the result.
   *
   * @example
   * ```ts
   * const result = await client.execute('return 1 + 1');
   * if (result.success) {
   *   console.log(result.value);
   * }
   * ```
   */
  async execute(code: string, options: ExecuteOptions & SessionEventHandlers = {}): Promise<SessionResult> {
    const handle = this.executeStream(code, options);
    return handle.wait();
  }

  /**
   * Execute code and return a session handle for streaming.
   *
   * @example
   * ```ts
   * const session = client.executeStream('return 1 + 1', {
   *   onStdout: (chunk) => console.log(chunk),
   *   onToolCall: (callId, name, args) => console.log('Tool:', name),
   * });
   *
   * const result = await session.wait();
   * ```
   */
  executeStream(code: string, options: ExecuteOptions & SessionEventHandlers = {}): SessionHandle {
    const sessionId = options.sessionId ?? generateSessionId();
    const abortController = new AbortController();

    // Combine external signal with internal abort controller
    if (options.signal) {
      options.signal.addEventListener('abort', () => {
        abortController.abort(options.signal?.reason);
      });
    }

    // Create promise for result
    let resolveResult: (result: SessionResult) => void;
    let rejectResult: (error: Error) => void;
    const resultPromise = new Promise<SessionResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    // Create reconnection state machine
    const reconnectState = new ReconnectionStateMachine({
      config: {
        maxRetries: this.config.maxReconnectAttempts,
        initialDelayMs: this.config.reconnectDelay,
      },
      onEvent: (event) => {
        if (event.type === 'retry_started') {
          // Attempt reconnection
          this.reconnectSession(sessionId);
        }
      },
    });

    // Create heartbeat monitor
    const heartbeatMonitor = new HeartbeatMonitor({
      timeoutMs: DEFAULT_CONFIG.heartbeatTimeoutMs,
      onTimeout: () => {
        // Handle heartbeat timeout - trigger reconnection if enabled
        if (this.config.autoReconnect) {
          const session = this.activeSessions.get(sessionId);
          if (session) {
            reconnectState.onDisconnected('Heartbeat timeout');
          }
        }
      },
    });

    // Store session state
    const session: ActiveSession = {
      sessionId,
      events: [],
      abortController,
      resolve: resolveResult!,
      reject: rejectResult!,
      handlers: options,
      startTime: Date.now(),
      toolCallCount: 0,
      stdoutBytes: 0,
      reconnectState,
      heartbeatMonitor,
      lastSequence: 0,
    };

    this.activeSessions.set(sessionId, session);

    // Start the session
    this.startSession(session, code, options.limits).catch((error) => {
      this.handleSessionError(sessionId, error);
    });

    // Capture reference to events array for getEvents() after completion
    const eventsRef = session.events;

    // Return handle
    return {
      sessionId,
      wait: () => resultPromise,
      cancel: async (reason?: string) => {
        await this.cancelSession(sessionId, reason);
      },
      getEvents: () => [...eventsRef],
      isActive: () => this.activeSessions.has(sessionId),
    };
  }

  /**
   * Get information about a session.
   */
  async getSession(sessionId: SessionId): Promise<SessionInfo | null> {
    const url = `${this.config.baseUrl}/sessions/${sessionId}`;

    try {
      const response = await this.config.fetch(url, {
        method: 'GET',
        headers: this.buildHeaders(),
      });

      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        throw new EnclaveClientError('SESSION_ERROR', `Failed to get session: ${response.status}`);
      }

      return (await response.json()) as SessionInfo;
    } catch (error) {
      if (error instanceof EnclaveClientError) throw error;
      throw new EnclaveClientError(
        'NETWORK_ERROR',
        'Failed to get session',
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Cancel a running session.
   */
  async cancelSession(sessionId: SessionId, reason?: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      return;
    }

    // Stop heartbeat monitoring
    session.heartbeatMonitor.stop();
    session.reconnectState.close();

    // Abort the request
    session.abortController.abort(reason);

    // Send cancel request to server
    const url = `${this.config.baseUrl}/sessions/${sessionId}/cancel`;

    try {
      await this.config.fetch(url, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({ reason }),
      });
    } catch {
      // Ignore errors - session may already be cancelled
    }

    // Complete the session
    this.completeSession(sessionId, {
      success: false,
      sessionId,
      error: { code: 'CANCELLED', message: reason ?? 'Session cancelled' },
      events: session.events,
      stats: {
        durationMs: Date.now() - session.startTime,
        toolCallCount: session.toolCallCount,
        stdoutBytes: session.stdoutBytes,
      },
    });
  }

  /**
   * Start a session and begin streaming events.
   */
  private async startSession(session: ActiveSession, code: string, limits?: Partial<SessionLimits>): Promise<void> {
    const url = `${this.config.baseUrl}/sessions`;

    // Build request body
    const body: Record<string, unknown> = {
      sessionId: session.sessionId,
      code,
    };

    if (limits) {
      body.config = {
        maxExecutionMs: limits.sessionTtlMs,
        maxToolCalls: limits.maxToolCalls,
        heartbeatIntervalMs: limits.heartbeatIntervalMs,
      };
    }

    try {
      const response = await this.config.fetch(url, {
        method: 'POST',
        headers: {
          ...this.buildHeaders(),
          'Content-Type': 'application/json',
          Accept: 'application/x-ndjson',
        },
        body: JSON.stringify(body),
        signal: session.abortController.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new EnclaveClientError('SESSION_ERROR', `Failed to start session: ${response.status} - ${errorText}`);
      }

      // Mark as connected
      session.reconnectState.onConnected();
      session.heartbeatMonitor.start();

      // Stream the response
      await this.streamResponse(session, response);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        // Session was cancelled
        return;
      }

      // Handle connection error
      if (this.config.autoReconnect && session.reconnectState.canReconnect()) {
        session.reconnectState.onDisconnected(error instanceof Error ? error.message : 'Connection lost');
        return;
      }

      throw error;
    }
  }

  /**
   * Stream and parse the NDJSON response.
   */
  private async streamResponse(session: ActiveSession, response: Response): Promise<void> {
    const body = response.body;
    if (!body) {
      throw new EnclaveClientError('PARSE_ERROR', 'No response body');
    }

    try {
      // Use the async generator to parse NDJSON stream
      for await (const event of parseNdjsonStream(body)) {
        // The generator yields validated events
        this.handleEvent(session, event as StreamEvent);
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return;
      }

      // Handle stream error
      if (this.config.autoReconnect && session.reconnectState.canReconnect()) {
        session.reconnectState.onDisconnected(error instanceof Error ? error.message : 'Stream error');
        return;
      }

      throw error;
    }
  }

  /**
   * Handle a received stream event.
   */
  private handleEvent(session: ActiveSession, event: StreamEvent): void {
    // Track sequence
    if (event.seq !== undefined) {
      session.lastSequence = event.seq;
    }

    // Store event
    session.events.push(event);

    // Call general event handler
    session.handlers.onEvent?.(event);

    // Route to specific handlers
    if (isSessionInitEvent(event)) {
      session.handlers.onSessionInit?.(event);
    } else if (isStdoutEvent(event)) {
      session.stdoutBytes += event.payload.chunk.length;
      session.handlers.onStdout?.(event.payload.chunk);
    } else if (isLogEvent(event)) {
      session.handlers.onLog?.(event.payload.level, event.payload.message, event.payload.data);
    } else if (isToolCallEvent(event)) {
      session.toolCallCount++;
      session.handlers.onToolCall?.(event.payload.callId, event.payload.toolName, event.payload.args);
    } else if (isToolResultAppliedEvent(event)) {
      session.handlers.onToolResultApplied?.(event.payload.callId);
    } else if (isHeartbeatEvent(event)) {
      session.heartbeatMonitor.onHeartbeat();
      session.handlers.onHeartbeat?.();
    } else if (isErrorEvent(event)) {
      session.handlers.onError?.(event.payload.code ?? 'UNKNOWN', event.payload.message);
    } else if (isFinalEvent(event)) {
      this.handleFinalEvent(session, event);
    }
  }

  /**
   * Handle the final event and complete the session.
   */
  private handleFinalEvent(session: ActiveSession, event: FinalEvent): void {
    session.heartbeatMonitor.stop();
    session.reconnectState.close();

    const result: SessionResult = {
      success: event.payload.ok,
      sessionId: session.sessionId,
      events: session.events,
      stats: {
        durationMs: Date.now() - session.startTime,
        toolCallCount: session.toolCallCount,
        stdoutBytes: session.stdoutBytes,
      },
    };

    if (event.payload.ok) {
      result.value = event.payload.result;
    } else {
      result.error = {
        code: event.payload.error?.code,
        message: event.payload.error?.message ?? 'Unknown error',
      };
    }

    this.completeSession(session.sessionId, result);
  }

  /**
   * Handle a session error.
   */
  private handleSessionError(sessionId: SessionId, error: unknown): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    session.heartbeatMonitor.stop();
    session.reconnectState.close();

    const clientError =
      error instanceof EnclaveClientError
        ? error
        : new EnclaveClientError(
            'NETWORK_ERROR',
            error instanceof Error ? error.message : 'Unknown error',
            error instanceof Error ? error : undefined,
          );

    this.completeSession(sessionId, {
      success: false,
      sessionId,
      error: { code: clientError.code, message: clientError.message },
      events: session.events,
      stats: {
        durationMs: Date.now() - session.startTime,
        toolCallCount: session.toolCallCount,
        stdoutBytes: session.stdoutBytes,
      },
    });
  }

  /**
   * Complete a session and clean up.
   */
  private completeSession(sessionId: SessionId, result: SessionResult): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    this.activeSessions.delete(sessionId);
    session.resolve(result);
  }

  /**
   * Attempt to reconnect a session.
   */
  private async reconnectSession(sessionId: SessionId): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    // Request replay from last known sequence
    const url = `${this.config.baseUrl}/sessions/${sessionId}/stream`;
    const params = new URLSearchParams();
    if (session.lastSequence > 0) {
      params.set('from', String(session.lastSequence + 1));
    }

    try {
      const response = await this.config.fetch(`${url}?${params}`, {
        method: 'GET',
        headers: {
          ...this.buildHeaders(),
          Accept: 'application/x-ndjson',
        },
        signal: session.abortController.signal,
      });

      if (!response.ok) {
        throw new EnclaveClientError('RECONNECT_FAILED', `Reconnection failed: ${response.status}`);
      }

      session.reconnectState.onConnected();
      session.heartbeatMonitor.start();

      await this.streamResponse(session, response);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return;
      }

      if (session.reconnectState.canReconnect()) {
        session.reconnectState.onDisconnected(error instanceof Error ? error.message : 'Reconnection failed');
      } else {
        this.handleSessionError(sessionId, error);
      }
    }
  }

  /**
   * Build request headers.
   */
  private buildHeaders(): Record<string, string> {
    return {
      ...this.config.headers,
    };
  }
}
