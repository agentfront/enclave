/**
 * Async/Promise Bomb Attack Prevention Tests
 *
 * Category: ATK-ASYNC (Attack Vector Category 9)
 *
 * Tests protection against event loop exhaustion via promise flooding
 * and async generator attacks. The enclave implements BLANKET BLOCKING
 * of Promise, setTimeout, and other async primitives as defense-in-depth.
 *
 * Defense layers:
 * 1. Promise/async globals are completely blocked in default security mode
 * 2. setTimeout/setInterval are not available
 * 3. queueMicrotask is not available
 * 4. Timeout enforcement across any async operations that do occur
 *
 * Test Categories:
 * - ATK-ASYNC-01 to ATK-ASYNC-08: Blanket Async Blocking
 * - ATK-ASYNC-09 to ATK-ASYNC-12: Promise Flood Prevention
 * - ATK-ASYNC-13 to ATK-ASYNC-15: Microtask Flooding Prevention
 * - ATK-ASYNC-16 to ATK-ASYNC-19: Safe Async Patterns
 * - ATK-ASYNC-20 to ATK-ASYNC-21: Generator Attack Prevention
 * - ATK-ASYNC-22 to ATK-ASYNC-24: CPU Exhaustion Protection
 *
 * @packageDocumentation
 */

import { Enclave } from '../enclave';

