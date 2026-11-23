/**
 * Set, Map, Error, TypeError and RangeError in AgentScript, on every path a script can run.
 */

import { InterpreterAdapter } from '../adapters/interpreter-adapter';
import { Enclave } from '../enclave';
import { PortableEnclave } from '../portable-enclave';
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

    expect(toolHandler).toHaveBeenCalledWith('echo', { ids: ['x', 'y'], byId: [[1, 'one']] });
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
});
