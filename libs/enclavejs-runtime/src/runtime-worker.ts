/**
 * Runtime Worker
 *
 * Standalone worker that executes Enclave sessions.
 * Can run as a separate process/worker and communicate via WebSocket.
 *
 * @packageDocumentation
 */

import type { SessionId } from '@enclavejs/types';
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
  host: '0.0.0.0',
  wsPath: '/ws',
  maxSessions: 10,
  defaultLimits: {},
  debug: false,
  heartbeatIntervalMs: 15000,
  connectionTimeoutMs: 30000,
};

/**
 * Runtime worker implementation
 *
 * Manages multiple session executors and provides a WebSocket interface
 * for communication with the broker.
 */
export class RuntimeWorker implements IRuntimeWorker {
  private readonly config: Required<RuntimeConfig>;
  private readonly sessions: Map<SessionId, SessionExecutor>;
  private state: RuntimeState = 'idle';
  private startedAt = 0;
  private totalSessions = 0;

  constructor(config: RuntimeConfig = {}) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    };
    this.sessions = new Map();
  }

  /**
   * Check if runtime is running
   */
  get isRunning(): boolean {
    return this.state === 'running';
  }

  /**
   * Start the runtime worker
   */
  async start(): Promise<void> {
    if (this.state !== 'idle' && this.state !== 'stopped') {
      throw new Error(`Cannot start runtime in state: ${this.state}`);
    }

    this.state = 'starting';
    this.startedAt = Date.now();

    // In a full implementation, this would start the WebSocket server
    // For now, we mark as running for embedded use
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
   */
  async handleRequest(request: RuntimeRequest, channel: RuntimeChannel): Promise<void> {
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
   * Handle execute request
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

    // Execute asynchronously
    executor
      .execute()
      .catch((error) => {
        this.log(`Session ${executor.sessionId} execution error: ${error}`);
      })
      .finally(() => {
        // Clean up after completion
        this.cleanupSession(executor.sessionId);
      });
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
