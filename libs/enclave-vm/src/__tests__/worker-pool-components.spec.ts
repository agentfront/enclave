/**
 * Tests for worker-pool components
 *
 * Tests the individual components of the worker pool system
 * that can be unit tested without spawning actual workers.
 */

import { ExecutionQueue } from '../adapters/worker-pool/execution-queue';
import { RateLimiter, createRateLimiter } from '../adapters/worker-pool/rate-limiter';
import {
  safeDeserialize,
  safeSerialize,
  sanitizeObject,
  isDangerousKey,
} from '../adapters/worker-pool/safe-deserialize';
import {
  isToolCallMessage,
  isExecutionResultMessage,
  isMemoryReportResultMessage,
  isConsoleMessage,
  isWorkerReadyMessage,
  toolCallMessageSchema,
  executionResultMessageSchema,
  consoleMessageSchema,
  workerReadyMessageSchema,
  workerToMainMessageSchema,
  type WorkerToMainMessage,
  type ToolCallMessage,
  type ExecutionResultMessage,
  type ConsoleMessage,
} from '../adapters/worker-pool/protocol';
import { MemoryMonitor } from '../adapters/worker-pool/memory-monitor';
import { buildWorkerPoolConfig, DEFAULT_WORKER_POOL_CONFIG, WORKER_POOL_PRESETS } from '../adapters/worker-pool/config';
import {
  WorkerPoolError,
  WorkerTimeoutError,
  WorkerMemoryError,
  WorkerCrashedError,
  WorkerPoolDisposedError,
  QueueFullError,
  QueueTimeoutError,
  ExecutionAbortedError,
  MessageFloodError,
  MessageValidationError,
  MessageSizeError,
  WorkerStartupError,
  TooManyPendingCallsError,
} from '../adapters/worker-pool/errors';

