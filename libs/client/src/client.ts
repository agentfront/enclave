/**
 * EnclaveClient
 *
 * Browser and Node.js client SDK for connecting to the EnclaveJS streaming runtime.
 *
 * @packageDocumentation
 */

import type { SessionId, SessionLimits, StreamEvent, FinalEvent } from '@enclave-vm/types';
import {
  DEFAULT_SESSION_LIMITS,
  SESSION_ID_PREFIX,
  generateSessionId,
  isFinalEvent,
  isSessionInitEvent,
  isStdoutEvent,
  isLogEvent,
  isToolCallEvent,
  isToolResultAppliedEvent,
  isHeartbeatEvent,
  isErrorEvent,
  isPartialResultEvent,
  isToolProgressEvent,
  isDeadlineExceededEvent,
  isCatalogChangedEvent,
} from '@enclave-vm/types';
import {
  ConnectionState,
  DEFAULT_MAX_LINE_LENGTH,
  NdjsonLineTooLongError,
  ReconnectionStateMachine,
  parseNdjsonStream,
} from '@enclave-vm/stream';

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
  maxEventLength: DEFAULT_MAX_LINE_LENGTH,
} as const;

/**
 * The options this client implements. Any other key is refused by the constructor.
 */
const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'baseUrl',
  'headers',
  'timeout',
  'autoReconnect',
  'maxReconnectAttempts',
  'reconnectDelay',
  'maxEventLength',
  'fetch',
]);

/**
 * What to use instead of an option that this client does not have.
 */
const UNIMPLEMENTED_OPTION_HINTS: Readonly<Record<string, string>> = {
  encryption:
    'This client does not encrypt: requests and events travel as plain JSON, protected only by the ' +
    'transport. Use an https: baseUrl.',
  auth: 'Send credentials with the `headers` option.',
  serverUrl: 'The option is called `baseUrl`.',
  reconnect: 'Use `autoReconnect`, `maxReconnectAttempts` and `reconnectDelay`.',
};

/**
 * One connection of a session: the request that opened it and the stream it carries.
 */
interface Connection {
  controller: AbortController;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Internal session state.
 */
interface ActiveSession {
  sessionId: SessionId;
  events: StreamEvent[];
  resolve: (result: SessionResult) => void;
  handlers: SessionEventHandlers;
  startTime: number;
  toolCallCount: number;
  stdoutBytes: number;
  reconnectState: ReconnectionStateMachine;
  /** Sequence number of the last event delivered; -1 before the first one. */
  lastSequence: number;
  /** Longest silence accepted on an open stream, in milliseconds. */
  silenceMs: number;
  /** The one open connection of the session, if any. */
  connection: Connection | null;
  /** Set when the session has its result. Nothing is delivered after that. */
  ended: boolean;
  /** Removes the listener on the caller's abort signal. */
  detachSignal: () => void;
}

function invalidConfig(message: string): never {
  throw new TypeError(`EnclaveClient: ${message}`);
}

/**
 * Check a configuration and fill in the defaults.
 *
 * An option that is not implemented is refused, not ignored: an application that asks for a
 * protection must not go on without it unnoticed.
 */
function resolveConfig(config: EnclaveClientConfig): Required<Omit<EnclaveClientConfig, 'headers'>> & {
  headers?: Record<string, string>;
} {
  if (typeof config !== 'object' || config === null) {
    invalidConfig('a configuration object with `baseUrl` is required');
  }

  for (const key of Object.keys(config)) {
    if (CONFIG_KEYS.has(key) || (config as unknown as Record<string, unknown>)[key] === undefined) continue;
    const hint = UNIMPLEMENTED_OPTION_HINTS[key];
    invalidConfig(`unknown option "${key}".${hint ? ` ${hint}` : ''}`);
  }

  if (typeof config.baseUrl !== 'string' || config.baseUrl.length === 0) {
    invalidConfig('`baseUrl` must be a non-empty string');
  }

  if (config.headers !== undefined) {
    const headers: unknown = config.headers;
    if (
      typeof headers !== 'object' ||
      headers === null ||
      Array.isArray(headers) ||
      Object.values(headers).some((value) => typeof value !== 'string')
    ) {
      invalidConfig('`headers` must be an object of strings');
    }
  }

  const duration = (name: 'timeout' | 'reconnectDelay', minimum: number): number => {
    const value: unknown = config[name];
    if (value === undefined) return DEFAULT_CONFIG[name];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
      invalidConfig(`\`${name}\` must be a number of milliseconds${minimum > 0 ? ' above zero' : ', zero or more'}`);
    }
    return value;
  };

