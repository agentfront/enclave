/**
 * Client Server Tests
 *
 * Tests for the Client server that:
 * 1. Serves the web UI
 * 2. Proxies to Broker in embedded and lambda modes
 * 3. Connects directly to Lambda in direct mode
 *
 * The client server has three execution modes:
 * - Embedded: Client → Broker (embedded runtime)
 * - Lambda: Client → Broker → Lambda (3-tier)
 * - Direct: Client → Lambda (bypasses broker)
 */

import express, { Express, Request, Response } from 'express';
import { Server } from 'http';
import request from 'supertest';
import { WebSocket, WebSocketServer } from 'ws';
import type { AddressInfo } from 'net';
import type { SessionId, CallId, StreamEvent } from '@enclavejs/types';
import { generateSessionId, PROTOCOL_VERSION } from '@enclavejs/types';
import { parseNdjson, delay } from './test-utils';

// Mock Broker server for testing
function createMockBrokerServer(): {
  app: Express;
  start: () => Promise<{ server: Server; port: number; url: string }>;
} {
  const app = express();
  app.use(express.json());

  // Embedded mode endpoint
  app.post('/sessions/embedded', async (req, res) => {
    const { code } = req.body;
    const sessionId = generateSessionId();
    let seq = 0;

    res.setHeader('Content-Type', 'application/x-ndjson');

    // session_init
    res.write(
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        sessionId,
        seq: ++seq,
        type: 'session_init',
        payload: {
          cancelUrl: `/sessions/${sessionId}/cancel`,
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          encryption: { enabled: false },
        },
      }) + '\n',
    );

    // Simulate execution
    if (code.includes('callTool')) {
      const callId = `c_${Math.random().toString(36).slice(2)}` as CallId;
      res.write(
        JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          sessionId,
          seq: ++seq,
          type: 'tool_call',
          payload: { callId, toolName: 'getCurrentTime', args: {} },
        }) + '\n',
      );

      res.write(
        JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          sessionId,
          seq: ++seq,
          type: 'tool_result_applied',
          payload: { callId },
        }) + '\n',
      );
    }

    // final
    res.write(
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        sessionId,
        seq: ++seq,
        type: 'final',
        payload: {
          ok: true,
          result: code.includes('error') ? undefined : { timestamp: '2024-01-01T00:00:00Z', server: 'broker' },
          error: code.includes('error') ? { code: 'EXECUTION_ERROR', message: 'Test error' } : undefined,
          stats: { durationMs: 100, toolCallCount: code.includes('callTool') ? 1 : 0, stdoutBytes: 0 },
        },
      }) + '\n',
    );

    res.end();
  });

  // Lambda mode endpoint
  app.post('/sessions/lambda', async (req, res) => {
    const { code } = req.body;
    const sessionId = generateSessionId();
    let seq = 0;

    res.setHeader('Content-Type', 'application/x-ndjson');

    // session_init
    res.write(
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        sessionId,
        seq: ++seq,
        type: 'session_init',
        payload: {
          cancelUrl: `/sessions/${sessionId}/cancel`,
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          encryption: { enabled: false },
        },
      }) + '\n',
    );

    // final
    res.write(
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        sessionId,
        seq: ++seq,
        type: 'final',
        payload: {
          ok: true,
          result: { timestamp: '2024-01-01T00:00:00Z', server: 'lambda' },
          stats: { durationMs: 50, toolCallCount: 0, stdoutBytes: 0 },
        },
      }) + '\n',
    );

    res.end();
  });

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', server: 'mock-broker' });
  });

  return {
    app,
    start: () =>
      new Promise((resolve) => {
        const server = app.listen(0, () => {
          const address = server.address() as AddressInfo;
          resolve({
            server,
            port: address.port,
            url: `http://localhost:${address.port}`,
          });
        });
      }),
  };
}

