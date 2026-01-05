/**
 * Memory Limit Enforcement Tests
 *
 * Tests for the memory tracking and limit enforcement feature.
 */

import { Enclave } from '../enclave';
import { MemoryTracker, MemoryLimitError, estimateStringSize, estimateArraySize } from '../memory-tracker';

describe('MemoryTracker', () => {
  describe('basic tracking', () => {
    it('should track allocations and report peak usage', () => {
      const tracker = new MemoryTracker({ memoryLimit: 0 }); // unlimited
      tracker.start();

      tracker.track(1000);
      tracker.track(2000);
      tracker.track(500);

      const snapshot = tracker.getSnapshot();
      expect(snapshot.trackedBytes).toBe(3500);
      expect(snapshot.peakTrackedBytes).toBe(3500);
      expect(snapshot.allocationCount).toBe(3);
    });

    it('should track string sizes correctly', () => {
      const tracker = new MemoryTracker({ memoryLimit: 0 });
      tracker.start();

      tracker.trackString('hello'); // 5 chars * 2 bytes + 40 overhead = 50 bytes
      const snapshot = tracker.getSnapshot();

      expect(snapshot.trackedBytes).toBe(estimateStringSize('hello'));
    });

    it('should track array sizes correctly', () => {
      const tracker = new MemoryTracker({ memoryLimit: 0 });
      tracker.start();

      tracker.trackArray(100); // 32 + 100 * 8 = 832 bytes
      const snapshot = tracker.getSnapshot();

      expect(snapshot.trackedBytes).toBe(estimateArraySize(100));
    });

    it('should reset on start()', () => {
      const tracker = new MemoryTracker({ memoryLimit: 0 });
      tracker.start();
      tracker.track(1000);

      tracker.start(); // reset
      const snapshot = tracker.getSnapshot();

      expect(snapshot.trackedBytes).toBe(0);
      expect(snapshot.peakTrackedBytes).toBe(0);
      expect(snapshot.allocationCount).toBe(0);
    });
  });

  describe('limit enforcement', () => {
    it('should throw MemoryLimitError when limit exceeded', () => {
      const tracker = new MemoryTracker({ memoryLimit: 1000 });
      tracker.start();

      tracker.track(500);
      tracker.track(400);

      expect(() => tracker.track(200)).toThrow(MemoryLimitError);
    });

    it('should include usage info in MemoryLimitError', () => {
      const tracker = new MemoryTracker({ memoryLimit: 1000 });
      tracker.start();

      tracker.track(800);

      try {
        tracker.track(300);
        fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(MemoryLimitError);
        const memErr = err as MemoryLimitError;
        expect(memErr.usedBytes).toBe(1100);
        expect(memErr.limitBytes).toBe(1000);
        expect(memErr.code).toBe('MEMORY_LIMIT_EXCEEDED');
      }
    });

    it('should not throw when limit is 0 (unlimited)', () => {
      const tracker = new MemoryTracker({ memoryLimit: 0 });
      tracker.start();

      // Should not throw even with large allocation
      expect(() => tracker.track(1000000000)).not.toThrow();
    });
  });

  describe('release tracking', () => {
    it('should reduce tracked bytes on release', () => {
      const tracker = new MemoryTracker({ memoryLimit: 0 });
      tracker.start();

      tracker.track(1000);
      tracker.release(400);

      const snapshot = tracker.getSnapshot();
      expect(snapshot.trackedBytes).toBe(600);
      expect(snapshot.peakTrackedBytes).toBe(1000); // Peak should remain
    });

    it('should not go below zero on release', () => {
      const tracker = new MemoryTracker({ memoryLimit: 0 });
      tracker.start();

      tracker.track(100);
      tracker.release(200); // More than tracked

      const snapshot = tracker.getSnapshot();
      expect(snapshot.trackedBytes).toBe(0);
    });
  });
});

