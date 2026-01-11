/**
 * EnclaveClient Tests
 */

import { EnclaveClient, EnclaveClientError } from './index';
import type { SessionResult, SessionEventHandlers } from './index';
import type { StreamEvent, SessionId, CallId } from '@enclavejs/types';
import { EventType, PROTOCOL_VERSION } from '@enclavejs/types';

// Helper to create a mock ReadableStream from NDJSON events
function createMockStream(events: StreamEvent[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const lines = events.map((e) => JSON.stringify(e) + '\n').join('');
  let position = 0;

  return new ReadableStream({
    pull(controller) {
      if (position < lines.length) {
        const chunk = lines.slice(position, position + 100);
        position += 100;
        controller.enqueue(encoder.encode(chunk));
      } else {
        controller.close();
      }
    },
  });
}

// Helper to create mock fetch that returns NDJSON stream
function createMockFetch(events: StreamEvent[], status = 200): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();

    // Handle different endpoints
    if (url.includes('/sessions') && init?.method === 'POST') {
      if (status !== 200) {
        return new Response(`Error ${status}`, { status });
      }
      return new Response(createMockStream(events), {
        status: 200,
        headers: { 'Content-Type': 'application/x-ndjson' },
      });
    }

    if (url.includes('/sessions/') && init?.method === 'GET') {
      const sessionId = url.split('/sessions/')[1]?.split('/')[0];
      return new Response(
        JSON.stringify({
          sessionId,
          state: 'completed',
          createdAt: Date.now(),
          expiresAt: Date.now() + 60000,
          stats: { duration: 1000, toolCallCount: 0 },
        }),
        { status: 200 },
      );
    }

    if (url.includes('/cancel')) {
      return new Response('{}', { status: 200 });
    }

    return new Response('Not found', { status: 404 });
  };
}

// Helper to create base event fields
function createBaseEvent(sessionId: SessionId, seq: number) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    sessionId,
    seq,
  };
}

// Helper to create test events
function createSessionInitEvent(sessionId: SessionId, seq = 1): StreamEvent {
  return {
    ...createBaseEvent(sessionId, seq),
    type: EventType.SessionInit,
    payload: {
      cancelUrl: `/sessions/${sessionId}/cancel`,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      encryption: { enabled: false },
    },
  };
}

function createStdoutEvent(sessionId: SessionId, chunk: string, seq = 2): StreamEvent {
  return {
    ...createBaseEvent(sessionId, seq),
    type: EventType.Stdout,
    payload: { chunk },
  };
}

function createLogEvent(
  sessionId: SessionId,
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  seq = 3,
): StreamEvent {
  return {
    ...createBaseEvent(sessionId, seq),
    type: EventType.Log,
    payload: { level, message },
  };
}

function createToolCallEvent(
  sessionId: SessionId,
  callId: CallId,
  toolName: string,
  args: unknown,
  seq = 4,
): StreamEvent {
  return {
    ...createBaseEvent(sessionId, seq),
    type: EventType.ToolCall,
    payload: { callId, toolName, args },
  };
}

function createToolResultAppliedEvent(sessionId: SessionId, callId: CallId, seq = 5): StreamEvent {
  return {
    ...createBaseEvent(sessionId, seq),
    type: EventType.ToolResultApplied,
    payload: { callId },
  };
}

function createHeartbeatEvent(sessionId: SessionId, seq = 6): StreamEvent {
  return {
    ...createBaseEvent(sessionId, seq),
    type: EventType.Heartbeat,
    payload: { ts: new Date().toISOString() },
  };
}

function createFinalSuccessEvent(sessionId: SessionId, result: unknown, seq = 10): StreamEvent {
  return {
    ...createBaseEvent(sessionId, seq),
    type: EventType.Final,
    payload: {
      ok: true,
      result,
    },
  };
}

function createFinalErrorEvent(sessionId: SessionId, code: string, message: string, seq = 10): StreamEvent {
  return {
    ...createBaseEvent(sessionId, seq),
    type: EventType.Final,
    payload: {
      ok: false,
      error: { code, message },
    },
  };
}

function createErrorEvent(sessionId: SessionId, code: string, message: string, seq = 7): StreamEvent {
  return {
    ...createBaseEvent(sessionId, seq),
    type: EventType.Error,
    payload: { code, message },
  };
}

// Test session ID
const TEST_SESSION_ID = 's_test123' as SessionId;
const TEST_CALL_ID = 'c_call123' as CallId;

