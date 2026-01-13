/**
 * Client Server - Port 4100
 *
 * Express server that serves the web UI and proxies requests to broker/lambda.
 *
 * Execution Modes:
 * 1. Embedded:  Client → Broker (embedded runtime)
 * 2. Lambda:    Client → Broker → Lambda (3-tier via WebSocket)
 * 3. Direct:    Client → Lambda (bypasses broker - for comparison)
 *
 * Architecture Comparison:
 *   Mode 1: Client ⟷ Broker (code + tools in one place)
 *   Mode 2: Client ⟷ Broker ⟷ Lambda (secure 3-tier)
 *   Mode 3: Client ⟷ Lambda (direct, no broker validation)
 */

import express, { Request, Response } from 'express';
import path from 'path';
import WebSocket from 'ws';
import type { SessionId } from '@enclavejs/types';
import { generateSessionId } from '@enclavejs/types';

const PORT = 4100;
const BROKER_URL = 'http://localhost:4101';
const LAMBDA_WS_URL = 'ws://localhost:4102/ws';

const app = express();

app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================================
// MODE 1: EMBEDDED - Client → Broker (embedded runtime)
// ============================================================================
// Handler for embedded mode execution
async function handleEmbeddedExecute(req: Request, res: Response): Promise<void> {
  const { code } = req.body;
  if (!code || typeof code !== 'string') {
    res.status(400).json({ error: 'Code is required' });
    return;
  }

  console.log(`\x1b[34m[Client → Embedded]\x1b[0m Executing: ${code.slice(0, 50)}...`);

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const response = await fetch(`${BROKER_URL}/sessions/embedded`, {
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
          const event = JSON.parse(line);
          lastEvent = event;
          if (event.type === 'tool_call') {
            console.log(`\x1b[34m[Client → Embedded]\x1b[0m Tool: ${event.payload.toolName}`);
          }
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
          result: { success: finalEvent.payload.ok, value: finalEvent.payload.result, stats: finalEvent.payload.stats },
        }) + '\n',
      );
    }

    res.end();
    console.log(`\x1b[34m[Client → Embedded]\x1b[0m Complete`);
  } catch (error) {
    console.error(`\x1b[31m[Client → Embedded error]\x1b[0m`, error);
    res.write(JSON.stringify({ type: 'client_error', error: String(error) }) + '\n');
    res.end();
  }
}

app.post('/api/execute/embedded', handleEmbeddedExecute);

// ============================================================================
// MODE 2: LAMBDA - Client → Broker → Lambda (3-tier via WebSocket)
// ============================================================================
app.post('/api/execute/lambda', async (req: Request, res: Response) => {
  const { code } = req.body;
  if (!code || typeof code !== 'string') {
    res.status(400).json({ error: 'Code is required' });
    return;
  }

  console.log(`\x1b[34m[Client → Broker → Lambda]\x1b[0m Executing: ${code.slice(0, 50)}...`);

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const response = await fetch(`${BROKER_URL}/sessions/lambda`, {
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
          const event = JSON.parse(line);
          lastEvent = event;
          if (event.type === 'tool_call') {
            console.log(`\x1b[34m[Client → Broker → Lambda]\x1b[0m Tool: ${event.payload.toolName}`);
          }
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
          result: { success: finalEvent.payload.ok, value: finalEvent.payload.result, stats: finalEvent.payload.stats },
        }) + '\n',
      );
    }

    res.end();
    console.log(`\x1b[34m[Client → Broker → Lambda]\x1b[0m Complete`);
  } catch (error) {
    console.error(`\x1b[31m[Client → Broker → Lambda error]\x1b[0m`, error);
    res.write(JSON.stringify({ type: 'client_error', error: String(error) }) + '\n');
    res.end();
  }
});