describe('Memory Limit in Enclave', () => {
  describe('string allocation tracking', () => {
    it('should block exponential string growth attack', async () => {
      const enclave = new Enclave({
        memoryLimit: 10 * 1024 * 1024, // 10MB
        timeout: 5000,
        doubleVm: { enabled: false }, // Disable double-VM to test VmAdapter directly
      });

      // This code doubles a string 27 times, creating ~134MB
      const code = `
        let s = 'a';
        for (let i = 0; i < 27; i++) {
          s = s + s;
        }
        return s.length;
      `;

      const result = await enclave.run(code);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MEMORY_LIMIT_EXCEEDED');
    });

    it('should report memoryUsage in stats on success', async () => {
      const enclave = new Enclave({
        memoryLimit: 10 * 1024 * 1024, // 10MB
        timeout: 5000,
        doubleVm: { enabled: false },
      });

      // Small string operations
      const code = `
        let s = 'hello';
        s = s + ' world';
        return s;
      `;

      const result = await enclave.run(code);

      expect(result.success).toBe(true);
      expect(result.value).toBe('hello world');
      expect(result.stats.memoryUsage).toBeGreaterThan(0);
    });

    it('should report memoryUsage in stats on memory error', async () => {
      const enclave = new Enclave({
        memoryLimit: 1 * 1024 * 1024, // 1MB
        timeout: 5000,
        doubleVm: { enabled: false },
      });

      const code = `
        let s = 'a';
        for (let i = 0; i < 25; i++) {
          s = s + s;
        }
        return s.length;
      `;

      const result = await enclave.run(code);

      expect(result.success).toBe(false);
      expect(result.stats.memoryUsage).toBeGreaterThan(0);
    });
  });

  describe('array allocation tracking', () => {
    it('should block large array creation', async () => {
      const enclave = new Enclave({
        memoryLimit: 1 * 1024 * 1024, // 1MB
        timeout: 5000,
        doubleVm: { enabled: false },
      });

      // Try to create a large array
      const code = `
        const arr = Array.from({ length: 500000 }, (_, i) => i);
        return arr.length;
      `;

      const result = await enclave.run(code);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MEMORY_LIMIT_EXCEEDED');
    });

    it('should allow small arrays within limit', async () => {
      const enclave = new Enclave({
        memoryLimit: 10 * 1024 * 1024, // 10MB
        timeout: 5000,
        doubleVm: { enabled: false },
      });

      const code = `
        const arr = [1, 2, 3, 4, 5];
        return arr.length;
      `;

      const result = await enclave.run(code);

      expect(result.success).toBe(true);
      expect(result.value).toBe(5);
    });
  });

  describe('without memory limit', () => {
    it('should not track memory when memoryLimit is explicitly 0', async () => {
      const enclave = new Enclave({
        timeout: 5000,
        memoryLimit: 0, // Explicitly disable memory tracking
        doubleVm: { enabled: false },
      });

      const code = `
        let s = 'a';
        for (let i = 0; i < 10; i++) {
          s = s + s;
        }
        return s.length;
      `;

      const result = await enclave.run(code);

      expect(result.success).toBe(true);
      expect(result.value).toBe(1024);
      // memoryUsage should be undefined when memoryLimit is 0
      expect(result.stats.memoryUsage).toBeUndefined();
    });

    it('should track memory with default 1 MB limit', async () => {
      const enclave = new Enclave({
        timeout: 5000,
        doubleVm: { enabled: false },
        // No memoryLimit set - default is 1 MB
      });

      // Use string concatenation which is tracked by memory monitor
      const code = `
        let s = 'hello';
        s = s + ' world';
        return s;
      `;

      const result = await enclave.run(code);

      expect(result.success).toBe(true);
      expect(result.value).toBe('hello world');
      // Default memoryLimit of 1 MB means memory tracking is active
      expect(result.stats.memoryUsage).toBeGreaterThan(0);
    });
  });

  describe('error details', () => {
    it('should include bytes used and limit in error data', async () => {
      const enclave = new Enclave({
        memoryLimit: 1 * 1024 * 1024, // 1MB
        timeout: 5000,
        doubleVm: { enabled: false },
      });

      const code = `
        let s = 'a';
        for (let i = 0; i < 25; i++) {
          s = s + s;
        }
        return s.length;
      `;

      const result = await enclave.run(code);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MEMORY_LIMIT_EXCEEDED');
      expect(result.error?.data).toBeDefined();
      expect((result.error?.data as { usedBytes: number }).usedBytes).toBeGreaterThan(1 * 1024 * 1024);
      expect((result.error?.data as { limitBytes: number }).limitBytes).toBe(1 * 1024 * 1024);
    });
  });
});

