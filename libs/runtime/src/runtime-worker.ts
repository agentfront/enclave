/**
 * Runtime Worker
 *
 * Session bookkeeping of a runtime worker, for requests that the embedding application hands
 * to `handleRequest()` together with a channel.
 *
 * What it does not do: it opens no port (`start()` only changes the worker's state; `port`,
 * `host` and `wsPath` are not used), it authenticates nobody, and it does not execute code
 * (an `execute` request is answered with `RuntimeNotImplementedError`).
 *
 * @packageDocumentation
 */

import type { SessionId } from '@enclave-vm/types';
import type {
  RuntimeConfig,
  RuntimeState,
  RuntimeStats,
  RuntimeSession,
  RuntimeWorker as IRuntimeWorker,
  RuntimeRequest,
  RuntimeChannel,
} from './types';
import { SessionExecutor, createSessionExecutor } from './session-executor';

/**
 * Default runtime configuration
 */
const DEFAULT_CONFIG: Required<RuntimeConfig> = {
  port: 3001,
  host: '127.0.0.1',
  wsPath: '/ws',
  maxSessions: 10,
  defaultLimits: {},
  debug: false,
  heartbeatIntervalMs: 15000,
  connectionTimeoutMs: 30000,
};

/**
 * The configuration to use: the defaults, with the values that were given.
 * An option given as `undefined` is the default; a session limit that is not a positive
 * integer is refused, so that it can never mean "no limit".
 */
function resolveConfig(config: RuntimeConfig): Required<RuntimeConfig> {
  const resolved: Required<RuntimeConfig> = { ...DEFAULT_CONFIG };
  const target = resolved as unknown as Record<string, unknown>;

  for (const [key, value] of Object.entries(config ?? {})) {
    if (value !== undefined) {
      target[key] = value;
    }
  }

  if (
    typeof resolved.maxSessions !== 'number' ||
    !Number.isSafeInteger(resolved.maxSessions) ||
    resolved.maxSessions < 1
  ) {
    throw new RangeError('maxSessions must be a positive integer');
  }

  return resolved;
}

/**
 * Runtime worker implementation
 *
 * Keeps the session executors of the requests it is handed. It has no network interface of
 * its own, and executing a session's code is not implemented.
 */
export class RuntimeWorker implements IRuntimeWorker {
  private readonly config: Required<RuntimeConfig>;
  private readonly sessions: Map<SessionId, SessionExecutor>;
  private state: RuntimeState = 'idle';
  private startedAt = 0;
  private totalSessions = 0;

  constructor(config: RuntimeConfig = {}) {
    this.config = resolveConfig(config);
    this.sessions = new Map();
  }

  /**
   * Check if runtime is running
   */
  get isRunning(): boolean {
    return this.state === 'running';
  }

  /**
   * Start the runtime worker: mark it as running, so that `handleRequest()` accepts requests.
   *
   * No server is started and no port is opened. The requests come from the application that
   * embeds the worker.
   */
  async start(): Promise<void> {
    if (this.state !== 'idle' && this.state !== 'stopped') {
      throw new Error(`Cannot start runtime in state: ${this.state}`);
    }

    this.state = 'starting';
    this.startedAt = Date.now();
    this.state = 'running';

    this.log('Runtime worker started');
  }

  /**
   * Stop the runtime worker
   */
  async stop(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'stopping') {
      return;
    }

    this.state = 'stopping';

    // Cancel all active sessions
    const cancelPromises: Promise<void>[] = [];
    for (const [_sessionId, executor] of this.sessions) {
      cancelPromises.push(
        executor.cancel('Runtime stopping').catch(() => {
          // Ignore cancel errors during shutdown
        }),
      );
    }

    await Promise.all(cancelPromises);

    // Dispose all sessions
    for (const executor of this.sessions.values()) {
      executor.dispose();
    }
    this.sessions.clear();

