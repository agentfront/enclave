/**
 * Session Executor Tests
 */

import { createSessionExecutor, SessionExecutor } from './session-executor';
import { createMemoryChannel } from './channels/memory-channel';

describe('SessionExecutor', () => {
  describe('createSessionExecutor', () => {
    it('should create executor with generated session ID', () => {
      const channel = createMemoryChannel();
      const executor = createSessionExecutor({
        code: 'return 1',
        channel,
      });

      expect(executor.sessionId).toMatch(/^s_/);
    });

    it('should create executor with provided session ID', () => {
      const channel = createMemoryChannel();
      const executor = createSessionExecutor({
        sessionId: 's_custom123' as `s_${string}`,
        code: 'return 1',
        channel,
      });

      expect(executor.sessionId).toBe('s_custom123');
    });
  });

  describe('getInfo', () => {
    it('should return session info', () => {
      const channel = createMemoryChannel();
      const executor = createSessionExecutor({
        sessionId: 's_test' as `s_${string}`,
        code: 'return 1',
        channel,
      });

      const info = executor.getInfo();

      expect(info.sessionId).toBe('s_test');
      expect(info.state).toBe('starting');
      expect(info.createdAt).toBeGreaterThan(0);
      expect(info.expiresAt).toBeGreaterThan(info.createdAt);
    });
  });

  describe('state', () => {
    it('should start in starting state', () => {
      const channel = createMemoryChannel();
      const executor = createSessionExecutor({
        code: 'return 1',
        channel,
      });

      expect(executor.state).toBe('starting');
    });
  });

  describe('isTerminal', () => {
    it('should be false initially', () => {
      const channel = createMemoryChannel();
      const executor = createSessionExecutor({
        code: 'return 1',
        channel,
      });

      expect(executor.isTerminal).toBe(false);
    });
  });

  describe('cancel', () => {
    it('should cancel the session', async () => {
      const channel = createMemoryChannel();
      const executor = createSessionExecutor({
        code: 'return 1',
        channel,
      });

      await executor.cancel('test reason');

      expect(executor.isTerminal).toBe(true);
    });
  });

  describe('dispose', () => {
    it('should dispose the executor', () => {
      const channel = createMemoryChannel();
      const executor = createSessionExecutor({
        code: 'return 1',
        channel,
      });

      // Should not throw
      executor.dispose();
    });

    it('should handle multiple dispose calls', () => {
      const channel = createMemoryChannel();
      const executor = createSessionExecutor({
        code: 'return 1',
        channel,
      });

      executor.dispose();
      executor.dispose();

      // Should not throw
    });
  });

  describe('execute', () => {
    it('should throw if already executing', async () => {
      const channel = createMemoryChannel();
      const executor = createSessionExecutor({
        code: 'return 1',
        channel,
      });

      // Start first execution (won't complete normally without proper setup)
      const promise1 = executor.execute().catch(() => {});

      // Try to start second execution immediately
      await expect(executor.execute()).rejects.toThrow('already executing');

      // Clean up
      await executor.cancel('test cleanup');
      await promise1;
    });
  });

  describe('limits', () => {
    it('should pass limits to session', () => {
      const channel = createMemoryChannel();
      const executor = createSessionExecutor({
        code: 'return 1',
        channel,
        limits: {
          sessionTtlMs: 30000,
          maxToolCalls: 5,
        },
      });

      const info = executor.getInfo();

      // Session should have custom TTL
      expect(info.expiresAt - info.createdAt).toBeLessThanOrEqual(30001);
    });
  });

  describe('debug mode', () => {
    it('should accept debug flag', () => {
      const channel = createMemoryChannel();
      const executor = createSessionExecutor({
        code: 'return 1',
        channel,
        debug: true,
      });

      // Should not throw
      expect(executor).toBeDefined();
    });
  });
});