describe('Size estimation functions', () => {
  it('estimateStringSize should account for UTF-16 and overhead', () => {
    // Empty string: 0 * 2 + 40 = 40
    expect(estimateStringSize('')).toBe(40);

    // 10 chars: 10 * 2 + 40 = 60
    expect(estimateStringSize('0123456789')).toBe(60);

    // 1000 chars: 1000 * 2 + 40 = 2040
    expect(estimateStringSize('a'.repeat(1000))).toBe(2040);
  });

  it('estimateArraySize should account for pointers and overhead', () => {
    // Empty: 32 + 0 * 8 = 32
    expect(estimateArraySize(0)).toBe(32);

    // 100 elements: 32 + 100 * 8 = 832
    expect(estimateArraySize(100)).toBe(832);

    // 1000 elements: 32 + 1000 * 8 = 8032
    expect(estimateArraySize(1000)).toBe(8032);
  });
});

describe('Memory Limit in Worker Pool', () => {
  /**
   * Note: Worker Pool memory enforcement uses a different mechanism than VmAdapter.
   *
   * - VmAdapter: Uses MemoryTracker with AST transformation to track allocations
   * - WorkerPoolAdapter: Uses V8's --max-old-space-size flag for per-worker memory limits
   *
   * IMPORTANT: Node.js 24+ has stricter worker permissions that block the
   * --max-old-space-size flag in worker execArgv. In these environments,
   * per-worker memory limits cannot be enforced at the OS level.
   *
   * The tests below verify that worker pool configuration accepts memory settings
   * and that the MemoryMonitor can report worker memory usage.
   */

  // Skip memory limit tests on Node.js 24+ due to worker security restrictions
  const nodeVersion = parseInt(process.version.slice(1).split('.')[0], 10);
  const skipDueToNodeVersion = nodeVersion >= 24;

  describe('worker pool configuration', () => {
    it('should accept memoryLimitPerWorker configuration', async () => {
      // This test verifies the configuration is accepted, not that it's enforced
      const enclave = new Enclave({
        timeout: 5000,
        memoryLimit: 0, // Disable VM-level memory tracking
        adapter: 'worker_threads',
        workerPoolConfig: {
          minWorkers: 1,
          maxWorkers: 1,
          // Set to 0 for Node.js 24+ compatibility
          memoryLimitPerWorker: 0,
        },
        doubleVm: { enabled: false },
      });

      const code = `return 1 + 2;`;

      try {
        const result = await enclave.run(code);
        expect(result.success).toBe(true);
        expect(result.value).toBe(3);
      } finally {
        enclave.dispose();
      }
    });

    it('should execute code in worker pool adapter', async () => {
      const enclave = new Enclave({
        timeout: 5000,
        memoryLimit: 0, // Disable VM-level memory tracking
        adapter: 'worker_threads',
        workerPoolConfig: {
          minWorkers: 1,
          maxWorkers: 1,
          memoryLimitPerWorker: 0,
        },
        doubleVm: { enabled: false },
      });

      const code = `
        let sum = 0;
        for (let i = 0; i < 10; i++) {
          sum += i;
        }
        return sum;
      `;

      try {
        const result = await enclave.run(code);
        expect(result.success).toBe(true);
        expect(result.value).toBe(45);
      } finally {
        enclave.dispose();
      }
    });
  });

  describe('OS-level memory enforcement', () => {
    // These tests are skipped on Node.js 24+ due to worker security restrictions
    // They would work on Node.js 22 and earlier

    (skipDueToNodeVersion ? it.skip : it)(
      'should accept memory limit configuration for earlier Node.js versions',
      async () => {
        // On Node.js < 24, this would enforce the memory limit
        const enclave = new Enclave({
          timeout: 10000,
          memoryLimit: 0, // Disable VM-level memory tracking
          adapter: 'worker_threads',
          workerPoolConfig: {
            minWorkers: 1,
            maxWorkers: 1,
            memoryLimitPerWorker: 50 * 1024 * 1024, // 50MB
          },
          doubleVm: { enabled: false },
        });

        try {
          // Simple code that works within memory limits
          const result = await enclave.run(`return 'hello';`);
          expect(result.success).toBe(true);
        } finally {
          enclave.dispose();
        }
      },
    );
  });
});