describe('ATK-ASYNC: Async/Promise Bomb Attack Prevention', () => {
  // ============================================================================
  // ATK-ASYNC-01 to ATK-ASYNC-08: Blanket Async Blocking
  // The enclave blocks Promise, setTimeout, etc. as blanket protection
  // ============================================================================
  describe('ATK-ASYNC-01 to ATK-ASYNC-08: Blanket Async Blocking', () => {
    it('ATK-ASYNC-01: should block Promise constructor access', async () => {
      const enclave = new Enclave({ timeout: 2000 });
      const code = `
        return typeof Promise;
      `;
      const result = await enclave.run(code);

      // Promise is not in allowed globals
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/UNKNOWN_GLOBAL|Promise|not.*allowed/i);
      enclave.dispose();
    });

    it('ATK-ASYNC-02: should block Promise.resolve() usage', async () => {
      const enclave = new Enclave({ timeout: 2000 });
      const code = `
        const p = Promise.resolve(42);
        return p;
      `;
      const result = await enclave.run(code);

      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/UNKNOWN_GLOBAL|Promise|not.*allowed/i);
      enclave.dispose();
    });

    it('ATK-ASYNC-03: should block new Promise() construction', async () => {
      const enclave = new Enclave({ timeout: 2000 });
      const code = `
        const p = new Promise((resolve) => resolve(42));
        return p;
      `;
      const result = await enclave.run(code);

      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/UNKNOWN_GLOBAL|Promise|not.*allowed/i);
      enclave.dispose();
    });

    it('ATK-ASYNC-04: should block setTimeout access', async () => {
      const enclave = new Enclave({ timeout: 2000 });
      const code = `
        return typeof setTimeout;
      `;
      const result = await enclave.run(code);

      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/UNKNOWN_GLOBAL|setTimeout|not.*allowed/i);
      enclave.dispose();
    });

    it('ATK-ASYNC-05: should block setInterval access', async () => {
      const enclave = new Enclave({ timeout: 2000 });
      const code = `
        return typeof setInterval;
      `;
      const result = await enclave.run(code);

      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/UNKNOWN_GLOBAL|setInterval|not.*allowed/i);
      enclave.dispose();
    });

    it('ATK-ASYNC-06: should block queueMicrotask access', async () => {
      const enclave = new Enclave({ timeout: 2000 });
      const code = `
        return typeof queueMicrotask;
      `;
      const result = await enclave.run(code);

      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/UNKNOWN_GLOBAL|queueMicrotask|not.*allowed/i);
      enclave.dispose();
    });

    it('ATK-ASYNC-07: should block setImmediate access', async () => {
      const enclave = new Enclave({ timeout: 2000 });
      const code = `
        return typeof setImmediate;
      `;
      const result = await enclave.run(code);

      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/UNKNOWN_GLOBAL|setImmediate|not.*allowed/i);
      enclave.dispose();
    });

    it('ATK-ASYNC-08: should block process.nextTick access', async () => {
      const enclave = new Enclave({ timeout: 2000 });
      const code = `
        return typeof process;
      `;
      const result = await enclave.run(code);

      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/UNKNOWN_GLOBAL|process|not.*allowed/i);
      enclave.dispose();
    });
  });

  // ============================================================================
  // ATK-ASYNC-09 to ATK-ASYNC-12: Promise Flood Prevention
  // ============================================================================
  describe('ATK-ASYNC-09 to ATK-ASYNC-12: Promise Flood Prevention', () => {
    it('ATK-ASYNC-09: should block Promise.all() flood attempt', async () => {
      const enclave = new Enclave({ timeout: 2000, maxIterations: 100000 });
      const code = `
        async function __ag_main() {
          const tasks = [];
          for (let i = 0; i < 10000; i++) {
            tasks.push(Promise.resolve(i));
          }
          const results = await Promise.all(tasks);
          return results.length;
        }
      `;
      const result = await enclave.run(code);

      // Promise is blocked
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/UNKNOWN_GLOBAL|Promise|not.*allowed/i);
      enclave.dispose();
    });

    it('ATK-ASYNC-10: should block Promise.race() flood attempt', async () => {
      const enclave = new Enclave({ timeout: 2000 });
      const code = `
        async function __ag_main() {
          const tasks = [];
          for (let i = 0; i < 20000; i++) {
            tasks.push(Promise.resolve(i));
          }
          return await Promise.race(tasks);
        }
      `;
      const result = await enclave.run(code);

      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/UNKNOWN_GLOBAL|Promise|not.*allowed/i);
      enclave.dispose();
    });

    it('ATK-ASYNC-11: should block recursive promise chain attack', async () => {
      const enclave = new Enclave({ timeout: 2000 });
      const code = `
        async function __ag_main() {
          function createPromiseChain(depth) {
            if (depth <= 0) return Promise.resolve(0);
            return Promise.resolve().then(() => createPromiseChain(depth - 1));
          }
          return await createPromiseChain(10000);
        }
      `;
      const result = await enclave.run(code);

      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/UNKNOWN_GLOBAL|Promise|not.*allowed/i);
      enclave.dispose();
    });

    it('ATK-ASYNC-12: should block unresolved promise accumulation', async () => {
      const enclave = new Enclave({ timeout: 2000 });
      const code = `
        async function __ag_main() {
          const pending = [];
          for (let i = 0; i < 50000; i++) {
            pending.push(new Promise(() => {})); // Never resolves
          }
          return pending.length;
        }
      `;
      const result = await enclave.run(code);

      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/UNKNOWN_GLOBAL|Promise|not.*allowed/i);
      enclave.dispose();
    });
  });

  // ============================================================================
  // ATK-ASYNC-13 to ATK-ASYNC-15: Microtask Flooding Prevention
  // ============================================================================
  describe('ATK-ASYNC-13 to ATK-ASYNC-15: Microtask Flooding Prevention', () => {
    it('ATK-ASYNC-13: should block queueMicrotask flooding', async () => {
      const enclave = new Enclave({ timeout: 2000 });
      const code = `
        async function __ag_main() {
          let count = 0;
          for (let i = 0; i < 10000; i++) {
            queueMicrotask(() => { count++; });
          }
          return count;
        }
      `;
      const result = await enclave.run(code);

      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/UNKNOWN_GLOBAL|queueMicrotask|not.*allowed/i);
      enclave.dispose();
    });

    it('ATK-ASYNC-14: should block Promise.resolve().then() flooding', async () => {
      const enclave = new Enclave({ timeout: 2000 });
      const code = `
        async function __ag_main() {
          let count = 0;
          for (let i = 0; i < 10000; i++) {
            Promise.resolve().then(() => { count++; });
          }
          return count;
        }
      `;
      const result = await enclave.run(code);

      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/UNKNOWN_GLOBAL|Promise|not.*allowed/i);
      enclave.dispose();
    });

    it('ATK-ASYNC-15: should block self-replicating microtasks', async () => {
      const enclave = new Enclave({ timeout: 1000 });
      const code = `
        async function __ag_main() {
          let count = 0;
          function replicate() {
            count++;
            if (count < 1000) {
              Promise.resolve().then(replicate);
            }
          }
          replicate();
          return count;
        }
      `;
      const result = await enclave.run(code);

      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/UNKNOWN_GLOBAL|Promise|not.*allowed/i);
      enclave.dispose();
    });
  });

  // ============================================================================
  // ATK-ASYNC-16 to ATK-ASYNC-19: Safe Async Patterns
  // Async keyword allowed with callTool, but Promise blocked
  // ============================================================================
  describe('ATK-ASYNC-16 to ATK-ASYNC-19: Safe Async Patterns', () => {
    it('ATK-ASYNC-16: should allow async function declaration', async () => {
      const enclave = new Enclave({ timeout: 1000 });
      const code = `
        async function __ag_main() {
          return "hello";
        }
      `;
      const result = await enclave.run(code);
      // Async function declaration is allowed, but Promise usage is blocked
      expect(result.success).toBe(true);
      expect(result.value).toBe('hello');
      enclave.dispose();
    });

    it('ATK-ASYNC-17: should allow async function with synchronous operations', async () => {
      const enclave = new Enclave({ timeout: 1000 });
      const code = `
        async function __ag_main() {
          let sum = 0;
          for (let i = 0; i < 10; i++) {
            sum += i;
          }
          return sum;
        }
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(true);
      expect(result.value).toBe(45);
      enclave.dispose();
    });

    it('ATK-ASYNC-18: should allow async function with callTool (internal promises)', async () => {
      const enclave = new Enclave({
        timeout: 1000,
        toolHandler: async (name, args) => {
          return { success: true, value: 42 };
        },
      });
      const code = `
        async function __ag_main() {
          const result = await callTool("myTool", { key: "value" });
          return result.value;
        }
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(true);
      expect(result.value).toBe(42);
      enclave.dispose();
    });

    it('ATK-ASYNC-19: should allow multiple await callTool operations', async () => {
      const enclave = new Enclave({
        timeout: 1000,
        toolHandler: async (name, args) => {
          return { success: true, value: (args as { n: number }).n * 2 };
        },
      });
      const code = `
        async function __ag_main() {
          const r1 = await callTool("double", { n: 1 });
          const r2 = await callTool("double", { n: 2 });
          const r3 = await callTool("double", { n: 3 });
          return r1.value + r2.value + r3.value;
        }
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(true);
      expect(result.value).toBe(12); // 2 + 4 + 6
      enclave.dispose();
    });
  });

  // ============================================================================
  // ATK-ASYNC-20 to ATK-ASYNC-21: Generator Attack Prevention
  // ============================================================================
  describe('ATK-ASYNC-20 to ATK-ASYNC-21: Generator Attack Prevention', () => {
    it('ATK-ASYNC-20: should handle generator functions (if allowed)', async () => {
      const enclave = new Enclave({ timeout: 1000, maxIterations: 100 });
      const code = `
        function* simpleGenerator() {
          yield 1;
          yield 2;
          yield 3;
        }
        let sum = 0;
        for (const val of simpleGenerator()) {
          sum += val;
        }
        return sum;
      `;
      const result = await enclave.run(code);
      // Generators may be allowed or blocked depending on security level
      // If allowed, should complete normally within iteration limits
      if (result.success) {
        expect(result.value).toBe(6);
      }
      enclave.dispose();
    });

    it('ATK-ASYNC-21: should protect against infinite generator', async () => {
      const enclave = new Enclave({ timeout: 1000, maxIterations: 100 });
      const code = `
        function* infiniteGenerator() {
          let i = 0;
          while (true) {
            yield i++;
          }
        }
        let count = 0;
        for (const val of infiniteGenerator()) {
          count++;
          if (count > 10000) break;
        }
        return count;
      `;
      const result = await enclave.run(code);
      // Should be limited by iteration counter or infinite loop detection
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/iteration|infinite|loop|validation/i);
      enclave.dispose();
    });
  });

  // ============================================================================
  // ATK-ASYNC-22 to ATK-ASYNC-24: CPU Exhaustion Protection
  // Protected by iteration limits
  // ============================================================================
  describe('ATK-ASYNC-22 to ATK-ASYNC-24: CPU Exhaustion Protection', () => {
    it('ATK-ASYNC-22: should protect against tight synchronous loops', async () => {
      const enclave = new Enclave({ timeout: 1000, maxIterations: 100 });
      const code = `
        let count = 0;
        for (let i = 0; i < 1000000; i++) {
          count++;
        }
        return count;
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/iteration.*limit|exceeded/i);
      enclave.dispose();
    });

    it('ATK-ASYNC-23: should protect against nested synchronous loops', async () => {
      const enclave = new Enclave({ timeout: 1000, maxIterations: 100 });
      const code = `
        let count = 0;
        for (let i = 0; i < 1000; i++) {
          for (let j = 0; j < 1000; j++) {
            count++;
          }
        }
        return count;
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/iteration.*limit|exceeded/i);
      enclave.dispose();
    });

    it('ATK-ASYNC-24: should allow loops within iteration limits', async () => {
      const enclave = new Enclave({ timeout: 1000, maxIterations: 1000 });
      const code = `
        let count = 0;
        for (let i = 0; i < 100; i++) {
          count++;
        }
        return count;
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(true);
      expect(result.value).toBe(100);
      enclave.dispose();
    });
  });
});