// Mock Lambda WebSocket server for testing
function createMockLambdaServer(): Promise<{
  wss: WebSocketServer;
  port: number;
  url: string;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 });

    wss.on('connection', (ws: WebSocket) => {
      ws.on('message', async (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());

          if (message.type === 'execute') {
            const sessionId = message.sessionId;
            const code = message.code;
            let seq = 0;

            // session_init
            ws.send(
              JSON.stringify({
                protocolVersion: PROTOCOL_VERSION,
                sessionId,
                seq: ++seq,
                type: 'session_init',
                payload: {
                  cancelUrl: `/sessions/${sessionId}/cancel`,
                  expiresAt: new Date(Date.now() + 60000).toISOString(),
                  encryption: { enabled: false },
                },
              }),
            );

            // Handle tool calls
            if (code.includes('callTool')) {
              const callId = `c_${Math.random().toString(36).slice(2)}` as CallId;
              ws.send(
                JSON.stringify({
                  protocolVersion: PROTOCOL_VERSION,
                  sessionId,
                  seq: ++seq,
                  type: 'tool_call',
                  payload: { callId, toolName: 'getCurrentTime', args: {} },
                }),
              );

              // Wait for tool result
              const waitForToolResult = new Promise<void>((resolveResult) => {
                const handler = (resultData: Buffer) => {
                  const result = JSON.parse(resultData.toString());
                  if (result.type === 'tool_result' && result.callId === callId) {
                    ws.off('message', handler);

                    ws.send(
                      JSON.stringify({
                        protocolVersion: PROTOCOL_VERSION,
                        sessionId,
                        seq: ++seq,
                        type: 'tool_result_applied',
                        payload: { callId },
                      }),
                    );

                    resolveResult();
                  }
                };
                ws.on('message', handler);
              });

              await waitForToolResult;
            }

            // final
            ws.send(
              JSON.stringify({
                protocolVersion: PROTOCOL_VERSION,
                sessionId,
                seq: ++seq,
                type: 'final',
                payload: {
                  ok: true,
                  result: { timestamp: '2024-01-01T00:00:00Z', server: 'client-direct' },
                  stats: { durationMs: 75, toolCallCount: code.includes('callTool') ? 1 : 0, stdoutBytes: 0 },
                },
              }),
            );
          }
        } catch {
          // Ignore parse errors
        }
      });
    });

    wss.on('listening', () => {
      const address = wss.address() as AddressInfo;
      const port = address.port;
      resolve({
        wss,
        port,
        url: `ws://localhost:${port}`,
        close: () =>
          new Promise<void>((res) => {
            wss.close(() => res());
          }),
      });
    });
  });
}

// Create a test client server
function createTestClientServer(
  brokerUrl: string,
  lambdaWsUrl: string,
): {
  app: Express;
} {
  const app = express();

  app.use(express.json());

  // Input validation helper
  const validateCode = (req: Request, res: Response): string | null => {
    const { code } = req.body;
    if (!code || typeof code !== 'string') {
      res.status(400).json({ error: 'Code is required' });
      return null;
    }
    return code;
  };

  // Embedded mode
  app.post('/api/execute/embedded', async (req: Request, res: Response) => {
    const code = validateCode(req, res);
    if (!code) return;

    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');

    try {
      const response = await fetch(`${brokerUrl}/sessions/embedded`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
        body: JSON.stringify({ code }),
      });

      if (!response.ok) throw new Error(`Broker returned ${response.status}`);

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let lastEvent: unknown = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        res.write(chunk);

        const lines = chunk.split('\n').filter((l) => l.trim());
        for (const line of lines) {
          try {
            lastEvent = JSON.parse(line);
          } catch {
            // Ignore
          }
        }
      }

      if (lastEvent && (lastEvent as { type: string }).type === 'final') {
        const finalEvent = lastEvent as { payload: { ok: boolean; result: unknown; stats?: unknown } };
        res.write(
          JSON.stringify({
            type: 'client_result',
            result: {
              success: finalEvent.payload.ok,
              value: finalEvent.payload.result,
              stats: finalEvent.payload.stats,
            },
          }) + '\n',
        );
      }

      res.end();
    } catch (error) {
      res.write(JSON.stringify({ type: 'client_error', error: String(error) }) + '\n');
      res.end();
    }
  });

  // Lambda mode
  app.post('/api/execute/lambda', async (req: Request, res: Response) => {
    const code = validateCode(req, res);
    if (!code) return;

    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');

    try {
      const response = await fetch(`${brokerUrl}/sessions/lambda`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
        body: JSON.stringify({ code }),
      });

      if (!response.ok) throw new Error(`Broker returned ${response.status}`);

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let lastEvent: unknown = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        res.write(chunk);

        const lines = chunk.split('\n').filter((l) => l.trim());
        for (const line of lines) {
          try {
            lastEvent = JSON.parse(line);
          } catch {
            // Ignore
          }
        }
      }

      if (lastEvent && (lastEvent as { type: string }).type === 'final') {
        const finalEvent = lastEvent as { payload: { ok: boolean; result: unknown; stats?: unknown } };
        res.write(
          JSON.stringify({
            type: 'client_result',
            result: {
              success: finalEvent.payload.ok,
              value: finalEvent.payload.result,
              stats: finalEvent.payload.stats,
            },
          }) + '\n',
        );
      }

      res.end();
    } catch (error) {
      res.write(JSON.stringify({ type: 'client_error', error: String(error) }) + '\n');
      res.end();
    }
  });

  // Direct mode
  app.post('/api/execute/direct', async (req: Request, res: Response) => {
    const code = validateCode(req, res);
    if (!code) return;

    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');

    const sessionId = generateSessionId();

    try {
      const ws = new WebSocket(lambdaWsUrl);

      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', reject);
        setTimeout(() => reject(new Error('Connection timeout')), 5000);
      });

      ws.send(JSON.stringify({ type: 'execute', sessionId, code }));

      ws.on('message', async (data: Buffer) => {
        try {
          const event = JSON.parse(data.toString());

          if (res.writable) {
            res.write(JSON.stringify(event) + '\n');
          }

          if (event.type === 'tool_call') {
            // Handle tool locally
            const result = await handleToolLocally(event.payload.toolName, event.payload.args);
            ws.send(
              JSON.stringify({
                type: 'tool_result',
                sessionId,
                callId: event.payload.callId,
                success: true,
                value: result,
              }),
            );
          }

          if (event.type === 'final') {
            if (res.writable) {
              res.write(
                JSON.stringify({
                  type: 'client_result',
                  result: { success: event.payload.ok, value: event.payload.result, stats: event.payload.stats },
                }) + '\n',
              );
            }
            ws.close();
            res.end();
          }
        } catch {
          // Ignore
        }
      });

      ws.on('close', () => {
        if (res.writable) {
          res.end();
        }
      });

      ws.on('error', (error) => {
        if (res.writable) {
          res.write(JSON.stringify({ type: 'client_error', error: String(error) }) + '\n');
          res.end();
        }
      });
    } catch (error) {
      res.write(JSON.stringify({ type: 'client_error', error: String(error) }) + '\n');
      res.end();
    }
  });

  // Health check
  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      server: 'client',
      brokerUrl,
      lambdaWsUrl,
      modes: ['embedded', 'lambda', 'direct'],
    });
  });

  return { app };
}