  const count = (name: 'maxReconnectAttempts' | 'maxEventLength', minimum: number): number => {
    const value: unknown = config[name];
    if (value === undefined) return DEFAULT_CONFIG[name];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
      invalidConfig(`\`${name}\` must be an integer of ${minimum} or more`);
    }
    return value;
  };

  if (config.autoReconnect !== undefined && typeof config.autoReconnect !== 'boolean') {
    invalidConfig('`autoReconnect` must be a boolean');
  }

  if (config.fetch !== undefined && typeof config.fetch !== 'function') {
    invalidConfig('`fetch` must be a function');
  }
  if (config.fetch === undefined && typeof globalThis.fetch !== 'function') {
    invalidConfig('no global fetch is available; pass one with the `fetch` option');
  }

  return {
    // Normalize baseUrl (remove trailing slash)
    baseUrl: config.baseUrl.replace(/\/$/, ''),
    headers: config.headers,
    timeout: duration('timeout', 1),
    autoReconnect: config.autoReconnect ?? DEFAULT_CONFIG.autoReconnect,
    maxReconnectAttempts: count('maxReconnectAttempts', 0),
    reconnectDelay: duration('reconnectDelay', 0),
    maxEventLength: count('maxEventLength', 1),
    fetch: config.fetch ?? globalThis.fetch.bind(globalThis),
  };
}

/**
 * The path segment for a session id, or null when the value is not a session id.
 *
 * A session id is a string that starts with the protocol's prefix. It is always encoded, so
 * whatever it contains it stays one segment of the request path and adds no query.
 */
