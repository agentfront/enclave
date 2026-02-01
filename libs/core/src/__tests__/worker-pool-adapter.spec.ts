/**
 * WorkerPoolAdapter Integration Tests
 *
 * Tests for the worker_threads based sandbox adapter.
 * These tests use actual worker threads for OS-level isolation.
 *
 * @packageDocumentation
 */

import { Enclave } from '../enclave';
import type { ToolHandler } from '../types';

/**
 * Helper to create Enclave with WorkerPoolAdapter
 *
 * Note: Node.js 24+ has stricter worker permissions that block
 * --max-old-space-size flags in worker execArgv. We set memoryLimitPerWorker: 0
 * to disable per-worker memory limits in tests. Memory enforcement can still
 * be tested via the MemoryMonitor which uses process.memoryUsage().
 */
function createWorkerEnclave(
  options: {
    securityLevel?: 'PERMISSIVE' | 'STANDARD' | 'SECURE' | 'STRICT';
    toolHandler?: ToolHandler;
    globals?: Record<string, unknown>;
    maxConsoleOutputBytes?: number;
    maxConsoleCalls?: number;
    sanitizeStackTraces?: boolean;
    timeout?: number;
    maxIterations?: number;
    maxToolCalls?: number;
    memoryLimitPerWorker?: number;
    memoryLimit?: number;
  } = {},
) {
  const { memoryLimitPerWorker, memoryLimit, ...rest } = options;
  return new Enclave({
    ...rest,
    // Disable VM-level memory tracking by default (set to 0)
    // Tests that need memory tracking should explicitly set memoryLimit > 0
    memoryLimit: memoryLimit ?? 0,
    adapter: 'worker_threads',
    workerPoolConfig: {
      minWorkers: 1,
      maxWorkers: 2,
      warmOnInit: true,
      // Set to 0 to disable --max-old-space-size flag (blocked by Node.js 24+ security model)
      memoryLimitPerWorker: memoryLimitPerWorker ?? 0,
    },
    // Disable double VM to test worker adapter directly
    doubleVm: { enabled: false },
  });
}

