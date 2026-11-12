/**
 * Session HTTP Handler
 *
 * Framework-agnostic HTTP handler for session API endpoints.
 *
 * @packageDocumentation
 */

import type { SessionId, SessionLimits, StreamEvent } from '@enclave-vm/types';
import { DEFAULT_SESSION_LIMITS } from '@enclave-vm/types';
import type { Broker } from '../broker';
import type { BrokerSession } from '../broker-session';
import type { SessionInfo } from '../session-manager';
import type {
  BrokerRequest,
  BrokerResponse,
  CreateSessionRequest,
  SessionInfoResponse,
  ListSessionsResponse,
  ErrorResponse,
} from './types';
import { EventFilter, createEventFilter } from '../event-filter';
import { parseCreateSessionRequest } from './request-validation';
import type { RequestedLimits } from './request-validation';

/**
 * The shortest and the longest heartbeat interval a request can get. A broker configured with
 * a shorter interval keeps its own as the lower bound.
 */
const MIN_REQUEST_HEARTBEAT_MS = 1000;
const MAX_REQUEST_HEARTBEAT_MS = 300_000;

/**
 * Session handler configuration
 */
export interface SessionHandlerConfig {
  /**
   * Broker instance
   */
  broker: Broker;

  /**
   * Enable CORS headers
   * @default true
   */
  cors?: boolean;

  /**
   * Allowed origins for CORS
   * @default ['*']
   */
  allowedOrigins?: string[];
}

/**
 * Route handler function type
 */
export type RouteHandler = (req: BrokerRequest, res: BrokerResponse) => Promise<void>;

/**
 * Session HTTP Handler
 *
 * Provides HTTP endpoints for session management and streaming.
 */
export class SessionHandler {
  private readonly broker: Broker;
  private readonly cors: boolean;
  private readonly allowedOrigins: string[];

  constructor(config: SessionHandlerConfig) {
    this.broker = config.broker;
    this.cors = config.cors ?? true;
    this.allowedOrigins = config.allowedOrigins ?? ['*'];
  }

  /**
   * Get route definitions for registration with HTTP frameworks
   */
  getRoutes(): Array<{
    method: 'GET' | 'POST' | 'DELETE' | 'OPTIONS';
    path: string;
    handler: RouteHandler;
  }> {
    return [
      { method: 'GET', path: '/sessions', handler: this.listSessions.bind(this) },
      { method: 'POST', path: '/sessions', handler: this.createSession.bind(this) },
      { method: 'GET', path: '/sessions/:sessionId', handler: this.getSession.bind(this) },
      { method: 'GET', path: '/sessions/:sessionId/stream', handler: this.streamSession.bind(this) },
      { method: 'DELETE', path: '/sessions/:sessionId', handler: this.terminateSession.bind(this) },
      { method: 'OPTIONS', path: '/sessions', handler: this.handleCors.bind(this) },
      { method: 'OPTIONS', path: '/sessions/:sessionId', handler: this.handleCors.bind(this) },
      { method: 'OPTIONS', path: '/sessions/:sessionId/stream', handler: this.handleCors.bind(this) },
    ];
  }

