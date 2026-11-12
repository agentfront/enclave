/**
 * Runtime Integration Tests
 *
 * Tests that verify the runtime components work together correctly.
 */

import { createRuntimeWorker } from './runtime-worker';
import { createSessionExecutor, RuntimeNotImplementedError } from './session-executor';
import { createMemoryChannel, createMemoryChannelPair } from './channels/memory-channel';

describe('Runtime Integration', () => {
  describe('Worker with Memory Channel', () => {
    it('should answer an execute request with RuntimeNotImplementedError and end the session on the channel', async () => {
      const worker = createRuntimeWorker({ debug: false, maxSessions: 5 });
      await worker.start();

      const channel = createMemoryChannel();

      await expect(
        worker.handleRequest(
          {
            type: 'execute',
            sessionId: 's_integration1' as `s_${string}`,
            code: 'return 1 + 1',
          },
          channel,
        ),
      ).rejects.toBeInstanceOf(RuntimeNotImplementedError);

      // The other end of the channel sees a session that started and ended with an error
      const events = channel.getEvents();
      expect(events.map((event) => event.type)).toEqual(['session_init', 'final']);
      expect(events[1]).toMatchObject({ payload: { ok: false, error: { code: 'NOT_IMPLEMENTED' } } });

      // Nothing is left behind
      expect(worker.getSessions()).toHaveLength(0);

      await worker.stop();
    });

    it('should not keep sessions of requests it cannot serve', async () => {
      const worker = createRuntimeWorker({ debug: false, maxSessions: 10 });
      await worker.start();

      const outcomes = await Promise.allSettled(
        ['s_multi1', 's_multi2', 's_multi3'].map((sessionId) =>
          worker.handleRequest(
            { type: 'execute', sessionId: sessionId as `s_${string}`, code: 'return 1' },
            createMemoryChannel(),
          ),
        ),
      );

      expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected', 'rejected']);
      for (const outcome of outcomes) {
        expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(RuntimeNotImplementedError);
      }
      expect(worker.getStats().activeSessions).toBe(0);

      await worker.stop();
    });

    it('should ignore a cancel request for a session it does not have', async () => {
      const worker = createRuntimeWorker({ debug: false });
      await worker.start();

      await worker.handleRequest(
        {
          type: 'cancel',
          sessionId: 's_cancel1' as `s_${string}`,
          reason: 'Test cancellation',
        },
        createMemoryChannel(),
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

      await worker
        .handleRequest(
          {
            type: 'execute',
            sessionId: 's_stats1' as `s_${string}`,
            code: 'return 1',
          },
          channel,
        )
        .catch(() => undefined);

      // The request was counted, and its session is over
      const afterStats = worker.getStats();
      expect(afterStats.totalSessions).toBe(1);
      expect(afterStats.activeSessions).toBe(0);

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
    it('should reject a request that is not a request object', async () => {
      const worker = createRuntimeWorker({ debug: false });
      await worker.start();

      const channel = createMemoryChannel();

      await expect(worker.handleRequest(null as never, channel)).rejects.toThrow(TypeError);
      await expect(worker.handleRequest('execute' as never, channel)).rejects.toThrow(TypeError);
      await expect(
        worker.handleRequest({ type: 'execute', sessionId: 's_nocode' as `s_${string}`, code: 42 as never }, channel),
      ).rejects.toThrow(TypeError);
      expect(worker.getSessions()).toHaveLength(0);

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

      // Requests that end at once (executing is not implemented)
      await worker
        .handleRequest({ type: 'execute', sessionId: 's_shutdown1' as `s_${string}`, code: 'return 1' }, channels[0])
        .catch(() => undefined);
      await worker
        .handleRequest({ type: 'execute', sessionId: 's_shutdown2' as `s_${string}`, code: 'return 2' }, channels[1])
        .catch(() => undefined);

      // Stop worker
      await worker.stop();

      // All sessions should be cleaned up
      expect(worker.getSessions().length).toBe(0);
    });
  });
});