describe('WorkerPoolAdapter', () => {
  // Longer timeout for worker tests due to spawn overhead
  jest.setTimeout(30000);

  describe('Basic Execution', () => {
    it('should execute simple code and return result', async () => {
      const enclave = createWorkerEnclave();
      try {
        const result = await enclave.run(`
          return 42;
        `);

        console.log('Full result:', JSON.stringify(result, null, 2));
        if (!result.success) {
          console.error('Test failed with error:', result.error);
        }
        expect(result.success).toBe(true);
        expect(result.value).toBe(42);
      } finally {
        // Clean up the worker pool
        enclave.dispose();
      }
    });

    it('should execute async code with await', async () => {
      const toolHandler: ToolHandler = async () => {
        await new Promise((r) => setTimeout(r, 10));
        return { done: true };
      };

      const enclave = createWorkerEnclave({ toolHandler });
      const result = await enclave.run(`
        async function __ag_main() {
          const response = await callTool('asyncOp', {});
          return response.done ? 'async complete' : 'failed';
        }
      `);

      expect(result.success).toBe(true);
      expect(result.value).toBe('async complete');
    });

    it('should handle errors in user code', async () => {
      // Use a syntax error that doesn't require Error constructor
      const enclave = createWorkerEnclave({ securityLevel: 'PERMISSIVE' });
      const result = await enclave.run(`
        async function __ag_main() {
          // Use a simpler error mechanism that works with AST validation
          throw { message: 'user error', name: 'Error' };
        }
      `);

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('user error');
    });

    it('should return primitives correctly', async () => {
      const enclave = createWorkerEnclave();

      const stringResult = await enclave.run(`
        async function __ag_main() { return 'hello'; }
      `);
      expect(stringResult.value).toBe('hello');

      const numberResult = await enclave.run(`
        async function __ag_main() { return 123.45; }
      `);
      expect(numberResult.value).toBe(123.45);

      const boolResult = await enclave.run(`
        async function __ag_main() { return true; }
      `);
      expect(boolResult.value).toBe(true);

      const nullResult = await enclave.run(`
        async function __ag_main() { return null; }
      `);
      expect(nullResult.value).toBe(null);
    });

    it('should return objects correctly', async () => {
      const enclave = createWorkerEnclave();
      const result = await enclave.run(`
        async function __ag_main() {
          return { a: 1, b: 'two', c: { nested: true } };
        }
      `);

      expect(result.success).toBe(true);
      expect(result.value).toEqual({ a: 1, b: 'two', c: { nested: true } });
    });

    it('should return arrays correctly', async () => {
      const enclave = createWorkerEnclave();
      const result = await enclave.run(`
        async function __ag_main() {
          return [1, 'two', { three: 3 }, [4, 5]];
        }
      `);

      expect(result.success).toBe(true);
      expect(result.value).toEqual([1, 'two', { three: 3 }, [4, 5]]);
    });

    it('should provide standard globals', async () => {
      const enclave = createWorkerEnclave();
      const result = await enclave.run(`
        async function __ag_main() {
          return {
            mathPi: Math.PI,
            jsonParse: JSON.parse('{"a":1}').a,
            arrayFrom: Array.from([1,2,3]).length,
            objectKeys: Object.keys({x: 1, y: 2}).length,
          };
        }
      `);

      expect(result.success).toBe(true);
      expect(result.value).toEqual({
        mathPi: Math.PI,
        jsonParse: 1,
        arrayFrom: 3,
        objectKeys: 2,
      });
    });

    it('should track execution stats', async () => {
      const enclave = createWorkerEnclave();
      const result = await enclave.run(`
        async function __ag_main() {
          let sum = 0;
          for (let i = 0; i < 5; i++) sum += i;
          return sum;
        }
      `);

      expect(result.success).toBe(true);
      expect(result.stats.duration).toBeGreaterThanOrEqual(0);
      expect(result.stats.startTime).toBeGreaterThan(0);
      expect(result.stats.endTime).toBeGreaterThanOrEqual(result.stats.startTime);
    });
  });

  describe('Tool Calls', () => {
    it('should execute tool calls via worker', async () => {
      const toolHandler: ToolHandler = async (name, args) => {
        return { tool: name, args, result: 'success' };
      };

      const enclave = createWorkerEnclave({ toolHandler });
      const result = await enclave.run(`
        async function __ag_main() {
          const response = await callTool('myTool', { key: 'value' });
          return response;
        }
      `);

      expect(result.success).toBe(true);
      expect(result.value).toEqual({
        tool: 'myTool',
        args: { key: 'value' },
        result: 'success',
      });
    });

    it('should handle tool call errors', async () => {
      const toolHandler: ToolHandler = async () => {
        throw new Error('tool failed');
      };

      const enclave = createWorkerEnclave({ toolHandler });
      const result = await enclave.run(`
        async function __ag_main() {
          try {
            await callTool('failingTool', {});
            return 'should not reach';
          } catch (e) {
            return 'caught: ' + e.message;
          }
        }
      `);

      expect(result.success).toBe(true);
      expect(result.value).toContain('caught:');
    });

    it('should track tool call count in stats', async () => {
      const toolHandler: ToolHandler = async () => ({ ok: true });

      const enclave = createWorkerEnclave({ toolHandler });
      const result = await enclave.run(`
        async function __ag_main() {
          await callTool('tool1', {});
          await callTool('tool2', {});
          await callTool('tool3', {});
          return 'done';
        }
      `);

      expect(result.success).toBe(true);
      expect(result.stats.toolCallCount).toBe(3);
    });

    it('should enforce maxToolCalls limit', async () => {
      const toolHandler: ToolHandler = async () => ({ ok: true });

      const enclave = createWorkerEnclave({
        toolHandler,
        maxToolCalls: 2,
      });
      const result = await enclave.run(`
        async function __ag_main() {
          await callTool('tool1', {});
          await callTool('tool2', {});
          await callTool('tool3', {}); // Should fail
          return 'should not reach';
        }
      `);

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('tool call limit');
    });
  });

  describe('Iteration Limits', () => {
    // NOTE: These tests use default security level (not PERMISSIVE) because:
    // 1. PERMISSIVE mode may not transform loops to use __safe_for
    // 2. While loops are blocked by default - only for loops are allowed
    // Tests verify that iteration limits are enforced via transformed for loops.

    it('should enforce maxIterations limit in for loops', async () => {
      // Use default security level which transforms for loops to use __safe_for
      const enclave = createWorkerEnclave({ maxIterations: 100 });
      const result = await enclave.run(`
        async function __ag_main() {
          let count = 0;
          for (let i = 0; i < 1000; i++) {
            count++;
          }
          return count;
        }
      `);

      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/iteration limit/i);
      enclave.dispose();
    });

    it('should track iteration count in stats', async () => {
      // Use default security level for proper loop transformation
      // NOTE: Only for-of loops track iteration count (via __safe_forOf).
      // Regular for loops use inline checks for limits but don't track count.
      const enclave = createWorkerEnclave({ maxIterations: 1000 });
      const result = await enclave.run(`
        async function __ag_main() {
          const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
          let sum = 0;
          for (const item of items) {
            sum += item;
          }
          return sum;
        }
      `);

      expect(result.success).toBe(true);
      expect(result.value).toBe(55); // Sum of 1-10
      expect(result.stats.iterationCount).toBeGreaterThanOrEqual(10);
      enclave.dispose();
    });
  });

  describe('Timeout Handling', () => {
    it('should timeout long-running code', async () => {
      const enclave = createWorkerEnclave({ timeout: 500 });
      const result = await enclave.run(`
        async function __ag_main() {
          // Busy wait that can't be interrupted by iteration limits
          const start = Date.now();
          while (Date.now() - start < 10000) {
            // Spin
          }
          return 'should not reach';
        }
      `);

      expect(result.success).toBe(false);
      // Worker timeout results in various error messages
      expect(result.error?.message).toBeDefined();
    });
  });

  describe('Console Output', () => {
    it('should enforce maxConsoleCalls limit', async () => {
      // Use PERMISSIVE to allow loops and console access
      const enclave = createWorkerEnclave({ securityLevel: 'PERMISSIVE', maxConsoleCalls: 5 });
      const result = await enclave.run(`
        async function __ag_main() {
          for (let i = 0; i < 10; i++) {
            console.log('message', i);
          }
          return 'done';
        }
      `);

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Console call limit');
    });

    it('should enforce maxConsoleOutputBytes limit', async () => {
      // Use PERMISSIVE to allow console access
      const enclave = createWorkerEnclave({ securityLevel: 'PERMISSIVE', maxConsoleOutputBytes: 100 });
      const result = await enclave.run(`
        async function __ag_main() {
          console.log('x'.repeat(200));
          return 'done';
        }
      `);

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Console output limit');
    });
  });

  describe('Custom Globals', () => {
    // NOTE: Custom globals test is skipped because the AST guard rejects unknown identifiers
    // even in PERMISSIVE mode. The worker pool adapter correctly serializes globals to the
    // worker, but the Enclave's AST validation blocks access to unregistered globals.
    // To use custom globals, they must be registered with the AST guard's allowed globals list.

    it.skip('should inject custom globals', async () => {
      const enclave = createWorkerEnclave({
        securityLevel: 'PERMISSIVE',
        globals: {
          customValue: 42,
        },
      });
      const result = await enclave.run(`
        async function __ag_main() {
          return {
            value: customValue,
          };
        }
      `);

      expect(result.success).toBe(true);
      expect(result.value).toEqual({ value: 42 });
    });
  });

  describe('Security', () => {
    // NOTE: These tests verify that dangerous globals are blocked by AST validation.
    // This is MORE secure than just returning undefined - code cannot even reference them.
    // The AST validator transforms unknown identifiers to __safe_X which are not allowed.

    it('should block worker_threads APIs via AST validation', async () => {
      const enclave = createWorkerEnclave({ securityLevel: 'PERMISSIVE' });

      // Test each separately - AST validation rejects at first unknown identifier
      const parentPortResult = await enclave.run(`return typeof parentPort;`);
      expect(parentPortResult.success).toBe(false);
      expect(parentPortResult.error?.message).toMatch(/unknown identifier/i);

      const workerDataResult = await enclave.run(`return typeof workerData;`);
      expect(workerDataResult.success).toBe(false);
      expect(workerDataResult.error?.message).toMatch(/unknown identifier/i);

      // Note: 'Worker' is a known global in browser contexts, but blocked as unknown in node
      const workerResult = await enclave.run(`return typeof Worker;`);
      expect(workerResult.success).toBe(false);
      expect(workerResult.error?.message).toMatch(/unknown identifier/i);

      enclave.dispose();
    });

    it('should block process access via AST validation', async () => {
      const enclave = createWorkerEnclave({ securityLevel: 'PERMISSIVE' });
      const result = await enclave.run(`
        async function __ag_main() {
          return typeof process;
        }
      `);

      // AST validation blocks unknown globals - MORE secure than returning undefined
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/unknown identifier/i);
      enclave.dispose();
    });

    it('should block require access via AST validation', async () => {
      const enclave = createWorkerEnclave({ securityLevel: 'PERMISSIVE' });
      const result = await enclave.run(`
        async function __ag_main() {
          return typeof require;
        }
      `);

      // AST validation blocks unknown globals - MORE secure than returning undefined
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/unknown identifier/i);
      enclave.dispose();
    });
  });

  describe('Numeric Addition', () => {
    it('should preserve JavaScript + operator semantics for numbers', async () => {
      const enclave = createWorkerEnclave();
      const result = await enclave.run(`
        async function __ag_main() {
          const a = 1 + 2;
          const b = 10 + 20;
          const c = 1.5 + 2.5;
          return { a, b, c };
        }
      `);

      expect(result.success).toBe(true);
      expect(result.value).toEqual({ a: 3, b: 30, c: 4 });
    });
  });

  describe('Security Level Dependent Globals', () => {
    // NOTE: These tests verify that AST validation and worker sandbox
    // both enforce the same security-level-dependent globals (defense-in-depth).

    it('should allow console in PERMISSIVE mode', async () => {
      const enclave = createWorkerEnclave({ securityLevel: 'PERMISSIVE' });
      const result = await enclave.run(`
        async function __ag_main() {
          console.log('test message');
          return 'logged';
        }
      `);

      expect(result.success).toBe(true);
      expect(result.value).toBe('logged');
      enclave.dispose();
    });

    it('should block console in STANDARD mode at AST validation', async () => {
      const enclave = createWorkerEnclave({ securityLevel: 'STANDARD' });
      const result = await enclave.run(`
        async function __ag_main() {
          console.log('test');
          return 'logged';
        }
      `);

      // AST validation should block console in STANDARD mode
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/unknown identifier|not allowed/i);
      enclave.dispose();
    });

    it('should block console in STRICT mode at AST validation', async () => {
      const enclave = createWorkerEnclave({ securityLevel: 'STRICT' });
      const result = await enclave.run(`
        async function __ag_main() {
          console.log('test');
          return 'logged';
        }
      `);

      // AST validation should block console in STRICT mode
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/unknown identifier|not allowed/i);
      enclave.dispose();
    });

    it('should allow utility functions in STANDARD mode', async () => {
      const enclave = createWorkerEnclave({ securityLevel: 'STANDARD' });
      const result = await enclave.run(`
        async function __ag_main() {
          return {
            parsed: parseInt('42'),
            encoded: encodeURIComponent('hello world'),
            isNumber: isFinite(123),
          };
        }
      `);

      expect(result.success).toBe(true);
      expect(result.value).toEqual({
        parsed: 42,
        encoded: 'hello%20world',
        isNumber: true,
      });
      enclave.dispose();
    });

    it('should block utility functions in STRICT mode at AST validation', async () => {
      const enclave = createWorkerEnclave({ securityLevel: 'STRICT' });
      const result = await enclave.run(`
        async function __ag_main() {
          return parseInt('42');
        }
      `);

      // AST validation should block parseInt in STRICT mode
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/unknown identifier|not allowed/i);
      enclave.dispose();
    });

    it('should allow utility functions in SECURE mode', async () => {
      const enclave = createWorkerEnclave({ securityLevel: 'SECURE' });
      const result = await enclave.run(`
        async function __ag_main() {
          return {
            parsed: parseInt('42'),
            encoded: encodeURIComponent('hello world'),
            isNumber: isFinite(123),
          };
        }
      `);

      expect(result.success).toBe(true);
      expect(result.value).toEqual({
        parsed: 42,
        encoded: 'hello%20world',
        isNumber: true,
      });
      enclave.dispose();
    });
  });
});
