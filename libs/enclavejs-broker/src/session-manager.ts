/**
 * Session Manager
 *
 * Manages multiple broker sessions with lifecycle management.
 *
 * @packageDocumentation
 */

import type { SessionId, StreamEvent } from '@enclavejs/types';
import type { SessionFinalResult } from 'enclave-vm';
import { BrokerSession, createBrokerSession } from './broker-session';
import type { BrokerSessionConfig } from './broker-session';
import type { ToolRegistry } from './tool-registry';

/**
 * Session manager configuration
 */
export interface SessionManagerConfig {
  /**
   * Maximum number of concurrent sessions
   * @default 100
   */
  maxSessions?: number;

  /**
   * Interval for cleanup of expired sessions (ms)
   * @default 60000
   */
  cleanupIntervalMs?: number;

  /**
   * Default session configuration
   */
  defaultSessionConfig?: Partial<BrokerSessionConfig>;
}

/**
 * Session info for listing
 */
export interface SessionInfo {
  sessionId: SessionId;
  state: string;
  createdAt: number;
  expiresAt: number;
  isExpired: boolean;
}

/**
 * Session creation result
 */
export interface CreateSessionResult {
  session: BrokerSession;
  sessionId: SessionId;
}

/**
 * Session Manager
 *
 * Manages the lifecycle of multiple broker sessions:
 * - Session creation and tracking
 * - Automatic cleanup of expired sessions
 * - Session lookup and listing
 * - Resource limits (max sessions)
 */
export class SessionManager {
  private readonly sessions: Map<SessionId, BrokerSession>;
  private readonly toolRegistry: ToolRegistry;
  private readonly config: Required<SessionManagerConfig>;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(toolRegistry: ToolRegistry, config: SessionManagerConfig = {}) {
    this.sessions = new Map();
    this.toolRegistry = toolRegistry;
    this.config = {
      maxSessions: config.maxSessions ?? 100,
      cleanupIntervalMs: config.cleanupIntervalMs ?? 60000,
      defaultSessionConfig: config.defaultSessionConfig ?? {},
    };

    // Start cleanup interval
    this.startCleanup();
  }

  /**
   * Create a new session
   *
   * @throws Error if max sessions reached or manager is disposed
   */
  create(config?: BrokerSessionConfig): CreateSessionResult {
    if (this.disposed) {
      throw new Error('Session manager is disposed');
    }

    if (this.sessions.size >= this.config.maxSessions) {
      throw new Error(
        `Maximum sessions reached (${this.config.maxSessions}). ` +
          'Wait for existing sessions to complete or increase maxSessions.',
      );
    }

    const sessionConfig = {
      ...this.config.defaultSessionConfig,
      ...config,
    };

    const session = createBrokerSession(this.toolRegistry, sessionConfig);
    this.sessions.set(session.sessionId, session);

    return {
      session,
      sessionId: session.sessionId,
    };
  }

  /**
   * Get a session by ID
   */
  get(sessionId: SessionId): BrokerSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Check if a session exists
   */
  has(sessionId: SessionId): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * List all sessions
   */
  list(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((session) => ({
      sessionId: session.sessionId,
      state: session.state,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      isExpired: session.isExpired(),
    }));
  }

  /**
   * List active (non-terminal) sessions
   */
  listActive(): SessionInfo[] {
    return this.list().filter((info) => !['completed', 'cancelled', 'failed'].includes(info.state));
  }

  /**
   * Terminate a session
   */
  async terminate(sessionId: SessionId, reason?: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    await session.cancel(reason ?? 'Terminated by session manager');
    session.dispose();
    this.sessions.delete(sessionId);
    return true;
  }

  /**
   * Execute code in a new session and wait for completion
   *
   * This is a convenience method that creates a session, executes code,
   * waits for completion, and cleans up.
   */
  async executeAndWait(
    code: string,
    config?: BrokerSessionConfig,
    eventHandler?: (event: StreamEvent) => void,
  ): Promise<SessionFinalResult> {
    const { session, sessionId } = this.create(config);

    try {
      // Subscribe to events if handler provided
      if (eventHandler) {
        session.onEvent(eventHandler);
      }

      // Execute and wait
      const result = await session.execute(code);
      return result;
    } finally {
      // Clean up
      session.dispose();
      this.sessions.delete(sessionId);
    }
  }

  /**
   * Get count of active sessions
   */
  get activeCount(): number {
    return this.listActive().length;
  }

  /**
   * Get total session count
   */
  get totalCount(): number {
    return this.sessions.size;
  }

  /**
   * Clean up expired and terminal sessions
   */
  cleanup(): number {
    let cleaned = 0;

    for (const [sessionId, session] of this.sessions) {
      if (session.isExpired() || session.isTerminal()) {
        session.dispose();
        this.sessions.delete(sessionId);
        cleaned++;
      }
    }

    return cleaned;
  }

  /**
   * Start automatic cleanup
   */
  private startCleanup(): void {
    if (this.cleanupInterval) {
      return;
    }

    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, this.config.cleanupIntervalMs);
  }

  /**
   * Stop automatic cleanup
   */
  private stopCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Dispose of the manager and all sessions
   */
  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.stopCleanup();

    // Cancel and dispose all sessions
    const promises: Promise<void>[] = [];
    for (const [_sessionId, session] of this.sessions) {
      promises.push(
        session.cancel('Session manager disposed').catch(() => {
          // Ignore cancel errors during disposal
        }),
      );
      session.dispose();
    }

    await Promise.all(promises);
    this.sessions.clear();
  }
}

/**
 * Create a new session manager
 */
export function createSessionManager(toolRegistry: ToolRegistry, config?: SessionManagerConfig): SessionManager {
  return new SessionManager(toolRegistry, config);
}
