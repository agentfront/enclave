/**
 * Test utilities for streaming-demo tests
 */

import { WebSocket, WebSocketServer } from 'ws';
import type { AddressInfo } from 'net';
import type { StreamEvent, SessionId, CallId } from '@enclavejs/types';

/**
 * Wait for a WebSocket to connect
 */
export function waitForConnection(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    ws.on('open', () => resolve());
    ws.on('error', reject);
    setTimeout(() => reject(new Error('Connection timeout')), 5000);
  });
}

/**
 * Collect all events from a WebSocket until final event
 */
export function collectEvents(ws: WebSocket): Promise<StreamEvent[]> {
  return new Promise((resolve, reject) => {
    const events: StreamEvent[] = [];

    ws.on('message', (data: Buffer) => {
      try {
        const event = JSON.parse(data.toString()) as StreamEvent;
        events.push(event);
        if (event.type === 'final') {
          resolve(events);
        }
      } catch (error) {
        reject(error);
      }
    });

    ws.on('error', reject);
    setTimeout(() => reject(new Error('Timeout waiting for events')), 10000);
  });
}

/**
 * Parse NDJSON response into events
 */
export function parseNdjson(data: string): StreamEvent[] {
  return data
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as StreamEvent);
}

/**
 * Wait for specific event type
 */
export function waitForEvent(ws: WebSocket, eventType: string): Promise<StreamEvent> {
  return new Promise((resolve, reject) => {
    const handler = (data: Buffer) => {
      try {
        const event = JSON.parse(data.toString()) as StreamEvent;
        if (event.type === eventType) {
          ws.off('message', handler);
          resolve(event);
        }
      } catch {
        // Ignore parse errors
      }
    };

    ws.on('message', handler);
    ws.on('error', reject);
    setTimeout(() => {
      ws.off('message', handler);
      reject(new Error(`Timeout waiting for ${eventType} event`));
    }, 10000);
  });
}

/**
 * Create a mock tool result message
 */
export function createToolResultMessage(
  sessionId: SessionId,
  callId: CallId,
  value: unknown,
  success = true,
): Record<string, unknown> {
  return {
    type: 'tool_result',
    sessionId,
    callId,
    success,
    value,
  };
}

/**
 * Start a simple WebSocket server for testing
 */
export function createTestWebSocketServer(): Promise<{
  wss: WebSocketServer;
  port: number;
  url: string;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 });

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

/**
 * Wait for milliseconds
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a test code snippet
 */
export const testCode = {
  simple: 'return 1 + 2',
  withTool: 'return await callTool("getCurrentTime", {})',
  multiTool: `
    const time = await callTool("getCurrentTime", {});
    const sum = await callTool("addNumbers", { a: 10, b: 20 });
    return { time, sum };
  `,
  // Use a failing tool call to trigger an error (since throw new Error isn't allowed)
  error: 'return await callTool("failingTool", {})',
  // Runtime error that doesn't use tool calls - access undefined property
  runtimeError: 'const x = undefined; return x.y.z',
  timeout: 'while(true) {}',
};