// Local tool handler for direct mode
async function handleToolLocally(toolName: string, args: Record<string, unknown>): Promise<unknown> {
  switch (toolName) {
    case 'getCurrentTime':
      return { timestamp: new Date().toISOString(), server: 'client-direct' };
    case 'addNumbers': {
      const { a, b } = args as { a: number; b: number };
      return { result: a + b, calculatedBy: 'client-direct' };
    }
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

describe('Client Server', () => {
  let mockBroker: { server: Server; port: number; url: string };
  let mockLambda: Awaited<ReturnType<typeof createMockLambdaServer>>;

  beforeAll(async () => {
    const { start } = createMockBrokerServer();
    mockBroker = await start();
    mockLambda = await createMockLambdaServer();
  });

  afterAll(async () => {
    mockBroker.server.close();
    await mockLambda.close();
  });

  describe('Health Check', () => {
    it('should return health status with modes', async () => {
      const { app } = createTestClientServer(mockBroker.url, mockLambda.url);

      const response = await request(app).get('/api/health');

      expect(response.status).toBe(200);
      expect(response.body).toEqual(
        expect.objectContaining({
          status: 'ok',
          server: 'client',
          modes: ['embedded', 'lambda', 'direct'],
        }),
      );
    });

    it('should include broker and lambda URLs', async () => {
      const { app } = createTestClientServer(mockBroker.url, mockLambda.url);

      const response = await request(app).get('/api/health');

      expect(response.body.brokerUrl).toBe(mockBroker.url);
      expect(response.body.lambdaWsUrl).toBe(mockLambda.url);
    });
  });

  describe('Input Validation', () => {
    it('should reject embedded requests without code', async () => {
      const { app } = createTestClientServer(mockBroker.url, mockLambda.url);

      const response = await request(app).post('/api/execute/embedded').send({});

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error', 'Code is required');
    });

    it('should reject lambda requests without code', async () => {
      const { app } = createTestClientServer(mockBroker.url, mockLambda.url);

      const response = await request(app).post('/api/execute/lambda').send({});

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error', 'Code is required');
    });

    it('should reject direct requests without code', async () => {
      const { app } = createTestClientServer(mockBroker.url, mockLambda.url);

      const response = await request(app).post('/api/execute/direct').send({});

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error', 'Code is required');
    });

    it('should reject non-string code', async () => {
      const { app } = createTestClientServer(mockBroker.url, mockLambda.url);

      const response = await request(app).post('/api/execute/embedded').send({ code: 123 });

      expect(response.status).toBe(400);
    });
  });

  describe('Embedded Mode (/api/execute/embedded)', () => {
    it('should proxy to broker and return NDJSON stream', async () => {
      const { app } = createTestClientServer(mockBroker.url, mockLambda.url);

      const response = await request(app)
        .post('/api/execute/embedded')
        .send({ code: 'return 1 + 2' })
        .set('Accept', 'application/x-ndjson');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('application/x-ndjson');

      const events = parseNdjson(response.text);
      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events[0].type).toBe('session_init');
    });

    it('should include client_result event at the end', async () => {
      const { app } = createTestClientServer(mockBroker.url, mockLambda.url);

      const response = await request(app)
        .post('/api/execute/embedded')
        .send({ code: 'return 1 + 2' })
        .set('Accept', 'application/x-ndjson');

      const events = parseNdjson(response.text);
      const clientResult = events.find((e) => e.type === 'client_result');

      expect(clientResult).toBeDefined();
      expect((clientResult as { result: { success: boolean } }).result.success).toBe(true);
    });

    it('should forward tool calls from broker', async () => {
      const { app } = createTestClientServer(mockBroker.url, mockLambda.url);

      const response = await request(app)
        .post('/api/execute/embedded')
        .send({ code: 'return await callTool("getCurrentTime", {})' })
        .set('Accept', 'application/x-ndjson');

      const events = parseNdjson(response.text);
      const toolCall = events.find((e) => e.type === 'tool_call');

      expect(toolCall).toBeDefined();
      expect((toolCall!.payload as { toolName: string }).toolName).toBe('getCurrentTime');
    });

    it('should forward broker result correctly', async () => {
      const { app } = createTestClientServer(mockBroker.url, mockLambda.url);

      const response = await request(app)
        .post('/api/execute/embedded')
        .send({ code: 'return await callTool("getCurrentTime", {})' })
        .set('Accept', 'application/x-ndjson');

      const events = parseNdjson(response.text);
      const final = events.find((e) => e.type === 'final');

      expect((final!.payload as { result: { server: string } }).result.server).toBe('broker');
    });
  });

  describe('Lambda Mode (/api/execute/lambda)', () => {
    it('should proxy to broker lambda endpoint', async () => {
      const { app } = createTestClientServer(mockBroker.url, mockLambda.url);

      const response = await request(app)
        .post('/api/execute/lambda')
        .send({ code: 'return 1 + 2' })
        .set('Accept', 'application/x-ndjson');

      expect(response.status).toBe(200);

      const events = parseNdjson(response.text);
      expect(events[0].type).toBe('session_init');
    });

    it('should receive lambda result through broker', async () => {
      const { app } = createTestClientServer(mockBroker.url, mockLambda.url);

      const response = await request(app)
        .post('/api/execute/lambda')
        .send({ code: 'return 1 + 2' })
        .set('Accept', 'application/x-ndjson');

      const events = parseNdjson(response.text);
      const final = events.find((e) => e.type === 'final');

      expect((final!.payload as { result: { server: string } }).result.server).toBe('lambda');
    });

    it('should include client_result event', async () => {
      const { app } = createTestClientServer(mockBroker.url, mockLambda.url);

      const response = await request(app)
        .post('/api/execute/lambda')
        .send({ code: 'return 1 + 2' })
        .set('Accept', 'application/x-ndjson');

      const events = parseNdjson(response.text);
      const clientResult = events.find((e) => e.type === 'client_result');

      expect(clientResult).toBeDefined();
    });
  });

  describe('Direct Mode (/api/execute/direct)', () => {
    it('should connect directly to Lambda via WebSocket', async () => {
      const { app } = createTestClientServer(mockBroker.url, mockLambda.url);

      const response = await request(app)
        .post('/api/execute/direct')
        .send({ code: 'return 1 + 2' })
        .set('Accept', 'application/x-ndjson');

      expect(response.status).toBe(200);

      const events = parseNdjson(response.text);
      expect(events[0].type).toBe('session_init');
    });

    it('should handle tools locally in direct mode', async () => {
      const { app } = createTestClientServer(mockBroker.url, mockLambda.url);

      const response = await request(app)
        .post('/api/execute/direct')
        .send({ code: 'return await callTool("getCurrentTime", {})' })
        .set('Accept', 'application/x-ndjson');

      const events = parseNdjson(response.text);
      const final = events.find((e) => e.type === 'final');

      // In direct mode, result should indicate client-direct
      expect((final!.payload as { result: { server: string } }).result.server).toBe('client-direct');
    });

    it('should receive final result with client_result', async () => {
      const { app } = createTestClientServer(mockBroker.url, mockLambda.url);

      const response = await request(app)
        .post('/api/execute/direct')
        .send({ code: 'return 1 + 2' })
        .set('Accept', 'application/x-ndjson');

      const events = parseNdjson(response.text);
      const clientResult = events.find((e) => e.type === 'client_result');

      expect(clientResult).toBeDefined();
      expect((clientResult as { result: { success: boolean } }).result.success).toBe(true);
    });
  });

  describe('Mode Comparison', () => {
    it('should return different server identifiers for each mode', async () => {
      const { app } = createTestClientServer(mockBroker.url, mockLambda.url);

      const embeddedResponse = await request(app)
        .post('/api/execute/embedded')
        .send({ code: 'return await callTool("getCurrentTime", {})' });

      const lambdaResponse = await request(app).post('/api/execute/lambda').send({ code: 'return 1' });

      const directResponse = await request(app)
        .post('/api/execute/direct')
        .send({ code: 'return await callTool("getCurrentTime", {})' });

      const embeddedEvents = parseNdjson(embeddedResponse.text);
      const lambdaEvents = parseNdjson(lambdaResponse.text);
      const directEvents = parseNdjson(directResponse.text);

      const embeddedFinal = embeddedEvents.find((e) => e.type === 'final');
      const lambdaFinal = lambdaEvents.find((e) => e.type === 'final');
      const directFinal = directEvents.find((e) => e.type === 'final');

      expect((embeddedFinal!.payload as { result: { server: string } }).result.server).toBe('broker');
      expect((lambdaFinal!.payload as { result: { server: string } }).result.server).toBe('lambda');
      expect((directFinal!.payload as { result: { server: string } }).result.server).toBe('client-direct');
    });
  });

  describe('Error Handling', () => {
    it('should handle broker connection error', async () => {
      // Use invalid broker URL
      const { app } = createTestClientServer('http://localhost:99999', mockLambda.url);

      const response = await request(app).post('/api/execute/embedded').send({ code: 'return 1' });

      expect(response.status).toBe(200);

      const events = parseNdjson(response.text);
      const errorEvent = events.find((e) => e.type === 'client_error');

      expect(errorEvent).toBeDefined();
    });

    it('should handle lambda connection error in direct mode', async () => {
      // Use invalid lambda URL
      const { app } = createTestClientServer(mockBroker.url, 'ws://localhost:99999');

      const response = await request(app).post('/api/execute/direct').send({ code: 'return 1' });

      expect(response.status).toBe(200);

      const events = parseNdjson(response.text);
      const errorEvent = events.find((e) => e.type === 'client_error');

      expect(errorEvent).toBeDefined();
    });
  });

  describe('Protocol Compliance', () => {
    it('should forward protocolVersion from broker', async () => {
      const { app } = createTestClientServer(mockBroker.url, mockLambda.url);

      const response = await request(app).post('/api/execute/embedded').send({ code: 'return 1' });

      const events = parseNdjson(response.text);

      for (const event of events.filter((e) => e.type !== 'client_result' && e.type !== 'client_error')) {
        expect(event.protocolVersion).toBe(PROTOCOL_VERSION);
      }
    });

    it('should forward sessionId from broker', async () => {
      const { app } = createTestClientServer(mockBroker.url, mockLambda.url);

      const response = await request(app).post('/api/execute/embedded').send({ code: 'return 1' });

      const events = parseNdjson(response.text).filter((e) => e.type !== 'client_result' && e.type !== 'client_error');
      const sessionId = events[0].sessionId;

      for (const event of events) {
        expect(event.sessionId).toBe(sessionId);
      }
    });

    it('should forward sequential seq numbers', async () => {
      const { app } = createTestClientServer(mockBroker.url, mockLambda.url);

      const response = await request(app).post('/api/execute/embedded').send({ code: 'return 1' });

      const events = parseNdjson(response.text).filter((e) => e.type !== 'client_result' && e.type !== 'client_error');

      for (let i = 0; i < events.length; i++) {
        expect(events[i].seq).toBe(i + 1);
      }
    });
  });
});