    this.state = 'stopped';
    this.log('Runtime worker stopped');
  }

  /**
   * Get runtime statistics
   */
  getStats(): RuntimeStats {
    const now = Date.now();
    const memoryUsage = process.memoryUsage();

    return {
      state: this.state,
      activeSessions: this.sessions.size,
      totalSessions: this.totalSessions,
      startedAt: this.startedAt,
      uptimeMs: this.startedAt > 0 ? now - this.startedAt : 0,
      memoryUsage: {
        heapUsed: memoryUsage.heapUsed,
        heapTotal: memoryUsage.heapTotal,
        rss: memoryUsage.rss,
      },
    };
  }

  /**
   * Get active sessions
   */
  getSessions(): RuntimeSession[] {
    return Array.from(this.sessions.values()).map((executor) => executor.getInfo());
  }

  /**
   * Handle incoming request from channel
   *
   * The caller is trusted: nothing here authenticates where a request came from. An `execute`
   * request rejects with `RuntimeNotImplementedError`.
   */
  async handleRequest(request: RuntimeRequest, channel: RuntimeChannel): Promise<void> {
    if (typeof request !== 'object' || request === null || typeof request.type !== 'string') {
      throw new TypeError('Invalid runtime request');
    }

    switch (request.type) {
      case 'execute':
        await this.handleExecute(request, channel);
        break;

      case 'cancel':
        await this.handleCancel(request);
        break;

      case 'tool_result':
        await this.handleToolResult(request);
        break;

      case 'ping':
        // Pong is handled by sending back a heartbeat event
        this.log('Received ping');
        break;

      default:
        this.log(`Unknown request type: ${(request as RuntimeRequest).type}`);
    }
  }

  /**
   * Handle execute request: the session is created, ended with the error code
   * `NOT_IMPLEMENTED` on its channel, and removed again.
   *
   * @throws RuntimeNotImplementedError when the request was valid
   */
  private async handleExecute(
    request: { type: 'execute'; sessionId: SessionId; code: string; limits?: unknown },
    channel: RuntimeChannel,
  ): Promise<void> {
    if (!this.isRunning) {
      throw new Error('Runtime is not running');
    }

    if (this.sessions.size >= this.config.maxSessions) {
      throw new Error(`Maximum sessions reached (${this.config.maxSessions})`);
    }

    const { sessionId, code, limits } = request;

    if (typeof code !== 'string') {
      throw new TypeError('Invalid execute request: `code` must be a string');
    }

    // Check if session already exists
    if (this.sessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} already exists`);
    }

    // Create session executor
    const executor = createSessionExecutor({
      sessionId,
      code,
      limits: limits as Record<string, unknown>,
      channel,
      debug: this.config.debug,
    });

    this.sessions.set(executor.sessionId, executor);
    this.totalSessions++;

    try {
      await executor.execute();
    } catch (error) {
      this.log(`Session ${executor.sessionId} execution error: ${error}`);
      throw error;
    } finally {
      // A session that is over does not count against the session limit
      this.cleanupSession(executor.sessionId);
    }
  }

  /**
   * Handle cancel request
   */
  private async handleCancel(request: { type: 'cancel'; sessionId: SessionId; reason?: string }): Promise<void> {
    const executor = this.sessions.get(request.sessionId);
    if (!executor) {
      this.log(`Cancel request for unknown session: ${request.sessionId}`);
      return;
    }

    await executor.cancel(request.reason);
    this.cleanupSession(request.sessionId);
  }

  /**
   * Handle tool result
   */
  private async handleToolResult(request: {
    type: 'tool_result';
    sessionId: SessionId;
    callId: string;
    success: boolean;
    value?: unknown;
    error?: { code?: string; message: string };
  }): Promise<void> {
    const executor = this.sessions.get(request.sessionId);
    if (!executor) {
      this.log(`Tool result for unknown session: ${request.sessionId}`);
      return;
    }

    await executor.submitToolResult(request.callId as `c_${string}`, request.success, request.value, request.error);
  }

  /**
   * Clean up a session
   */
  private cleanupSession(sessionId: SessionId): void {
    const executor = this.sessions.get(sessionId);
    if (executor) {
      executor.dispose();
      this.sessions.delete(sessionId);
    }
  }

  /**
   * Log debug message
   */
  private log(message: string): void {
    if (this.config.debug) {
      console.log(`[RuntimeWorker] ${message}`);
    }
  }
}

/**
 * Create a runtime worker
 */
export function createRuntimeWorker(config?: RuntimeConfig): RuntimeWorker {
  return new RuntimeWorker(config);
}
