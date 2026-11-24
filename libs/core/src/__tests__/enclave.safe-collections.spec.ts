/**
 * Set, Map, Error, TypeError and RangeError in AgentScript, on every path a script can run.
 */

import { InterpreterAdapter } from '../adapters/interpreter-adapter';
import { Enclave } from '../enclave';
import { PortableEnclave } from '../portable-enclave';
import type { PostReviewInput, ReviewOptions } from '../review/types';
import type { CreateEnclaveOptions, ExecutionResult, ToolHandler } from '../types';

interface ScriptRunner {
  run(code: string, toolHandler?: ToolHandler): Promise<ExecutionResult<unknown>>;
  dispose(): void;
}

const PATHS: Array<[string, (options: CreateEnclaveOptions) => ScriptRunner]> = [
  ['double VM', (options) => new Enclave(options)],
  ['single VM', (options) => new Enclave({ ...options, doubleVm: { enabled: false } })],
  ['interpreter', (options) => new Enclave({ ...options, sandboxAdapter: new InterpreterAdapter() })],
  ['portable runner', (options) => new PortableEnclave(options)],
];

describe.each(PATHS)('Set, Map and errors on the %s', (_path, createRunner) => {
  async function run(code: string, options: CreateEnclaveOptions = {}): Promise<ExecutionResult<unknown>> {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const runner = createRunner({ securityLevel: 'SECURE', ...options });
    try {
      return await runner.run(code);
    } finally {
      runner.dispose();
      warn.mockRestore();
    }
  }

  it('counts the distinct entries of a Set', async () => {
    const result = await run(`const ids = new Set(['a', 'b', 'a']); return ids.size;`);

    expect(result.value).toBe(2);
  });

  it('reads back what a Map holds', async () => {
    const result = await run(`
      const totals = new Map();
      totals.set('a', 1).set('b', 2).set('a', 3);
      const seen = [];
      totals.forEach((value, key) => { seen.push(key + value); });
      return [totals.size, totals.get('a'), totals.has('c'), [...totals.keys()], seen];
    `);

    expect(result.value).toEqual([2, 3, false, ['a', 'b'], ['a3', 'b2']]);
  });

  it('returns a Set as an array and a Map as [key, value] pairs', async () => {
    const result = await run(`return { ids: new Set([1, 2, 2]), byId: new Map([['a', 1], [2, 'b']]) };`);

    expect(result.value).toEqual({
      ids: [1, 2],
      byId: [
        ['a', 1],
        [2, 'b'],
      ],
    });
  });

  it('sends a Set as an array and a Map as [key, value] pairs to a tool', async () => {
    const toolHandler = jest.fn(async (_name: string, args: Record<string, unknown>) => args);

    const result = await run(
      `return await callTool('echo', { ids: new Set(['x', 'y']), byId: new Map([[1, 'one']]) });`,
      { toolHandler },
    );

    expect(toolHandler).toHaveBeenCalledWith('echo', { ids: ['x', 'y'], byId: [[1, 'one']] }, { callIndex: 0 });
    expect(result.value).toEqual({ ids: ['x', 'y'], byId: [[1, 'one']] });
  });

  it('makes errors with a name and a message and no stack', async () => {
    const result = await run(`
      const error = new Error('x');
      const typeError = new TypeError('bad type');
      return [error.stack, String(error), error.message, String(typeError), String(new RangeError()), typeError instanceof Error];
    `);

    expect(result.value).toEqual([undefined, 'Error: x', 'x', 'TypeError: bad type', 'RangeError', true]);
  });

  it('lets a catch read the message of a thrown error', async () => {
    const result = await run(`
      try {
        throw new RangeError('no overdue invoices');
      } catch (error) {
        return [error.name, error.message, error instanceof RangeError];
      }
    `);

    expect(result.value).toEqual(['RangeError', 'no overdue invoices', true]);
  });

  it('reports an uncaught error by its name and message, without a stack', async () => {
    const result = await run(`throw new Error('no overdue invoices');`);

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ name: 'Error', message: 'no overdue invoices' });
    expect(result.error?.stack).toBeUndefined();
  });

  it('charges an entry once, however often it is added', async () => {
    const result = await run(
      `const seen = new Set(); for (let i = 0; i < 9000; i++) { seen.add('same'); } return seen.size;`,
      { memoryLimit: 64 * 1024, maxIterations: 10000 },
    );

    expect(result.value).toBe(1);
  });

  it('refuses Set, Map and the errors under STRICT', async () => {
    for (const code of [`return new Set().size;`, `return new Map().size;`, `throw new Error('x');`]) {
      const result = await run(code, { securityLevel: 'STRICT' });

      expect(result.error?.code).toBe('VALIDATION_ERROR');
    }
  });

  it('refuses WeakMap, WeakSet and WeakRef', async () => {
    for (const code of [`return new WeakMap();`, `return new WeakSet();`, `return new WeakRef({});`]) {
      const result = await run(code, { securityLevel: 'STANDARD' });

      expect(result.error?.code).toBe('VALIDATION_ERROR');
    }
  });

  it('lets a catch receive what a forEach callback threw', async () => {
    const result = await run(`
      const caught = [];
      try { new Set([1]).forEach(() => { throw 'stop'; }); } catch (e) { caught.push(e); }
      try { new Map([[1, 2]]).forEach(() => { throw { code: 7 }; }); } catch (e) { caught.push(e.code); }
      return caught;
    `);

    expect(result.value).toEqual(['stop', 7]);
  });

  it('counts the pair of a returned Map entry and its two slots against maxSanitizeProperties', async () => {
    const refused = await run(`return new Map([[1, 2]]);`, { maxSanitizeProperties: 2 });
    const accepted = await run(`return new Map([[1, 2]]);`, { maxSanitizeProperties: 3 });

    expect(refused.error?.message).toMatch(/maximum properties/);
    expect(accepted.value).toEqual([[1, 2]]);
  });
});

