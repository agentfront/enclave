/**
 * Runtime Server (Lambda) - Port 4102
 *
 * WebSocket-only server that executes code in enclave-vm.
 * This simulates a Lambda/Edge function that is NOT directly accessible.
 *
 * Security: No HTTP endpoints for code execution - only WebSocket connections
 * from the broker are accepted.
 *
 * Architecture:
 *   Client ⟺ Broker (4101) ⟺ [WebSocket] ⟺ Runtime/Lambda (4102)
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { SessionId, CallId, StreamEvent } from '@enclave-vm/types';
import { generateSessionId, PROTOCOL_VERSION } from '@enclave-vm/types';
import { Enclave } from '@enclave-vm/core';
import crypto from 'crypto';

const PORT = 4102;

// Pending tool call structure with proper cleanup
interface PendingToolCall {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

// Active sessions
interface ActiveSession {
  sessionId: SessionId;
  enclave: Enclave;
  ws: WebSocket;
  seq: number;
  pendingToolCalls: Map<CallId, PendingToolCall>;
}

const sessions = new Map<SessionId, ActiveSession>();

// Create WebSocket server
const wss = new WebSocketServer({ port: PORT, path: '/ws' });

console.log('');
console.log('\x1b[35m========================================\x1b[0m');
console.log('\x1b[35m  Runtime Server (Lambda) Started\x1b[0m');
console.log('\x1b[35m========================================\x1b[0m');
console.log(`  WebSocket: ws://localhost:${PORT}/ws`);
console.log('');
console.log('  Security: No HTTP endpoints');
console.log('  Only accepts WebSocket from Broker');
console.log('');
console.log('  Message Types:');
console.log('    execute     - Start code execution');
console.log('    tool_result - Receive tool result from broker');
console.log('    cancel      - Cancel execution');
console.log('\x1b[35m========================================\x1b[0m');
console.log('');

wss.on('connection', (ws: WebSocket) => {
  console.log('\x1b[35m[Runtime]\x1b[0m Broker connected via WebSocket');

  ws.on('message', async (data: Buffer) => {
    try {
      const message = JSON.parse(data.toString());
      await handleMessage(ws, message);
    } catch (error) {
      console.error('\x1b[31m[Runtime]\x1b[0m Failed to parse message:', error);
    }
  });

  ws.on('close', () => {
    console.log('\x1b[35m[Runtime]\x1b[0m Broker disconnected');
    // Clean up any sessions for this WebSocket
    for (const [sessionId, session] of sessions) {
      if (session.ws === ws) {
        console.log(`\x1b[35m[Runtime]\x1b[0m Cleaning up session ${sessionId}`);
        session.enclave.dispose();
        sessions.delete(sessionId);
      }
    }
  });

  ws.on('error', (error) => {
    console.error('\x1b[31m[Runtime]\x1b[0m WebSocket error:', error);
  });
});

// Send event to broker
function sendEvent(ws: WebSocket, event: StreamEvent) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(event));
  }
}

// Validation helpers
function validateExecuteRequest(msg: Record<string, unknown>): ExecuteRequest | null {
  if (msg.type === 'execute' && typeof msg.code === 'string') {
    return {
      type: 'execute',
      sessionId: typeof msg.sessionId === 'string' ? (msg.sessionId as SessionId) : undefined,
      code: msg.code,
    };
  }
  return null;
}

function validateToolResultRequest(msg: Record<string, unknown>): ToolResultRequest | null {
  if (
    msg.type === 'tool_result' &&
    typeof msg.sessionId === 'string' &&
    typeof msg.callId === 'string' &&
    typeof msg.success === 'boolean'
  ) {
    return {
      type: 'tool_result',
      sessionId: msg.sessionId as SessionId,
      callId: msg.callId as CallId,
      success: msg.success,
      value: msg.value,
      error: msg.error as { code?: string; message: string } | undefined,
    };
  }
  return null;
}

function validateCancelRequest(msg: Record<string, unknown>): CancelRequest | null {
  if (msg.type === 'cancel' && typeof msg.sessionId === 'string') {
    return {
      type: 'cancel',
      sessionId: msg.sessionId as SessionId,
      reason: typeof msg.reason === 'string' ? msg.reason : undefined,
    };
  }
  return null;
}

// Handle incoming messages from broker
async function handleMessage(ws: WebSocket, message: Record<string, unknown>) {
  switch (message.type) {
    case 'execute': {
      const req = validateExecuteRequest(message);
      if (!req) {
        console.warn('\x1b[33m[Runtime]\x1b[0m Invalid execute message: missing or invalid code');
        return;
      }
      await handleExecute(ws, req);
      break;
    }
    case 'tool_result': {
      const req = validateToolResultRequest(message);
      if (!req) {
        console.warn('\x1b[33m[Runtime]\x1b[0m Invalid tool_result message: missing required fields');
        return;
      }
      handleToolResult(req);
      break;
    }
    case 'cancel': {
      const req = validateCancelRequest(message);
      if (!req) {
        console.warn('\x1b[33m[Runtime]\x1b[0m Invalid cancel message: missing sessionId');
        return;
      }
      handleCancel(req);
      break;
    }
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      break;
    default:
      console.warn(`\x1b[33m[Runtime]\x1b[0m Unknown message type: ${message.type}`);
  }
}

interface ExecuteRequest {
  type: 'execute';
  sessionId?: SessionId;
  code: string;
}

interface ToolResultRequest {
  type: 'tool_result';
  sessionId: SessionId;
  callId: CallId;
  success: boolean;
  value?: unknown;
  error?: { code?: string; message: string };
}

interface CancelRequest {
  type: 'cancel';
  sessionId: SessionId;
  reason?: string;
}

// Handle execute request
async function handleExecute(ws: WebSocket, request: ExecuteRequest) {
  const sessionId = (request.sessionId ?? generateSessionId()) as SessionId;

  console.log(`\x1b[35m[Runtime]\x1b[0m Execute request: session ${sessionId}`);

  // Check for session collision and dispose existing session
  const existingSession = sessions.get(sessionId);
  if (existingSession) {
    console.warn(`\x1b[33m[Runtime]\x1b[0m Session collision: ${sessionId}, disposing existing`);
    existingSession.enclave.dispose();
    // Reject all pending tool calls
    for (const [_callId, pending] of existingSession.pendingToolCalls) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Session replaced'));
    }
    existingSession.pendingToolCalls.clear();
    sessions.delete(sessionId);
  }

  // Create pending tool calls map for this session
  const pendingToolCalls = new Map<CallId, PendingToolCall>();
  let seq = 0;

  // Send session_init event
  sendEvent(ws, {
    protocolVersion: PROTOCOL_VERSION,
    sessionId,
    seq: ++seq,
    type: 'session_init',
    payload: {
      cancelUrl: `/sessions/${sessionId}/cancel`, // Placeholder URL for demo
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      encryption: { enabled: false },
    },
  });

  // Create enclave with tool handler that sends to broker
  const enclave = new Enclave({
    timeout: 30000,
    maxIterations: 10000,
    toolHandler: async (toolName: string, args: Record<string, unknown>) => {
      const callId = crypto.randomUUID() as CallId;

      console.log(`\x1b[35m[Runtime]\x1b[0m Tool call: ${toolName}(${JSON.stringify(args)})`);

      // Send tool_call event to broker
      const currentSession = sessions.get(sessionId);
      if (currentSession) {
        currentSession.seq = ++seq;
      }
      sendEvent(ws, {
        protocolVersion: PROTOCOL_VERSION,
        sessionId,
        seq,
        type: 'tool_call',
        payload: { callId, toolName, args },
      });

      // Wait for tool result from broker
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pendingToolCalls.delete(callId);
          reject(new Error(`Tool call ${toolName} timed out`));
        }, 30000);

        pendingToolCalls.set(callId, { resolve, reject, timeout });
      });
    },
  });

  // Store session with seq tracking
  const session: ActiveSession = {
    sessionId,
    enclave,
    ws,
    seq,
    pendingToolCalls,
  };
  sessions.set(sessionId, session);

  try {
    // Execute code
    const result = await enclave.run(request.code);

    console.log(`\x1b[35m[Runtime]\x1b[0m Session ${sessionId} completed: ${result.success ? 'SUCCESS' : 'FAILED'}`);

    // Send final event
    sendEvent(ws, {
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
    console.error(`\x1b[31m[Runtime]\x1b[0m Execution error:`, error);

    sendEvent(ws, {
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
    // Cleanup
    enclave.dispose();
    sessions.delete(sessionId);
  }
}

// Handle tool result from broker
function handleToolResult(request: ToolResultRequest) {
  const session = sessions.get(request.sessionId);
  if (!session) {
    console.warn(`\x1b[33m[Runtime]\x1b[0m Tool result for unknown session: ${request.sessionId}`);
    return;
  }

  const pending = session.pendingToolCalls.get(request.callId);
  if (!pending) {
    console.warn(`\x1b[33m[Runtime]\x1b[0m Tool result for unknown call: ${request.callId}`);
    return;
  }

  console.log(`\x1b[35m[Runtime]\x1b[0m Tool result received: ${request.callId}`);

  // Clear the timeout
  clearTimeout(pending.timeout);
  session.pendingToolCalls.delete(request.callId);

  // Send tool_result_applied event
  session.seq++;
  sendEvent(session.ws, {
    protocolVersion: PROTOCOL_VERSION,
    sessionId: request.sessionId,
    seq: session.seq,
    type: 'tool_result_applied',
    payload: { callId: request.callId },
  });

  if (request.success) {
    pending.resolve(request.value);
  } else {
    // For errors, we still resolve but with the error info
    // The enclave will handle it appropriately
    pending.resolve({ __error: true, ...request.error });
  }
}

// Handle cancel request
function handleCancel(request: CancelRequest) {
  const session = sessions.get(request.sessionId);
  if (!session) {
    console.warn(`\x1b[33m[Runtime]\x1b[0m Cancel for unknown session: ${request.sessionId}`);
    return;
  }

  console.log(`\x1b[35m[Runtime]\x1b[0m Cancelling session ${request.sessionId}: ${request.reason || 'No reason'}`);

  // Dispose enclave (this will abort execution)
  session.enclave.dispose();
  sessions.delete(request.sessionId);

  // Reject any pending tool calls (with proper cleanup)
  for (const [callId, pending] of session.pendingToolCalls) {
    console.log(`\x1b[35m[Runtime]\x1b[0m Rejecting pending tool call: ${callId}`);
    clearTimeout(pending.timeout);
    pending.reject(new Error('Session cancelled'));
  }
  session.pendingToolCalls.clear();
}

// Graceful shutdown
async function gracefulShutdown() {
  console.log('\x1b[35m[Runtime]\x1b[0m Shutting down...');

  // Close WebSocket server
  await new Promise<void>((resolve) => {
    wss.close((err) => {
      if (err) {
        console.error('\x1b[31m[Runtime]\x1b[0m Error closing WebSocket server:', err);
      }
      resolve();
    });
  });

  // Dispose all enclaves
  const disposePromises = Array.from(sessions.values()).map(async (session) => {
    try {
      session.enclave.dispose();
    } catch (err) {
      console.error('\x1b[31m[Runtime]\x1b[0m Error disposing enclave:', err);
    }
  });
  await Promise.all(disposePromises);

  sessions.clear();
  console.log('\x1b[35m[Runtime]\x1b[0m Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => void gracefulShutdown());
process.on('SIGINT', () => void gracefulShutdown());
