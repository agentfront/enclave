/**
 * Broker Server - Port 4101
 *
 * Express server that supports multiple execution modes:
 *
 * 1. Embedded Mode (POST /sessions/embedded)
 *    Client → Broker (with embedded enclave-vm)
 *    - Code executes directly in broker process
 *    - Tools are local
 *    - Simplest deployment
 *
 * 2. Lambda Mode (POST /sessions/lambda)
 *    Client → Broker → Lambda (via WebSocket)
 *    - Broker validates input, connects to Lambda
 *    - Code executes on Lambda
 *    - Tools are on Broker (Lambda calls back)
 *    - Secure 3-tier architecture
 *
 * Architecture:
 *   Mode 1: Client ⟷ Broker (embedded runtime)
 *   Mode 2: Client ⟷ Broker ⟷ Lambda (WebSocket)
 */

import express, { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import WebSocket from 'ws';
import type { SessionId, CallId, StreamEvent } from '@enclavejs/types';
import { generateSessionId, PROTOCOL_VERSION } from '@enclavejs/types';
import { Enclave } from 'enclave-vm';

const PORT = 4101;
const RUNTIME_WS_URL = 'ws://localhost:4102/ws';

// Active sessions tracking (for Lambda mode)
interface ActiveSession {
  sessionId: SessionId;
  clientRes: Response;
  ws: WebSocket;
  seq: number;
}

const activeSessions = new Map<SessionId, ActiveSession>();

// Tool handlers - executed locally on the broker
const toolHandlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
  getCurrentTime: async () => {
    console.log('\x1b[36m[Broker Tool]\x1b[0m getCurrentTime() called');
    return {
      timestamp: new Date().toISOString(),
      server: 'broker',
      port: PORT,
    };
  },

  addNumbers: async (args) => {
    const { a, b } = args as { a: number; b: number };
    console.log(`\x1b[36m[Broker Tool]\x1b[0m addNumbers(${a}, ${b}) called`);
    const result = a + b;
    return {
      result,
      operation: `${a} + ${b} = ${result}`,
      calculatedBy: 'broker-server',
    };
  },

  fetchExternalApi: async () => {
    console.log('\x1b[36m[Broker Tool]\x1b[0m fetchExternalApi() called');
    try {
      const response = await fetch('https://httpbin.org/json');
      const data = await response.json();
      return {
        success: true,
        source: 'httpbin.org',
        data,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  },

  useSecret: async () => {
    console.log('\x1b[36m[Broker Tool]\x1b[0m useSecret() called');
    const apiKey = 'demo-secret-key-12345';
    const dbUrl = 'postgres://demo:demo@localhost/demo';
    return {
      hasApiKey: !!apiKey,
      apiKeyPrefix: apiKey.slice(0, 10) + '...',
      hasDatabaseUrl: !!dbUrl,
      dbUrlHost: dbUrl.includes('@') ? dbUrl.split('@')[1]?.split('/')[0] : 'hidden',
      message: 'Secrets are injected by the broker, never exposed to client code!',
    };
  },

  multiply: async (args) => {
    const { a, b } = args as { a: number; b: number };
    console.log(`\x1b[36m[Broker Tool]\x1b[0m multiply(${a}, ${b}) called`);
    return {
      result: a * b,
      operation: `${a} * ${b} = ${a * b}`,
    };
  },

  greet: async (args) => {
    const { name } = args as { name: string };
    console.log(`\x1b[36m[Broker Tool]\x1b[0m greet("${name}") called`);
    return {
      greeting: `Hello, ${name}!`,
      timestamp: new Date().toISOString(),
    };
  },
};

// Tool definitions for listing
const toolNames = Object.keys(toolHandlers);

// Input validation schema
const executeRequestSchema = z.object({
  code: z.string().min(1).max(100000),
});

// Sanitize code input (basic example - can be extended)
function sanitizeCode(code: string): string {
  return code.trim();
}

// ============================================================================
// EMBEDDED MODE - Execute code directly in broker using enclave-vm
// ============================================================================

async function executeEmbedded(req: Request, res: Response) {
  const parseResult = executeRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({ error: 'Invalid request', details: parseResult.error.issues });
    return;
  }

  const { code } = parseResult.data;
  const sanitizedCode = sanitizeCode(code);
  const sessionId = generateSessionId();
  let seq = 0;

  console.log(`\x1b[32m[Broker Embedded]\x1b[0m Execute request: session ${sessionId}`);

  // Set up NDJSON streaming response
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Send session_init
  res.write(
    JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      sessionId,
      seq: ++seq,
      type: 'session_init',
      payload: {
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        encryption: { enabled: false },
      },
    }) + '\n',
  );

  // Create enclave with tool handler
  const enclave = new Enclave({
    timeout: 30000,
    maxIterations: 10000,
    toolHandler: async (toolName: string, args: Record<string, unknown>) => {
      const callId = `c_${Math.random().toString(36).slice(2)}` as CallId;

      // Send tool_call event
      res.write(
        JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          sessionId,
          seq: ++seq,
          type: 'tool_call',
          payload: { callId, toolName, args },
        }) + '\n',
      );

      // Execute tool
      const handler = toolHandlers[toolName];
      if (!handler) {
        throw new Error(`Unknown tool: ${toolName}`);
      }

      const result = await handler(args);

      // Send tool_result_applied event
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
    const startTime = Date.now();
    const result = await enclave.run(sanitizedCode);
    const durationMs = Date.now() - startTime;

    console.log(
      `\x1b[32m[Broker Embedded]\x1b[0m Session ${sessionId} completed: ${result.success ? 'SUCCESS' : 'FAILED'}`,
    );

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
            durationMs,
            toolCallCount: result.stats?.toolCallCount ?? 0,
            stdoutBytes: 0,
          },
        },
      }) + '\n',
    );
  } catch (error) {
    console.error(`\x1b[31m[Broker Embedded]\x1b[0m Execution error:`, error);
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
}

