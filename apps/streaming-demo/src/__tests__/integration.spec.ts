/**
 * Integration Tests
 *
 * Tests the full 3-tier architecture:
 * Client → Broker → Lambda
 *
 * These tests spin up actual servers and test the complete flow.
 */

import express, { Express, Request, Response } from 'express';
import { Server } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import type { AddressInfo } from 'net';
import type { SessionId, CallId, StreamEvent } from '@enclave-vm/types';
import { generateSessionId, PROTOCOL_VERSION } from '@enclave-vm/types';
import { Enclave } from '@enclave-vm/core';
import { parseNdjson, delay, testCode } from './test-utils';

// Integration test helpers

interface TestServer {
  server: Server;
  port: number;
  url: string;
  close: () => Promise<void>;
}

interface TestWebSocketServer {
  wss: WebSocketServer;
  port: number;
  url: string;
  close: () => Promise<void>;
}

// Tool handlers
const toolHandlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
  getCurrentTime: async () => ({ timestamp: new Date().toISOString(), server: 'integration-test' }),
  addNumbers: async (args) => {
    const { a, b } = args as { a: number; b: number };
    return { result: a + b };
  },
  multiply: async (args) => {
    const { a, b } = args as { a: number; b: number };
    return { result: a * b };
  },
  greet: async (args) => {
    const { name } = args as { name: string };
    return { greeting: `Hello, ${name}!` };
  },
  failingTool: async () => {
    throw new Error('Tool intentionally failed');
  },
};

// Create Lambda/Runtime server (WebSocket only)
function createLambdaServer(): Promise<TestWebSocketServer> {
  return new Promise((resolve) => {
    const sessions = new Map<
      SessionId,
      {
        enclave: Enclave;
        pendingToolCalls: Map<CallId, (result: unknown) => void>;
      }
    >();

    const wss = new WebSocketServer({ port: 0 });

    wss.on('connection', (ws: WebSocket) => {
      ws.on('message', async (data: Buffer) => {
        const message = JSON.parse(data.toString());

        if (message.type === 'execute') {
          const sessionId = message.sessionId as SessionId;
          const code = message.code as string;
          let seq = 0;

          const sendEvent = (event: StreamEvent) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify(event));
            }
          };

          sendEvent({
            protocolVersion: PROTOCOL_VERSION,
            sessionId,
            seq: ++seq,
            type: 'session_init',
            payload: {
              cancelUrl: `/sessions/${sessionId}/cancel`,
              expiresAt: new Date(Date.now() + 60000).toISOString(),
              encryption: { enabled: false },
            },
          });

          const pendingToolCalls = new Map<CallId, (result: unknown) => void>();

          const enclave = new Enclave({
            timeout: 5000,
            maxIterations: 10000,
            toolHandler: async (toolName: string, args: Record<string, unknown>) => {
              const callId = `c_${Math.random().toString(36).slice(2)}` as CallId;

              sendEvent({
                protocolVersion: PROTOCOL_VERSION,
                sessionId,
                seq: ++seq,
                type: 'tool_call',
                payload: { callId, toolName, args },
              });

              return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                  pendingToolCalls.delete(callId);
                  reject(new Error(`Tool timeout`));
                }, 5000);

                pendingToolCalls.set(callId, (result: unknown) => {
                  clearTimeout(timeout);
                  pendingToolCalls.delete(callId);

                  sendEvent({
                    protocolVersion: PROTOCOL_VERSION,
                    sessionId,
                    seq: ++seq,
                    type: 'tool_result_applied',
                    payload: { callId },
                  });

                  // Check if the result is an error marker
                  if (
                    result &&
                    typeof result === 'object' &&
                    '__error' in result &&
                    (result as { __error: boolean }).__error
                  ) {
                    reject(new Error((result as { message?: string }).message || 'Tool call failed'));
                  } else {
                    resolve(result);
                  }
                });
              });
            },
          });

          sessions.set(sessionId, { enclave, pendingToolCalls });

          try {
            const result = await enclave.run(code);

            sendEvent({
              protocolVersion: PROTOCOL_VERSION,
              sessionId,
              seq: ++seq,
              type: 'final',
              payload: {
                ok: result.success,
                result: result.value,
                error: result.error ? { code: 'ERROR', message: result.error.message } : undefined,
                stats: {
                  durationMs: result.stats?.duration ?? 0,
                  toolCallCount: result.stats?.toolCallCount ?? 0,
                  stdoutBytes: 0,
                },
              },
            });
          } catch (error) {
            sendEvent({
              protocolVersion: PROTOCOL_VERSION,
              sessionId,
              seq: ++seq,
              type: 'final',
              payload: {
                ok: false,
                error: { code: 'ERROR', message: error instanceof Error ? error.message : 'Unknown' },
                stats: { durationMs: 0, toolCallCount: 0, stdoutBytes: 0 },
              },
            });
          } finally {
            enclave.dispose();
            sessions.delete(sessionId);
          }
        } else if (message.type === 'tool_result') {
          const session = sessions.get(message.sessionId as SessionId);
          if (session) {
            const resolver = session.pendingToolCalls.get(message.callId as CallId);
            if (resolver) {
              if (message.success === false) {
                // For failed tool calls, pass an error object that the toolHandler can detect
                const errorMessage = (message.error as { message?: string })?.message || 'Tool call failed';
                resolver({ __error: true, message: errorMessage });
              } else {
                resolver(message.value);
              }
            }
          }
        }
      });
    });

    wss.on('listening', () => {
      const address = wss.address() as AddressInfo;
      resolve({
        wss,
        port: address.port,
        url: `ws://localhost:${address.port}`,
        close: () =>
          new Promise<void>((res) => {
            for (const session of sessions.values()) {
              session.enclave.dispose();
            }
            wss.close(() => res());
          }),
      });
    });
  });
}

