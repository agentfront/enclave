/**
 * Enclave Tests
 *
 * Comprehensive tests for the Enclave execution environment.
 */

import { Enclave, runAgentScript } from '../enclave';
import type { ToolHandler } from '../types';

describe('Enclave', () => {
  describe('Basic Execution', () => {
    it('should execute simple AgentScript code', async () => {
      const enclave = new Enclave();
      const code = `
        const x = 1 + 2;
        return x;
      `;

      const result = await enclave.run<number>(code);

      if (!result.success) {
        console.log('SIMPLE TEST Error:', JSON.stringify(result.error, null, 2));
      }

      expect(result.success).toBe(true);
      expect(result.value).toBe(3);
      // Duration may be 0 for very fast executions (sub-millisecond)
      expect(result.stats.duration).toBeGreaterThanOrEqual(0);
      expect(result.stats.toolCallCount).toBe(0);
      expect(result.stats.iterationCount).toBe(0);

      enclave.dispose();
    });

    it('should execute code with array operations', async () => {
      const enclave = new Enclave();
      const code = `
        const numbers = [1, 2, 3, 4, 5];
        const doubled = numbers.map(n => n * 2);
        return doubled;
      `;

      const result = await enclave.run<number[]>(code);

      expect(result.success).toBe(true);
      expect(result.value).toEqual([2, 4, 6, 8, 10]);

      enclave.dispose();
    });

    it('should support Math and JSON globals', async () => {
      const enclave = new Enclave();
      const code = `
        const data = { value: Math.PI };
        const str = JSON.stringify(data);
        const parsed = JSON.parse(str);
        return parsed.value;
      `;

      const result = await enclave.run<number>(code);

      expect(result.success).toBe(true);
      expect(result.value).toBe(Math.PI);

      enclave.dispose();
    });
  });

  describe('Tool Calls', () => {
    it('should execute tool calls via callTool', async () => {
      const toolHandler: ToolHandler = async (toolName, args) => {
        if (toolName === 'users_get') {
          return { id: args['userId'], name: 'Alice' };
        }
        throw new Error(`Unknown tool: ${toolName}`);
      };

      const enclave = new Enclave({ toolHandler });
      const code = `
        const user = await callTool('users_get', { userId: 123 });
        return user.name;
      `;

      const result = await enclave.run<string>(code);

      if (!result.success) {
        console.log('Error:', result.error);
      }

      expect(result.success).toBe(true);
      expect(result.value).toBe('Alice');
      expect(result.stats.toolCallCount).toBe(1);

      enclave.dispose();
    });

    it('should track multiple tool calls', async () => {
      const toolHandler: ToolHandler = async (toolName, args) => {
        if (toolName === 'math_add') {
          return (args['a'] as number) + (args['b'] as number);
        }
        return 0;
      };

      const enclave = new Enclave({ toolHandler });
      const code = `
        const result1 = await callTool('math_add', { a: 1, b: 2 });
        const result2 = await callTool('math_add', { a: 3, b: 4 });
        const result3 = await callTool('math_add', { a: result1, b: result2 });
        return result3;
      `;

      const result = await enclave.run<number>(code);

      expect(result.success).toBe(true);
      expect(result.value).toBe(10); // (1+2) + (3+4) = 3 + 7 = 10
      expect(result.stats.toolCallCount).toBe(3);

      enclave.dispose();
    });

    it('should enforce max tool call limit', async () => {
      const toolHandler: ToolHandler = async () => ({ ok: true });

      const enclave = new Enclave({
        toolHandler,
        maxToolCalls: 2,
      });

      const code = `
        await callTool('test', {});
        await callTool('test', {});
        await callTool('test', {}); // This should exceed limit
        return 'done';
      `;

      const result = await enclave.run(code);

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Maximum tool call limit exceeded');
      expect(result.error?.message).toContain('(2)');

      enclave.dispose();
    });

    it('should fail if no tool handler configured', async () => {
      const enclave = new Enclave(); // No tool handler

      const code = `
        const result = await callTool('test', {});
        return result;
      `;

      const result = await enclave.run(code);

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('No tool handler configured');

      enclave.dispose();
    });
  });

  describe('Loops and Iterations', () => {
    it('should execute for-of loops', async () => {
      const enclave = new Enclave();
      const code = `
        const numbers = [1, 2, 3, 4, 5];
        let sum = 0;
        for (const n of numbers) {
          sum += n;
        }
        return sum;
      `;

      const result = await enclave.run<number>(code);

      expect(result.success).toBe(true);
      expect(result.value).toBe(15);
      expect(result.stats.iterationCount).toBe(5);

      enclave.dispose();
    });

    it('should enforce max iteration limit', async () => {
      const enclave = new Enclave({
        maxIterations: 10,
      });

      const code = `
        const numbers = Array.from({ length: 20 }, (_, i) => i);
        let sum = 0;
        for (const n of numbers) {
          sum += n;
        }
        return sum;
      `;

      const result = await enclave.run(code);

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Maximum iteration limit exceeded');
      expect(result.error?.message).toContain('(10)');

      enclave.dispose();
    });

    it('should track iterations across multiple loops', async () => {
      const enclave = new Enclave({
        maxIterations: 100,
      });

      const code = `
        let count = 0;

        for (const x of [1, 2, 3]) {
          for (const y of [1, 2, 3]) {
            count++;
          }
        }

        return count;
      `;

      const result = await enclave.run<number>(code);

      expect(result.success).toBe(true);
      expect(result.value).toBe(9);
      // Iteration count is: 3 (outer loop) + 9 (inner loop) = 12 total iterations
      expect(result.stats.iterationCount).toBe(12);

      enclave.dispose();
    });
  });

  describe('Timeouts', () => {
    it('should enforce execution timeout', async () => {
      const enclave = new Enclave({
        timeout: 100, // 100ms timeout
      });

      const code = `
        // Simulate long-running operation
        const start = Date.now();
        while (Date.now() - start < 500) {
          // Busy wait for 500ms
        }
        return 'done';
      `;

      const result = await enclave.run(code);

      expect(result.success).toBe(false);
      expect(result.stats.duration).toBeLessThan(200);

      enclave.dispose();
    }, 10000);
  });

  describe('Validation', () => {
    it('should reject code with eval', async () => {
      const enclave = new Enclave();
      const code = `
        const x = eval('1 + 2');
        return x;
      `;

      const result = await enclave.run(code);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('VALIDATION_ERROR');
      expect(result.error?.message).toContain('validation failed');

      enclave.dispose();
    });

    it('should reject code with Function constructor', async () => {
      const enclave = new Enclave();
      const code = `
        const fn = new Function('return 42');
        return fn();
      `;

      const result = await enclave.run(code);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('VALIDATION_ERROR');

      enclave.dispose();
    });

    it('should reject code with reserved prefixes', async () => {
      const enclave = new Enclave();
      const code = `
        const __ag_secret = 42;
        return __ag_secret;
      `;

      const result = await enclave.run(code);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('VALIDATION_ERROR');

      enclave.dispose();
    });

    it('should allow validation to be disabled', async () => {
      const enclave = new Enclave({
        validate: false,
      });

      const code = `
        const __ag_test = 42;
        return __ag_test;
      `;

      const result = await enclave.run<number>(code);

      // Without validation, code might fail at runtime or transform
      // but won't fail at validation step
      expect(result.error?.code).not.toBe('VALIDATION_ERROR');

      enclave.dispose();
    });
  });

  describe('Custom Globals', () => {
    it('should support custom globals', async () => {
      const enclave = new Enclave({
        allowFunctionsInGlobals: true, // Required to pass functions in globals
        globals: {
          customValue: 42,
          customFunction: (x: number) => x * 2,
        },
      });

      const code = `
        const result = customFunction(customValue);
        return result;
      `;

      const result = await enclave.run<number>(code);

      expect(result.success).toBe(true);
      expect(result.value).toBe(84);

      enclave.dispose();
    });

    it('should support non-function globals without allowFunctionsInGlobals', async () => {
      const enclave = new Enclave({
        globals: {
          customValue: 42,
          customString: 'hello',
          customObject: { nested: { value: 123 } },
        },
      });

      const code = `
        return {
          value: customValue,
          str: customString,
          nested: customObject.nested.value
        };
      `;

      const result = await enclave.run(code);

      expect(result.success).toBe(true);
      const value = result.value as Record<string, unknown>;
      expect(value['value']).toBe(42);
      expect(value['str']).toBe('hello');
      expect(value['nested']).toBe(123);

      enclave.dispose();
    });

    describe.each([
      ['the double VM', {}],
      ['the single VM', { doubleVm: { enabled: false } }],
    ] as const)('in %s', (_sandbox, sandbox) => {
      let warn: jest.SpyInstance;
      beforeAll(() => {
        warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      });
      afterAll(() => {
        warn.mockRestore();
      });

      it('lets a script collect host data into an object of its own with reduce and forEach', async () => {
        const enclave = new Enclave({
          ...sandbox,
          globals: {
            rows: [
              { id: 'a', score: 1 },
              { id: 'b', score: 2 },
            ],
          },
        });

        const result = await enclave.run(`
          const byId = rows.reduce((collected, row) => { collected[row.id] = row.score; return collected; }, {});
          const doubled = [];
          rows.forEach((row) => { doubled.push(row.score * 2); });
          return { byId, doubled };
        `);

        expect(result.error).toBeUndefined();
        expect(result.value).toEqual({ byId: { a: 1, b: 2 }, doubled: [2, 4] });
        enclave.dispose();
      });

      it('lets a script read a regular expression from globals, and refuses to run it', async () => {
        const enclave = new Enclave({ ...sandbox, globals: { pattern: /a+b/gi } });

        const read = await enclave.run('return [pattern.source, pattern.flags];');
        expect(read.error).toBeUndefined();
        expect(read.value).toEqual(['a+b', 'gi']);

        const run = await enclave.run("return pattern.test('aab');");
        expect(run.success).toBe(false);
        expect(run.error?.message).toMatch(/A regular expression passed in globals cannot be run in the sandbox/);
        enclave.dispose();
      });

      it('tells a global that is an object from one that is a string, for a method called search', async () => {
        const enclave = new Enclave({
          ...sandbox,
          toolNamespaces: { docs: ['search'] },
          toolHandler: async (name, args) => ({ tool: name, q: args['q'] }),
          globals: { text: 'some text' },
        });

        // On a tool namespace it is the host's method, with any argument
        const tool = await enclave.run("const args = { q: 'needle' }; return await docs.search(args);");
        expect(tool.error).toBeUndefined();
        expect(tool.value).toEqual({ tool: 'docs.search', q: 'needle' });

        // On a string it is the string method, which takes its argument as a pattern
        const text = await enclave.run("const pattern = 'some'; return text.search(pattern);");
        expect(text.success).toBe(false);
        expect(text.error?.message).toContain('NO_REGEX_METHOD');
        enclave.dispose();
      });

      it('refuses a custom global named Object', () => {
        expect(() => new Enclave({ ...sandbox, globals: { Object: { marker: 1 } } })).toThrow(
          'A custom global cannot be named "Object": the sandbox provides its own Object',
        );
      });
    });
  });

  describe('runAgentScript convenience function', () => {
    it('should execute and dispose automatically', async () => {
      const code = `
        const x = 10;
        const y = 20;
        return x + y;
      `;

      const result = await runAgentScript<number>(code);

      expect(result.success).toBe(true);
      expect(result.value).toBe(30);
    });

    it('should accept configuration options', async () => {
      const toolHandler: ToolHandler = async (toolName) => {
        if (toolName === 'test') {
          return 'success';
        }
        return null;
      };

      const code = `
        const result = await callTool('test', {});
        return result;
      `;

      const result = await runAgentScript<string>(code, { toolHandler });

      expect(result.success).toBe(true);
      expect(result.value).toBe('success');
    });
  });

  describe('Error Handling', () => {
    it('should handle runtime errors gracefully', async () => {
      const enclave = new Enclave();
      const code = `
        const obj = null;
        return obj.property; // Will throw TypeError
      `;

      const result = await enclave.run(code);

      expect(result.success).toBe(false);
      expect(result.error?.name).toContain('Error');
      expect(result.error?.stack).toBeDefined();

      enclave.dispose();
    });

    it('should handle tool handler errors', async () => {
      const toolHandler: ToolHandler = async () => {
        throw new Error('Tool execution failed');
      };

      const enclave = new Enclave({ toolHandler });
      const code = `
        const result = await callTool('failing_tool', {});
        return result;
      `;

      const result = await enclave.run(code);

      expect(result.success).toBe(false);
      // The string bridge preserves the original error message from the tool handler
      expect(result.error?.message).toContain('Tool execution failed');

      enclave.dispose();
    });
  });

  describe('Stats Tracking', () => {
    it('should track execution statistics', async () => {
      const toolHandler: ToolHandler = async () => ({ ok: true });

      const enclave = new Enclave({ toolHandler });
      const code = `
        const items = [1, 2, 3];
        for (const item of items) {
          await callTool('process', { item });
        }
        return 'done';
      `;

      const result = await enclave.run(code);

      expect(result.success).toBe(true);
      expect(result.stats.toolCallCount).toBe(3);
      expect(result.stats.iterationCount).toBe(3);
      // Duration may be 0 for very fast executions (sub-millisecond)
      expect(result.stats.duration).toBeGreaterThanOrEqual(0);
      expect(result.stats.startTime).toBeLessThanOrEqual(result.stats.endTime);

      enclave.dispose();
    });
  });

  describe('Tool Call Validation', () => {
    it('should reject empty tool name', async () => {
      const toolHandler: ToolHandler = async () => ({ ok: true });
      const enclave = new Enclave({ toolHandler });

      const code = `
        const result = await callTool('', {});
        return result;
      `;

      const result = await enclave.run(code);

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('non-empty string');

      enclave.dispose();
    });

    it('should reject non-object arguments', async () => {
      const toolHandler: ToolHandler = async () => ({ ok: true });
      const enclave = new Enclave({ toolHandler });

      const code = `
        const result = await callTool('test', 'not-an-object');
        return result;
      `;

      const result = await enclave.run(code);

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('must be an object');

      enclave.dispose();
    });

    it('should reject array arguments', async () => {
      const toolHandler: ToolHandler = async () => ({ ok: true });
      const enclave = new Enclave({ toolHandler });

      const code = `
        const result = await callTool('test', [1, 2, 3]);
        return result;
      `;

      const result = await enclave.run(code);

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('must be an object');

      enclave.dispose();
    });

    it('should reject null arguments', async () => {
      const toolHandler: ToolHandler = async () => ({ ok: true });
      const enclave = new Enclave({ toolHandler });

      const code = `
        const result = await callTool('test', null);
        return result;
      `;

      const result = await enclave.run(code);

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('must be an object');

      enclave.dispose();
    });
  });
});