describe('worker-pool components', () => {
  describe('ExecutionQueue', () => {
    it('should create a queue with config', () => {
      const queue = new ExecutionQueue({
        maxQueueSize: 10,
        queueTimeoutMs: 5000,
      });
      expect(queue.length).toBe(0);
      expect(queue.isFull).toBe(false);
    });

    it('should report isFull correctly', () => {
      const queue = new ExecutionQueue({
        maxQueueSize: 1,
        queueTimeoutMs: 5000,
      });
      expect(queue.isFull).toBe(false);
    });

    it('should throw QueueFullError when queue is full', async () => {
      const queue = new ExecutionQueue({
        maxQueueSize: 0,
        queueTimeoutMs: 5000,
      });
      await expect(queue.enqueue()).rejects.toThrow(QueueFullError);
    });

    it('should throw ExecutionAbortedError if signal already aborted', async () => {
      const queue = new ExecutionQueue({
        maxQueueSize: 10,
        queueTimeoutMs: 5000,
      });
      const controller = new AbortController();
      controller.abort();
      await expect(queue.enqueue(controller.signal)).rejects.toThrow(ExecutionAbortedError);
    });

    it('should handle abort signal while queued', async () => {
      const queue = new ExecutionQueue({
        maxQueueSize: 10,
        queueTimeoutMs: 5000,
      });
      const controller = new AbortController();

      const promise = queue.enqueue(controller.signal);

      // Abort after a short delay
      setTimeout(() => controller.abort(), 10);

      await expect(promise).rejects.toThrow(ExecutionAbortedError);
      expect(queue.length).toBe(0);
    });

    it('should timeout queued requests', async () => {
      const queue = new ExecutionQueue({
        maxQueueSize: 10,
        queueTimeoutMs: 50, // Short timeout for test
      });

      await expect(queue.enqueue()).rejects.toThrow(QueueTimeoutError);
    });

    it('should notify slot available and fulfill request', async () => {
      const queue = new ExecutionQueue({
        maxQueueSize: 10,
        queueTimeoutMs: 5000,
      });

      const promise = queue.enqueue();

      // Notify that a slot is available
      const fulfilled = queue.notifySlotAvailable('slot-1');
      expect(fulfilled).toBe(true);

      const slotId = await promise;
      expect(slotId).toBe('slot-1');
    });

    it('should return false when notifying empty queue', () => {
      const queue = new ExecutionQueue({
        maxQueueSize: 10,
        queueTimeoutMs: 5000,
      });

      expect(queue.notifySlotAvailable('slot-1')).toBe(false);
    });

    it('should clear queue and reject pending requests', async () => {
      const queue = new ExecutionQueue({
        maxQueueSize: 10,
        queueTimeoutMs: 5000,
      });

      const promise = queue.enqueue();
      queue.clear();

      await expect(promise).rejects.toThrow(ExecutionAbortedError);
      expect(queue.length).toBe(0);
    });

    it('should track statistics correctly', async () => {
      const queue = new ExecutionQueue({
        maxQueueSize: 10,
        queueTimeoutMs: 5000,
      });

      // Enqueue and fulfill
      const promise = queue.enqueue();
      queue.notifySlotAvailable('slot-1');
      await promise;

      const stats = queue.getStats();
      expect(stats.totalQueued).toBe(1);
      expect(stats.totalFulfilled).toBe(1);
      expect(stats.length).toBe(0);
      expect(stats.maxSize).toBe(10);
    });

    it('should track timeout statistics', async () => {
      const queue = new ExecutionQueue({
        maxQueueSize: 10,
        queueTimeoutMs: 10,
      });

      try {
        await queue.enqueue();
      } catch {
        // Expected timeout
      }

      const stats = queue.getStats();
      expect(stats.totalTimedOut).toBe(1);
    });

    it('should track abort statistics', async () => {
      const queue = new ExecutionQueue({
        maxQueueSize: 10,
        queueTimeoutMs: 5000,
      });

      const controller = new AbortController();
      const promise = queue.enqueue(controller.signal);
      controller.abort();

      try {
        await promise;
      } catch {
        // Expected abort
      }

      const stats = queue.getStats();
      expect(stats.totalAborted).toBe(1);
    });

    it('should reset statistics', () => {
      const queue = new ExecutionQueue({
        maxQueueSize: 10,
        queueTimeoutMs: 5000,
      });

      // Do some operations to create stats
      queue.notifySlotAvailable('slot-1');

      queue.resetStats();
      const stats = queue.getStats();
      expect(stats.totalQueued).toBe(0);
      expect(stats.totalFulfilled).toBe(0);
    });
  });

  describe('RateLimiter', () => {
    it('should create a rate limiter with config', () => {
      const limiter = new RateLimiter({
        maxMessagesPerWindow: 10,
        windowMs: 1000,
      });
      expect(limiter).toBeDefined();
    });

    it('should allow messages under limit', () => {
      const limiter = new RateLimiter({
        maxMessagesPerWindow: 10,
        windowMs: 1000,
      });

      expect(() => limiter.checkLimit('slot-1')).not.toThrow();
      expect(() => limiter.checkLimit('slot-1')).not.toThrow();
    });

    it('should throw MessageFloodError when limit exceeded', () => {
      const limiter = new RateLimiter({
        maxMessagesPerWindow: 2,
        windowMs: 10000, // Long window to avoid reset
      });

      limiter.checkLimit('slot-1');
      limiter.checkLimit('slot-1');
      expect(() => limiter.checkLimit('slot-1')).toThrow(MessageFloodError);
    });

    it('should track different slots independently', () => {
      const limiter = new RateLimiter({
        maxMessagesPerWindow: 1,
        windowMs: 10000,
      });

      limiter.checkLimit('slot-1');
      expect(() => limiter.checkLimit('slot-2')).not.toThrow();
    });

    it('should reset slot rate limit', () => {
      const limiter = new RateLimiter({
        maxMessagesPerWindow: 1,
        windowMs: 10000,
      });

      limiter.checkLimit('slot-1');
      expect(() => limiter.checkLimit('slot-1')).toThrow();

      limiter.reset('slot-1');
      expect(() => limiter.checkLimit('slot-1')).not.toThrow();
    });

    it('should clear all tracking', () => {
      const limiter = new RateLimiter({
        maxMessagesPerWindow: 1,
        windowMs: 10000,
      });

      limiter.checkLimit('slot-1');
      limiter.checkLimit('slot-2');

      limiter.clear();

      expect(() => limiter.checkLimit('slot-1')).not.toThrow();
      expect(() => limiter.checkLimit('slot-2')).not.toThrow();
    });

    it('should get current rate for slot', () => {
      const limiter = new RateLimiter({
        maxMessagesPerWindow: 10,
        windowMs: 10000,
      });

      expect(limiter.getCurrentRate('slot-1')).toBe(0);

      limiter.checkLimit('slot-1');
      limiter.checkLimit('slot-1');

      expect(limiter.getCurrentRate('slot-1')).toBe(2);
    });

    it('should return 0 rate for expired window', async () => {
      const limiter = new RateLimiter({
        maxMessagesPerWindow: 10,
        windowMs: 10, // Very short window
      });

      limiter.checkLimit('slot-1');
      expect(limiter.getCurrentRate('slot-1')).toBe(1);

      await new Promise((r) => setTimeout(r, 20));
      expect(limiter.getCurrentRate('slot-1')).toBe(0);
    });

    it('should prune expired windows', async () => {
      const limiter = new RateLimiter({
        maxMessagesPerWindow: 10,
        windowMs: 10,
      });

      limiter.checkLimit('slot-1');
      limiter.checkLimit('slot-2');

      // Wait for windows to expire
      await new Promise((r) => setTimeout(r, 30));

      const pruned = limiter.prune();
      expect(pruned).toBe(2);
    });

    it('should reset window after expiry', async () => {
      const limiter = new RateLimiter({
        maxMessagesPerWindow: 1,
        windowMs: 10,
      });

      limiter.checkLimit('slot-1');
      expect(() => limiter.checkLimit('slot-1')).toThrow();

      // Wait for window to expire
      await new Promise((r) => setTimeout(r, 20));

      // Should work again
      expect(() => limiter.checkLimit('slot-1')).not.toThrow();
    });

    describe('createRateLimiter', () => {
      it('should create limiter with per-second rate', () => {
        const limiter = createRateLimiter(100);
        expect(limiter).toBeInstanceOf(RateLimiter);
      });
    });
  });

  describe('safe-deserialize', () => {
    describe('safeDeserialize', () => {
      it('should parse valid JSON', () => {
        const result = safeDeserialize('{"name":"test","value":42}');
        expect(result).toEqual({ name: 'test', value: 42 });
      });

      it('should handle null', () => {
        expect(safeDeserialize('null')).toBeNull();
      });

      it('should handle primitives', () => {
        expect(safeDeserialize('"hello"')).toBe('hello');
        expect(safeDeserialize('42')).toBe(42);
        expect(safeDeserialize('true')).toBe(true);
      });

      it('should handle arrays', () => {
        const result = safeDeserialize('[1,2,3]');
        expect(result).toEqual([1, 2, 3]);
      });

      it('should strip __proto__ key', () => {
        const result = safeDeserialize('{"__proto__":{"malicious":true},"safe":"value"}');
        expect(result).toEqual({ safe: 'value' });
        expect((result as Record<string, unknown>)['__proto__']).toBeUndefined();
      });

      it('should strip constructor key', () => {
        const result = safeDeserialize('{"constructor":{"attack":true},"safe":"value"}');
        expect(result).toEqual({ safe: 'value' });
      });

      it('should strip prototype key', () => {
        const result = safeDeserialize('{"prototype":{"hack":true},"safe":"value"}');
        expect(result).toEqual({ safe: 'value' });
      });

      it('should strip dangerous keys recursively', () => {
        const result = safeDeserialize('{"nested":{"deep":{"__proto__":{},"value":1}}}');
        expect((result as Record<string, unknown>)['nested']).toEqual({ deep: { value: 1 } });
      });

      it('should create null-prototype objects', () => {
        const result = safeDeserialize('{"key":"value"}') as object;
        expect(Object.getPrototypeOf(result)).toBeNull();
      });

      it('should throw MessageSizeError when exceeding size limit', () => {
        const largeJson = JSON.stringify({ data: 'x'.repeat(1000) });
        expect(() => safeDeserialize(largeJson, 100)).toThrow(MessageSizeError);
      });

      it('should allow messages under size limit', () => {
        const json = JSON.stringify({ small: true });
        expect(() => safeDeserialize(json, 10000)).not.toThrow();
      });

      it('should throw MessageValidationError for invalid JSON', () => {
        expect(() => safeDeserialize('not valid json')).toThrow(MessageValidationError);
      });

      it('should throw MessageValidationError when depth exceeded', () => {
        // Create deeply nested object (>50 levels)
        let deep = '{"a":1}';
        for (let i = 0; i < 60; i++) {
          deep = `{"nested":${deep}}`;
        }
        expect(() => safeDeserialize(deep)).toThrow(MessageValidationError);
        expect(() => safeDeserialize(deep)).toThrow(/maximum depth/);
      });
    });

    describe('safeSerialize', () => {
      it('should serialize objects to JSON', () => {
        const result = safeSerialize({ name: 'test', value: 42 });
        expect(result).toBe('{"name":"test","value":42}');
      });

      it('should strip __proto__ during serialization', () => {
        const obj = { safe: 'value' };
        Object.defineProperty(obj, '__proto__', { value: 'malicious', enumerable: true });
        const result = safeSerialize(obj);
        expect(result).not.toContain('__proto__');
      });

      it('should strip constructor during serialization', () => {
        const obj = { safe: 'value', constructor: 'bad' };
        const result = safeSerialize(obj);
        expect(result).not.toContain('constructor');
      });

      it('should handle arrays', () => {
        const result = safeSerialize([1, 2, 3]);
        expect(result).toBe('[1,2,3]');
      });

      it('should handle null', () => {
        expect(safeSerialize(null)).toBe('null');
      });
    });

    describe('sanitizeObject', () => {
      it('should return primitives unchanged', () => {
        expect(sanitizeObject(42)).toBe(42);
        expect(sanitizeObject('hello')).toBe('hello');
        expect(sanitizeObject(true)).toBe(true);
      });

      it('should return null/undefined unchanged', () => {
        expect(sanitizeObject(null)).toBeNull();
        expect(sanitizeObject(undefined)).toBeUndefined();
      });

      it('should sanitize objects', () => {
        const result = sanitizeObject({ name: 'test' });
        expect(result).toEqual({ name: 'test' });
      });

      it('should strip dangerous keys', () => {
        const obj = {
          safe: 'value',
          __proto__: {},
          constructor: {},
          prototype: {},
        };
        const result = sanitizeObject(obj);
        expect(result).toEqual({ safe: 'value' });
      });

      it('should sanitize arrays', () => {
        const result = sanitizeObject([{ name: 'a' }, { name: 'b' }]);
        expect(result).toEqual([{ name: 'a' }, { name: 'b' }]);
      });

      it('should truncate when depth exceeded', () => {
        // Create very deep object (>50 levels)
        let deep: Record<string, unknown> = { value: 1 };
        for (let i = 0; i < 60; i++) {
          deep = { nested: deep };
        }
        const result = sanitizeObject(deep) as Record<string, unknown>;
        // At depth 51, it returns undefined for the value, so we check
        // that the deepest level is undefined (truncated)
        let current = result;
        let depth = 0;
        while (current && typeof current === 'object' && 'nested' in current) {
          current = current['nested'] as Record<string, unknown>;
          depth++;
        }
        // Should stop at MAX_DEPTH (50)
        expect(depth).toBeLessThanOrEqual(51);
      });
    });

    describe('isDangerousKey', () => {
      it('should return true for __proto__', () => {
        expect(isDangerousKey('__proto__')).toBe(true);
      });

      it('should return true for constructor', () => {
        expect(isDangerousKey('constructor')).toBe(true);
      });

      it('should return true for prototype', () => {
        expect(isDangerousKey('prototype')).toBe(true);
      });

      it('should return false for safe keys', () => {
        expect(isDangerousKey('name')).toBe(false);
        expect(isDangerousKey('value')).toBe(false);
        expect(isDangerousKey('data')).toBe(false);
      });
    });
  });

  describe('config', () => {
    describe('DEFAULT_WORKER_POOL_CONFIG', () => {
      it('should have expected default values', () => {
        expect(DEFAULT_WORKER_POOL_CONFIG.minWorkers).toBe(2);
        expect(DEFAULT_WORKER_POOL_CONFIG.memoryLimitPerWorker).toBe(128 * 1024 * 1024);
        expect(DEFAULT_WORKER_POOL_CONFIG.maxExecutionsPerWorker).toBe(1000);
        expect(DEFAULT_WORKER_POOL_CONFIG.warmOnInit).toBe(true);
      });
    });

    describe('WORKER_POOL_PRESETS', () => {
      it('should have STRICT preset with tight limits', () => {
        const preset = WORKER_POOL_PRESETS.STRICT;
        expect(preset.memoryLimitPerWorker).toBe(64 * 1024 * 1024);
        expect(preset.maxExecutionsPerWorker).toBe(100);
        expect(preset.maxWorkers).toBe(4);
      });

      it('should have SECURE preset with balanced settings', () => {
        const preset = WORKER_POOL_PRESETS.SECURE;
        expect(preset.memoryLimitPerWorker).toBe(128 * 1024 * 1024);
        expect(preset.maxExecutionsPerWorker).toBe(500);
      });

      it('should have STANDARD preset', () => {
        const preset = WORKER_POOL_PRESETS.STANDARD;
        expect(preset.memoryLimitPerWorker).toBe(256 * 1024 * 1024);
        expect(preset.maxExecutionsPerWorker).toBe(1000);
      });

      it('should have PERMISSIVE preset with high limits', () => {
        const preset = WORKER_POOL_PRESETS.PERMISSIVE;
        expect(preset.memoryLimitPerWorker).toBe(512 * 1024 * 1024);
        expect(preset.maxExecutionsPerWorker).toBe(5000);
        expect(preset.maxWorkers).toBe(32);
      });
    });

    describe('buildWorkerPoolConfig', () => {
      it('should apply preset for security level', () => {
        const config = buildWorkerPoolConfig('STRICT');
        expect(config.memoryLimitPerWorker).toBe(64 * 1024 * 1024);
        expect(config.maxWorkers).toBe(4);
      });

      it('should apply overrides over preset', () => {
        const config = buildWorkerPoolConfig('STRICT', { maxWorkers: 8 });
        expect(config.maxWorkers).toBe(8);
        // Preset values not overridden should still apply
        expect(config.memoryLimitPerWorker).toBe(64 * 1024 * 1024);
      });

      it('should include all required fields', () => {
        const config = buildWorkerPoolConfig('STANDARD');
        expect(config.minWorkers).toBeDefined();
        expect(config.maxWorkers).toBeDefined();
        expect(config.memoryLimitPerWorker).toBeDefined();
        expect(config.memoryCheckIntervalMs).toBeDefined();
        expect(config.maxExecutionsPerWorker).toBeDefined();
        expect(config.idleTimeoutMs).toBeDefined();
        expect(config.queueTimeoutMs).toBeDefined();
        expect(config.maxQueueSize).toBeDefined();
        expect(config.gracefulShutdownTimeoutMs).toBeDefined();
        expect(config.maxMessagesPerSecond).toBeDefined();
        expect(config.maxPendingToolCalls).toBeDefined();
        expect(config.maxMessageSizeBytes).toBeDefined();
        expect(config.warmOnInit).toBeDefined();
      });
    });
  });

  describe('errors', () => {
    describe('WorkerPoolError', () => {
      it('should create base error', () => {
        const error = new WorkerPoolError('test error');
        expect(error.name).toBe('WorkerPoolError');
        expect(error.message).toBe('test error');
        expect(error instanceof Error).toBe(true);
      });
    });

    describe('WorkerTimeoutError', () => {
      it('should create with default message', () => {
        const error = new WorkerTimeoutError();
        expect(error.name).toBe('WorkerTimeoutError');
        expect(error.message).toContain('timeout');
      });

      it('should create with custom message', () => {
        const error = new WorkerTimeoutError('custom timeout');
        expect(error.message).toBe('custom timeout');
      });
    });

    describe('WorkerMemoryError', () => {
      it('should create with memory details', () => {
        const error = new WorkerMemoryError(150 * 1024 * 1024, 128 * 1024 * 1024);
        expect(error.name).toBe('WorkerMemoryError');
        expect(error.memoryBytes).toBe(150 * 1024 * 1024);
        expect(error.limitBytes).toBe(128 * 1024 * 1024);
        expect(error.message).toContain('150MB');
        expect(error.message).toContain('128MB');
      });
    });

    describe('WorkerCrashedError', () => {
      it('should create with exit code', () => {
        const error = new WorkerCrashedError('Worker crashed', 1);
        expect(error.name).toBe('WorkerCrashedError');
        expect(error.exitCode).toBe(1);
      });

      it('should work without exit code', () => {
        const error = new WorkerCrashedError('Worker crashed');
        expect(error.exitCode).toBeUndefined();
      });
    });

    describe('WorkerPoolDisposedError', () => {
      it('should create disposed error', () => {
        const error = new WorkerPoolDisposedError();
        expect(error.name).toBe('WorkerPoolDisposedError');
        expect(error.message).toContain('disposed');
      });
    });

    describe('QueueFullError', () => {
      it('should create with queue stats', () => {
        const error = new QueueFullError(100, 100);
        expect(error.name).toBe('QueueFullError');
        expect(error.queueSize).toBe(100);
        expect(error.maxSize).toBe(100);
        expect(error.message).toContain('100/100');
      });
    });

    describe('QueueTimeoutError', () => {
      it('should create with wait time', () => {
        const error = new QueueTimeoutError(5000);
        expect(error.name).toBe('QueueTimeoutError');
        expect(error.waitedMs).toBe(5000);
        expect(error.message).toContain('5000ms');
      });
    });

    describe('ExecutionAbortedError', () => {
      it('should create with default message', () => {
        const error = new ExecutionAbortedError();
        expect(error.name).toBe('ExecutionAbortedError');
        expect(error.message).toContain('aborted');
      });

      it('should create with custom reason', () => {
        const error = new ExecutionAbortedError('User cancelled');
        expect(error.message).toBe('User cancelled');
      });
    });

    describe('MessageFloodError', () => {
      it('should create with slot ID', () => {
        const error = new MessageFloodError('slot-123');
        expect(error.name).toBe('MessageFloodError');
        expect(error.slotId).toBe('slot-123');
        expect(error.message).toContain('rate limit');
      });
    });

    describe('MessageValidationError', () => {
      it('should create with default message', () => {
        const error = new MessageValidationError();
        expect(error.name).toBe('MessageValidationError');
        expect(error.message).toContain('Invalid message');
      });

      it('should create with details', () => {
        const error = new MessageValidationError('missing type field');
        expect(error.message).toContain('missing type field');
      });
    });

    describe('MessageSizeError', () => {
      it('should create with size details', () => {
        const error = new MessageSizeError(20 * 1024, 16 * 1024);
        expect(error.name).toBe('MessageSizeError');
        expect(error.sizeBytes).toBe(20 * 1024);
        expect(error.maxBytes).toBe(16 * 1024);
        expect(error.message).toContain('20KB');
        expect(error.message).toContain('16KB');
      });
    });

    describe('WorkerStartupError', () => {
      it('should create with message', () => {
        const error = new WorkerStartupError('Failed to spawn');
        expect(error.name).toBe('WorkerStartupError');
        expect(error.message).toBe('Failed to spawn');
      });

      it('should include cause', () => {
        const cause = new Error('ENOENT');
        const error = new WorkerStartupError('Failed', cause);
        expect(error.cause).toBe(cause);
      });
    });

    describe('TooManyPendingCallsError', () => {
      it('should create with counts', () => {
        const error = new TooManyPendingCallsError(100, 100);
        expect(error.name).toBe('TooManyPendingCallsError');
        expect(error.pending).toBe(100);
        expect(error.max).toBe(100);
        expect(error.message).toContain('100/100');
      });
    });

    it('should all extend WorkerPoolError', () => {
      expect(new WorkerTimeoutError() instanceof WorkerPoolError).toBe(true);
      expect(new WorkerMemoryError(1, 1) instanceof WorkerPoolError).toBe(true);
      expect(new WorkerCrashedError('') instanceof WorkerPoolError).toBe(true);
      expect(new WorkerPoolDisposedError() instanceof WorkerPoolError).toBe(true);
      expect(new QueueFullError(1, 1) instanceof WorkerPoolError).toBe(true);
      expect(new QueueTimeoutError(1) instanceof WorkerPoolError).toBe(true);
      expect(new ExecutionAbortedError() instanceof WorkerPoolError).toBe(true);
      expect(new MessageFloodError('') instanceof WorkerPoolError).toBe(true);
      expect(new MessageValidationError() instanceof WorkerPoolError).toBe(true);
      expect(new MessageSizeError(1, 1) instanceof WorkerPoolError).toBe(true);
      expect(new WorkerStartupError('') instanceof WorkerPoolError).toBe(true);
      expect(new TooManyPendingCallsError(1, 1) instanceof WorkerPoolError).toBe(true);
    });
  });

  describe('MemoryMonitor', () => {
    it('should create with config', () => {
      const slots = new Map();
      const monitor = new MemoryMonitor(
        {
          memoryLimitPerWorker: 128 * 1024 * 1024,
          memoryCheckIntervalMs: 1000,
        },
        slots,
      );
      expect(monitor).toBeDefined();
      expect(monitor.isRunning).toBe(false);
    });

    it('should start and stop monitoring', () => {
      const slots = new Map();
      const monitor = new MemoryMonitor(
        {
          memoryLimitPerWorker: 128 * 1024 * 1024,
          memoryCheckIntervalMs: 100000, // Long interval to avoid actual checks
        },
        slots,
      );

      monitor.start();
      expect(monitor.isRunning).toBe(true);

      monitor.start(); // Should be idempotent
      expect(monitor.isRunning).toBe(true);

      monitor.stop();
      expect(monitor.isRunning).toBe(false);

      monitor.stop(); // Should be idempotent
      expect(monitor.isRunning).toBe(false);
    });

    it('should return stats', () => {
      const slots = new Map();
      const monitor = new MemoryMonitor(
        {
          memoryLimitPerWorker: 128 * 1024 * 1024,
          memoryCheckIntervalMs: 1000,
        },
        slots,
      );

      const stats = monitor.getStats();
      expect(stats.checksPerformed).toBe(0);
      expect(stats.memoryExceededCount).toBe(0);
      expect(stats.checkFailureCount).toBe(0);
      expect(stats.peakMemoryBytes).toBe(0);
      expect(stats.avgMemoryBytes).toBe(0);
      expect(stats.totalSamples).toBe(0);
    });

    it('should reset stats', () => {
      const slots = new Map();
      const monitor = new MemoryMonitor(
        {
          memoryLimitPerWorker: 128 * 1024 * 1024,
          memoryCheckIntervalMs: 1000,
        },
        slots,
      );

      monitor.resetStats();
      const stats = monitor.getStats();
      expect(stats.checksPerformed).toBe(0);
    });

    it('should get current usage summary with no slots', () => {
      const slots = new Map();
      const monitor = new MemoryMonitor(
        {
          memoryLimitPerWorker: 128 * 1024 * 1024,
          memoryCheckIntervalMs: 1000,
        },
        slots,
      );

      const summary = monitor.getCurrentUsageSummary();
      expect(summary.totalRss).toBe(0);
      expect(summary.avgRss).toBe(0);
      expect(summary.maxRss).toBe(0);
      expect(summary.slotCount).toBe(0);
    });

    it('should check all slots and emit checkComplete', async () => {
      const slots = new Map();
      const monitor = new MemoryMonitor(
        {
          memoryLimitPerWorker: 128 * 1024 * 1024,
          memoryCheckIntervalMs: 1000,
        },
        slots,
      );

      const checkCompletePromise = new Promise<Map<string, unknown>>((resolve) => {
        monitor.on('checkComplete', resolve);
      });

      const results = await monitor.checkAllSlots();
      expect(results.size).toBe(0);

      const emittedResults = await checkCompletePromise;
      expect(emittedResults.size).toBe(0);
    });

    it('should return null for checkSlotImmediate with no slot', async () => {
      const slots = new Map();
      const monitor = new MemoryMonitor(
        {
          memoryLimitPerWorker: 128 * 1024 * 1024,
          memoryCheckIntervalMs: 1000,
        },
        slots,
      );

      const result = await monitor.checkSlotImmediate('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('protocol', () => {
    describe('type guards', () => {
      const toolCallMsg: ToolCallMessage = {
        type: 'tool-call',
        requestId: 'req-1',
        callId: 'call-1',
        toolName: 'testTool',
        args: { key: 'value' },
      };

      const resultMsg: ExecutionResultMessage = {
        type: 'result',
        requestId: 'req-1',
        success: true,
        value: 42,
        stats: {
          duration: 100,
          toolCallCount: 1,
          iterationCount: 0,
          startTime: 1000,
          endTime: 1100,
        },
      };

      const consoleMsg: ConsoleMessage = {
        type: 'console',
        requestId: 'req-1',
        level: 'log',
        args: ['test message'],
      };

      const memoryReportMsg: WorkerToMainMessage = {
        type: 'memory-report-result',
        usage: {
          rss: 1024,
          heapTotal: 512,
          heapUsed: 256,
          external: 128,
          arrayBuffers: 64,
        },
      };

      const readyMsg: WorkerToMainMessage = { type: 'ready' };

      describe('isToolCallMessage', () => {
        it('should return true for tool-call messages', () => {
          expect(isToolCallMessage(toolCallMsg)).toBe(true);
        });

        it('should return false for other message types', () => {
          expect(isToolCallMessage(resultMsg)).toBe(false);
          expect(isToolCallMessage(consoleMsg)).toBe(false);
          expect(isToolCallMessage(readyMsg)).toBe(false);
        });
      });

      describe('isExecutionResultMessage', () => {
        it('should return true for result messages', () => {
          expect(isExecutionResultMessage(resultMsg)).toBe(true);
        });

        it('should return false for other message types', () => {
          expect(isExecutionResultMessage(toolCallMsg)).toBe(false);
          expect(isExecutionResultMessage(consoleMsg)).toBe(false);
        });
      });

      describe('isMemoryReportResultMessage', () => {
        it('should return true for memory-report-result messages', () => {
          expect(isMemoryReportResultMessage(memoryReportMsg)).toBe(true);
        });

        it('should return false for other message types', () => {
          expect(isMemoryReportResultMessage(toolCallMsg)).toBe(false);
          expect(isMemoryReportResultMessage(resultMsg)).toBe(false);
        });
      });

      describe('isConsoleMessage', () => {
        it('should return true for console messages', () => {
          expect(isConsoleMessage(consoleMsg)).toBe(true);
        });

        it('should return false for other message types', () => {
          expect(isConsoleMessage(toolCallMsg)).toBe(false);
          expect(isConsoleMessage(resultMsg)).toBe(false);
        });
      });

      describe('isWorkerReadyMessage', () => {
        it('should return true for ready messages', () => {
          expect(isWorkerReadyMessage(readyMsg)).toBe(true);
        });

        it('should return false for other message types', () => {
          expect(isWorkerReadyMessage(toolCallMsg)).toBe(false);
          expect(isWorkerReadyMessage(resultMsg)).toBe(false);
        });
      });
    });

    describe('Zod schemas', () => {
      describe('toolCallMessageSchema', () => {
        it('should validate valid tool-call message', () => {
          const msg = {
            type: 'tool-call',
            requestId: 'exec-123',
            callId: 'call-456',
            toolName: 'myTool',
            args: { param: 'value' },
          };
          expect(() => toolCallMessageSchema.parse(msg)).not.toThrow();
        });

        it('should reject invalid tool name', () => {
          const msg = {
            type: 'tool-call',
            requestId: 'exec-123',
            callId: 'call-456',
            toolName: '123invalid',
            args: {},
          };
          expect(() => toolCallMessageSchema.parse(msg)).toThrow();
        });

        it('should reject extra fields (strict mode)', () => {
          const msg = {
            type: 'tool-call',
            requestId: 'exec-123',
            callId: 'call-456',
            toolName: 'myTool',
            args: {},
            extraField: 'bad',
          };
          expect(() => toolCallMessageSchema.parse(msg)).toThrow();
        });
      });

      describe('executionResultMessageSchema', () => {
        it('should validate successful result', () => {
          const msg = {
            type: 'result',
            requestId: 'exec-123',
            success: true,
            value: { data: 'test' },
            stats: {
              duration: 100,
              toolCallCount: 1,
              iterationCount: 10,
              startTime: 1000,
              endTime: 1100,
            },
          };
          expect(() => executionResultMessageSchema.parse(msg)).not.toThrow();
        });

        it('should validate error result', () => {
          const msg = {
            type: 'result',
            requestId: 'exec-123',
            success: false,
            error: {
              name: 'Error',
              message: 'Something went wrong',
            },
            stats: {
              duration: 50,
              toolCallCount: 0,
              iterationCount: 0,
              startTime: 1000,
              endTime: 1050,
            },
          };
          expect(() => executionResultMessageSchema.parse(msg)).not.toThrow();
        });

        it('should reject negative duration', () => {
          const msg = {
            type: 'result',
            requestId: 'exec-123',
            success: true,
            stats: {
              duration: -1,
              toolCallCount: 0,
              iterationCount: 0,
              startTime: 1000,
              endTime: 1000,
            },
          };
          expect(() => executionResultMessageSchema.parse(msg)).toThrow();
        });
      });

      describe('consoleMessageSchema', () => {
        it('should validate valid console message', () => {
          const msg = {
            type: 'console',
            requestId: 'exec-123',
            level: 'log',
            args: ['test', 123],
          };
          expect(() => consoleMessageSchema.parse(msg)).not.toThrow();
        });

        it('should reject invalid level', () => {
          const msg = {
            type: 'console',
            requestId: 'exec-123',
            level: 'debug',
            args: [],
          };
          expect(() => consoleMessageSchema.parse(msg)).toThrow();
        });
      });

      describe('workerReadyMessageSchema', () => {
        it('should validate ready message', () => {
          const msg = { type: 'ready' };
          expect(() => workerReadyMessageSchema.parse(msg)).not.toThrow();
        });
      });

      describe('workerToMainMessageSchema', () => {
        it('should validate all message types', () => {
          expect(() => workerToMainMessageSchema.parse({ type: 'ready' })).not.toThrow();
          expect(() =>
            workerToMainMessageSchema.parse({
              type: 'tool-call',
              requestId: 'r1',
              callId: 'c1',
              toolName: 'tool',
              args: {},
            }),
          ).not.toThrow();
          expect(() =>
            workerToMainMessageSchema.parse({
              type: 'result',
              requestId: 'r1',
              success: true,
              stats: {
                duration: 0,
                toolCallCount: 0,
                iterationCount: 0,
                startTime: 0,
                endTime: 0,
              },
            }),
          ).not.toThrow();
        });
      });
    });
  });
});
