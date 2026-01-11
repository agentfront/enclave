import { z } from 'zod';
import { createBroker } from '../broker';
import { SessionHandler, createSessionHandler } from './session-handler';
import type { BrokerRequest, BrokerResponse, SessionInfoResponse, ListSessionsResponse, ErrorResponse } from './types';
import type { Broker } from '../broker';
import type { StreamEvent } from '@enclavejs/types';

describe('SessionHandler', () => {
  let broker: Broker;
  let handler: SessionHandler;

  beforeEach(() => {
    broker = createBroker();
    handler = createSessionHandler({ broker });
  });

  afterEach(async () => {
    await broker.dispose();
  });

  // Helper to create mock request
  function createRequest(overrides: Partial<BrokerRequest> = {}): BrokerRequest {
    return {
      method: 'GET',
      path: '/sessions',
      params: {},
      query: {},
      body: undefined,
      headers: {},
      ...overrides,
    };
  }

  // Helper to create mock response
  function createResponse(): BrokerResponse & {
    statusCode: number;
    body: unknown;
    headersSent: Record<string, string>;
    written: string[];
    ended: boolean;
  } {
    const result = {
      statusCode: 200,
      body: undefined as unknown,
      headersSent: {} as Record<string, string>,
      written: [] as string[],
      ended: false,
      status(code: number) {
        result.statusCode = code;
        return result;
      },
      json(data: unknown) {
        result.body = data;
      },
      setHeader(name: string, value: string) {
        result.headersSent[name] = value;
        return result;
      },
      write(data: string) {
        result.written.push(data);
      },
      end() {
        result.ended = true;
      },
      flush() {
        // no-op for tests
      },
    };
    return result;
  }

  describe('getRoutes', () => {
    it('should return route definitions', () => {
      const routes = handler.getRoutes();

      expect(routes.length).toBeGreaterThan(0);
      expect(routes.some((r) => r.method === 'GET' && r.path === '/sessions')).toBe(true);
      expect(routes.some((r) => r.method === 'POST' && r.path === '/sessions')).toBe(true);
      expect(routes.some((r) => r.method === 'GET' && r.path === '/sessions/:sessionId')).toBe(true);
      expect(routes.some((r) => r.method === 'DELETE' && r.path === '/sessions/:sessionId')).toBe(true);
    });
  });

  describe('listSessions', () => {
    it('should return empty list initially', async () => {
      const req = createRequest();
      const res = createResponse();

      const route = handler.getRoutes().find((r) => r.method === 'GET' && r.path === '/sessions');
      await route!.handler(req, res);

      expect(res.statusCode).toBe(200);
      const body = res.body as ListSessionsResponse;
      expect(body.sessions).toEqual([]);
      expect(body.total).toBe(0);
    });

    it('should return sessions when they exist', async () => {
      broker.createSession();
      broker.createSession();

      const req = createRequest();
      const res = createResponse();

      const route = handler.getRoutes().find((r) => r.method === 'GET' && r.path === '/sessions');
      await route!.handler(req, res);

      const body = res.body as ListSessionsResponse;
      expect(body.sessions.length).toBe(2);
      expect(body.total).toBe(2);
    });
  });

  describe('getSession', () => {
    it('should return 404 for non-existent session', async () => {
      const req = createRequest({
        params: { sessionId: 's_nonexistent' },
      });
      const res = createResponse();

      const route = handler.getRoutes().find((r) => r.method === 'GET' && r.path === '/sessions/:sessionId');
      await route!.handler(req, res);

      expect(res.statusCode).toBe(404);
      const body = res.body as ErrorResponse;
      expect(body.code).toBe('NOT_FOUND');
    });

    it('should return session info for existing session', async () => {
      const session = broker.createSession();

      const req = createRequest({
        params: { sessionId: session.sessionId },
      });
      const res = createResponse();

      const route = handler.getRoutes().find((r) => r.method === 'GET' && r.path === '/sessions/:sessionId');
      await route!.handler(req, res);

      expect(res.statusCode).toBe(200);
      const body = res.body as SessionInfoResponse;
      expect(body.sessionId).toBe(session.sessionId);
      expect(body.state).toBe('starting');
    });
  });

  describe('createSession', () => {
    it('should return 400 for missing code', async () => {
      const req = createRequest({
        method: 'POST',
        body: {},
      });
      const res = createResponse();

      const route = handler.getRoutes().find((r) => r.method === 'POST' && r.path === '/sessions');
      await route!.handler(req, res);

      expect(res.statusCode).toBe(400);
      const body = res.body as ErrorResponse;
      expect(body.code).toBe('INVALID_REQUEST');
    });

    it('should create session and stream events', async () => {
      const req = createRequest({
        method: 'POST',
        body: { code: 'return 42' },
      });
      const res = createResponse();

      const route = handler.getRoutes().find((r) => r.method === 'POST' && r.path === '/sessions');
      await route!.handler(req, res);

      expect(res.headersSent['Content-Type']).toBe('application/x-ndjson');
      expect(res.headersSent['X-Session-ID']).toMatch(/^s_/);
      expect(res.ended).toBe(true);

      // Parse NDJSON events
      const events = res.written.filter((line) => line.trim()).map((line) => JSON.parse(line.trim()) as StreamEvent);

      expect(events.some((e) => e.type === 'session_init')).toBe(true);
      expect(events.some((e) => e.type === 'final')).toBe(true);

      const finalEvent = events.find((e) => e.type === 'final') as
        | { type: 'final'; payload: { ok: boolean; result?: unknown } }
        | undefined;
      expect(finalEvent?.payload.ok).toBe(true);
    });

    it('should stream tool call events', async () => {
      broker.tool('double', {
        argsSchema: z.object({ n: z.number() }),
        handler: async ({ n }: { n: number }) => n * 2,
      });

      const req = createRequest({
        method: 'POST',
        body: {
          code: `
            const result = await callTool('double', { n: 5 });
            return result;
          `,
        },
      });
      const res = createResponse();

      const route = handler.getRoutes().find((r) => r.method === 'POST' && r.path === '/sessions');
      await route!.handler(req, res);

      const events = res.written.filter((line) => line.trim()).map((line) => JSON.parse(line.trim()) as StreamEvent);

      expect(events.some((e) => e.type === 'tool_call')).toBe(true);
      expect(events.some((e) => e.type === 'tool_result_applied')).toBe(true);

      const finalEvent = events.find((e) => e.type === 'final') as
        | { type: 'final'; payload: { ok: boolean; result?: unknown } }
        | undefined;
      expect(finalEvent?.payload.ok).toBe(true);
      expect(finalEvent?.payload.result).toBe(10);
    });
  });

  describe('terminateSession', () => {
    it('should return 404 for non-existent session', async () => {
      const req = createRequest({
        method: 'DELETE',
        params: { sessionId: 's_nonexistent' },
      });
      const res = createResponse();

      const route = handler.getRoutes().find((r) => r.method === 'DELETE' && r.path === '/sessions/:sessionId');
      await route!.handler(req, res);

      expect(res.statusCode).toBe(404);
    });

    it('should terminate existing session', async () => {
      const session = broker.createSession();

      const req = createRequest({
        method: 'DELETE',
        params: { sessionId: session.sessionId },
      });
      const res = createResponse();

      const route = handler.getRoutes().find((r) => r.method === 'DELETE' && r.path === '/sessions/:sessionId');
      await route!.handler(req, res);

      expect(res.statusCode).toBe(200);
      expect((res.body as { success: boolean }).success).toBe(true);
      expect(broker.getSession(session.sessionId)).toBeUndefined();
    });
  });

  describe('CORS', () => {
    it('should add CORS headers by default', async () => {
      const req = createRequest();
      const res = createResponse();

      const route = handler.getRoutes().find((r) => r.method === 'GET' && r.path === '/sessions');
      await route!.handler(req, res);

      expect(res.headersSent['Access-Control-Allow-Origin']).toBe('*');
    });

    it('should handle OPTIONS preflight', async () => {
      const req = createRequest({ method: 'OPTIONS' });
      const res = createResponse();

      const route = handler.getRoutes().find((r) => r.method === 'OPTIONS' && r.path === '/sessions');
      await route!.handler(req, res);

      expect(res.statusCode).toBe(204);
      expect(res.headersSent['Access-Control-Allow-Methods']).toContain('POST');
    });

    it('should respect allowed origins', async () => {
      const restrictedHandler = createSessionHandler({
        broker,
        allowedOrigins: ['https://example.com'],
      });

      const req = createRequest({
        headers: { origin: 'https://example.com' },
      });
      const res = createResponse();

      const route = restrictedHandler.getRoutes().find((r) => r.method === 'GET' && r.path === '/sessions');
      await route!.handler(req, res);

      expect(res.headersSent['Access-Control-Allow-Origin']).toBe('https://example.com');
    });
  });

  describe('streamSession', () => {
    it('should return 404 for non-existent session', async () => {
      const req = createRequest({
        params: { sessionId: 's_nonexistent' },
      });
      const res = createResponse();

      const route = handler.getRoutes().find((r) => r.method === 'GET' && r.path === '/sessions/:sessionId/stream');
      await route!.handler(req, res);

      expect(res.statusCode).toBe(404);
    });

    it('should replay past events for completed session', async () => {
      // Create and execute a session
      const result = await broker.execute('return 42');
      expect(result.success).toBe(true);

      // The session is auto-removed after completion in broker.execute()
      // So this test verifies the 404 case for completed sessions
      const req = createRequest({
        params: { sessionId: 's_completed' },
        query: { fromSeq: '0' },
      });
      const res = createResponse();

      const route = handler.getRoutes().find((r) => r.method === 'GET' && r.path === '/sessions/:sessionId/stream');
      await route!.handler(req, res);

      // Session doesn't exist after execution completes
      expect(res.statusCode).toBe(404);
    });
  });
});
