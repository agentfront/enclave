/**
 * Broker Server Tests
 *
 * Tests for the Broker server that supports:
 * 1. Embedded mode - Code executes directly in broker
 * 2. Lambda mode - Code executes on Lambda via WebSocket
 *
 * The broker:
 * - Validates and sanitizes input
 * - Manages tool handlers
 * - Streams events to clients via NDJSON
 */

import express, { Express } from 'express';
import { Server } from 'http';
import request from 'supertest';
import { WebSocket, WebSocketServer } from 'ws';
import type { AddressInfo } from 'net';
import type { SessionId, CallId, StreamEvent } from '@enclavejs/types';
import { generateSessionId, PROTOCOL_VERSION } from '@enclavejs/types';
import { z } from 'zod';
import { Enclave } from 'enclave-vm';
import { parseNdjson, delay, testCode } from './test-utils';

// Tool handlers for testing
const testToolHandlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
  getCurrentTime: async () => ({
    timestamp: new Date().toISOString(),
    server: 'test-broker',
  }),
  addNumbers: async (args) => {
    const { a, b } = args as { a: number; b: number };
    return { result: a + b };
  },
  greet: async (args) => {
    const { name } = args as { name: string };
    return { greeting: `Hello, ${name}!` };
  },
  failingTool: async () => {
    throw new Error('Tool intentionally failed');
  },
};

// Create a test broker server
function createTestBrokerServer(): {
  app: Express;
  start: () => Promise<{ server: Server; port: number; url: string }>;
} {
  const app = express();
  app.use(express.json());

  const executeRequestSchema = z.object({
    code: z.string().min(1).max(100000),
  });

  // Embedded mode endpoint
  app.post('/sessions/embedded', async (req, res) => {
    const parseResult = executeRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({ error: 'Invalid request', details: parseResult.error.issues });
      return;
    }

    const { code } = parseResult.data;
    const sessionId = generateSessionId();
    let seq = 0;

    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');

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

    const enclave = new Enclave({
      timeout: 5000,
      maxIterations: 10000,
      toolHandler: async (toolName: string, args: Record<string, unknown>) => {
        const callId = `c_${Math.random().toString(36).slice(2)}` as CallId;

        res.write(
          JSON.stringify({
            protocolVersion: PROTOCOL_VERSION,
            sessionId,
            seq: ++seq,
            type: 'tool_call',
            payload: { callId, toolName, args },
          }) + '\n',
        );

        const handler = testToolHandlers[toolName];
        if (!handler) {
          throw new Error(`Unknown tool: ${toolName}`);
        }

        const result = await handler(args);

        res.write(
          JSON.stringify({
            protocolVersion: PROTOCOL_VERSION,
            sessionId,
            seq: ++seq,
            type: 'tool_result_applied',
            payload: { callId },
          }) + '\n',
        );

        return result;
      },
    });

    try {
      const result = await enclave.run(code);

      res.write(
        JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          sessionId,
          seq: ++seq,
          type: 'final',
          payload: {
            ok: result.success,
            result: result.value,
            error: result.error ? { code: 'EXECUTION_ERROR', message: result.error.message } : undefined,
            stats: {
              durationMs: result.stats?.duration ?? 0,
              toolCallCount: result.stats?.toolCallCount ?? 0,
              stdoutBytes: 0,
            },
          },
        }) + '\n',
      );
    } catch (error) {
      res.write(
        JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          sessionId,
          seq: ++seq,
          type: 'final',
          payload: {
            ok: false,
            error: { code: 'RUNTIME_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
            stats: { durationMs: 0, toolCallCount: 0, stdoutBytes: 0 },
          },
        }) + '\n',
      );
    } finally {
      enclave.dispose();
      res.end();
    }
  });

  // Health endpoint
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', tools: Object.keys(testToolHandlers) });
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

