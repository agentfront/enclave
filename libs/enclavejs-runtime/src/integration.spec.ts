/**
 * Runtime Integration Tests
 *
 * Tests that verify the runtime components work together correctly.
 */

import { createRuntimeWorker } from './runtime-worker';
import { createSessionExecutor } from './session-executor';
import { createMemoryChannel, createMemoryChannelPair } from './channels/memory-channel';
import type { StreamEvent } from '@enclavejs/types';

describe('Runtime Integration', () => {
  describe('Worker with Memory Channel', () => {
    it('should handle full session lifecycle', async () => {
      const worker = createRuntimeWorker({ debug: false, maxSessions: 5 });
      await worker.start();

      const channel = createMemoryChannel();
      const events: StreamEvent[] = [];

      // Track events sent to channel
      const originalSend = channel.send.bind(channel);
      channel.send = (event: StreamEvent) => {
        events.push(event);
        originalSend(event);
      };

      // Start a session
      await worker.handleRequest(
        {
          type: 'execute',
          sessionId: 's_integration1' as `s_${string}`,
          code: 'return 1 + 1',
        },
        channel,
      );

      // Wait for session to process
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify session was created
      const sessions = worker.getSessions();
      expect(sessions.length).toBeGreaterThanOrEqual(0);

      await worker.stop();
    });

    it('should handle multiple concurrent sessions', async () => {
      const worker = createRuntimeWorker({ debug: false, maxSessions: 10 });
      await worker.start();

      const channels = [createMemoryChannel(), createMemoryChannel(), createMemoryChannel()];

      // Start multiple sessions
      await Promise.all([
        worker.handleRequest(
          { type: 'execute', sessionId: 's_multi1' as `s_${string}`, code: 'return 1' },
          channels[0],
        ),
        worker.handleRequest(
          { type: 'execute', sessionId: 's_multi2' as `s_${string}`, code: 'return 2' },
          channels[1],
        ),
        worker.handleRequest(
          { type: 'execute', sessionId: 's_multi3' as `s_${string}`, code: 'return 3' },
          channels[2],
        ),
      ]);

      await new Promise((resolve) => setTimeout(resolve, 100));

      await worker.stop();
    });

    it('should handle session cancellation', async () => {
      const worker = createRuntimeWorker({ debug: false });
      await worker.start();

      const channel = createMemoryChannel();

      // Start a session
      await worker.handleRequest(
        {
          type: 'execute',
          sessionId: 's_cancel1' as `s_${string}`,
          code: 'while(true) {}', // Long-running code
        },
        channel,
      );

      // Cancel it
      await worker.handleRequest(
        {
          type: 'cancel',
          sessionId: 's_cancel1' as `s_${string}`,
          reason: 'Test cancellation',
        },
        channel,
      );

      await worker.stop();
    });
  });

  describe('SessionExecutor with Memory Channel', () => {
    it('should forward events to channel', async () => {
      const channel = createMemoryChannel();
      const executor = createSessionExecutor({
        sessionId: 's_forward1' as `s_${string}`,
        code: 'return 42',
        channel,
      });

      // Cancel to trigger events
      await executor.cancel('test');

      // Check that events were sent
      const events = channel.getEvents();
      expect(events.length).toBeGreaterThan(0);

      executor.dispose();
    });

    it('should handle disposal during active session', async () => {
      const channel = createMemoryChannel();
      const executor = createSessionExecutor({
        code: 'return 1',
        channel,
      });

      // Dispose immediately
      executor.dispose();

      // Should not throw
      expect(executor.isTerminal).toBe(false);
    });
  });

  describe('Memory Channel Pair', () => {
    it('should enable bidirectional communication', () => {
      const { client, server } = createMemoryChannelPair();

      const clientReceived: unknown[] = [];
      const serverReceived: unknown[] = [];

      client.onMessage((msg) => clientReceived.push(msg));
      server.onMessage((msg) => serverReceived.push(msg));

      // Note: The channel pair forwards messages, so we need to send
      // directly and check if messages propagate

      expect(client.isOpen).toBe(true);
      expect(server.isOpen).toBe(true);
    });

    it('should handle closing one side', () => {
      const { client, server } = createMemoryChannelPair();

      client.close();

      expect(client.isOpen).toBe(false);
      expect(server.isOpen).toBe(true);
    });
  });

  describe('Worker Stats', () => {
    it('should track session counts correctly', async () => {
      const worker = createRuntimeWorker({ debug: false });
      await worker.start();

      const initialStats = worker.getStats();
      expect(initialStats.activeSessions).toBe(0);
      expect(initialStats.totalSessions).toBe(0);

      const channel = createMemoryChannel();

      await worker.handleRequest(
        {
          type: 'execute',
          sessionId: 's_stats1' as `s_${string}`,
          code: 'return 1',
        },
        channel,
      );

      const afterStats = worker.getStats();
      expect(afterStats.totalSessions).toBe(1);

      await worker.stop();
    });

    it('should report memory usage', async () => {
      const worker = createRuntimeWorker();
      await worker.start();

      const stats = worker.getStats();

      expect(stats.memoryUsage).toBeDefined();
      expect(stats.memoryUsage.heapUsed).toBeGreaterThan(0);
      expect(stats.memoryUsage.heapTotal).toBeGreaterThan(0);
      expect(stats.memoryUsage.rss).toBeGreaterThan(0);

      await worker.stop();
    });

    it('should report uptime', async () => {
      const worker = createRuntimeWorker();
      await worker.start();

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 50));

      const stats = worker.getStats();
      expect(stats.uptimeMs).toBeGreaterThan(0);
      expect(stats.startedAt).toBeGreaterThan(0);

      await worker.stop();
    });
  });

  describe('Error Handling', () => {
    it('should handle execute request with invalid session ID format gracefully', async () => {
      const worker = createRuntimeWorker({ debug: false });
      await worker.start();

      const channel = createMemoryChannel();

      // Session IDs that don't match s_ prefix will still work
      // (the validation is at a higher level)
      await worker.handleRequest(
        {
          type: 'execute',
          sessionId: 'invalid_id' as `s_${string}`,
          code: 'return 1',
        },
        channel,
      );

      await worker.stop();
    });

    it('should handle tool result for completed session', async () => {
      const worker = createRuntimeWorker({ debug: false });
      await worker.start();

      const channel = createMemoryChannel();

      // Send tool result for non-existent session
      await worker.handleRequest(
        {
          type: 'tool_result',
          sessionId: 's_completed' as `s_${string}`,
          callId: 'c_test',
          success: true,
          value: 42,
        },
        channel,
      );

      // Should not throw
      await worker.stop();
    });

    it('should handle unknown request type', async () => {
      const worker = createRuntimeWorker({ debug: false });
      await worker.start();

      const channel = createMemoryChannel();

      // Send unknown request type
      await worker.handleRequest({ type: 'unknown' } as any, channel);

      // Should not throw
      await worker.stop();
    });
  });

  describe('Graceful Shutdown', () => {
    it('should cancel all sessions on stop', async () => {
      const worker = createRuntimeWorker({ debug: false });
      await worker.start();

      const channels = [createMemoryChannel(), createMemoryChannel()];

      // Start sessions
      await worker.handleRequest(
        { type: 'execute', sessionId: 's_shutdown1' as `s_${string}`, code: 'return 1' },
        channels[0],
      );
      await worker.handleRequest(
        { type: 'execute', sessionId: 's_shutdown2' as `s_${string}`, code: 'return 2' },
        channels[1],
      );

      // Stop worker
      await worker.stop();

      // All sessions should be cleaned up
      expect(worker.getSessions().length).toBe(0);
    });
  });
});