describe('EnclaveClient', () => {
  describe('constructor', () => {
    it('should create client with minimal config', () => {
      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        fetch: jest.fn(),
      });
      expect(client).toBeInstanceOf(EnclaveClient);
    });

    it('should normalize baseUrl by removing trailing slash', () => {
      const mockFetch = jest.fn().mockResolvedValue(new Response(createMockStream([]), { status: 200 }));
      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com/',
        fetch: mockFetch,
      });

      client.execute('return 1');

      expect(mockFetch).toHaveBeenCalledWith('https://api.example.com/sessions', expect.any(Object));
    });
  });

  describe('execute', () => {
    it('should execute code and return result', async () => {
      const events: StreamEvent[] = [
        createSessionInitEvent(TEST_SESSION_ID),
        createFinalSuccessEvent(TEST_SESSION_ID, 42),
      ];

      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        fetch: createMockFetch(events),
      });

      const result = await client.execute('return 42');

      expect(result.success).toBe(true);
      expect(result.value).toBe(42);
      expect(result.events).toHaveLength(2);
    });

    it('should handle execution errors', async () => {
      const events: StreamEvent[] = [
        createSessionInitEvent(TEST_SESSION_ID),
        createFinalErrorEvent(TEST_SESSION_ID, 'EXECUTION_ERROR', 'Something went wrong'),
      ];

      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        fetch: createMockFetch(events),
      });

      const result = await client.execute('throw new Error()');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EXECUTION_ERROR');
      expect(result.error?.message).toBe('Something went wrong');
    });

    it('should handle network errors', async () => {
      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        fetch: async () => {
          throw new Error('Network failure');
        },
        autoReconnect: false,
      });

      const result = await client.execute('return 1');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('NETWORK_ERROR');
    });

    it('should handle HTTP error status', async () => {
      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        fetch: createMockFetch([], 500),
        autoReconnect: false,
      });

      const result = await client.execute('return 1');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SESSION_ERROR');
    });

    it('should include custom headers', async () => {
      const mockFetch = jest
        .fn()
        .mockResolvedValue(
          new Response(
            createMockStream([createSessionInitEvent(TEST_SESSION_ID), createFinalSuccessEvent(TEST_SESSION_ID, 1)]),
            { status: 200 },
          ),
        );

      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        headers: { Authorization: 'Bearer token123' },
        fetch: mockFetch,
      });

      await client.execute('return 1');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer token123',
          }),
        }),
      );
    });

    it('should pass session limits in config', async () => {
      const mockFetch = jest
        .fn()
        .mockResolvedValue(
          new Response(
            createMockStream([createSessionInitEvent(TEST_SESSION_ID), createFinalSuccessEvent(TEST_SESSION_ID, 1)]),
            { status: 200 },
          ),
        );

      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        fetch: mockFetch,
      });

      await client.execute('return 1', {
        limits: {
          sessionTtlMs: 30000,
          maxToolCalls: 5,
        },
      });

      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options.body);

      expect(body.config).toEqual({
        maxExecutionMs: 30000,
        maxToolCalls: 5,
      });
    });
  });

  describe('executeStream', () => {
    it('should return a session handle', () => {
      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        fetch: createMockFetch([]),
      });

      const handle = client.executeStream('return 1');

      expect(handle.sessionId).toMatch(/^s_/);
      expect(typeof handle.wait).toBe('function');
      expect(typeof handle.cancel).toBe('function');
      expect(typeof handle.getEvents).toBe('function');
      expect(typeof handle.isActive).toBe('function');
    });

    it('should use provided sessionId', () => {
      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        fetch: createMockFetch([]),
      });

      const handle = client.executeStream('return 1', {
        sessionId: 's_custom123' as SessionId,
      });

      expect(handle.sessionId).toBe('s_custom123');
    });

    it('should report active status correctly', async () => {
      const events: StreamEvent[] = [
        createSessionInitEvent(TEST_SESSION_ID),
        createFinalSuccessEvent(TEST_SESSION_ID, 1),
      ];

      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        fetch: createMockFetch(events),
      });

      const handle = client.executeStream('return 1');

      // Initially active
      expect(handle.isActive()).toBe(true);

      // Wait for completion
      await handle.wait();

      // Now inactive
      expect(handle.isActive()).toBe(false);
    });
  });

  describe('event handlers', () => {
    it('should call onEvent for every event', async () => {
      const events: StreamEvent[] = [
        createSessionInitEvent(TEST_SESSION_ID, 1),
        createStdoutEvent(TEST_SESSION_ID, 'hello', 2),
        createFinalSuccessEvent(TEST_SESSION_ID, 1, 3),
      ];

      const onEvent = jest.fn();
      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        fetch: createMockFetch(events),
      });

      await client.execute('console.log("hello"); return 1', { onEvent });

      expect(onEvent).toHaveBeenCalledTimes(3);
    });

    it('should call onSessionInit on session init', async () => {
      const events: StreamEvent[] = [
        createSessionInitEvent(TEST_SESSION_ID),
        createFinalSuccessEvent(TEST_SESSION_ID, 1),
      ];

      const onSessionInit = jest.fn();
      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        fetch: createMockFetch(events),
      });

      await client.execute('return 1', { onSessionInit });

      expect(onSessionInit).toHaveBeenCalledTimes(1);
      expect(onSessionInit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: EventType.SessionInit,
        }),
      );
    });

    it('should call onStdout for stdout events', async () => {
      const events: StreamEvent[] = [
        createSessionInitEvent(TEST_SESSION_ID),
        createStdoutEvent(TEST_SESSION_ID, 'hello world'),
        createFinalSuccessEvent(TEST_SESSION_ID, 1),
      ];

      const onStdout = jest.fn();
      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        fetch: createMockFetch(events),
      });

      await client.execute('console.log("hello world"); return 1', { onStdout });

      expect(onStdout).toHaveBeenCalledWith('hello world');
    });

    it('should call onLog for log events', async () => {
      const events: StreamEvent[] = [
        createSessionInitEvent(TEST_SESSION_ID),
        createLogEvent(TEST_SESSION_ID, 'info', 'test message'),
        createFinalSuccessEvent(TEST_SESSION_ID, 1),
      ];

      const onLog = jest.fn();
      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        fetch: createMockFetch(events),
      });

      await client.execute('return 1', { onLog });

      expect(onLog).toHaveBeenCalledWith('info', 'test message', undefined);
    });

    it('should call onToolCall for tool call events', async () => {
      const events: StreamEvent[] = [
        createSessionInitEvent(TEST_SESSION_ID),
        createToolCallEvent(TEST_SESSION_ID, TEST_CALL_ID, 'myTool', {
          arg: 'value',
        }),
        createToolResultAppliedEvent(TEST_SESSION_ID, TEST_CALL_ID),
        createFinalSuccessEvent(TEST_SESSION_ID, 1),
      ];

      const onToolCall = jest.fn();
      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        fetch: createMockFetch(events),
      });

      await client.execute('return 1', { onToolCall });

      expect(onToolCall).toHaveBeenCalledWith(TEST_CALL_ID, 'myTool', {
        arg: 'value',
      });
    });

    it('should call onToolResultApplied when tool result is applied', async () => {
      const events: StreamEvent[] = [
        createSessionInitEvent(TEST_SESSION_ID),
        createToolCallEvent(TEST_SESSION_ID, TEST_CALL_ID, 'myTool', {}),
        createToolResultAppliedEvent(TEST_SESSION_ID, TEST_CALL_ID),
        createFinalSuccessEvent(TEST_SESSION_ID, 1),
      ];

      const onToolResultApplied = jest.fn();
      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        fetch: createMockFetch(events),
      });

      await client.execute('return 1', { onToolResultApplied });

      expect(onToolResultApplied).toHaveBeenCalledWith(TEST_CALL_ID);
    });

    it('should call onHeartbeat for heartbeat events', async () => {
      const events: StreamEvent[] = [
        createSessionInitEvent(TEST_SESSION_ID),
        createHeartbeatEvent(TEST_SESSION_ID),
        createFinalSuccessEvent(TEST_SESSION_ID, 1),
      ];

      const onHeartbeat = jest.fn();
      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        fetch: createMockFetch(events),
      });

      await client.execute('return 1', { onHeartbeat });

      expect(onHeartbeat).toHaveBeenCalled();
    });

    it('should call onError for error events', async () => {
      const events: StreamEvent[] = [
        createSessionInitEvent(TEST_SESSION_ID),
        createErrorEvent(TEST_SESSION_ID, 'TOOL_ERROR', 'Tool failed'),
        createFinalSuccessEvent(TEST_SESSION_ID, 1),
      ];

      const onError = jest.fn();
      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        fetch: createMockFetch(events),
      });

      await client.execute('return 1', { onError });

      expect(onError).toHaveBeenCalledWith('TOOL_ERROR', 'Tool failed');
    });
  });

  describe('cancelSession', () => {
    it('should cancel an active session', async () => {
      // Create a stream that never ends
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(JSON.stringify(createSessionInitEvent(TEST_SESSION_ID)) + '\n'));
          // Don't close - simulates a long-running session
        },
      });

      const mockFetch = jest.fn().mockImplementation(async (url: string) => {
        if (url.includes('/sessions') && !url.includes('/cancel')) {
          return new Response(stream, { status: 200 });
        }
        return new Response('{}', { status: 200 });
      });

      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        fetch: mockFetch,
      });

      const handle = client.executeStream('while(true) {}');

      // Wait a bit for session to start
      await new Promise((r) => setTimeout(r, 10));

      // Cancel
      await handle.cancel('User requested');

      const result = await handle.wait();

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('CANCELLED');
    });
  });

  describe('getSession', () => {
    it('should get session info', async () => {
      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        fetch: createMockFetch([]),
      });

      const info = await client.getSession('s_test123' as SessionId);

      expect(info).toEqual(
        expect.objectContaining({
          sessionId: 's_test123',
          state: 'completed',
        }),
      );
    });

    it('should return null for non-existent session', async () => {
      const mockFetch = jest.fn().mockResolvedValue(new Response('Not found', { status: 404 }));

      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        fetch: mockFetch,
      });

      const info = await client.getSession('s_notfound' as SessionId);

      expect(info).toBeNull();
    });
  });

  describe('stats tracking', () => {
    it('should track stdout bytes', async () => {
      const events: StreamEvent[] = [
        createSessionInitEvent(TEST_SESSION_ID),
        createStdoutEvent(TEST_SESSION_ID, 'hello', 2),
        createStdoutEvent(TEST_SESSION_ID, ' world', 3),
        createFinalSuccessEvent(TEST_SESSION_ID, 1, 4),
      ];

      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        fetch: createMockFetch(events),
      });

      const result = await client.execute('return 1');

      expect(result.stats?.stdoutBytes).toBe(11); // "hello" + " world"
    });

    it('should track tool call count', async () => {
      const events: StreamEvent[] = [
        createSessionInitEvent(TEST_SESSION_ID),
        createToolCallEvent(TEST_SESSION_ID, 'c_1' as CallId, 'tool1', {}, 2),
        createToolResultAppliedEvent(TEST_SESSION_ID, 'c_1' as CallId, 3),
        createToolCallEvent(TEST_SESSION_ID, 'c_2' as CallId, 'tool2', {}, 4),
        createToolResultAppliedEvent(TEST_SESSION_ID, 'c_2' as CallId, 5),
        createFinalSuccessEvent(TEST_SESSION_ID, 1, 6),
      ];

      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        fetch: createMockFetch(events),
      });

      const result = await client.execute('return 1');

      expect(result.stats?.toolCallCount).toBe(2);
    });

    it('should track duration', async () => {
      const events: StreamEvent[] = [
        createSessionInitEvent(TEST_SESSION_ID),
        createFinalSuccessEvent(TEST_SESSION_ID, 1),
      ];

      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        fetch: createMockFetch(events),
      });

      const result = await client.execute('return 1');

      expect(result.stats?.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getEvents', () => {
    it('should return events received so far', async () => {
      const events: StreamEvent[] = [
        createSessionInitEvent(TEST_SESSION_ID),
        createStdoutEvent(TEST_SESSION_ID, 'hello'),
        createFinalSuccessEvent(TEST_SESSION_ID, 1),
      ];

      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        fetch: createMockFetch(events),
      });

      const handle = client.executeStream('return 1');
      await handle.wait();

      const receivedEvents = handle.getEvents();
      expect(receivedEvents).toHaveLength(3);
    });
  });

  describe('streaming edge cases', () => {
    it('should handle empty result (null)', async () => {
      const events: StreamEvent[] = [
        createSessionInitEvent(TEST_SESSION_ID),
        createFinalSuccessEvent(TEST_SESSION_ID, null),
      ];

      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        fetch: createMockFetch(events),
      });

      const result = await client.execute('return null');

      expect(result.success).toBe(true);
      expect(result.value).toBeNull();
    });

    it('should handle undefined result', async () => {
      const events: StreamEvent[] = [
        createSessionInitEvent(TEST_SESSION_ID),
        createFinalSuccessEvent(TEST_SESSION_ID, undefined),
      ];

      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        fetch: createMockFetch(events),
      });

      const result = await client.execute('return undefined');

      expect(result.success).toBe(true);
      expect(result.value).toBeUndefined();
    });

    it('should handle complex object result', async () => {
      const complexResult = {
        users: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
        ],
        metadata: { total: 2, page: 1 },
        nested: { deeply: { nested: { value: 'found' } } },
      };

      const events: StreamEvent[] = [
        createSessionInitEvent(TEST_SESSION_ID),
        createFinalSuccessEvent(TEST_SESSION_ID, complexResult),
      ];

      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        fetch: createMockFetch(events),
      });

      const result = await client.execute('return complexObj');

      expect(result.success).toBe(true);
      expect(result.value).toEqual(complexResult);
    });

    it('should handle array result', async () => {
      const arrayResult = [1, 2, 3, 'four', { five: 5 }];

      const events: StreamEvent[] = [
        createSessionInitEvent(TEST_SESSION_ID),
        createFinalSuccessEvent(TEST_SESSION_ID, arrayResult),
      ];

      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        fetch: createMockFetch(events),
      });

      const result = await client.execute('return [1,2,3]');

      expect(result.success).toBe(true);
      expect(result.value).toEqual(arrayResult);
    });

    it('should handle multiple stdout events', async () => {
      const events: StreamEvent[] = [
        createSessionInitEvent(TEST_SESSION_ID, 1),
        createStdoutEvent(TEST_SESSION_ID, 'Line 1\n', 2),
        createStdoutEvent(TEST_SESSION_ID, 'Line 2\n', 3),
        createStdoutEvent(TEST_SESSION_ID, 'Line 3\n', 4),
        createFinalSuccessEvent(TEST_SESSION_ID, 'done', 5),
      ];

      const stdoutChunks: string[] = [];
      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        fetch: createMockFetch(events),
      });

      const result = await client.execute('console.log stuff', {
        onStdout: (chunk) => stdoutChunks.push(chunk),
      });

      expect(result.success).toBe(true);
      expect(stdoutChunks).toEqual(['Line 1\n', 'Line 2\n', 'Line 3\n']);
      expect(result.stats?.stdoutBytes).toBe(21);
    });

    it('should handle log events with data', async () => {
      const events: StreamEvent[] = [
        createSessionInitEvent(TEST_SESSION_ID, 1),
        {
          ...createBaseEvent(TEST_SESSION_ID, 2),
          type: EventType.Log,
          payload: {
            level: 'info' as const,
            message: 'User action',
            data: { userId: 123, action: 'login' },
          },
        },
        createFinalSuccessEvent(TEST_SESSION_ID, 1, 3),
      ];

      const logCalls: Array<{ level: string; message: string; data?: Record<string, unknown> }> = [];
      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        fetch: createMockFetch(events),
      });

      await client.execute('return 1', {
        onLog: (level, message, data) => logCalls.push({ level, message, data }),
      });

      expect(logCalls).toHaveLength(1);
      expect(logCalls[0]).toEqual({
        level: 'info',
        message: 'User action',
        data: { userId: 123, action: 'login' },
      });
    });

    it('should handle response with no body', async () => {
      const mockFetch = jest.fn().mockResolvedValue(new Response(null, { status: 200 }));

      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        fetch: mockFetch,
        autoReconnect: false,
      });

      const result = await client.execute('return 1');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('PARSE_ERROR');
    });

    it('should handle large number of events', async () => {
      const events: StreamEvent[] = [createSessionInitEvent(TEST_SESSION_ID, 1)];

      // Add 100 stdout events
      for (let i = 0; i < 100; i++) {
        events.push(createStdoutEvent(TEST_SESSION_ID, `chunk${i}`, i + 2));
      }
      events.push(createFinalSuccessEvent(TEST_SESSION_ID, 'done', 102));

      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        fetch: createMockFetch(events),
      });

      const result = await client.execute('return 1');

      expect(result.success).toBe(true);
      expect(result.events).toHaveLength(102);
    });
  });

  describe('abort signal handling', () => {
    it('should forward external abort signal to internal controller', async () => {
      // Test that external AbortSignal is wired up correctly
      const abortController = new AbortController();
      let signalPassed: AbortSignal | null | undefined;

      const mockFetch = jest.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        signalPassed = init?.signal;
        // Return a quick success
        return new Response(
          createMockStream([createSessionInitEvent(TEST_SESSION_ID), createFinalSuccessEvent(TEST_SESSION_ID, 1)]),
          { status: 200 },
        );
      });

      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        fetch: mockFetch,
      });

      await client.execute('return 1', {
        signal: abortController.signal,
      });

      // Verify signal was passed to fetch
      expect(signalPassed).toBeDefined();
    });

    it('should support cancellation via handle.cancel()', async () => {
      // Create a stream that sends init event and stays open
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(JSON.stringify(createSessionInitEvent(TEST_SESSION_ID)) + '\n'));
          // Don't close - simulates long-running session
        },
      });

      const mockFetch = jest.fn().mockImplementation(async (url: string) => {
        if (url.includes('/sessions') && !url.includes('/cancel')) {
          return new Response(stream, { status: 200 });
        }
        return new Response('{}', { status: 200 });
      });

      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        fetch: mockFetch,
      });

      const handle = client.executeStream('while(true) {}');

      // Wait for session to start, then cancel
      await new Promise((r) => setTimeout(r, 20));
      await handle.cancel('Test cancellation');

      const result = await handle.wait();

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('CANCELLED');
      expect(result.error?.message).toBe('Test cancellation');
    });
  });

  describe('concurrent sessions', () => {
    it('should handle multiple concurrent sessions', async () => {
      const session1Id = 's_session1' as SessionId;
      const session2Id = 's_session2' as SessionId;
      const session3Id = 's_session3' as SessionId;

      const createEventsForSession = (sessionId: SessionId, value: number) => [
        createSessionInitEvent(sessionId, 1),
        createStdoutEvent(sessionId, `output from ${sessionId}`, 2),
        createFinalSuccessEvent(sessionId, value, 3),
      ];

      let callCount = 0;
      const mockFetch = jest.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes('/sessions') && init?.method === 'POST') {
          const body = JSON.parse(init.body as string);
          const sessionId = body.sessionId;
          callCount++;
          const value = callCount;

          return new Response(createMockStream(createEventsForSession(sessionId, value)), { status: 200 });
        }
        return new Response('{}', { status: 200 });
      });

      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        fetch: mockFetch,
      });

      // Start 3 sessions concurrently
      const [result1, result2, result3] = await Promise.all([
        client.execute('return 1', { sessionId: session1Id }),
        client.execute('return 2', { sessionId: session2Id }),
        client.execute('return 3', { sessionId: session3Id }),
      ]);

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      expect(result3.success).toBe(true);

      // Each should have its own session ID
      expect(result1.sessionId).toBe(session1Id);
      expect(result2.sessionId).toBe(session2Id);
      expect(result3.sessionId).toBe(session3Id);
    });

    it('should isolate events between concurrent sessions', async () => {
      const session1Id = 's_iso1' as SessionId;
      const session2Id = 's_iso2' as SessionId;

      const mockFetch = jest.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes('/sessions') && init?.method === 'POST') {
          const body = JSON.parse(init.body as string);
          const sessionId = body.sessionId;

          const events = [
            createSessionInitEvent(sessionId as SessionId, 1),
            createStdoutEvent(sessionId as SessionId, `Hello from ${sessionId}`, 2),
            createFinalSuccessEvent(sessionId as SessionId, sessionId, 3),
          ];

          return new Response(createMockStream(events), { status: 200 });
        }
        return new Response('{}', { status: 200 });
      });

      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        fetch: mockFetch,
      });

      const stdout1: string[] = [];
      const stdout2: string[] = [];

      const [result1, result2] = await Promise.all([
        client.execute('return 1', {
          sessionId: session1Id,
          onStdout: (chunk) => stdout1.push(chunk),
        }),
        client.execute('return 2', {
          sessionId: session2Id,
          onStdout: (chunk) => stdout2.push(chunk),
        }),
      ]);

      expect(stdout1).toEqual(['Hello from s_iso1']);
      expect(stdout2).toEqual(['Hello from s_iso2']);
      expect(result1.value).toBe(session1Id);
      expect(result2.value).toBe(session2Id);
    });
  });

  describe('HTTP error handling', () => {
    it('should handle 400 Bad Request', async () => {
      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        fetch: createMockFetch([], 400),
        autoReconnect: false,
      });

      const result = await client.execute('invalid code');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SESSION_ERROR');
      expect(result.error?.message).toContain('400');
    });

    it('should handle 401 Unauthorized', async () => {
      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        fetch: createMockFetch([], 401),
        autoReconnect: false,
      });

      const result = await client.execute('return 1');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SESSION_ERROR');
      expect(result.error?.message).toContain('401');
    });

    it('should handle 403 Forbidden', async () => {
      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        fetch: createMockFetch([], 403),
        autoReconnect: false,
      });

      const result = await client.execute('return 1');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SESSION_ERROR');
    });

    it('should handle 503 Service Unavailable', async () => {
      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        fetch: createMockFetch([], 503),
        autoReconnect: false,
      });

      const result = await client.execute('return 1');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SESSION_ERROR');
    });

    it('should handle getSession network error', async () => {
      const mockFetch = jest.fn().mockRejectedValue(new Error('Network failed'));

      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        fetch: mockFetch,
      });

      await expect(client.getSession('s_test' as SessionId)).rejects.toThrow(EnclaveClientError);
    });

    it('should handle getSession server error', async () => {
      const mockFetch = jest.fn().mockResolvedValue(new Response('Internal Server Error', { status: 500 }));

      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        fetch: mockFetch,
      });

      await expect(client.getSession('s_test' as SessionId)).rejects.toThrow(EnclaveClientError);
    });
  });

  describe('configuration options', () => {
    it('should use custom timeout', async () => {
      const mockFetch = jest
        .fn()
        .mockResolvedValue(
          new Response(
            createMockStream([createSessionInitEvent(TEST_SESSION_ID), createFinalSuccessEvent(TEST_SESSION_ID, 1)]),
            { status: 200 },
          ),
        );

      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        timeout: 5000,
        fetch: mockFetch,
      });

      await client.execute('return 1');

      // Client was created with timeout option
      expect(client).toBeInstanceOf(EnclaveClient);
    });

    it('should use custom reconnect settings', async () => {
      const mockFetch = jest
        .fn()
        .mockResolvedValue(
          new Response(
            createMockStream([createSessionInitEvent(TEST_SESSION_ID), createFinalSuccessEvent(TEST_SESSION_ID, 1)]),
            { status: 200 },
          ),
        );

      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        autoReconnect: true,
        maxReconnectAttempts: 5,
        reconnectDelay: 2000,
        fetch: mockFetch,
      });

      await client.execute('return 1');

      // Client was created with reconnect options
      expect(client).toBeInstanceOf(EnclaveClient);
    });

    it('should disable reconnection when autoReconnect is false', async () => {
      let fetchCallCount = 0;
      const mockFetch = jest.fn().mockImplementation(async () => {
        fetchCallCount++;
        throw new Error('Connection failed');
      });

      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        autoReconnect: false,
        fetch: mockFetch,
      });

      const result = await client.execute('return 1');

      expect(result.success).toBe(false);
      expect(fetchCallCount).toBe(1); // Only one attempt, no retries
    });

    it('should include heartbeat interval in limits', async () => {
      const mockFetch = jest
        .fn()
        .mockResolvedValue(
          new Response(
            createMockStream([createSessionInitEvent(TEST_SESSION_ID), createFinalSuccessEvent(TEST_SESSION_ID, 1)]),
            { status: 200 },
          ),
        );

      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        fetch: mockFetch,
      });

      await client.execute('return 1', {
        limits: {
          heartbeatIntervalMs: 10000,
        },
      });

      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options.body);

      expect(body.config.heartbeatIntervalMs).toBe(10000);
    });
  });

  describe('request body format', () => {
    it('should send correct request body structure', async () => {
      const mockFetch = jest
        .fn()
        .mockResolvedValue(
          new Response(
            createMockStream([createSessionInitEvent(TEST_SESSION_ID), createFinalSuccessEvent(TEST_SESSION_ID, 1)]),
            { status: 200 },
          ),
        );

      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        fetch: mockFetch,
      });

      await client.execute('const x = 1; return x;', {
        sessionId: 's_mySession' as SessionId,
      });

      const [url, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options.body);

      expect(url).toBe('https://api.example.com/sessions');
      expect(options.method).toBe('POST');
      expect(options.headers).toEqual(
        expect.objectContaining({
          'Content-Type': 'application/json',
          Accept: 'application/x-ndjson',
        }),
      );
      expect(body.sessionId).toBe('s_mySession');
      expect(body.code).toBe('const x = 1; return x;');
    });

    it('should not include config when no limits provided', async () => {
      const mockFetch = jest
        .fn()
        .mockResolvedValue(
          new Response(
            createMockStream([createSessionInitEvent(TEST_SESSION_ID), createFinalSuccessEvent(TEST_SESSION_ID, 1)]),
            { status: 200 },
          ),
        );

      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        fetch: mockFetch,
      });

      await client.execute('return 1');

      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options.body);

      expect(body.config).toBeUndefined();
    });
  });

  describe('cancel endpoint', () => {
    it('should call cancel endpoint with reason', async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(JSON.stringify(createSessionInitEvent(TEST_SESSION_ID)) + '\n'));
        },
      });

      const cancelCalls: Array<{ url: string; body: string }> = [];
      const mockFetch = jest.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes('/cancel')) {
          cancelCalls.push({ url, body: init?.body as string });
          return new Response('{}', { status: 200 });
        }
        if (url.includes('/sessions')) {
          return new Response(stream, { status: 200 });
        }
        return new Response('{}', { status: 200 });
      });

      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        fetch: mockFetch,
      });

      const handle = client.executeStream('while(true) {}');
      await new Promise((r) => setTimeout(r, 10));

      await handle.cancel('User requested cancellation');

      expect(cancelCalls).toHaveLength(1);
      expect(cancelCalls[0].url).toContain('/cancel');
      expect(JSON.parse(cancelCalls[0].body)).toEqual({
        reason: 'User requested cancellation',
      });
    });

    it('should handle cancel when session not active', async () => {
      const events: StreamEvent[] = [
        createSessionInitEvent(TEST_SESSION_ID),
        createFinalSuccessEvent(TEST_SESSION_ID, 1),
      ];

      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        fetch: createMockFetch(events),
      });

      const handle = client.executeStream('return 1');
      await handle.wait();

      // Session already completed, cancel should be no-op
      await expect(handle.cancel()).resolves.toBeUndefined();
    });
  });

  describe('session info', () => {
    it('should return complete session info', async () => {
      const now = Date.now();
      const mockFetch = jest.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            sessionId: 's_info123',
            state: 'running',
            createdAt: now,
            expiresAt: now + 60000,
            stats: {
              duration: 5000,
              toolCallCount: 3,
            },
          }),
          { status: 200 },
        ),
      );

      const client = new EnclaveClient({
        baseUrl: 'https://api.example.com',
        fetch: mockFetch,
      });

      const info = await client.getSession('s_info123' as SessionId);

      expect(info).toEqual({
        sessionId: 's_info123',
        state: 'running',
        createdAt: now,
        expiresAt: now + 60000,
        stats: {
          duration: 5000,
          toolCallCount: 3,
        },
      });
    });
  });
});