// Create Broker server (with Lambda mode support)
function createBrokerServer(lambdaUrl: string): Promise<TestServer> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());

    const activeSessions = new Map<SessionId, { ws: WebSocket; res: Response }>();

    // Embedded mode
    app.post('/sessions/embedded', async (req, res) => {
      const { code } = req.body;
      const sessionId = generateSessionId();
      let seq = 0;

      res.setHeader('Content-Type', 'application/x-ndjson');

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

          const handler = toolHandlers[toolName];
          if (!handler) throw new Error(`Unknown tool: ${toolName}`);

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
              error: result.error ? { code: 'ERROR', message: result.error.message } : undefined,
              stats: { durationMs: 0, toolCallCount: result.stats?.toolCallCount ?? 0, stdoutBytes: 0 },
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
              error: { code: 'ERROR', message: error instanceof Error ? error.message : 'Unknown' },
              stats: { durationMs: 0, toolCallCount: 0, stdoutBytes: 0 },
            },
          }) + '\n',
        );
      } finally {
        enclave.dispose();
        res.end();
      }
    });

    // Lambda mode
    app.post('/sessions/lambda', async (req, res) => {
      const { code } = req.body;
      const sessionId = generateSessionId();

      res.setHeader('Content-Type', 'application/x-ndjson');

      try {
        const ws = new WebSocket(lambdaUrl);

        await new Promise<void>((resolve, reject) => {
          ws.on('open', () => resolve());
          ws.on('error', reject);
          setTimeout(() => reject(new Error('Connection timeout')), 5000);
        });

        activeSessions.set(sessionId, { ws, res });

        ws.on('message', async (data: Buffer) => {
          const event = JSON.parse(data.toString()) as StreamEvent;

          if (res.writable) {
            res.write(JSON.stringify(event) + '\n');
          }

          if (event.type === 'tool_call') {
            const { callId, toolName, args } = event.payload as {
              callId: CallId;
              toolName: string;
              args: Record<string, unknown>;
            };
            const handler = toolHandlers[toolName];

            if (handler) {
              try {
                const result = await handler(args);
                ws.send(JSON.stringify({ type: 'tool_result', sessionId, callId, success: true, value: result }));
              } catch (error) {
                ws.send(
                  JSON.stringify({
                    type: 'tool_result',
                    sessionId,
                    callId,
                    success: false,
                    error: { message: error instanceof Error ? error.message : 'Unknown' },
                  }),
                );
              }
            }
          }

          if (event.type === 'final') {
            ws.close();
            if (res.writable) {
              res.end();
            }
            activeSessions.delete(sessionId);
          }
        });

        ws.send(JSON.stringify({ type: 'execute', sessionId, code }));
      } catch (error) {
        res.write(
          JSON.stringify({
            protocolVersion: PROTOCOL_VERSION,
            sessionId,
            seq: 1,
            type: 'final',
            payload: {
              ok: false,
              error: { code: 'CONNECTION_ERROR', message: 'Failed to connect to Lambda' },
              stats: { durationMs: 0, toolCallCount: 0, stdoutBytes: 0 },
            },
          }) + '\n',
        );
        res.end();
      }
    });

    app.get('/health', (req, res) => {
      res.json({ status: 'ok' });
    });

    const server = app.listen(0, () => {
      const address = server.address() as AddressInfo;
      resolve({
        server,
        port: address.port,
        url: `http://localhost:${address.port}`,
        close: () =>
          new Promise<void>((res) => {
            for (const session of activeSessions.values()) {
              session.ws.close();
            }
            server.close(() => res());
          }),
      });
    });
  });
}