describe('Broker Server', () => {
  describe('Health Check', () => {
    it('should return health status with tools list', async () => {
      const { app } = createTestBrokerServer();

      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        status: 'ok',
        tools: expect.arrayContaining(['getCurrentTime', 'addNumbers', 'greet']),
      });
    });
  });

  describe('Input Validation', () => {
    it('should reject requests without code', async () => {
      const { app } = createTestBrokerServer();

      const response = await request(app).post('/sessions/embedded').send({});

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error', 'Invalid request');
    });

    it('should reject requests with empty code', async () => {
      const { app } = createTestBrokerServer();

      const response = await request(app).post('/sessions/embedded').send({ code: '' });

      expect(response.status).toBe(400);
    });

    it('should accept valid code', async () => {
      const { app } = createTestBrokerServer();

      const response = await request(app)
        .post('/sessions/embedded')
        .send({ code: 'return 1' })
        .set('Accept', 'application/x-ndjson');

      expect(response.status).toBe(200);
    });
  });

  describe('Embedded Mode Execution', () => {
    it('should execute simple code and return NDJSON stream', async () => {
      const { app } = createTestBrokerServer();

      const response = await request(app)
        .post('/sessions/embedded')
        .send({ code: testCode.simple })
        .set('Accept', 'application/x-ndjson');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('application/x-ndjson');

      const events = parseNdjson(response.text);

      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events[0].type).toBe('session_init');
      expect(events[events.length - 1].type).toBe('final');
      expect((events[events.length - 1].payload as { ok: boolean; result: unknown }).ok).toBe(true);
      expect((events[events.length - 1].payload as { ok: boolean; result: unknown }).result).toBe(3);
    });

    it('should handle tool calls in embedded mode', async () => {
      const { app } = createTestBrokerServer();

      const response = await request(app)
        .post('/sessions/embedded')
        .send({ code: testCode.withTool })
        .set('Accept', 'application/x-ndjson');

      expect(response.status).toBe(200);

      const events = parseNdjson(response.text);

      // Should have: session_init, tool_call, tool_result_applied, final
      const toolCall = events.find((e) => e.type === 'tool_call');
      const toolResultApplied = events.find((e) => e.type === 'tool_result_applied');
      const final = events.find((e) => e.type === 'final');

      expect(toolCall).toBeDefined();
      expect(toolCall!.payload).toEqual(
        expect.objectContaining({
          toolName: 'getCurrentTime',
          args: {},
        }),
      );

      expect(toolResultApplied).toBeDefined();
      expect(final).toBeDefined();
      expect((final!.payload as { ok: boolean }).ok).toBe(true);
    });

    it('should handle multiple tool calls', async () => {
      const { app } = createTestBrokerServer();

      const response = await request(app)
        .post('/sessions/embedded')
        .send({ code: testCode.multiTool })
        .set('Accept', 'application/x-ndjson');

      expect(response.status).toBe(200);

      const events = parseNdjson(response.text);
      const toolCalls = events.filter((e) => e.type === 'tool_call');

      expect(toolCalls.length).toBe(2);
      expect((toolCalls[0].payload as { toolName: string }).toolName).toBe('getCurrentTime');
      expect((toolCalls[1].payload as { toolName: string }).toolName).toBe('addNumbers');
    });

    it('should handle execution errors', async () => {
      const { app } = createTestBrokerServer();

      const response = await request(app)
        .post('/sessions/embedded')
        .send({ code: testCode.error })
        .set('Accept', 'application/x-ndjson');

      expect(response.status).toBe(200);

      const events = parseNdjson(response.text);
      const final = events.find((e) => e.type === 'final');

      expect(final).toBeDefined();
      expect((final!.payload as { ok: boolean }).ok).toBe(false);
      expect((final!.payload as { error: { message: string } }).error.message).toContain('Tool intentionally failed');
    });

    it('should handle unknown tool errors', async () => {
      const { app } = createTestBrokerServer();

      const response = await request(app)
        .post('/sessions/embedded')
        .send({ code: 'return await callTool("unknownTool", {})' })
        .set('Accept', 'application/x-ndjson');

      expect(response.status).toBe(200);

      const events = parseNdjson(response.text);
      const final = events.find((e) => e.type === 'final');

      expect(final).toBeDefined();
      expect((final!.payload as { ok: boolean }).ok).toBe(false);
      expect((final!.payload as { error: { message: string } }).error.message).toContain('Unknown tool');
    });
  });

  describe('Protocol Compliance', () => {
    it('should include all required fields in session_init', async () => {
      const { app } = createTestBrokerServer();

      const response = await request(app)
        .post('/sessions/embedded')
        .send({ code: testCode.simple })
        .set('Accept', 'application/x-ndjson');

      const events = parseNdjson(response.text);
      const sessionInit = events.find((e) => e.type === 'session_init');

      expect(sessionInit).toBeDefined();
      expect(sessionInit!.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(sessionInit!.sessionId).toMatch(/^s_/);
      expect(sessionInit!.seq).toBe(1);
      expect(sessionInit!.payload).toEqual(
        expect.objectContaining({
          expiresAt: expect.any(String),
          encryption: { enabled: false },
        }),
      );
    });

    it('should include stats in final event', async () => {
      const { app } = createTestBrokerServer();

      const response = await request(app)
        .post('/sessions/embedded')
        .send({ code: testCode.withTool })
        .set('Accept', 'application/x-ndjson');

      const events = parseNdjson(response.text);
      const final = events.find((e) => e.type === 'final');

      expect(final).toBeDefined();
      const payload = final!.payload as unknown as {
        stats: { durationMs: number; toolCallCount: number; stdoutBytes: number };
      };
      expect(payload.stats).toEqual(
        expect.objectContaining({
          durationMs: expect.any(Number),
          toolCallCount: expect.any(Number),
          stdoutBytes: expect.any(Number),
        }),
      );
    });

    it('should maintain sequential seq numbers', async () => {
      const { app } = createTestBrokerServer();

      const response = await request(app)
        .post('/sessions/embedded')
        .send({ code: testCode.withTool })
        .set('Accept', 'application/x-ndjson');

      const events = parseNdjson(response.text);

      for (let i = 0; i < events.length; i++) {
        expect(events[i].seq).toBe(i + 1);
      }
    });

    it('should use consistent sessionId across all events', async () => {
      const { app } = createTestBrokerServer();

      const response = await request(app)
        .post('/sessions/embedded')
        .send({ code: testCode.withTool })
        .set('Accept', 'application/x-ndjson');

      const events = parseNdjson(response.text);
      const sessionId = events[0].sessionId;

      for (const event of events) {
        expect(event.sessionId).toBe(sessionId);
      }
    });
  });

  describe('Tool Handlers', () => {
    it('should execute getCurrentTime tool', async () => {
      const { app } = createTestBrokerServer();

      const response = await request(app)
        .post('/sessions/embedded')
        .send({ code: 'return await callTool("getCurrentTime", {})' })
        .set('Accept', 'application/x-ndjson');

      const events = parseNdjson(response.text);
      const final = events.find((e) => e.type === 'final');

      expect((final!.payload as { ok: boolean; result: { timestamp: string } }).ok).toBe(true);
      expect((final!.payload as { result: { timestamp: string } }).result.timestamp).toBeDefined();
    });

    it('should execute addNumbers tool with arguments', async () => {
      const { app } = createTestBrokerServer();

      const response = await request(app)
        .post('/sessions/embedded')
        .send({ code: 'return await callTool("addNumbers", { a: 5, b: 7 })' })
        .set('Accept', 'application/x-ndjson');

      const events = parseNdjson(response.text);
      const final = events.find((e) => e.type === 'final');

      expect((final!.payload as { ok: boolean }).ok).toBe(true);
      expect((final!.payload as { result: { result: number } }).result.result).toBe(12);
    });

    it('should execute greet tool', async () => {
      const { app } = createTestBrokerServer();

      const response = await request(app)
        .post('/sessions/embedded')
        .send({ code: 'return await callTool("greet", { name: "World" })' })
        .set('Accept', 'application/x-ndjson');

      const events = parseNdjson(response.text);
      const final = events.find((e) => e.type === 'final');

      expect((final!.payload as { ok: boolean }).ok).toBe(true);
      expect((final!.payload as { result: { greeting: string } }).result.greeting).toBe('Hello, World!');
    });
  });
});
