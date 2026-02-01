/**
 * Safe Runtime Tests
 *
 * Tests for safe runtime wrapper functions (__safe_callTool, __safe_for, etc.)
 *
 * @packageDocumentation
 */

import { createSafeRuntime, serializeSafeRuntime } from '../safe-runtime';
import type { ExecutionContext, EnclaveConfig, ExecutionStats } from '../types';
import { ReferenceSidecar } from '../sidecar/reference-sidecar';
import { ReferenceConfig, REFERENCE_CONFIGS } from '../sidecar/reference-config';

/**
 * Create a mock execution context for testing
 */
function createMockContext(
  overrides: Partial<{
    toolHandler: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    maxToolCalls: number;
    maxIterations: number;
    aborted: boolean;
    globals: Record<string, unknown>;
  }>,
): ExecutionContext {
  const stats: ExecutionStats = {
    duration: 0,
    toolCallCount: 0,
    iterationCount: 0,
    startTime: Date.now(),
    endTime: 0,
  };

  // Create config with required fields - note config.toolHandler doesn't exist per types
  const config = {
    timeout: 5000,
    maxIterations: overrides.maxIterations ?? 10000,
    maxToolCalls: overrides.maxToolCalls ?? 100,
    memoryLimit: 128 * 1024 * 1024,
    adapter: 'vm' as const,
    allowBuiltins: false,
    sanitizeStackTraces: true,
    maxSanitizeDepth: 20,
    maxSanitizeProperties: 10000,
    allowFunctionsInGlobals: false,
    maxConsoleOutputBytes: 1024 * 1024,
    maxConsoleCalls: 1000,
    globals: overrides.globals ?? {},
    secureProxyConfig: {
      blockConstructor: true,
      blockPrototype: true,
      blockLegacyAccessors: true,
      proxyMaxDepth: 10,
    },
  };

  return {
    config,
    stats,
    abortController: new AbortController(),
    aborted: overrides.aborted ?? false,
    toolHandler: overrides.toolHandler,
  } as unknown as ExecutionContext;
}

