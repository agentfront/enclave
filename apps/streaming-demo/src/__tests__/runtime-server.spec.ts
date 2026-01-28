/**
 * Runtime Server Tests
 *
 * Tests for the Lambda/Runtime server that executes code via WebSocket.
 * The runtime server:
 * - Only accepts WebSocket connections (no HTTP endpoints)
 * - Executes code in enclave-vm
 * - Sends tool_call events and waits for tool_result
 * - Supports session cancellation
 */

import { WebSocket, WebSocketServer } from 'ws';
import type { AddressInfo, Server } from 'net';
import type { SessionId, CallId, StreamEvent } from '@enclave-vm/types';
import { generateSessionId, PROTOCOL_VERSION } from '@enclave-vm/types';
import { Enclave } from '@enclave-vm/core';
import { waitForConnection, collectEvents, delay, testCode } from './test-utils';

// We'll create a minimal runtime server for testing
// This mimics the actual runtime-server.ts but is self-contained

interface ActiveSession {
  sessionId: SessionId;
  enclave: Enclave;
  ws: WebSocket;
  pendingToolCalls: Map<CallId, (result: unknown) => void>;
}

function createTestRuntimeServer(): Promise<{
  wss: WebSocketServer;
  port: number;
  url: string;
  sessions: Map<SessionId, ActiveSession>;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const sessions = new Map<SessionId, ActiveSession>();
    const wss = new WebSocketServer({ port: 0 });

    wss.on('connection', (ws: WebSocket) => {
      ws.on('message', async (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());
          await handleMessage(ws, message, sessions);
        } catch {
          // Ignore parse errors
        }
      });

      ws.on('close', () => {
        // Clean up sessions for this WebSocket
        for (const [sessionId, session] of sessions) {
          if (session.ws === ws) {
            session.enclave.dispose();
            sessions.delete(sessionId);
          }
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
        sessions,
        close: () =>
          new Promise<void>((res) => {
            for (const session of sessions.values()) {
              session.enclave.dispose();
            }
            sessions.clear();
            wss.close(() => res());
          }),
      });
    });
  });
}

async function handleMessage(
  ws: WebSocket,
  message: { type: string; [key: string]: unknown },
  sessions: Map<SessionId, ActiveSession>,
) {
  const sendEvent = (event: StreamEvent) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(event));
    }
  };

  if (message.type === 'execute') {
    const sessionId = (message.sessionId ?? generateSessionId()) as SessionId;
    const code = message.code as string;
    let seq = 0;

    // Send session_init
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
            reject(new Error(`Tool call ${toolName} timed out`));
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

            resolve(result);
          });
        });
      },
    });

    const session: ActiveSession = { sessionId, enclave, ws, pendingToolCalls };
    sessions.set(sessionId, session);

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
          error: result.error ? { code: 'EXECUTION_ERROR', message: result.error.message } : undefined,
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
          error: {
            code: 'RUNTIME_ERROR',
            message: error instanceof Error ? error.message : 'Unknown error',
          },
          stats: { durationMs: 0, toolCallCount: 0, stdoutBytes: 0 },
        },
      });
    } finally {
      enclave.dispose();
      sessions.delete(sessionId);
    }
  } else if (message.type === 'tool_result') {
    const sessionId = message.sessionId as SessionId;
    const callId = message.callId as CallId;
    const session = sessions.get(sessionId);

    if (session) {
      const resolver = session.pendingToolCalls.get(callId);
      if (resolver) {
        if (message.success) {
          resolver(message.value);
        } else {
          resolver({ __error: true, ...((message.error as object) || {}) });
        }
      }
    }
  } else if (message.type === 'cancel') {
    const sessionId = message.sessionId as SessionId;
    const session = sessions.get(sessionId);

    if (session) {
      session.enclave.dispose();
      session.pendingToolCalls.clear();
      sessions.delete(sessionId);
    }
  }
}

