/**
 * Runtime Worker Tests
 */

import { createRuntimeWorker, RuntimeWorker as RuntimeWorkerImpl } from './runtime-worker';
import { createMemoryChannel } from './channels/memory-channel';

describe('RuntimeWorker', () => {
  describe('initialization', () => {
    it('should create worker with default config', () => {
      const worker = createRuntimeWorker();

      expect(worker).toBeDefined();
      expect(worker.isRunning).toBe(false);
    });

    it('should create worker with custom config', () => {
      const worker = createRuntimeWorker({
        port: 4000,
        maxSessions: 20,
        debug: true,
      });

      expect(worker).toBeDefined();
    });
  });

  describe('lifecycle', () => {
    let worker: RuntimeWorkerImpl;

    beforeEach(() => {
      worker = createRuntimeWorker({ debug: false });
    });

    afterEach(async () => {
      if (worker.isRunning) {
        await worker.stop();
      }
    });

    it('should start successfully', async () => {
      await worker.start();

      expect(worker.isRunning).toBe(true);
    });

    it('should throw when starting twice', async () => {
      await worker.start();

      await expect(worker.start()).rejects.toThrow();
    });

    it('should stop successfully', async () => {
      await worker.start();
      await worker.stop();

      expect(worker.isRunning).toBe(false);
    });

    it('should handle multiple stop calls gracefully', async () => {
      await worker.start();
      await worker.stop();
      await worker.stop();

      expect(worker.isRunning).toBe(false);
    });

    it('should restart after stop', async () => {
      await worker.start();
      await worker.stop();
      await worker.start();

      expect(worker.isRunning).toBe(true);
    });
  });

  describe('getStats', () => {
    it('should return stats when idle', () => {
      const worker = createRuntimeWorker();
      const stats = worker.getStats();

      expect(stats.state).toBe('idle');
      expect(stats.activeSessions).toBe(0);
      expect(stats.totalSessions).toBe(0);
      expect(stats.uptimeMs).toBe(0);
    });

    it('should return stats when running', async () => {
      const worker = createRuntimeWorker();
      await worker.start();

      const stats = worker.getStats();

      expect(stats.state).toBe('running');
      expect(stats.startedAt).toBeGreaterThan(0);
      expect(stats.memoryUsage).toBeDefined();
      expect(stats.memoryUsage.heapUsed).toBeGreaterThan(0);

      await worker.stop();
    });
  });

  describe('getSessions', () => {
    it('should return empty array when no sessions', () => {
      const worker = createRuntimeWorker();
      const sessions = worker.getSessions();

      expect(sessions).toEqual([]);
    });
  });

  describe('handleRequest', () => {
    let worker: RuntimeWorkerImpl;

    beforeEach(async () => {
      worker = createRuntimeWorker({ debug: false });
      await worker.start();
    });

    afterEach(async () => {
      await worker.stop();
    });

    it('should handle ping request', async () => {
      const channel = createMemoryChannel();

      await worker.handleRequest({ type: 'ping', timestamp: Date.now() }, channel);

      // Ping doesn't produce output, just logs
    });

    it('should handle cancel for non-existent session', async () => {
      const channel = createMemoryChannel();

      // Should not throw
      await worker.handleRequest(
        { type: 'cancel', sessionId: 's_nonexistent' as `s_${string}`, reason: 'test' },
        channel,
      );
    });

    it('should handle tool_result for non-existent session', async () => {
      const channel = createMemoryChannel();

      // Should not throw
      await worker.handleRequest(
        {
          type: 'tool_result',
          sessionId: 's_nonexistent' as `s_${string}`,
          callId: 'c_test',
          success: true,
          value: 42,
        },
        channel,
      );
    });

    it('should reject execute when not running', async () => {
      await worker.stop();
      const channel = createMemoryChannel();

      await expect(
        worker.handleRequest(
          {
            type: 'execute',
            sessionId: 's_test' as `s_${string}`,
            code: 'return 1',
          },
          channel,
        ),
      ).rejects.toThrow('Runtime is not running');
    });
  });

  describe('max sessions limit', () => {
    it('should respect max sessions limit', async () => {
      const worker = createRuntimeWorker({
        maxSessions: 2,
        debug: false,
      });
      await worker.start();

      const channel1 = createMemoryChannel();
      const channel2 = createMemoryChannel();
      const channel3 = createMemoryChannel();

      // Start first session
      await worker.handleRequest({ type: 'execute', sessionId: 's_1' as `s_${string}`, code: 'return 1' }, channel1);

      // Start second session
      await worker.handleRequest({ type: 'execute', sessionId: 's_2' as `s_${string}`, code: 'return 2' }, channel2);

      // Wait a bit for sessions to be registered
      await new Promise((resolve) => setTimeout(resolve, 50));

      const sessions = worker.getSessions();
      expect(sessions.length).toBeLessThanOrEqual(2);

      await worker.stop();
    });
  });
});