describe('createSafeRuntime', () => {
  describe('__safe_callTool', () => {
    it('should call tool handler with correct args', async () => {
      const toolHandler = jest.fn().mockResolvedValue({ result: 'success' });
      const context = createMockContext({ toolHandler });
      const runtime = createSafeRuntime(context);

      const result = await (runtime.__safe_callTool as Function)('testTool', { key: 'value' });

      expect(toolHandler).toHaveBeenCalledWith('testTool', { key: 'value' });
      expect(result).toEqual({ result: 'success' });
    });

    it('should track tool call count', async () => {
      const toolHandler = jest.fn().mockResolvedValue({});
      const context = createMockContext({ toolHandler });
      const runtime = createSafeRuntime(context);

      await (runtime.__safe_callTool as Function)('tool1', {});
      await (runtime.__safe_callTool as Function)('tool2', {});
      await (runtime.__safe_callTool as Function)('tool3', {});

      expect(context.stats.toolCallCount).toBe(3);
    });

    it('should enforce max tool call limit', async () => {
      const toolHandler = jest.fn().mockResolvedValue({});
      const context = createMockContext({ toolHandler, maxToolCalls: 2 });
      const runtime = createSafeRuntime(context);

      await (runtime.__safe_callTool as Function)('tool1', {});
      await (runtime.__safe_callTool as Function)('tool2', {});

      await expect((runtime.__safe_callTool as Function)('tool3', {})).rejects.toThrow(/maximum tool call limit/i);
    });

    it('should throw if tool name is not a string', async () => {
      const context = createMockContext({ toolHandler: jest.fn() });
      const runtime = createSafeRuntime(context);

      await expect((runtime.__safe_callTool as Function)(123, {})).rejects.toThrow(
        /tool name must be a non-empty string/i,
      );
    });

    it('should throw if tool name is empty', async () => {
      const context = createMockContext({ toolHandler: jest.fn() });
      const runtime = createSafeRuntime(context);

      await expect((runtime.__safe_callTool as Function)('', {})).rejects.toThrow(
        /tool name must be a non-empty string/i,
      );
    });

    it('should throw if args is not an object', async () => {
      const context = createMockContext({ toolHandler: jest.fn() });
      const runtime = createSafeRuntime(context);

      await expect((runtime.__safe_callTool as Function)('tool', 'not an object')).rejects.toThrow(
        /tool arguments must be an object/i,
      );
    });

    it('should throw if args is null', async () => {
      const context = createMockContext({ toolHandler: jest.fn() });
      const runtime = createSafeRuntime(context);

      await expect((runtime.__safe_callTool as Function)('tool', null)).rejects.toThrow(
        /tool arguments must be an object/i,
      );
    });

    it('should throw if args is an array', async () => {
      const context = createMockContext({ toolHandler: jest.fn() });
      const runtime = createSafeRuntime(context);

      await expect((runtime.__safe_callTool as Function)('tool', [1, 2, 3])).rejects.toThrow(
        /tool arguments must be an object/i,
      );
    });

    it('should throw if no tool handler configured', async () => {
      const context = createMockContext({});
      const runtime = createSafeRuntime(context);

      await expect((runtime.__safe_callTool as Function)('tool', {})).rejects.toThrow(/no tool handler configured/i);
    });

    it('should throw if execution is aborted', async () => {
      const context = createMockContext({
        toolHandler: jest.fn(),
        aborted: true,
      });
      const runtime = createSafeRuntime(context);

      await expect((runtime.__safe_callTool as Function)('tool', {})).rejects.toThrow(/execution aborted/i);
    });

    it('should sanitize tool handler results', async () => {
      const toolHandler = jest.fn().mockResolvedValue({
        normalData: 'value',
        nested: { a: 1 },
      });
      const context = createMockContext({ toolHandler });
      const runtime = createSafeRuntime(context);

      const result = await (runtime.__safe_callTool as Function)('tool', {});

      expect(result).toEqual({
        normalData: 'value',
        nested: { a: 1 },
      });
    });

    it('should wrap tool handler errors', async () => {
      const toolHandler = jest.fn().mockRejectedValue(new Error('Handler failed'));
      const context = createMockContext({ toolHandler });
      const runtime = createSafeRuntime(context);

      await expect((runtime.__safe_callTool as Function)('myTool', {})).rejects.toThrow(
        /tool call failed: myTool.*handler failed/i,
      );
    });
  });

  describe('__safe_forOf', () => {
    it('should iterate over arrays', () => {
      const context = createMockContext({});
      const runtime = createSafeRuntime(context);

      const items = [1, 2, 3, 4, 5];
      const collected: number[] = [];

      for (const item of (runtime.__safe_forOf as Function)(items)) {
        collected.push(item);
      }

      expect(collected).toEqual([1, 2, 3, 4, 5]);
    });

    it('should track iteration count', () => {
      const context = createMockContext({});
      const runtime = createSafeRuntime(context);

      const items = [1, 2, 3];
      for (const _item of (runtime.__safe_forOf as Function)(items)) {
        // consume iterator
      }

      expect(context.stats.iterationCount).toBe(3);
    });

    it('should enforce iteration limit', () => {
      const context = createMockContext({ maxIterations: 5 });
      const runtime = createSafeRuntime(context);

      const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

      expect(() => {
        for (const _item of (runtime.__safe_forOf as Function)(items)) {
          // consume iterator
        }
      }).toThrow(/maximum iteration limit exceeded/i);
    });

    it('should throw if aborted during iteration', () => {
      const context = createMockContext({});
      const runtime = createSafeRuntime(context);

      const items = [1, 2, 3, 4, 5];
      let count = 0;

      expect(() => {
        for (const _item of (runtime.__safe_forOf as Function)(items)) {
          count++;
          if (count === 3) {
            context.aborted = true;
          }
        }
      }).toThrow(/execution aborted/i);
    });
  });

  describe('__safe_for', () => {
    it('should execute for loop correctly', () => {
      const context = createMockContext({});
      const runtime = createSafeRuntime(context);

      let sum = 0;
      let i = 0;

      (runtime.__safe_for as Function)(
        () => {
          i = 0;
        },
        () => i < 5,
        () => {
          i++;
        },
        () => {
          sum += i;
        },
      );

      expect(sum).toBe(10); // 0+1+2+3+4
    });

    it('should track iteration count', () => {
      const context = createMockContext({});
      const runtime = createSafeRuntime(context);

      let i = 0;
      (runtime.__safe_for as Function)(
        () => {
          i = 0;
        },
        () => i < 10,
        () => {
          i++;
        },
        () => undefined,
      );

      expect(context.stats.iterationCount).toBe(10);
    });

    it('should enforce iteration limit', () => {
      const context = createMockContext({ maxIterations: 5 });
      const runtime = createSafeRuntime(context);

      let i = 0;

      expect(() => {
        (runtime.__safe_for as Function)(
          () => {
            i = 0;
          },
          () => i < 100,
          () => {
            i++;
          },
          () => undefined,
        );
      }).toThrow(/maximum iteration limit exceeded/i);
    });

    it('should throw if aborted', () => {
      const context = createMockContext({});
      const runtime = createSafeRuntime(context);

      let i = 0;

      expect(() => {
        (runtime.__safe_for as Function)(
          () => {
            i = 0;
          },
          () => i < 10,
          () => {
            i++;
          },
          () => {
            if (i === 3) context.aborted = true;
          },
        );
      }).toThrow(/execution aborted/i);
    });
  });

  describe('__safe_while', () => {
    it('should execute while loop correctly', () => {
      const context = createMockContext({});
      const runtime = createSafeRuntime(context);

      let count = 0;
      (runtime.__safe_while as Function)(
        () => count < 5,
        () => {
          count++;
        },
      );

      expect(count).toBe(5);
    });

    it('should track iteration count', () => {
      const context = createMockContext({});
      const runtime = createSafeRuntime(context);

      let count = 0;
      (runtime.__safe_while as Function)(
        () => count < 10,
        () => {
          count++;
        },
      );

      expect(context.stats.iterationCount).toBe(10);
    });

    it('should enforce iteration limit', () => {
      const context = createMockContext({ maxIterations: 3 });
      const runtime = createSafeRuntime(context);

      expect(() => {
        (runtime.__safe_while as Function)(
          () => true,
          () => undefined,
        );
      }).toThrow(/maximum iteration limit exceeded/i);
    });

    it('should throw if aborted', () => {
      const context = createMockContext({});
      const runtime = createSafeRuntime(context);

      let count = 0;

      expect(() => {
        (runtime.__safe_while as Function)(
          () => count < 10,
          () => {
            count++;
            if (count === 3) context.aborted = true;
          },
        );
      }).toThrow(/execution aborted/i);
    });
  });

  describe('__safe_doWhile', () => {
    it('should execute do-while loop correctly', () => {
      const context = createMockContext({});
      const runtime = createSafeRuntime(context);

      let count = 0;
      (runtime.__safe_doWhile as Function)(
        () => {
          count++;
        },
        () => count < 5,
      );

      expect(count).toBe(5);
    });

    it('should execute body at least once', () => {
      const context = createMockContext({});
      const runtime = createSafeRuntime(context);

      let executed = false;
      (runtime.__safe_doWhile as Function)(
        () => {
          executed = true;
        },
        () => false,
      );

      expect(executed).toBe(true);
      expect(context.stats.iterationCount).toBe(1);
    });

    it('should enforce iteration limit', () => {
      const context = createMockContext({ maxIterations: 3 });
      const runtime = createSafeRuntime(context);

      expect(() => {
        (runtime.__safe_doWhile as Function)(
          () => undefined,
          () => true,
        );
      }).toThrow(/maximum iteration limit exceeded/i);
    });

    it('should throw if aborted', () => {
      const context = createMockContext({});
      const runtime = createSafeRuntime(context);

      let count = 0;

      expect(() => {
        (runtime.__safe_doWhile as Function)(
          () => {
            count++;
            if (count === 3) context.aborted = true;
          },
          () => count < 10,
        );
      }).toThrow(/execution aborted/i);
    });
  });

  describe('__safe_concat', () => {
    it('should concatenate strings normally', () => {
      const context = createMockContext({});
      const runtime = createSafeRuntime(context);

      const result = (runtime.__safe_concat as Function)('Hello', ' World');
      expect(result).toBe('Hello World');
    });

    it('should convert non-strings to strings', () => {
      const context = createMockContext({});
      const runtime = createSafeRuntime(context);

      expect((runtime.__safe_concat as Function)(42, ' items')).toBe('42 items');
      expect((runtime.__safe_concat as Function)('Value: ', true)).toBe('Value: true');
    });

    it('should throw when concatenating reference IDs without resolver', () => {
      const context = createMockContext({});
      const runtime = createSafeRuntime(context);

      expect(() => {
        (runtime.__safe_concat as Function)('__REF_12345678-1234-1234-1234-123456789012__', ' suffix');
      }).toThrow(/cannot concatenate reference ids/i);
    });
  });

  describe('__safe_template', () => {
    it('should interpolate template literals', () => {
      const context = createMockContext({});
      const runtime = createSafeRuntime(context);

      const result = (runtime.__safe_template as Function)(['Hello ', '!'], 'World');

      expect(result).toBe('Hello World!');
    });

    it('should handle multiple interpolations', () => {
      const context = createMockContext({});
      const runtime = createSafeRuntime(context);

      const result = (runtime.__safe_template as Function)(['', ' + ', ' = ', ''], 1, 2, 3);

      expect(result).toBe('1 + 2 = 3');
    });

    it('should throw when interpolating reference IDs without resolver', () => {
      const context = createMockContext({});
      const runtime = createSafeRuntime(context);

      expect(() => {
        (runtime.__safe_template as Function)(['Data: ', ''], '__REF_12345678-1234-1234-1234-123456789012__');
      }).toThrow(/cannot interpolate reference ids/i);
    });
  });

  describe('__safe_parallel', () => {
    it('should execute functions in parallel', async () => {
      const context = createMockContext({});
      const runtime = createSafeRuntime(context);

      const results = await (runtime.__safe_parallel as Function)([async () => 1, async () => 2, async () => 3]);

      expect(results).toEqual([1, 2, 3]);
    });

    it('should return empty array for empty input', async () => {
      const context = createMockContext({});
      const runtime = createSafeRuntime(context);

      const results = await (runtime.__safe_parallel as Function)([]);
      expect(results).toEqual([]);
    });

    it('should throw if input is not an array', async () => {
      const context = createMockContext({});
      const runtime = createSafeRuntime(context);

      await expect((runtime.__safe_parallel as Function)('not an array')).rejects.toThrow(
        /requires an array of functions/i,
      );
    });

    it('should throw if items are not functions', async () => {
      const context = createMockContext({});
      const runtime = createSafeRuntime(context);

      await expect((runtime.__safe_parallel as Function)([async () => 1, 'not a function'])).rejects.toThrow(
        /not a function/i,
      );
    });

    it('should enforce max parallel items limit', async () => {
      const context = createMockContext({});
      const runtime = createSafeRuntime(context);

      const fns = Array(101).fill(async () => 1);

      await expect((runtime.__safe_parallel as Function)(fns)).rejects.toThrow(/cannot execute more than 100/i);
    });

    it('should throw if aborted', async () => {
      const context = createMockContext({ aborted: true });
      const runtime = createSafeRuntime(context);

      await expect((runtime.__safe_parallel as Function)([async () => 1])).rejects.toThrow(/execution aborted/i);
    });

    it('should aggregate errors from failed operations', async () => {
      const context = createMockContext({});
      const runtime = createSafeRuntime(context);

      await expect(
        (runtime.__safe_parallel as Function)([
          async () => 1,
          async () => {
            throw new Error('Failed');
          },
          async () => 3,
        ]),
      ).rejects.toThrow(/1 of 3 parallel operations failed/i);
    });

    it('should respect maxConcurrency option', async () => {
      const context = createMockContext({});
      const runtime = createSafeRuntime(context);

      let concurrent = 0;
      let maxConcurrent = 0;

      const fns = Array(10)
        .fill(null)
        .map(() => async () => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise((r) => setTimeout(r, 10));
          concurrent--;
          return maxConcurrent;
        });

      await (runtime.__safe_parallel as Function)(fns, { maxConcurrency: 3 });

      expect(maxConcurrent).toBeLessThanOrEqual(3);
    });
  });

  describe('Standard Library', () => {
    it('should provide Math', () => {
      const context = createMockContext({});
      const runtime = createSafeRuntime(context) as Record<string, unknown>;

      expect(runtime['Math']).toBeDefined();
      expect((runtime['Math'] as typeof Math).PI).toBeCloseTo(3.14159, 4);
    });

    it('should provide JSON', () => {
      const context = createMockContext({});
      const runtime = createSafeRuntime(context) as Record<string, unknown>;

      expect(runtime['JSON']).toBeDefined();
      expect((runtime['JSON'] as typeof JSON).stringify({ a: 1 })).toBe('{"a":1}');
    });

    it('should provide Array', () => {
      const context = createMockContext({});
      const runtime = createSafeRuntime(context) as Record<string, unknown>;

      expect(runtime['Array']).toBeDefined();
      expect((runtime['Array'] as typeof Array).isArray([1, 2])).toBe(true);
    });

    it('should provide Object', () => {
      const context = createMockContext({});
      const runtime = createSafeRuntime(context) as Record<string, unknown>;

      expect(runtime['Object']).toBeDefined();
      expect((runtime['Object'] as typeof Object).keys({ a: 1 })).toEqual(['a']);
    });

    it('should provide primitives', () => {
      const context = createMockContext({});
      const runtime = createSafeRuntime(context);

      expect(runtime.NaN).toBeNaN();
      expect(runtime.Infinity).toBe(Infinity);
      expect(runtime.undefined).toBeUndefined();
    });
  });

  describe('Custom Globals', () => {
    it('should include custom globals with __safe_ prefix', () => {
      const context = createMockContext({
        globals: {
          myConfig: { version: '1.0.0' },
          myValue: 42,
        },
      });
      const runtime = createSafeRuntime(context);

      expect(runtime['__safe_myConfig']).toBeDefined();
      expect(runtime['__safe_myValue']).toBe(42);
    });
  });
});

describe('serializeSafeRuntime', () => {
  it('should return valid JavaScript code', () => {
    const code = serializeSafeRuntime();

    expect(code).toContain('async function __safe_callTool');
    expect(code).toContain('function* __safe_forOf');
    expect(code).toContain('function __safe_for');
    expect(code).toContain('function __safe_while');
    expect(code).toContain('function __safe_concat');
    expect(code).toContain('function __safe_template');
    expect(code).toContain('async function __safe_parallel');
  });

  it('should be parseable JavaScript', () => {
    const code = serializeSafeRuntime();

    // Should not throw when evaluated
    expect(() => {
      new Function(code);
    }).not.toThrow();
  });
});