describe('Runtime Server', () => {
  let server: Awaited<ReturnType<typeof createTestRuntimeServer>>;

  beforeEach(async () => {
    server = await createTestRuntimeServer();
  });

  afterEach(async () => {
    await server.close();
  });

  describe('WebSocket Connection', () => {
    it('should accept WebSocket connections', async () => {
      const ws = new WebSocket(server.url);
      await waitForConnection(ws);
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    });

    it('should handle multiple concurrent connections', async () => {
      const connections = await Promise.all(
        Array(3)
          .fill(null)
          .map(async () => {
            const ws = new WebSocket(server.url);
            await waitForConnection(ws);
            return ws;
          }),
      );

      expect(connections.every((ws) => ws.readyState === WebSocket.OPEN)).toBe(true);
      connections.forEach((ws) => ws.close());
    });
  });

  describe('Code Execution', () => {
    it('should execute simple code and return result', async () => {
      const ws = new WebSocket(server.url);
      await waitForConnection(ws);

      const sessionId = generateSessionId();
      ws.send(JSON.stringify({ type: 'execute', sessionId, code: testCode.simple }));

      const events = await collectEvents(ws);

      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events[0].type).toBe('session_init');
      expect(events[events.length - 1].type).toBe('final');

      const finalEvent = events[events.length - 1];
      expect(finalEvent.payload).toEqual(
        expect.objectContaining({
          ok: true,
          result: 3,
        }),
      );

      ws.close();
    });

    it('should handle execution errors', async () => {
      const ws = new WebSocket(server.url);
      await waitForConnection(ws);

      const sessionId = generateSessionId();
      // Use runtimeError which doesn't require tool calls
      ws.send(JSON.stringify({ type: 'execute', sessionId, code: testCode.runtimeError }));

      const events = await collectEvents(ws);

      const finalEvent = events[events.length - 1];
      expect(finalEvent.payload).toEqual(
        expect.objectContaining({
          ok: false,
          error: expect.objectContaining({
            message: expect.any(String),
          }),
        }),
      );

      ws.close();
    });

    it('should generate unique session IDs if not provided', async () => {
      const ws = new WebSocket(server.url);
      await waitForConnection(ws);

      ws.send(JSON.stringify({ type: 'execute', code: testCode.simple }));

      const events = await collectEvents(ws);

      expect(events[0].type).toBe('session_init');
      expect(events[0].sessionId).toMatch(/^s_/);

      ws.close();
    });
  });

  describe('Tool Calls', () => {
    it('should send tool_call events and wait for results', async () => {
      const ws = new WebSocket(server.url);
      await waitForConnection(ws);

      const sessionId = generateSessionId();
      ws.send(JSON.stringify({ type: 'execute', sessionId, code: testCode.withTool }));

      // Wait for tool_call event
      const toolCallPromise = new Promise<StreamEvent>((resolve) => {
        const handler = (data: Buffer) => {
          const event = JSON.parse(data.toString()) as StreamEvent;
          if (event.type === 'tool_call') {
            ws.off('message', handler);
            resolve(event);
          }
        };
        ws.on('message', handler);
      });

      const toolCallEvent = await toolCallPromise;
      expect(toolCallEvent.payload).toEqual(
        expect.objectContaining({
          toolName: 'getCurrentTime',
          args: {},
        }),
      );

      // Send tool result
      const callId = (toolCallEvent.payload as { callId: CallId }).callId;
      ws.send(
        JSON.stringify({
          type: 'tool_result',
          sessionId,
          callId,
          success: true,
          value: { timestamp: '2024-01-01T00:00:00Z' },
        }),
      );

      // Wait for final event
      const finalPromise = new Promise<StreamEvent>((resolve) => {
        const handler = (data: Buffer) => {
          const event = JSON.parse(data.toString()) as StreamEvent;
          if (event.type === 'final') {
            ws.off('message', handler);
            resolve(event);
          }
        };
        ws.on('message', handler);
      });

      const finalEvent = await finalPromise;
      expect(finalEvent.payload).toEqual(
        expect.objectContaining({
          ok: true,
          result: { timestamp: '2024-01-01T00:00:00Z' },
        }),
      );

      ws.close();
    });

    it('should send tool_result_applied after receiving result', async () => {
      const ws = new WebSocket(server.url);
      await waitForConnection(ws);

      const sessionId = generateSessionId();
      const receivedEvents: StreamEvent[] = [];

      ws.on('message', (data: Buffer) => {
        receivedEvents.push(JSON.parse(data.toString()) as StreamEvent);
      });

      ws.send(JSON.stringify({ type: 'execute', sessionId, code: testCode.withTool }));

      // Wait for tool_call
      await delay(100);
      const toolCallEvent = receivedEvents.find((e) => e.type === 'tool_call');
      expect(toolCallEvent).toBeDefined();

      // Send tool result
      const callId = (toolCallEvent!.payload as { callId: CallId }).callId;
      ws.send(
        JSON.stringify({
          type: 'tool_result',
          sessionId,
          callId,
          success: true,
          value: { timestamp: 'now' },
        }),
      );

      // Wait for final
      await delay(200);

      const toolResultApplied = receivedEvents.find((e) => e.type === 'tool_result_applied');
      expect(toolResultApplied).toBeDefined();
      expect(toolResultApplied!.payload).toEqual(
        expect.objectContaining({
          callId,
        }),
      );

      ws.close();
    });
  });

  describe('Session Management', () => {
    it('should track active sessions', async () => {
      const ws = new WebSocket(server.url);
      await waitForConnection(ws);

      const sessionId = generateSessionId();

      // Start long-running code
      ws.send(
        JSON.stringify({
          type: 'execute',
          sessionId,
          code: 'return await callTool("wait", {})',
        }),
      );

      await delay(100);
      expect(server.sessions.has(sessionId)).toBe(true);

      // Send cancel
      ws.send(JSON.stringify({ type: 'cancel', sessionId }));

      await delay(100);
      expect(server.sessions.has(sessionId)).toBe(false);

      ws.close();
    });

    it('should clean up sessions on WebSocket close', async () => {
      const ws = new WebSocket(server.url);
      await waitForConnection(ws);

      const sessionId = generateSessionId();
      ws.send(
        JSON.stringify({
          type: 'execute',
          sessionId,
          code: 'return await callTool("wait", {})',
        }),
      );

      await delay(100);
      expect(server.sessions.has(sessionId)).toBe(true);

      ws.close();

      await delay(100);
      expect(server.sessions.has(sessionId)).toBe(false);
    });
  });

  describe('Protocol Compliance', () => {
    it('should include protocolVersion in all events', async () => {
      const ws = new WebSocket(server.url);
      await waitForConnection(ws);

      ws.send(JSON.stringify({ type: 'execute', code: testCode.simple }));

      const events = await collectEvents(ws);

      for (const event of events) {
        expect(event.protocolVersion).toBe(PROTOCOL_VERSION);
      }

      ws.close();
    });

    it('should increment seq for each event', async () => {
      const ws = new WebSocket(server.url);
      await waitForConnection(ws);

      ws.send(JSON.stringify({ type: 'execute', code: testCode.simple }));

      const events = await collectEvents(ws);

      for (let i = 0; i < events.length; i++) {
        expect(events[i].seq).toBe(i + 1);
      }

      ws.close();
    });

    it('should include sessionId in all events', async () => {
      const ws = new WebSocket(server.url);
      await waitForConnection(ws);

      const sessionId = generateSessionId();
      ws.send(JSON.stringify({ type: 'execute', sessionId, code: testCode.simple }));

      const events = await collectEvents(ws);

      for (const event of events) {
        expect(event.sessionId).toBe(sessionId);
      }

      ws.close();
    });
  });
});