// ============================================================================
// MODE 3: DIRECT - Client → Lambda (bypasses broker)
// ============================================================================
app.post('/api/execute/direct', async (req: Request, res: Response) => {
  const { code } = req.body;
  if (!code || typeof code !== 'string') {
    res.status(400).json({ error: 'Code is required' });
    return;
  }

  console.log(`\x1b[34m[Client → Lambda Direct]\x1b[0m Executing: ${code.slice(0, 50)}...`);

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sessionId = generateSessionId();

  try {
    // Connect directly to Lambda via WebSocket
    const ws = new WebSocket(LAMBDA_WS_URL);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Connection timeout')), 5000);
      ws.on('open', () => {
        clearTimeout(timeout);
        console.log(`\x1b[34m[Client → Lambda Direct]\x1b[0m Connected to Lambda`);
        resolve();
      });
      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    // Send execute request
    ws.send(JSON.stringify({ type: 'execute', sessionId, code }));

    // Handle messages from Lambda
    ws.on('message', async (data: Buffer) => {
      try {
        const event = JSON.parse(data.toString());

        // Forward to client
        if (res.writable) {
          res.write(JSON.stringify(event) + '\n');
        }

        if (event.type === 'tool_call') {
          console.log(`\x1b[34m[Client → Lambda Direct]\x1b[0m Tool call: ${event.payload.toolName}`);
          console.log(`\x1b[33m[Client → Lambda Direct]\x1b[0m WARNING: No broker to handle tool!`);

          // In direct mode, we need to handle tools ourselves (simulating what broker does)
          // This demonstrates why broker is needed - direct mode must implement tools locally
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
          console.log(`\x1b[34m[Client → Lambda Direct]\x1b[0m Complete`);
        }
      } catch (error) {
        console.error(`\x1b[31m[Client → Lambda Direct]\x1b[0m Parse error:`, error);
      }
    });

    ws.on('close', () => {
      if (res.writable) {
        res.end();
      }
    });

    ws.on('error', (error) => {
      console.error(`\x1b[31m[Client → Lambda Direct]\x1b[0m WebSocket error:`, error);
      if (res.writable) {
        res.write(JSON.stringify({ type: 'client_error', error: String(error) }) + '\n');
        res.end();
      }
    });

    // Handle client disconnect
    req.on('close', () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'cancel', sessionId, reason: 'Client disconnected' }));
        ws.close();
      }
    });
  } catch (error) {
    console.error(`\x1b[31m[Client → Lambda Direct error]\x1b[0m`, error);
    res.write(JSON.stringify({ type: 'client_error', error: String(error) }) + '\n');
    res.end();
  }
});

// Simple local tool handlers for direct mode (demonstrates why broker is needed)
async function handleToolLocally(toolName: string, args: Record<string, unknown>): Promise<unknown> {
  console.log(`\x1b[33m[Local Tool]\x1b[0m ${toolName}() - Running on CLIENT (not broker)`);

  switch (toolName) {
    case 'getCurrentTime':
      return { timestamp: new Date().toISOString(), server: 'client-direct', port: PORT };
    case 'addNumbers': {
      const { a, b } = args as { a: number; b: number };
      return { result: a + b, operation: `${a} + ${b} = ${a + b}`, calculatedBy: 'client-direct' };
    }
    case 'multiply': {
      const { a, b } = args as { a: number; b: number };
      return { result: a * b, operation: `${a} * ${b} = ${a * b}` };
    }
    case 'greet': {
      const { name } = args as { name: string };
      return { greeting: `Hello, ${name}!`, timestamp: new Date().toISOString() };
    }
    case 'useSecret':
      return {
        hasApiKey: false,
        message: 'WARNING: Direct mode has no access to secrets! Use broker for secure access.',
      };
    case 'fetchExternalApi':
      return {
        success: false,
        message: 'Direct mode - external API calls disabled for demo',
      };
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

// Default execute endpoint (uses embedded mode)
app.post('/api/execute', handleEmbeddedExecute);

// Health check
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    server: 'client',
    port: PORT,
    brokerUrl: BROKER_URL,
    lambdaWsUrl: LAMBDA_WS_URL,
    modes: ['embedded', 'lambda', 'direct'],
  });
});

app.listen(PORT, () => {
  console.log('');
  console.log('\x1b[34m========================================\x1b[0m');
  console.log('\x1b[34m  Client Server Started\x1b[0m');
  console.log('\x1b[34m========================================\x1b[0m');
  console.log(`  Port: ${PORT}`);
  console.log(`  Broker: ${BROKER_URL}`);
  console.log(`  Lambda: ${LAMBDA_WS_URL}`);
  console.log('');
  console.log('  Open in browser: http://localhost:' + PORT);
  console.log('');
  console.log('  Execution Modes:');
  console.log('    POST /api/execute/embedded - Client → Broker (embedded)');
  console.log('    POST /api/execute/lambda   - Client → Broker → Lambda');
  console.log('    POST /api/execute/direct   - Client → Lambda (direct)');
  console.log('\x1b[34m========================================\x1b[0m');
  console.log('');
});