// ============================================================================
// LAMBDA MODE - Execute code on Lambda via WebSocket
// ============================================================================

function createRuntimeConnection(sessionId: SessionId, clientRes: Response): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    console.log(`\x1b[32m[Broker Lambda]\x1b[0m Connecting to runtime for session ${sessionId}`);

    const ws = new WebSocket(RUNTIME_WS_URL);

    ws.on('open', () => {
      console.log(`\x1b[32m[Broker Lambda]\x1b[0m Connected to runtime for session ${sessionId}`);
      resolve(ws);
    });

    ws.on('error', (error) => {
      console.error(`\x1b[31m[Broker Lambda]\x1b[0m WebSocket error for session ${sessionId}:`, error.message);
      reject(error);
    });

    ws.on('close', () => {
      console.log(`\x1b[32m[Broker Lambda]\x1b[0m WebSocket closed for session ${sessionId}`);
      activeSessions.delete(sessionId);
    });

    ws.on('message', async (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString()) as StreamEvent;
        await handleRuntimeMessage(sessionId, message);
      } catch (error) {
        console.error(`\x1b[31m[Broker Lambda]\x1b[0m Failed to parse runtime message:`, error);
      }
    });
  });
}

async function handleRuntimeMessage(sessionId: SessionId, event: StreamEvent) {
  const session = activeSessions.get(sessionId);
  if (!session) {
    console.warn(`\x1b[33m[Broker Lambda]\x1b[0m Message for unknown session: ${sessionId}`);
    return;
  }

  // Forward event to client
  if (session.clientRes.writable) {
    session.clientRes.write(JSON.stringify(event) + '\n');
  }

  // Handle tool calls
  if (event.type === 'tool_call') {
    const { callId, toolName, args } = event.payload as {
      callId: CallId;
      toolName: string;
      args: Record<string, unknown>;
    };

    console.log(`\x1b[32m[Broker Lambda]\x1b[0m Tool call from Lambda: ${toolName}(${JSON.stringify(args)})`);

    const handler = toolHandlers[toolName];
    if (!handler) {
      sendToRuntime(session.ws, {
        type: 'tool_result',
        sessionId,
        callId,
        success: false,
        error: { code: 'UNKNOWN_TOOL', message: `Unknown tool: ${toolName}` },
      });
      return;
    }

    try {
      const result = await handler(args);
      console.log(`\x1b[32m[Broker Lambda]\x1b[0m Tool ${toolName} completed, sending result to Lambda`);

      sendToRuntime(session.ws, {
        type: 'tool_result',
        sessionId,
        callId,
        success: true,
        value: result,
      });
    } catch (error) {
      console.error(`\x1b[31m[Broker Lambda]\x1b[0m Tool ${toolName} failed:`, error);
      sendToRuntime(session.ws, {
        type: 'tool_result',
        sessionId,
        callId,
        success: false,
        error: { code: 'TOOL_ERROR', message: error instanceof Error ? error.message : 'Tool execution failed' },
      });
    }
  }

  // Clean up on final event
  if (event.type === 'final') {
    console.log(`\x1b[32m[Broker Lambda]\x1b[0m Session ${sessionId} completed`);
    session.ws.close();
    if (session.clientRes.writable) {
      session.clientRes.end();
    }
    activeSessions.delete(sessionId);
  }
}