describe.each(PATHS.slice(0, 2))('memory usage of Set and Map entries on the %s', (_path, createRunner) => {
  it('reports every entry it charged', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const runner = createRunner({ securityLevel: 'SECURE' });
    try {
      const result = await runner.run(`const seen = new Set(); seen.add('a'); seen.add('a'); return seen.size;`);

      expect(result.stats.memoryUsage).toBe(16);
    } finally {
      runner.dispose();
      warn.mockRestore();
    }
  });
});

describe.each(PATHS)('the review hooks on the %s', (_path, createRunner) => {
  it('see a Set and a Map as they leave the script, and an error without a stack', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const seen: PostReviewInput[] = [];
    const callArgs: unknown[] = [];
    const review: ReviewOptions = {
      pre: (input) => {
        if (input.phase === 'call') callArgs.push(input.args);
        return { decision: 'allow' };
      },
      post: (input) => {
        seen.push(input);
        return { action: 'pass' };
      },
    };
    const toolHandler: ToolHandler = async () => 'ok';
    const returning = createRunner({ securityLevel: 'SECURE', review, toolHandler });
    const throwing = createRunner({ securityLevel: 'SECURE', review });
    try {
      const returned = await returning.run(
        `await callTool('record', { ids: new Set([1]), byId: new Map([[1, 'a']]) });
         return { ids: new Set([1, 2]), byId: new Map([[2, 'b']]) };`,
      );
      const failed = await throwing.run(`throw new RangeError('out of range');`);

      expect(returned.value).toEqual({ ids: [1, 2], byId: [[2, 'b']] });
      expect(callArgs).toEqual([{ ids: [1], byId: [[1, 'a']] }]);
      expect(seen.find((input) => input.phase === 'return')).toMatchObject({
        value: { ids: [1, 2], byId: [[2, 'b']] },
      });
      expect(failed.error).toMatchObject({ name: 'RangeError', message: 'out of range' });
      const error = seen.find((input) => input.phase === 'error');
      expect(error).toMatchObject({ error: { name: 'RangeError', message: 'out of range' } });
      expect(JSON.stringify(error)).not.toContain('stack');
    } finally {
      returning.dispose();
      throwing.dispose();
      warn.mockRestore();
    }
  });
});

describe('a custom global named Set or Map', () => {
  const globals = { Set: { label: 'catalog' }, Map: { label: 'atlas' } };

  it.each(PATHS.slice(0, 3))('replaces the built-in one on the %s', async (_path, createRunner) => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const runner = createRunner({ securityLevel: 'SECURE', globals });
    try {
      const result = await runner.run(`return [Set.label, Map.label];`);

      expect(result.value).toEqual(['catalog', 'atlas']);
    } finally {
      runner.dispose();
      warn.mockRestore();
    }
  });

  it('is refused by the portable runner, which never replaces a standard global', () => {
    expect(() => new PortableEnclave({ globals })).toThrow(/cannot replace standard global/);
  });
});