describe('Integration Tests', () => {
  let lambdaServer: TestWebSocketServer;
  let brokerServer: TestServer;

  beforeAll(async () => {
    lambdaServer = await createLambdaServer();
    brokerServer = await createBrokerServer(lambdaServer.url);
  });

  afterAll(async () => {
    await brokerServer.close();
    await lambdaServer.close();
  });

  describe('Embedded Mode (Client → Broker)', () => {
    it('should execute code in embedded mode', async () => {
      const response = await fetch(`${brokerServer.url}/sessions/embedded`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: testCode.simple }),
      });

      expect(response.ok).toBe(true);

      const text = await response.text();
      const events = parseNdjson(text);

      expect(events[0].type).toBe('session_init');
      expect(events[events.length - 1].type).toBe('final');
      expect((events[events.length - 1].payload as { ok: boolean; result: unknown }).ok).toBe(true);
      expect((events[events.length - 1].payload as { result: number }).result).toBe(3);
    });

    it('should handle tool calls in embedded mode', async () => {
      const response = await fetch(`${brokerServer.url}/sessions/embedded`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: testCode.withTool }),
      });

      const text = await response.text();
      const events = parseNdjson(text);

      const toolCall = events.find((e) => e.type === 'tool_call');
      const final = events.find((e) => e.type === 'final');

      expect(toolCall).toBeDefined();
      expect((final!.payload as { ok: boolean }).ok).toBe(true);
    });
  });

  describe('Lambda Mode (Client → Broker → Lambda)', () => {
    it('should execute code via Lambda', async () => {
      const response = await fetch(`${brokerServer.url}/sessions/lambda`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: testCode.simple }),
      });

      expect(response.ok).toBe(true);

      const text = await response.text();
      const events = parseNdjson(text);

      expect(events[0].type).toBe('session_init');
      expect(events[events.length - 1].type).toBe('final');
      expect((events[events.length - 1].payload as { ok: boolean }).ok).toBe(true);
    });

    it('should handle tool calls through broker', async () => {
      const response = await fetch(`${brokerServer.url}/sessions/lambda`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: testCode.withTool }),
      });

      const text = await response.text();
      const events = parseNdjson(text);

      // Lambda sends tool_call, Broker handles it, sends result back
      const toolCall = events.find((e) => e.type === 'tool_call');
      const toolResultApplied = events.find((e) => e.type === 'tool_result_applied');
      const final = events.find((e) => e.type === 'final');

      expect(toolCall).toBeDefined();
      expect((toolCall!.payload as { toolName: string }).toolName).toBe('getCurrentTime');
      expect(toolResultApplied).toBeDefined();
      expect((final!.payload as { ok: boolean }).ok).toBe(true);
    });

    it('should handle multiple tool calls', async () => {
      const response = await fetch(`${brokerServer.url}/sessions/lambda`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: testCode.multiTool }),
      });

      const text = await response.text();
      const events = parseNdjson(text);

      const toolCalls = events.filter((e) => e.type === 'tool_call');
      const final = events.find((e) => e.type === 'final');

      expect(toolCalls.length).toBe(2);
      expect((final!.payload as { ok: boolean }).ok).toBe(true);
    });

    it('should handle execution errors in Lambda', async () => {
      const response = await fetch(`${brokerServer.url}/sessions/lambda`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: testCode.error }),
      });

      const text = await response.text();
      const events = parseNdjson(text);

      const final = events.find((e) => e.type === 'final');

      expect((final!.payload as { ok: boolean }).ok).toBe(false);
      expect((final!.payload as { error: { message: string } }).error.message).toContain('Tool intentionally failed');
    });
  });

  describe('Mode Comparison', () => {
    it('should produce same result in embedded and lambda modes', async () => {
      const embeddedResponse = await fetch(`${brokerServer.url}/sessions/embedded`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'return await callTool("addNumbers", { a: 10, b: 20 })' }),
      });

      const lambdaResponse = await fetch(`${brokerServer.url}/sessions/lambda`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'return await callTool("addNumbers", { a: 10, b: 20 })' }),
      });

      const embeddedEvents = parseNdjson(await embeddedResponse.text());
      const lambdaEvents = parseNdjson(await lambdaResponse.text());

      const embeddedFinal = embeddedEvents.find((e) => e.type === 'final');
      const lambdaFinal = lambdaEvents.find((e) => e.type === 'final');

      expect((embeddedFinal!.payload as { result: { result: number } }).result.result).toBe(30);
      expect((lambdaFinal!.payload as { result: { result: number } }).result.result).toBe(30);
    });

    it('should have same event types in both modes', async () => {
      const code = testCode.withTool;

      const embeddedResponse = await fetch(`${brokerServer.url}/sessions/embedded`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });

      const lambdaResponse = await fetch(`${brokerServer.url}/sessions/lambda`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });

      const embeddedEvents = parseNdjson(await embeddedResponse.text());
      const lambdaEvents = parseNdjson(await lambdaResponse.text());

      const embeddedTypes = embeddedEvents.map((e) => e.type);
      const lambdaTypes = lambdaEvents.map((e) => e.type);

      // Both should have: session_init, tool_call, tool_result_applied, final
      expect(embeddedTypes).toContain('session_init');
      expect(embeddedTypes).toContain('tool_call');
      expect(embeddedTypes).toContain('tool_result_applied');
      expect(embeddedTypes).toContain('final');

      expect(lambdaTypes).toContain('session_init');
      expect(lambdaTypes).toContain('tool_call');
      expect(lambdaTypes).toContain('tool_result_applied');
      expect(lambdaTypes).toContain('final');
    });
  });

  describe('Chained Tool Calls', () => {
    it('should handle complex tool chains', async () => {
      const code = `
        const sum = await callTool("addNumbers", { a: 10, b: 20 });
        const product = await callTool("multiply", { a: sum.result, b: 3 });
        return { sum: sum.result, product: product.result };
      `;

      const response = await fetch(`${brokerServer.url}/sessions/lambda`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });

      const text = await response.text();
      const events = parseNdjson(text);

      const final = events.find((e) => e.type === 'final');

      expect((final!.payload as { ok: boolean }).ok).toBe(true);
      expect((final!.payload as { result: { sum: number; product: number } }).result).toEqual({
        sum: 30,
        product: 90,
      });
    });
  });
});