function sendToRuntime(ws: WebSocket, message: Record<string, unknown>) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function terminateSession(sessionId: SessionId, reason: string) {
  const session = activeSessions.get(sessionId);
  if (!session) return false;

  console.log(`\x1b[32m[Broker Lambda]\x1b[0m Terminating session ${sessionId}: ${reason}`);

  sendToRuntime(session.ws, { type: 'cancel', sessionId, reason });
  session.ws.close();

  if (session.clientRes.writable) {
    session.clientRes.write(
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        sessionId,
        seq: ++session.seq,
        type: 'final',
        payload: {
          ok: false,
          error: { code: 'TERMINATED', message: reason },
          stats: { durationMs: 0, toolCallCount: 0, stdoutBytes: 0 },
        },
      }) + '\n',
    );
    session.clientRes.end();
  }

  activeSessions.delete(sessionId);
  return true;
}

async function executeLambda(req: Request, res: Response) {
  const parseResult = executeRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({ error: 'Invalid request', details: parseResult.error.issues });
    return;
  }

  const { code } = parseResult.data;
  const sanitizedCode = sanitizeCode(code);
  const sessionId = generateSessionId();

  console.log(`\x1b[32m[Broker Lambda]\x1b[0m Execute request: session ${sessionId}`);

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const ws = await createRuntimeConnection(sessionId, res);

    const session: ActiveSession = { sessionId, clientRes: res, ws, seq: 0 };
    activeSessions.set(sessionId, session);

    console.log(`\x1b[32m[Broker Lambda]\x1b[0m Sending execute request to Lambda`);
    sendToRuntime(ws, { type: 'execute', sessionId, code: sanitizedCode });

    req.on('close', () => {
      if (activeSessions.has(sessionId)) {
        console.log(`\x1b[32m[Broker Lambda]\x1b[0m Client disconnected, terminating session ${sessionId}`);
        terminateSession(sessionId, 'Client disconnected');
      }
    });
  } catch (error) {
    console.error(`\x1b[31m[Broker Lambda]\x1b[0m Failed to connect to runtime:`, error);
    res.write(
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        sessionId,
        seq: 1,
        type: 'final',
        payload: {
          ok: false,
          error: { code: 'RUNTIME_UNAVAILABLE', message: 'Failed to connect to Lambda. Is the Lambda server running?' },
          stats: { durationMs: 0, toolCallCount: 0, stdoutBytes: 0 },
        },
      }) + '\n',
    );
    res.end();
  }
}

// ============================================================================
// EXPRESS APP
// ============================================================================

const app = express();

app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Last-Event-ID');
  next();
});

app.use(express.json());

// Embedded mode endpoint
app.post('/sessions/embedded', executeEmbedded);

// Lambda mode endpoint
app.post('/sessions/lambda', executeLambda);

// Default sessions endpoint (uses embedded mode)
app.post('/sessions', executeEmbedded);

// List active sessions
app.get('/sessions', (_req: Request, res: Response) => {
  const sessions = Array.from(activeSessions.keys()).map((sessionId) => ({
    sessionId,
    status: 'active',
    mode: 'lambda',
  }));
  res.json({ sessions });
});

// Terminate a session
app.delete('/sessions/:sessionId', (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const terminated = terminateSession(sessionId as SessionId, 'Terminated by API');
  if (terminated) {
    res.json({ success: true, sessionId });
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    server: 'broker',
    port: PORT,
    tools: toolNames,
    modes: ['embedded', 'lambda'],
    activeSessions: activeSessions.size,
  });
});

// Start server
app.listen(PORT, () => {
  console.log('');
  console.log('\x1b[32m========================================\x1b[0m');
  console.log('\x1b[32m  Broker Server Started\x1b[0m');
  console.log('\x1b[32m========================================\x1b[0m');
  console.log(`  Port: ${PORT}`);
  console.log(`  Lambda: ${RUNTIME_WS_URL}`);
  console.log(`  Tools: ${toolNames.join(', ')}`);
  console.log('');
  console.log('  Execution Modes:');
  console.log('    POST /sessions/embedded  - Embedded runtime (no Lambda)');
  console.log('    POST /sessions/lambda    - Via Lambda (WebSocket)');
  console.log('');
  console.log('  Other Endpoints:');
  console.log('    GET    /sessions         - List active sessions');
  console.log('    DELETE /sessions/:id     - Terminate a session');
  console.log('    GET    /health           - Health check');
  console.log('\x1b[32m========================================\x1b[0m');
  console.log('');
});