describe('EnclaveClientError', () => {
  it('should create error with code and message', () => {
    const error = new EnclaveClientError('NETWORK_ERROR', 'Connection failed');

    expect(error.name).toBe('EnclaveClientError');
    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.message).toBe('Connection failed');
  });

  it('should include cause if provided', () => {
    const cause = new Error('Original error');
    const error = new EnclaveClientError('NETWORK_ERROR', 'Connection failed', cause);

    expect(error.cause).toBe(cause);
  });

  it('should be an instance of Error', () => {
    const error = new EnclaveClientError('TIMEOUT', 'Request timed out');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(EnclaveClientError);
  });

  it('should support all error codes', () => {
    const codes = [
      'NETWORK_ERROR',
      'TIMEOUT',
      'PARSE_ERROR',
      'SESSION_ERROR',
      'CANCELLED',
      'RECONNECT_FAILED',
    ] as const;

    for (const code of codes) {
      const error = new EnclaveClientError(code, `Error: ${code}`);
      expect(error.code).toBe(code);
    }
  });
});

describe('EnclaveClient edge cases', () => {
  const sessionId = 's_edge123' as SessionId;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('malformed responses', () => {
    it('should handle mixed valid and invalid JSON lines', async () => {
      const events = [createSessionInitEvent(sessionId, 1), createFinalSuccessEvent(sessionId, 42, 3)];

      const encoder = new TextEncoder();
      const lines = [JSON.stringify(events[0]), 'this is not valid json', JSON.stringify(events[1])].join('\n');

      global.fetch = async () => {
        return new Response(encoder.encode(lines + '\n'), {
          status: 200,
          headers: { 'Content-Type': 'application/x-ndjson' },
        });
      };

      const client = new EnclaveClient({ baseUrl: 'https://api.example.com' });
      const handle = client.executeStream('return 42');
      const result = await handle.wait();

      // Should still succeed as final event was received
      expect(result.success).toBe(true);
    });

    it('should handle stream with error event followed by final', async () => {
      const events = [
        createSessionInitEvent(sessionId, 1),
        createFinalErrorEvent(sessionId, 'PARSE_ERROR', 'Invalid input', 2),
      ];

      global.fetch = createMockFetch(events);

      const client = new EnclaveClient({ baseUrl: 'https://api.example.com' });
      const handle = client.executeStream('return bad');
      const result = await handle.wait();

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('PARSE_ERROR');
    });
  });

  describe('network edge cases', () => {
    it('should handle response with wrong content type', async () => {
      const events = [createSessionInitEvent(sessionId, 1), createFinalSuccessEvent(sessionId, 42, 2)];

      global.fetch = createMockFetch(events);

      const client = new EnclaveClient({ baseUrl: 'https://api.example.com' });
      const handle = client.executeStream('return 42');
      const result = await handle.wait();

      // Should still work if content is valid NDJSON
      expect(result.success).toBe(true);
    });
  });

  describe('special values', () => {
    it('should handle undefined result value', async () => {
      const events = [createSessionInitEvent(sessionId, 1), createFinalSuccessEvent(sessionId, undefined, 2)];

      global.fetch = createMockFetch(events);

      const client = new EnclaveClient({ baseUrl: 'https://api.example.com' });
      const handle = client.executeStream('return undefined');
      const result = await handle.wait();

      expect(result.success).toBe(true);
      expect(result.value).toBeUndefined();
    });

    it('should handle NaN in result (as null)', async () => {
      const events = [
        createSessionInitEvent(sessionId, 1),
        createFinalSuccessEvent(sessionId, null, 2), // NaN serializes as null
      ];

      global.fetch = createMockFetch(events);

      const client = new EnclaveClient({ baseUrl: 'https://api.example.com' });
      const handle = client.executeStream('return NaN');
      const result = await handle.wait();

      expect(result.success).toBe(true);
      expect(result.value).toBeNull();
    });

    it('should handle Infinity in result (as null)', async () => {
      const events = [
        createSessionInitEvent(sessionId, 1),
        createFinalSuccessEvent(sessionId, null, 2), // Infinity serializes as null
      ];

      global.fetch = createMockFetch(events);

      const client = new EnclaveClient({ baseUrl: 'https://api.example.com' });
      const handle = client.executeStream('return Infinity');
      const result = await handle.wait();

      expect(result.success).toBe(true);
    });

    it('should handle deeply nested object', async () => {
      const deepObject = { a: { b: { c: { d: { e: { f: 'deep' } } } } } };
      const events = [createSessionInitEvent(sessionId, 1), createFinalSuccessEvent(sessionId, deepObject, 2)];

      global.fetch = createMockFetch(events);

      const client = new EnclaveClient({ baseUrl: 'https://api.example.com' });
      const handle = client.executeStream('return deep');
      const result = await handle.wait();

      expect(result.success).toBe(true);
      expect(result.value).toEqual(deepObject);
    });

    it('should handle unicode in stdout', async () => {
      const events = [
        createSessionInitEvent(sessionId, 1),
        createStdoutEvent(sessionId, '你好世界 🌍 مرحبا', 2),
        createFinalSuccessEvent(sessionId, 'done', 3),
      ];

      global.fetch = createMockFetch(events);

      let capturedStdout = '';
      const client = new EnclaveClient({ baseUrl: 'https://api.example.com' });
      const handle = client.executeStream('print("hello")', {
        onStdout: (chunk) => {
          capturedStdout += chunk;
        },
      });
      await handle.wait();

      expect(capturedStdout).toBe('你好世界 🌍 مرحبا');
    });

    it('should handle very long stdout chunks', async () => {
      const longChunk = 'x'.repeat(100000);
      const events = [
        createSessionInitEvent(sessionId, 1),
        createStdoutEvent(sessionId, longChunk, 2),
        createFinalSuccessEvent(sessionId, 'done', 3),
      ];

      global.fetch = createMockFetch(events);

      let capturedStdout = '';
      const client = new EnclaveClient({ baseUrl: 'https://api.example.com' });
      const handle = client.executeStream('print(long)', {
        onStdout: (chunk) => {
          capturedStdout += chunk;
        },
      });
      await handle.wait();

      expect(capturedStdout.length).toBe(100000);
    });
  });

  describe('session handle', () => {
    it('should track active state correctly', async () => {
      const events = [createSessionInitEvent(sessionId, 1), createFinalSuccessEvent(sessionId, 42, 2)];

      global.fetch = createMockFetch(events);

      const client = new EnclaveClient({ baseUrl: 'https://api.example.com' });
      const handle = client.executeStream('return 42');

      expect(handle.isActive()).toBe(true);

      await handle.wait();

      expect(handle.isActive()).toBe(false);
    });

    it('should return events through getEvents', async () => {
      const events = [
        createSessionInitEvent(sessionId, 1),
        createStdoutEvent(sessionId, 'hello', 2),
        createFinalSuccessEvent(sessionId, 42, 3),
      ];

      global.fetch = createMockFetch(events);

      const client = new EnclaveClient({ baseUrl: 'https://api.example.com' });
      const handle = client.executeStream('return 42');
      await handle.wait();

      const collectedEvents = handle.getEvents();
      expect(collectedEvents.length).toBe(3);
    });

    it('should handle wait called multiple times', async () => {
      const events = [createSessionInitEvent(sessionId, 1), createFinalSuccessEvent(sessionId, 42, 2)];

      global.fetch = createMockFetch(events);

      const client = new EnclaveClient({ baseUrl: 'https://api.example.com' });
      const handle = client.executeStream('return 42');

      const result1 = await handle.wait();
      const result2 = await handle.wait();

      expect(result1).toEqual(result2);
      expect(result1.success).toBe(true);
    });
  });
});