function sessionPathSegment(sessionId: unknown): string | null {
  if (
    typeof sessionId !== 'string' ||
    !sessionId.startsWith(SESSION_ID_PREFIX) ||
    sessionId.length <= SESSION_ID_PREFIX.length
  ) {
    return null;
  }
  try {
    return encodeURIComponent(sessionId);
  } catch {
    // Not valid Unicode: it has no encoding
    return null;
  }
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
   *
   * @throws TypeError when the configuration has an option this client does not implement
   *   (for example `encryption` or `auth`) or a value it cannot use
   */
  constructor(config: EnclaveClientConfig) {
    this.config = resolveConfig(config);
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

    // Create promise for result
    let resolveResult: (result: SessionResult) => void;
    const resultPromise = new Promise<SessionResult>((resolve) => {
      resolveResult = resolve;
    });

    // Store session state
    const session: ActiveSession = {
      sessionId,
      events: [],
      resolve: resolveResult!,
      handlers: options,
      startTime: Date.now(),
      toolCallCount: 0,
      stdoutBytes: 0,
      // Create reconnection state machine
      reconnectState: new ReconnectionStateMachine({
        config: {
          maxRetries: this.config.maxReconnectAttempts,
          initialDelayMs: this.config.reconnectDelay,
        },
        onEvent: (event) => {
          if (event.type === 'retry_started') {
            // Attempt reconnection
            void this.reconnectSession(session);
          }
        },
      }),
      lastSequence: -1,
      // The server sends a heartbeat at the interval the session asked for. Two intervals
      // without any event, and at least `timeout`, is a stream that has gone silent.
      silenceMs: Math.max(
        this.config.timeout,
        2 * (options.limits?.heartbeatIntervalMs ?? DEFAULT_SESSION_LIMITS.heartbeatIntervalMs),
      ),
      connection: null,
      ended: false,
      detachSignal: () => undefined,
    };

    // Return handle
    const handle: SessionHandle = {
      sessionId,
      wait: () => resultPromise,
      cancel: async (reason?: string) => {
        await this.stopSession(session, reason);
      },
      getEvents: () => [...session.events],
      isActive: () => !session.ended && this.activeSessions.get(sessionId) === session,
    };

    // A session that cannot be requested safely gets its result without a request.
    if (sessionPathSegment(sessionId) === null) {
      this.refuseSession(session, 'Invalid session id');
      return handle;
    }
    if (this.activeSessions.has(sessionId)) {
      this.refuseSession(session, `Session ${sessionId} is already running on this client`);
      return handle;
    }

    this.activeSessions.set(sessionId, session);

    // An abort of the caller's signal stops the session like cancel() does.
    const signal = options.signal;
    if (signal) {
      const reasonOf = (): string | undefined => (typeof signal.reason === 'string' ? signal.reason : undefined);
      if (signal.aborted) {
        this.endSession(session, this.cancelledResult(session, reasonOf()));
        return handle;
      }
      const onAbort = () => {
        void this.stopSession(session, reasonOf());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      session.detachSignal = () => signal.removeEventListener('abort', onAbort);
    }

    // Start the session
    void this.startSession(session, code, options.limits);

    return handle;
  }

  /**
   * Get information about a session.
   */
  async getSession(sessionId: SessionId): Promise<SessionInfo | null> {
    const segment = sessionPathSegment(sessionId);
    if (segment === null) {
      throw new EnclaveClientError('SESSION_ERROR', 'Invalid session id');
    }
    const url = `${this.config.baseUrl}/sessions/${segment}`;

    try {
      return await this.withDeadline('Getting the session', async (signal) => {
        const response = await this.config.fetch(url, {
          method: 'GET',
          headers: this.buildHeaders(),
          signal,
        });

        if (response.status === 404) {
          return null;
        }

        if (!response.ok) {
          throw new EnclaveClientError('SESSION_ERROR', `Failed to get session: ${response.status}`);
        }

        return (await response.json()) as SessionInfo;
      });
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
   *
   * The session of this client ends as `CANCELLED`, and the server is asked to end the session
   * (`DELETE /sessions/:sessionId`). When the server does not confirm that, the session's
   * `onError` handler is called with the code `CANCEL_FAILED`: the script may still be running.
   */
  async cancelSession(sessionId: SessionId, reason?: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      return;
    }

    await this.stopSession(session, reason);
  }

  /**
   * End a session of this client as cancelled and ask the server to end it too.
   * Never rejects.
   */
  private async stopSession(session: ActiveSession, reason?: string): Promise<void> {
    if (session.ended) {
      return;
    }

    // Stop listening first: nothing is delivered once the session was cancelled.
    this.endSession(session, this.cancelledResult(session, reason));

    // Send the stop request to the server
    const url = `${this.config.baseUrl}/sessions/${sessionPathSegment(session.sessionId)}`;
    let failure: string | null = null;

    try {
      await this.withDeadline('Stopping the session', async (signal) => {
        const response = await this.config.fetch(url, {
          method: 'DELETE',
          headers: this.buildHeaders(),
          signal,
        });
        void response.body?.cancel().catch(() => undefined);

        // 404: the server no longer has the session, so there is nothing left to stop
        if (!response.ok && response.status !== 404) {
          failure = `the server answered ${response.status}`;
        }
      });
    } catch (error) {
      failure = error instanceof Error ? error.message : 'the request failed';
    }

    if (failure !== null) {
      try {
        session.handlers.onError?.(
          'CANCEL_FAILED',
          `The server did not confirm that session ${session.sessionId} was stopped: ${failure}`,
        );
      } catch {
        // A handler's own error does not change the outcome of cancel()
      }
    }
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

    await this.runConnection(session, async (signal) => {
      const response = await this.config.fetch(url, {
        method: 'POST',
        headers: {
          ...this.buildHeaders(),
          'Content-Type': 'application/json',
          Accept: 'application/x-ndjson',
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!response.ok) {
        const errorText = (await response.text()).slice(0, 500);
        throw new EnclaveClientError('SESSION_ERROR', `Failed to start session: ${response.status} - ${errorText}`);
      }

      return response;
    });
  }

  /**
   * Attempt to reconnect a session.
   */
  private async reconnectSession(session: ActiveSession): Promise<void> {
    if (session.ended) return;

    // Request replay from the event after the last one delivered
    const url = `${this.config.baseUrl}/sessions/${sessionPathSegment(session.sessionId)}/stream`;
    const query = session.lastSequence >= 0 ? `?fromSeq=${session.lastSequence + 1}` : '';

    await this.runConnection(session, async (signal) => {
      const response = await this.config.fetch(`${url}${query}`, {
        method: 'GET',
        headers: {
          ...this.buildHeaders(),
          Accept: 'application/x-ndjson',
        },
        signal,
      });

      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new EnclaveClientError('RECONNECT_FAILED', `Reconnection failed: ${response.status}`);
      }

      return response;
    });
  }

  /**
   * Open a connection for a session and follow its stream until the session ends or the
   * connection is lost. A session has one connection at a time: the previous one is closed
   * first, and nothing that still arrives on it is delivered.
   */
  private async runConnection(
    session: ActiveSession,
    request: (signal: AbortSignal) => Promise<Response>,
  ): Promise<void> {
    if (session.ended) return;

    this.closeConnection(session);
    const connection: Connection = { controller: new AbortController(), timer: null };
    session.connection = connection;

    try {
      // The answer to the request has to arrive within the timeout
      this.watch(session, connection, this.config.timeout, 'No response from the server');
      const response = await request(connection.controller.signal);

      if (!this.isCurrent(session, connection)) {
        void response.body?.cancel().catch(() => undefined);
        return;
      }

      await this.streamResponse(session, connection, response);
    } catch (error) {
      this.connectionLost(session, connection, error);
    }
  }

  /**
   * Stream and parse the NDJSON response.
   */
  private async streamResponse(session: ActiveSession, connection: Connection, response: Response): Promise<void> {
    const body = response.body;
    if (!body) {
      throw new EnclaveClientError('PARSE_ERROR', 'No response body');
    }

    // From here on the next event has to arrive within the silence the session accepts
    this.watch(session, connection, session.silenceMs, 'No event from the server');

    // Use the async generator to parse NDJSON stream
    for await (const event of parseNdjsonStream(body, { maxLineLength: this.config.maxEventLength })) {
      if (!this.isCurrent(session, connection)) return;

      this.watch(session, connection, session.silenceMs, 'No event from the server');

      // The generator yields validated events
      this.handleEvent(session, event as StreamEvent);

      if (session.ended) return;
    }

    if (!this.isCurrent(session, connection)) return;

    // The stream is over and the session is not: the connection was lost
    throw new EnclaveClientError('NETWORK_ERROR', 'The stream ended before the session was complete');
  }

  /**
   * (Re)start the timer of a connection. When it runs out the connection counts as lost.
   */
  private watch(session: ActiveSession, connection: Connection, ms: number, what: string): void {
    if (connection.timer !== null) {
      clearTimeout(connection.timer);
    }
    connection.timer = setTimeout(() => {
      connection.timer = null;
      this.connectionLost(session, connection, new EnclaveClientError('TIMEOUT', `${what} within ${ms} ms`));
    }, ms);
  }

  /**
   * Whether a connection is the one its session is using.
   */
  private isCurrent(session: ActiveSession, connection: Connection): boolean {
    return !session.ended && session.connection === connection;
  }

  /**
   * Close the connection of a session, if it has one.
   */
  private closeConnection(session: ActiveSession): void {
    const connection = session.connection;
    if (!connection) return;

    session.connection = null;
    if (connection.timer !== null) {
      clearTimeout(connection.timer);
      connection.timer = null;
    }
    connection.controller.abort();
  }

  /**
   * A connection failed, ended early or went silent: reconnect if that is allowed, otherwise
   * the session fails. A connection that is no longer the session's own is ignored.
   */
  private connectionLost(session: ActiveSession, connection: Connection, error: unknown): void {
    if (!this.isCurrent(session, connection)) return;

    this.closeConnection(session);

    if (error instanceof NdjsonLineTooLongError) {
      // The same event would come again on a replay
      this.failSession(
        session,
        new EnclaveClientError(
          'PARSE_ERROR',
          `The server sent an event longer than ${this.config.maxEventLength} characters`,
          error,
        ),
      );
      return;
    }

    if (this.config.autoReconnect && session.reconnectState.canReconnect()) {
      session.reconnectState.onDisconnected(error instanceof Error ? error.message : 'Connection lost');
      return;
    }

    this.failSession(session, error);
  }

  /**
   * Handle a received stream event.
   */
  private handleEvent(session: ActiveSession, event: StreamEvent): void {
    if (session.ended) return;

    // Each event is delivered once and in order: an event at or below the last sequence
    // number delivered is a replay
    if (event.seq <= session.lastSequence) return;
    session.lastSequence = event.seq;

    // A stream counts as connected when it brings something new, so a server that accepts
    // streams and ends them without progress runs into the reconnection limit
    if (session.reconnectState.getState() !== ConnectionState.Connected) {
      session.reconnectState.onConnected();
    }

    if ((event as { type: string }).type === 'enc') {
      this.failSession(
        session,
        new EnclaveClientError('PARSE_ERROR', 'The server sent an encrypted event, which this client cannot read'),
      );
      return;
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
      session.handlers.onHeartbeat?.();
    } else if (isErrorEvent(event)) {
      session.handlers.onError?.(event.payload.code ?? 'UNKNOWN', event.payload.message);
    } else if (isPartialResultEvent(event)) {
      session.handlers.onPartialResult?.(
        event.payload.path,
        event.payload.data,
        event.payload.error,
        event.payload.hasNext,
      );
    } else if (isToolProgressEvent(event)) {
      session.handlers.onToolProgress?.(event.payload.callId, event.payload.phase, event.payload.elapsedMs);
    } else if (isDeadlineExceededEvent(event)) {
      session.handlers.onDeadlineExceeded?.(event.payload.elapsedMs, event.payload.budgetMs);
    } else if (isCatalogChangedEvent(event)) {
      session.handlers.onCatalogChanged?.(
        event.payload.version,
        event.payload.addedActions,
        event.payload.removedActions,
      );
    } else if (isFinalEvent(event)) {
      this.handleFinalEvent(session, event);
    }
  }

  /**
   * Handle the final event and complete the session.
   */
  private handleFinalEvent(session: ActiveSession, event: FinalEvent): void {
    const result: SessionResult = {
      success: event.payload.ok,
      sessionId: session.sessionId,
      events: session.events,
      stats: this.statsOf(session),
    };

    if (event.payload.ok) {
      result.value = event.payload.result;
    } else {
      result.error = {
        code: event.payload.error?.code,
        message: event.payload.error?.message ?? 'Unknown error',
      };
    }

    // Preserve per-path errors
    if (event.payload.errors?.length) {
      result.errors = event.payload.errors.map((e) => ({
        code: e.code,
        message: e.message,
        path: e.path,
      }));
    }

    this.endSession(session, result);
  }

  /**
   * End a session with an error.
   */
  private failSession(session: ActiveSession, error: unknown): void {
    const clientError =
      error instanceof EnclaveClientError
        ? error
        : new EnclaveClientError(
            'NETWORK_ERROR',
            error instanceof Error ? error.message : 'Unknown error',
            error instanceof Error ? error : undefined,
          );

    this.endSession(session, {
      success: false,
      sessionId: session.sessionId,
      error: { code: clientError.code, message: clientError.message },
      events: session.events,
      stats: this.statsOf(session),
    });
  }

  /**
   * End a session that was never requested from the server.
   */
  private refuseSession(session: ActiveSession, message: string): void {
    session.ended = true;
    session.reconnectState.close();
    session.resolve({
      success: false,
      sessionId: session.sessionId,
      error: { code: 'SESSION_ERROR', message },
      events: session.events,
      stats: this.statsOf(session),
    });
  }

  /**
   * Give a session its result and clean up. The first result is the only one.
   */
  private endSession(session: ActiveSession, result: SessionResult): void {
    if (session.ended) return;

    session.ended = true;
    this.closeConnection(session);
    session.reconnectState.close();
    session.detachSignal();

    if (this.activeSessions.get(session.sessionId) === session) {
      this.activeSessions.delete(session.sessionId);
    }
    session.resolve(result);
  }

  private cancelledResult(session: ActiveSession, reason?: string): SessionResult {
    return {
      success: false,
      sessionId: session.sessionId,
      error: { code: 'CANCELLED', message: reason || 'Session cancelled' },
      events: session.events,
      stats: this.statsOf(session),
    };
  }

  private statsOf(session: ActiveSession): NonNullable<SessionResult['stats']> {
    return {
      durationMs: Date.now() - session.startTime,
      toolCallCount: session.toolCallCount,
      stdoutBytes: session.stdoutBytes,
    };
  }

  /**
   * Run a request that is not a session stream, bounded by the configured timeout.
   * The promise settles at the deadline even when the request does not react to its signal.
   */
  private withDeadline<T>(what: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const ms = this.config.timeout;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new EnclaveClientError('TIMEOUT', `${what} timed out after ${ms} ms`));
        controller.abort();
      }, ms);

      work(controller.signal).then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
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
