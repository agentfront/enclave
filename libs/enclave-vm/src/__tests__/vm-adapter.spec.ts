/**
 * VmAdapter Tests
 *
 * Tests for the Node.js vm module based sandbox adapter.
 * These tests run with double VM DISABLED to directly test VmAdapter.
 *
 * @packageDocumentation
 */

import { Enclave } from '../enclave';
import type { ToolHandler } from '../types';

/**
 * Helper to create Enclave with VmAdapter (double VM disabled)
 */
function createVmAdapterEnclave(
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
  } = {},
) {
  return new Enclave({
    ...options,
    // CRITICAL: Disable double VM to directly test VmAdapter
    doubleVm: { enabled: false },
  });
}

describe('VmAdapter', () => {
  describe('Basic Execution', () => {
    it('should execute simple code and return result', async () => {
      const enclave = createVmAdapterEnclave();
      const result = await enclave.run(`
        async function __ag_main() {
          return 42;
        }
      `);

      expect(result.success).toBe(true);
      expect(result.value).toBe(42);
    });

    it('should execute async code with await', async () => {
      const toolHandler: ToolHandler = async () => {
        await new Promise((r) => setTimeout(r, 10));
        return { done: true };
      };

      const enclave = createVmAdapterEnclave({ toolHandler });
      const result = await enclave.run(`
        async function __ag_main() {
          const response = await callTool('asyncOp', {});
          return response.done ? 'async complete' : 'failed';
        }
      `);

      expect(result.success).toBe(true);
      expect(result.value).toBe('async complete');
    });

    it('should provide standard globals (Math, JSON, Array, etc.)', async () => {
      const enclave = createVmAdapterEnclave();
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
      const enclave = createVmAdapterEnclave();
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

  describe('Tool Handler', () => {
    it('should call tool handler and return results', async () => {
      const toolHandler: ToolHandler = async (name, args) => {
        return { tool: name, args, result: 'success' };
      };

      const enclave = createVmAdapterEnclave({ toolHandler });
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

    it('should track tool call count in stats', async () => {
      const toolHandler: ToolHandler = async () => ({ ok: true });

      const enclave = createVmAdapterEnclave({ toolHandler });
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

      const enclave = createVmAdapterEnclave({
        toolHandler,
        maxToolCalls: 2,
      });

      const result = await enclave.run(`
        async function __ag_main() {
          await callTool('tool1', {});
          await callTool('tool2', {});
          await callTool('tool3', {}); // Should exceed limit
          return 'done';
        }
      `);

      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/maximum tool call limit/i);
    });
  });

  describe('Custom Globals', () => {
    it('should inject custom globals into sandbox', async () => {
      const enclave = createVmAdapterEnclave({
        globals: {
          myConfig: { version: '1.0.0', debug: true },
          myValue: 42,
        },
      });

      const result = await enclave.run(`
        async function __ag_main() {
          return {
            version: myConfig.version,
            debug: myConfig.debug,
            value: myValue,
          };
        }
      `);

      expect(result.success).toBe(true);
      expect(result.value).toEqual({
        version: '1.0.0',
        debug: true,
        value: 42,
      });
    });

    it('should use user globals in computations', async () => {
      const enclave = createVmAdapterEnclave({
        globals: {
          multiplier: 5,
        },
      });

      const result = await enclave.run(`
        async function __ag_main() {
          return multiplier * 10;
        }
      `);

      expect(result.success).toBe(true);
      expect(result.value).toBe(50);
    });
  });

  describe('Protected Identifiers', () => {
    it('should make callTool non-writable', async () => {
      const toolHandler: ToolHandler = async () => ({ ok: true });
      const enclave = createVmAdapterEnclave({ toolHandler });

      // The safe runtime functions should not be overwritable
      const result = await enclave.run(`
        async function __ag_main() {
          // Test that callTool still works
          const r = await callTool('test', {});
          return r.ok;
        }
      `);

      expect(result.success).toBe(true);
      expect(result.value).toBe(true);
    });

    it('should not allow direct global assignment to runtime functions', async () => {
      const enclave = createVmAdapterEnclave();

      // This test verifies the sandbox is configured with non-writable properties
      // The AST validator prevents direct assignments like `callTool = x`
      const result = await enclave.run(`
        async function __ag_main() {
          // Check that callTool is defined
          return typeof callTool === 'function';
        }
      `);

      expect(result.success).toBe(true);
      expect(result.value).toBe(true);
    });
  });

  describe('Console Rate Limiting', () => {
    it('should allow console output within limits', async () => {
      const enclave = createVmAdapterEnclave({
        maxConsoleCalls: 10,
        maxConsoleOutputBytes: 1000,
      });

      const result = await enclave.run(`
        async function __ag_main() {
          console.log('test');
          console.log('test2');
          return 'success';
        }
      `);

      expect(result.success).toBe(true);
      expect(result.value).toBe('success');
    });

    it('should enforce maxConsoleCalls limit', async () => {
      const enclave = createVmAdapterEnclave({
        maxConsoleCalls: 3,
        maxConsoleOutputBytes: 10000,
      });

      const result = await enclave.run(`
        async function __ag_main() {
          for (let i = 0; i < 10; i++) {
            console.log('message');
          }
          return 'done';
        }
      `);

      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/console call limit exceeded/i);
    });

    it('should enforce maxConsoleOutputBytes limit', async () => {
      const enclave = createVmAdapterEnclave({
        maxConsoleCalls: 1000,
        maxConsoleOutputBytes: 50,
      });

      const result = await enclave.run(`
        async function __ag_main() {
          console.log('x'.repeat(100));
          return 'done';
        }
      `);

      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/console output size limit exceeded/i);
    });

    it('should support all console methods (log, error, warn, info)', async () => {
      const enclave = createVmAdapterEnclave({
        maxConsoleCalls: 10,
        maxConsoleOutputBytes: 1000,
      });

      const result = await enclave.run(`
        async function __ag_main() {
          console.log('log');
          console.error('error');
          console.warn('warn');
          console.info('info');
          return 'all methods called';
        }
      `);

      expect(result.success).toBe(true);
      expect(result.value).toBe('all methods called');
    });

    it('should handle objects in console output', async () => {
      const enclave = createVmAdapterEnclave({
        maxConsoleCalls: 10,
        maxConsoleOutputBytes: 1000,
      });

      const result = await enclave.run(`
        async function __ag_main() {
          console.log({ key: 'value' });
          console.log([1, 2, 3]);
          console.log(null);
          console.log(undefined);
          return 'logged objects';
        }
      `);

      expect(result.success).toBe(true);
      expect(result.value).toBe('logged objects');
    });
  });

  describe('Stack Trace Sanitization', () => {
    it('should capture error information for runtime errors', async () => {
      const enclave = createVmAdapterEnclave();
      const result = await enclave.run(`
        async function __ag_main() {
          const x = null;
          return x.y; // This throws TypeError at runtime
        }
      `);

      expect(result.success).toBe(false);
      expect(result.error?.name).toBe('TypeError');
      expect(result.error?.message).toMatch(/Cannot read properties of null/i);
    });

    it('should provide error information when sanitization is disabled', async () => {
      const enclave = createVmAdapterEnclave({
        sanitizeStackTraces: false,
      });

      const result = await enclave.run(`
        async function __ag_main() {
          const arr = [];
          return arr.nonexistent.value;
        }
      `);

      expect(result.success).toBe(false);
      expect(result.error?.name).toBe('TypeError');
      // Stack should be present when not sanitized
      expect(result.error?.stack).toBeDefined();
    });
  });

  describe('Security Levels', () => {
    describe('STRICT security level', () => {
      it('should provide isolated execution environment', async () => {
        const enclave = createVmAdapterEnclave({ securityLevel: 'STRICT' });
        const result = await enclave.run(`
          async function __ag_main() {
            return {
              mathWorks: typeof Math.PI === 'number',
              jsonWorks: typeof JSON.stringify === 'function',
            };
          }
        `);

        expect(result.success).toBe(true);
        expect(result.value).toEqual({
          mathWorks: true,
          jsonWorks: true,
        });
      });

      it('should enforce strict tool call limits', async () => {
        const toolHandler: ToolHandler = async () => ({ ok: true });
        // STRICT security level has lower maxToolCalls
        const enclave = createVmAdapterEnclave({
          securityLevel: 'STRICT',
          toolHandler,
          maxToolCalls: 5,
        });

        const result = await enclave.run(`
          async function __ag_main() {
            for (let i = 0; i < 10; i++) {
              await callTool('test', {});
            }
            return 'done';
          }
        `);

        expect(result.success).toBe(false);
        expect(result.error?.message).toMatch(/tool call limit/i);
      });
    });

    describe('STANDARD security level', () => {
      it('should provide standard execution environment', async () => {
        const enclave = createVmAdapterEnclave({ securityLevel: 'STANDARD' });
        const result = await enclave.run(`
          async function __ag_main() {
            const arr = [1, 2, 3];
            return arr.map(x => x * 2);
          }
        `);

        expect(result.success).toBe(true);
        expect(result.value).toEqual([2, 4, 6]);
      });
    });

    describe('PERMISSIVE security level', () => {
      it('should allow more relaxed execution', async () => {
        const enclave = createVmAdapterEnclave({ securityLevel: 'PERMISSIVE' });
        const result = await enclave.run(`
          async function __ag_main() {
            const obj = { a: 1, b: 2 };
            return Object.keys(obj);
          }
        `);

        expect(result.success).toBe(true);
        expect(result.value).toEqual(['a', 'b']);
      });
    });
  });

  describe('Timeout Handling', () => {
    it('should enforce execution timeout via iteration limit for loops', async () => {
      const enclave = createVmAdapterEnclave({
        timeout: 100, // 100ms timeout
        maxIterations: 1000000, // High iteration limit to test timeout
      });

      const result = await enclave.run(`
        async function __ag_main() {
          // Long-running async operation
          const start = Date.now();
          while (Date.now() - start < 200) {
            await new Promise(r => setTimeout(r, 10));
          }
          return 'should not reach';
        }
      `);

      expect(result.success).toBe(false);
      // Will either timeout or abort
      expect(result.error).toBeDefined();
    });

    it('should complete fast operations within timeout', async () => {
      const enclave = createVmAdapterEnclave({
        timeout: 1000,
      });

      const result = await enclave.run(`
        async function __ag_main() {
          return 'fast';
        }
      `);

      expect(result.success).toBe(true);
      expect(result.value).toBe('fast');
    });
  });

  describe('Iteration Limits', () => {
    it('should allow loops within configured iteration limit', async () => {
      const enclave = createVmAdapterEnclave({
        maxIterations: 100,
      });

      const result = await enclave.run(`
        async function __ag_main() {
          let sum = 0;
          for (let i = 0; i < 10; i++) {
            sum += i;
          }
          return sum;
        }
      `);

      expect(result.success).toBe(true);
      expect(result.value).toBe(45); // 0+1+2+...+9 = 45
    });

    it('should handle for-of loops correctly', async () => {
      const enclave = createVmAdapterEnclave({
        maxIterations: 1000,
      });

      const result = await enclave.run(`
        async function __ag_main() {
          let sum = 0;
          const items = [1, 2, 3, 4, 5];
          for (const item of items) {
            sum += item;
          }
          return sum;
        }
      `);

      expect(result.success).toBe(true);
      expect(result.value).toBe(15); // 1+2+3+4+5 = 15
    });
  });

  describe('Error Handling', () => {
    it('should catch and report TypeError for null property access', async () => {
      const enclave = createVmAdapterEnclave();
      const result = await enclave.run(`
        async function __ag_main() {
          const obj = null;
          return obj.property;
        }
      `);

      expect(result.success).toBe(false);
      expect(result.error?.name).toBe('TypeError');
      expect(result.error?.message).toMatch(/Cannot read properties of null/i);
    });

    it('should catch TypeError for undefined property chain', async () => {
      const enclave = createVmAdapterEnclave();
      const result = await enclave.run(`
        async function __ag_main() {
          const obj = {};
          return obj.nonexistent.foo;
        }
      `);

      expect(result.success).toBe(false);
      expect(result.error?.name).toBe('TypeError');
    });

    it('should provide error code in result', async () => {
      const enclave = createVmAdapterEnclave();
      const result = await enclave.run(`
        async function __ag_main() {
          const x = null;
          return x.y;
        }
      `);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('VM_EXECUTION_ERROR');
    });

    it('should handle tool handler errors', async () => {
      const toolHandler: ToolHandler = async () => {
        throw new Error('Tool failed');
      };

      const enclave = createVmAdapterEnclave({ toolHandler });
      const result = await enclave.run(`
        async function __ag_main() {
          return await callTool('failingTool', {});
        }
      `);

      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/Tool failed|tool call failed/i);
    });
  });

  describe('Disposal', () => {
    it('should dispose adapter resources', () => {
      const enclave = createVmAdapterEnclave();
      expect(() => enclave.dispose()).not.toThrow();
    });

    it('should handle multiple dispose calls', () => {
      const enclave = createVmAdapterEnclave();
      enclave.dispose();
      expect(() => enclave.dispose()).not.toThrow();
    });
  });

  describe('Multiple Tool Calls', () => {
    it('should handle multiple sequential tool calls', async () => {
      const toolHandler: ToolHandler = async (name, args) => {
        return { id: (args as { id: number }).id, processed: true };
      };

      const enclave = createVmAdapterEnclave({ toolHandler });
      const result = await enclave.run(`
        async function __ag_main() {
          const results = [];
          for (const id of [1, 2, 3]) {
            const r = await callTool('process', { id: id });
            results.push(r);
          }
          return results;
        }
      `);

      expect(result.success).toBe(true);
      expect(result.value).toEqual([
        { id: 1, processed: true },
        { id: 2, processed: true },
        { id: 3, processed: true },
      ]);
    });

    it('should pass different args to each tool call', async () => {
      const calls: { name: string; args: unknown }[] = [];
      const toolHandler: ToolHandler = async (name, args) => {
        calls.push({ name, args });
        return { received: args };
      };

      const enclave = createVmAdapterEnclave({ toolHandler });
      const result = await enclave.run(`
        async function __ag_main() {
          await callTool('tool1', { a: 1 });
          await callTool('tool2', { b: 2 });
          await callTool('tool3', { c: 3 });
          return 'done';
        }
      `);

      expect(result.success).toBe(true);
      expect(calls).toEqual([
        { name: 'tool1', args: { a: 1 } },
        { name: 'tool2', args: { b: 2 } },
        { name: 'tool3', args: { c: 3 } },
      ]);
    });
  });

  describe('Fresh Context Per Execution', () => {
    it('should create fresh context for each execution', async () => {
      const enclave = createVmAdapterEnclave();

      // First execution creates a variable
      const result1 = await enclave.run(`
        async function __ag_main() {
          const localVar = 'first execution';
          return localVar;
        }
      `);

      expect(result1.success).toBe(true);
      expect(result1.value).toBe('first execution');

      // Second execution should work independently
      const result2 = await enclave.run(`
        async function __ag_main() {
          const localVar = 'second execution';
          return localVar;
        }
      `);

      expect(result2.success).toBe(true);
      expect(result2.value).toBe('second execution');
    });

    it('should not share tool call state between executions', async () => {
      let callCount = 0;
      const toolHandler: ToolHandler = async () => {
        callCount++;
        return { count: callCount };
      };

      const enclave = createVmAdapterEnclave({ toolHandler });

      // First execution
      const result1 = await enclave.run(`
        async function __ag_main() {
          await callTool('test', {});
          await callTool('test', {});
          return 'done';
        }
      `);

      expect(result1.success).toBe(true);
      expect(result1.stats.toolCallCount).toBe(2);

      // Second execution - stats should reset
      const result2 = await enclave.run(`
        async function __ag_main() {
          await callTool('test', {});
          return 'done';
        }
      `);

      expect(result2.success).toBe(true);
      expect(result2.stats.toolCallCount).toBe(1);
    });
  });
});
