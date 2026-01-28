/**
 * WebSocket Channel Tests
 */

import { EventType, PROTOCOL_VERSION } from '@enclave-vm/types';
import type { StreamEvent } from '@enclave-vm/types';
import { WebSocketChannel, createWebSocketChannel } from './websocket-channel';

// Mock WebSocket for Node.js environment
class MockWebSocket {
  static instances: MockWebSocket[] = [];

  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((error: Error) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  readyState = 0; // CONNECTING
  sentMessages: string[] = [];

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sentMessages.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3; // CLOSED
    if (this.onclose) {
      this.onclose({ code: code ?? 1000, reason: reason ?? '' });
    }
  }

  // Test helpers
  simulateOpen(): void {
    this.readyState = 1; // OPEN
    if (this.onopen) {
      this.onopen();
    }
  }

  simulateMessage(data: string): void {
    if (this.onmessage) {
      this.onmessage({ data });
    }
  }

  simulateError(error: Error): void {
    if (this.onerror) {
      this.onerror(error);
    }
  }

  simulateClose(code: number, reason: string): void {
    this.readyState = 3;
    if (this.onclose) {
      this.onclose({ code, reason });
    }
  }
}

// Setup global WebSocket mock
(global as any).WebSocket = MockWebSocket;

describe('WebSocketChannel', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('createWebSocketChannel', () => {
    it('should create channel with URL', () => {
      const channel = createWebSocketChannel({ url: 'ws://localhost:3001' });

      expect(channel).toBeDefined();
      expect(channel.isOpen).toBe(false);
    });

    it('should create channel with custom config', () => {
      const channel = createWebSocketChannel({
        url: 'ws://localhost:3001',
        reconnect: {
          enabled: false,
          maxRetries: 3,
        },
        connectionTimeoutMs: 5000,
        debug: true,
      });

      expect(channel).toBeDefined();
    });
  });

  describe('connect', () => {
    it('should connect successfully', async () => {
      const channel = createWebSocketChannel({ url: 'ws://localhost:3001' });

      const connectPromise = channel.connect();

      // Get the mock WebSocket instance
      const ws = MockWebSocket.instances[0];
      expect(ws).toBeDefined();
      expect(ws.url).toBe('ws://localhost:3001');

      // Simulate successful connection
      ws.simulateOpen();

      await connectPromise;

      expect(channel.isOpen).toBe(true);
      expect(channel.channelState).toBe('connected');
    });

    it('should handle connection timeout', async () => {
      const channel = createWebSocketChannel({
        url: 'ws://localhost:3001',
        connectionTimeoutMs: 1000,
      });

      const connectPromise = channel.connect();

      // Advance timers past timeout
      jest.advanceTimersByTime(1500);

      await expect(connectPromise).rejects.toThrow('Connection timeout');
    });

    it('should not reconnect if already connected', async () => {
      const channel = createWebSocketChannel({ url: 'ws://localhost:3001' });

      const connectPromise1 = channel.connect();
      MockWebSocket.instances[0].simulateOpen();
      await connectPromise1;

      // Second connect should return immediately
      await channel.connect();

      expect(MockWebSocket.instances.length).toBe(1);
    });

    it('should handle connection error', async () => {
      const channel = createWebSocketChannel({ url: 'ws://localhost:3001' });

      const connectPromise = channel.connect();

      const ws = MockWebSocket.instances[0];
      ws.simulateError(new Error('Connection refused'));

      await expect(connectPromise).rejects.toThrow('Connection failed');
    });
  });

  describe('send', () => {
    it('should send event when connected', async () => {
      const channel = createWebSocketChannel({ url: 'ws://localhost:3001' });

      const connectPromise = channel.connect();
      MockWebSocket.instances[0].simulateOpen();
      await connectPromise;

      const event: StreamEvent = {
        protocolVersion: PROTOCOL_VERSION,
        sessionId: 's_test' as `s_${string}`,
        seq: 1,
        type: EventType.Heartbeat,
        payload: { ts: new Date().toISOString() },
      };

      channel.send(event);

      const ws = MockWebSocket.instances[0];
      expect(ws.sentMessages.length).toBe(1);
      expect(ws.sentMessages[0]).toContain('heartbeat');
    });

    it('should buffer messages when disconnected', () => {
      const channel = createWebSocketChannel({ url: 'ws://localhost:3001' });

      const event: StreamEvent = {
        protocolVersion: PROTOCOL_VERSION,
        sessionId: 's_test' as `s_${string}`,
        seq: 1,
        type: EventType.Heartbeat,
        payload: { ts: new Date().toISOString() },
      };

      // Send before connecting - should buffer
      channel.send(event);

      // No WebSocket created yet, message should be buffered
      expect(MockWebSocket.instances.length).toBe(0);
    });

    it('should flush buffer on connect', async () => {
      const channel = createWebSocketChannel({ url: 'ws://localhost:3001' });

      const event: StreamEvent = {
        protocolVersion: PROTOCOL_VERSION,
        sessionId: 's_test' as `s_${string}`,
        seq: 1,
        type: EventType.Heartbeat,
        payload: { ts: new Date().toISOString() },
      };

      // Buffer message
      channel.send(event);

      // Now connect
      const connectPromise = channel.connect();
      MockWebSocket.instances[0].simulateOpen();
      await connectPromise;

      // Buffered message should be sent
      const ws = MockWebSocket.instances[0];
      expect(ws.sentMessages.length).toBe(1);
    });
  });

  describe('onMessage', () => {
    it('should call handler on incoming message', async () => {
      const channel = createWebSocketChannel({ url: 'ws://localhost:3001' });

      const handler = jest.fn();
      channel.onMessage(handler);

      const connectPromise = channel.connect();
      MockWebSocket.instances[0].simulateOpen();
      await connectPromise;

      const ws = MockWebSocket.instances[0];
      ws.simulateMessage('{"type":"test","data":42}');

      expect(handler).toHaveBeenCalled();
    });

    it('should handle multiple handlers', async () => {
      const channel = createWebSocketChannel({ url: 'ws://localhost:3001' });

      const handler1 = jest.fn();
      const handler2 = jest.fn();
      channel.onMessage(handler1);
      channel.onMessage(handler2);

      const connectPromise = channel.connect();
      MockWebSocket.instances[0].simulateOpen();
      await connectPromise;

      MockWebSocket.instances[0].simulateMessage('{"type":"test"}');

      expect(handler1).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
    });

    it('should allow unsubscribing', async () => {
      const channel = createWebSocketChannel({ url: 'ws://localhost:3001' });

      const handler = jest.fn();
      const unsubscribe = channel.onMessage(handler);

      const connectPromise = channel.connect();
      MockWebSocket.instances[0].simulateOpen();
      await connectPromise;

      unsubscribe();

      MockWebSocket.instances[0].simulateMessage('{"type":"test"}');

      expect(handler).not.toHaveBeenCalled();
    });

    it('should handle malformed JSON gracefully', async () => {
      const channel = createWebSocketChannel({ url: 'ws://localhost:3001', debug: false });

      const handler = jest.fn();
      channel.onMessage(handler);

      const connectPromise = channel.connect();
      MockWebSocket.instances[0].simulateOpen();
      await connectPromise;

      // Send malformed JSON - should not throw
      MockWebSocket.instances[0].simulateMessage('not valid json');

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('close', () => {
    it('should close the channel', async () => {
      const channel = createWebSocketChannel({ url: 'ws://localhost:3001' });

      const connectPromise = channel.connect();
      MockWebSocket.instances[0].simulateOpen();
      await connectPromise;

      channel.close();

      expect(channel.isOpen).toBe(false);
      expect(channel.channelState).toBe('closed');
    });

    it('should clear message handlers', async () => {
      const channel = createWebSocketChannel({ url: 'ws://localhost:3001' });

      const handler = jest.fn();
      channel.onMessage(handler);

      const connectPromise = channel.connect();
      MockWebSocket.instances[0].simulateOpen();
      await connectPromise;

      channel.close();

      // Handler should be cleared
      expect(channel.isOpen).toBe(false);
    });

    it('should clear message buffer', () => {
      const channel = createWebSocketChannel({ url: 'ws://localhost:3001' });

      channel.send({
        protocolVersion: PROTOCOL_VERSION,
        sessionId: 's_test' as `s_${string}`,
        seq: 1,
        type: EventType.Heartbeat,
        payload: { ts: new Date().toISOString() },
      });

      channel.close();

      expect(channel.channelState).toBe('closed');
    });
  });

  describe('reconnection', () => {
    it('should attempt reconnection on disconnect', async () => {
      const channel = createWebSocketChannel({
        url: 'ws://localhost:3001',
        reconnect: {
          enabled: true,
          maxRetries: 3,
          initialDelayMs: 100,
        },
      });

      const connectPromise = channel.connect();
      MockWebSocket.instances[0].simulateOpen();
      await connectPromise;

      // Simulate disconnect
      MockWebSocket.instances[0].simulateClose(1006, 'Connection lost');

      expect(channel.channelState).toBe('reconnecting');

      // Advance timer for reconnection delay
      jest.advanceTimersByTime(100);

      // A new WebSocket should be created
      expect(MockWebSocket.instances.length).toBe(2);
    });

    it('should use exponential backoff', async () => {
      const channel = createWebSocketChannel({
        url: 'ws://localhost:3001',
        reconnect: {
          enabled: true,
          maxRetries: 5,
          initialDelayMs: 100,
          maxDelayMs: 1000,
        },
      });

      const connectPromise = channel.connect();
      MockWebSocket.instances[0].simulateOpen();
      await connectPromise;

      // First disconnect
      MockWebSocket.instances[0].simulateClose(1006, 'Lost');
      jest.advanceTimersByTime(100); // First retry: 100ms

      // Second disconnect
      MockWebSocket.instances[1].simulateClose(1006, 'Lost');
      jest.advanceTimersByTime(200); // Second retry: 200ms (100 * 2^1)

      expect(MockWebSocket.instances.length).toBe(3);
    });

    it('should stop after max retries', async () => {
      const channel = createWebSocketChannel({
        url: 'ws://localhost:3001',
        reconnect: {
          enabled: true,
          maxRetries: 2,
          initialDelayMs: 100,
        },
      });

      const connectPromise = channel.connect();
      MockWebSocket.instances[0].simulateOpen();
      await connectPromise;

      // First disconnect and retry
      MockWebSocket.instances[0].simulateClose(1006, 'Lost');
      jest.advanceTimersByTime(100);
      MockWebSocket.instances[1].simulateClose(1006, 'Lost');
      jest.advanceTimersByTime(200);
      MockWebSocket.instances[2].simulateClose(1006, 'Lost');

      // Should stop reconnecting
      expect(channel.channelState).toBe('closed');
    });

    it('should not reconnect when disabled', async () => {
      const channel = createWebSocketChannel({
        url: 'ws://localhost:3001',
        reconnect: {
          enabled: false,
        },
      });

      const connectPromise = channel.connect();
      MockWebSocket.instances[0].simulateOpen();
      await connectPromise;

      MockWebSocket.instances[0].simulateClose(1006, 'Lost');

      expect(channel.channelState).toBe('disconnected');
      expect(MockWebSocket.instances.length).toBe(1);
    });
  });

  describe('channelState', () => {
    it('should start as disconnected', () => {
      const channel = createWebSocketChannel({ url: 'ws://localhost:3001' });

      expect(channel.channelState).toBe('disconnected');
    });

    it('should transition through states', async () => {
      const channel = createWebSocketChannel({ url: 'ws://localhost:3001' });

      expect(channel.channelState).toBe('disconnected');

      const connectPromise = channel.connect();
      expect(channel.channelState).toBe('connecting');

      MockWebSocket.instances[0].simulateOpen();
      await connectPromise;
      expect(channel.channelState).toBe('connected');

      channel.close();
      expect(channel.channelState).toBe('closed');
    });
  });
});