describe('Memory Limit in Double VM', () => {
  describe('string allocation tracking', () => {
    it('should block exponential string growth attack in double VM', async () => {
      const enclave = new Enclave({
        memoryLimit: 10 * 1024 * 1024, // 10MB
        timeout: 5000,
        doubleVm: { enabled: true },
      });

      // This code doubles a string 27 times, creating ~134MB
      const code = `
        let s = 'a';
        for (let i = 0; i < 27; i++) {
          s = s + s;
        }
        return s.length;
      `;

      const result = await enclave.run(code);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MEMORY_LIMIT_EXCEEDED');
    });

    it('should report memoryUsage in stats on success in double VM', async () => {
      const enclave = new Enclave({
        memoryLimit: 10 * 1024 * 1024, // 10MB
        timeout: 5000,
        doubleVm: { enabled: true },
      });

      // Small string operations
      const code = `
        let s = 'hello';
        s = s + ' world';
        return s;
      `;

      const result = await enclave.run(code);

      expect(result.success).toBe(true);
      expect(result.value).toBe('hello world');
      expect(result.stats.memoryUsage).toBeGreaterThan(0);
    });

    it('should report memoryUsage in stats on memory error in double VM', async () => {
      const enclave = new Enclave({
        memoryLimit: 1 * 1024 * 1024, // 1MB
        timeout: 5000,
        doubleVm: { enabled: true },
      });

      const code = `
        let s = 'a';
        for (let i = 0; i < 25; i++) {
          s = s + s;
        }
        return s.length;
      `;

      const result = await enclave.run(code);

      expect(result.success).toBe(false);
      expect(result.stats.memoryUsage).toBeGreaterThan(0);
    });
  });

  describe('without memory limit', () => {
    it('should not track memory when memoryLimit is 0 in double VM', async () => {
      const enclave = new Enclave({
        timeout: 5000,
        memoryLimit: 0, // Explicitly disable memory tracking
        doubleVm: { enabled: true },
      });

      const code = `
        let s = 'a';
        for (let i = 0; i < 10; i++) {
          s = s + s;
        }
        return s.length;
      `;

      const result = await enclave.run(code);

      expect(result.success).toBe(true);
      expect(result.value).toBe(1024);
      // memoryUsage should be undefined when memoryLimit is 0
      expect(result.stats.memoryUsage).toBeUndefined();
    });
  });

  describe('numeric addition in double VM', () => {
    it('should preserve JavaScript + operator semantics for numbers', async () => {
      const enclave = new Enclave({
        memoryLimit: 10 * 1024 * 1024,
        timeout: 5000,
        doubleVm: { enabled: true },
      });

      const code = `
        const a = 1 + 2;
        const b = 10 + 20;
        const c = 1.5 + 2.5;
        return { a, b, c };
      `;

      const result = await enclave.run(code);

      expect(result.success).toBe(true);
      expect(result.value).toEqual({ a: 3, b: 30, c: 4 });
    });
  });
});