  /**
   * Add CORS headers to response
   */
  private addCorsHeaders(req: BrokerRequest, res: BrokerResponse): void {
    if (!this.cors) return;

    const origin = req.headers['origin'] as string | undefined;

    if (this.allowedOrigins.includes('*')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else if (origin && this.allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    } else {
      // Origin not allowed - don't set CORS headers
      return;
    }

    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Last-Event-ID');
    res.setHeader('Access-Control-Max-Age', '86400');
  }

  /**
   * Handle CORS preflight requests
   */
  async handleCors(req: BrokerRequest, res: BrokerResponse): Promise<void> {
    this.addCorsHeaders(req, res);
    res.status(204).end();
  }

  /**
   * List all active sessions
   *
   * GET /sessions
   */
  async listSessions(req: BrokerRequest, res: BrokerResponse): Promise<void> {
    this.addCorsHeaders(req, res);

    try {
      const sessions = this.broker.listSessions();
      const response: ListSessionsResponse = {
        sessions: sessions.map((info) => this.sessionInfoToResponse(info)),
        total: sessions.length,
      };

      res.status(200).json(response);
    } catch {
      this.sendError(res, 500, 'INTERNAL_ERROR', 'Failed to list sessions');
    }
  }

  /**
   * Create a new session and start execution
   *
   * POST /sessions
   * Body: { code: string, sessionId?: string, config?: {...} }
   *
   * Returns NDJSON stream of events
   */
  async createSession(req: BrokerRequest, res: BrokerResponse): Promise<void> {
    this.addCorsHeaders(req, res);

    // Validate the request body as a whole before any part of it is used
    const parsed = parseCreateSessionRequest(req.body);
    if (!parsed.ok) {
      this.sendError(res, 400, parsed.code, parsed.message);
      return;
    }
    const { code, config } = parsed.value;
    const body = req.body as CreateSessionRequest;

    // Check if broker is disposed
    if (this.broker.isDisposed) {
      this.sendError(res, 503, 'SERVICE_UNAVAILABLE', 'Broker is disposed');
      return;
    }

    try {
      // What the request asks for, bounded by the broker's own limits
      const limits = this.boundLimits(config);

      // Create event filter if configured
      let eventFilter: EventFilter | undefined;
      if (body.filter) {
        eventFilter = createEventFilter({ config: body.filter });
      }

      // Create session
      const session = this.broker.createSession({
        sessionId: body.sessionId,
        limits,
      });

      // Set up streaming response
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Session-ID', session.sessionId);

      // Subscribe to events and stream (with filtering)
      const unsubscribe = session.onEvent((event: StreamEvent) => {
        // Apply filter if configured
        if (eventFilter && !eventFilter.shouldSend(event)) {
          return; // Skip filtered events
        }
        this.writeEvent(res, event);
      });

      // Handle client disconnect - use flag to prevent double cleanup
      let cleanedUp = false;
      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        unsubscribe();
        if (!session.isTerminal()) {
          session.cancel('Client disconnected').catch(() => {
            // Ignore cancellation errors
          });
        }
      };

      if (req.signal) {
        req.signal.addEventListener('abort', cleanup, { once: true });
      }

      // Start execution
      try {
        await session.execute(code);
      } catch {
        // Error already emitted through events
      } finally {
        cleanup();
        res.end();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.sendError(res, 500, 'SESSION_CREATE_ERROR', message);
    }
  }

  /**
   * Get session information
   *
   * GET /sessions/:sessionId
   */
  async getSession(req: BrokerRequest, res: BrokerResponse): Promise<void> {
    this.addCorsHeaders(req, res);

    const sessionId = req.params['sessionId'] as SessionId | undefined;
    if (!sessionId) {
      this.sendError(res, 400, 'INVALID_REQUEST', 'Missing sessionId');
      return;
    }

    const session = this.broker.getSession(sessionId);
    if (!session) {
      this.sendError(res, 404, 'NOT_FOUND', `Session ${sessionId} not found`);
      return;
    }

    res.status(200).json(this.sessionToInfo(session));
  }

  /**
   * Stream session events (for reconnection)
   *
   * GET /sessions/:sessionId/stream?fromSeq=N&filter=JSON
   */
  async streamSession(req: BrokerRequest, res: BrokerResponse): Promise<void> {
    this.addCorsHeaders(req, res);

    const sessionId = req.params['sessionId'] as SessionId | undefined;
    if (!sessionId) {
      this.sendError(res, 400, 'INVALID_REQUEST', 'Missing sessionId');
      return;
    }

    const session = this.broker.getSession(sessionId);
    if (!session) {
      this.sendError(res, 404, 'NOT_FOUND', `Session ${sessionId} not found`);
      return;
    }

    // Parse stream options - validate fromSeq to handle NaN
    const parsedFromSeq = parseInt(req.query['fromSeq'] ?? '0', 10);
    const fromSeq = Number.isFinite(parsedFromSeq) && parsedFromSeq >= 0 ? parsedFromSeq : 0;

    // Parse filter config if provided (JSON-encoded query parameter)
    let eventFilter: EventFilter | undefined;
    if (req.query['filter']) {
      try {
        const filterConfig = JSON.parse(req.query['filter']);
        eventFilter = createEventFilter({ config: filterConfig });
      } catch {
        this.sendError(res, 400, 'INVALID_FILTER', 'Invalid filter configuration');
        return;
      }
    }

    // Set up streaming response
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Session-ID', session.sessionId);

    // Replay missed events (with filtering)
    const pastEvents = session.getEvents();
    for (const event of pastEvents) {
      if (event.seq >= fromSeq) {
        if (eventFilter && !eventFilter.shouldSend(event)) {
          continue; // Skip filtered events
        }
        this.writeEvent(res, event);
      }
    }

    // If session is terminal, end the response
    if (session.isTerminal()) {
      res.end();
      return;
    }

    // Subscribe to new events (with filtering)
    const unsubscribe = session.onEvent((event: StreamEvent) => {
      if (event.seq >= fromSeq) {
        // Apply filter if configured
        if (eventFilter && !eventFilter.shouldSend(event)) {
          // Still check for final event to end stream
          if (event.type === 'final') {
            unsubscribe();
            res.end();
          }
          return; // Skip filtered events
        }
        this.writeEvent(res, event);
      }

      // End stream when session completes
      if (event.type === 'final') {
        unsubscribe();
        res.end();
      }
    });

    // Handle client disconnect
    if (req.signal) {
      req.signal.addEventListener(
        'abort',
        () => {
          unsubscribe();
        },
        { once: true },
      );
    }
  }

  /**
   * Terminate a session
   *
   * DELETE /sessions/:sessionId
   */
  async terminateSession(req: BrokerRequest, res: BrokerResponse): Promise<void> {
    this.addCorsHeaders(req, res);

    const sessionId = req.params['sessionId'] as SessionId | undefined;
    if (!sessionId) {
      this.sendError(res, 400, 'INVALID_REQUEST', 'Missing sessionId');
      return;
    }

    const success = await this.broker.terminateSession(sessionId);
    if (!success) {
      this.sendError(res, 404, 'NOT_FOUND', `Session ${sessionId} not found`);
      return;
    }

    res.status(200).json({ success: true, sessionId });
  }

  /**
   * The limits a request gets: what it asks for, never above what the broker is configured
   * with. A request may lower a limit; it cannot raise one.
   */
  private boundLimits(requested: RequestedLimits): Partial<SessionLimits> {
    const ceiling: Required<SessionLimits> = this.broker.sessionLimits ?? DEFAULT_SESSION_LIMITS;
    const limits: Partial<SessionLimits> = {};

    if (requested.maxExecutionMs !== undefined) {
      limits.sessionTtlMs = Math.min(requested.maxExecutionMs, ceiling.sessionTtlMs);
    }
    if (requested.maxToolCalls !== undefined) {
      limits.maxToolCalls = Math.min(requested.maxToolCalls, ceiling.maxToolCalls);
    }
    // A heartbeat interval is not a limit that is safe to lower without a bound: it is kept
    // within a range, and a broker that sends no heartbeats does not start to on request.
    if (requested.heartbeatIntervalMs !== undefined && ceiling.heartbeatIntervalMs > 0) {
      const shortest = Math.min(MIN_REQUEST_HEARTBEAT_MS, ceiling.heartbeatIntervalMs);
      const longest = Math.max(MAX_REQUEST_HEARTBEAT_MS, ceiling.heartbeatIntervalMs);
      limits.heartbeatIntervalMs = Math.min(Math.max(requested.heartbeatIntervalMs, shortest), longest);
    }

    return limits;
  }

  /**
   * Convert BrokerSession to info response
   */
  private sessionToInfo(session: BrokerSession): SessionInfoResponse {
    const stats = session.getStats();
    return {
      sessionId: session.sessionId,
      state: session.state,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      stats: {
        duration: stats.duration,
        toolCallCount: stats.toolCallCount,
      },
    };
  }

  /**
   * Convert SessionInfo to response format
   */
  private sessionInfoToResponse(info: SessionInfo): SessionInfoResponse {
    return {
      sessionId: info.sessionId,
      state: info.state,
      createdAt: info.createdAt,
      expiresAt: info.expiresAt,
      stats: {
        duration: Date.now() - info.createdAt,
        toolCallCount: 0, // Not available from SessionInfo
      },
    };
  }

  /**
   * Write a stream event as NDJSON
   */
  private writeEvent(res: BrokerResponse, event: StreamEvent): void {
    res.write(JSON.stringify(event) + '\n');
    if (res.flush) {
      res.flush();
    }
  }

  /**
   * Send an error response
   */
  private sendError(res: BrokerResponse, status: number, code: string, message: string): void {
    const error: ErrorResponse = { code, message };
    res.status(status).json(error);
  }
}

/**
 * Create a session handler
 */
export function createSessionHandler(config: SessionHandlerConfig): SessionHandler {
  return new SessionHandler(config);
}
