import { test, expect } from '@playwright/test';
import { loadHarness, runInEnclave, runWithToolHandler } from './helpers';

test.describe('Set, Map and errors', () => {
  test.beforeEach(async ({ page }) => {
    await loadHarness(page);
  });

  test('counts the distinct entries of a Set', async ({ page }) => {
    const result = await runInEnclave(page, `const ids = new Set(['a', 'b', 'a']); return ids.size;`, {
      securityLevel: 'SECURE',
    });

    expect(result.value).toBe(2);
  });

  test('reads back what a Map holds', async ({ page }) => {
    const result = await runInEnclave(
      page,
      `const totals = new Map();
       totals.set('a', 1).set('b', 2).set('a', 3);
       const seen = [];
       totals.forEach((value, key) => { seen.push(key + value); });
       return [totals.size, totals.get('a'), totals.has('c'), [...totals.keys()], seen];`,
      { securityLevel: 'SECURE' },
    );

    expect(result.value).toEqual([2, 3, false, ['a', 'b'], ['a3', 'b2']]);
  });

  test('returns a Set as an array and a Map as [key, value] pairs', async ({ page }) => {
    const result = await runInEnclave(
      page,
      `return { ids: new Set([1, 2, 2]), byId: new Map([['a', 1], [2, 'b']]) };`,
      {
        securityLevel: 'SECURE',
      },
    );

    expect(result.value).toEqual({
      ids: [1, 2],
      byId: [
        ['a', 1],
        [2, 'b'],
      ],
    });
  });

  test('sends a Set as an array and a Map as [key, value] pairs to a tool', async ({ page }) => {
    const result = await runWithToolHandler(
      page,
      `return await callTool('echo', { ids: new Set(['x', 'y']), byId: new Map([[1, 'one']]) });`,
      'return args;',
      { securityLevel: 'SECURE' },
    );

    expect(result.value).toEqual({ ids: ['x', 'y'], byId: [[1, 'one']] });
  });

  test('makes errors with a name and a message and no stack', async ({ page }) => {
    const result = await runInEnclave(
      page,
      `const error = new Error('x');
       const typeError = new TypeError('bad type');
       return [error.stack === undefined, String(error), error.message, String(typeError), String(new RangeError()), typeError instanceof Error];`,
      { securityLevel: 'SECURE' },
    );

    expect(result.value).toEqual([true, 'Error: x', 'x', 'TypeError: bad type', 'RangeError', true]);
  });

  test('lets a catch read the message of a thrown error', async ({ page }) => {
    const result = await runInEnclave(
      page,
      `try {
         throw new RangeError('no overdue invoices');
       } catch (error) {
         return [error.name, error.message, error instanceof RangeError];
       }`,
      { securityLevel: 'SECURE' },
    );

    expect(result.value).toEqual(['RangeError', 'no overdue invoices', true]);
  });

  test('reports an uncaught error by its name and message, without a stack', async ({ page }) => {
    const result = await runInEnclave(page, `throw new Error('no overdue invoices');`, { securityLevel: 'SECURE' });

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ name: 'Error', message: 'no overdue invoices' });
    expect(result.error?.stack).toBeUndefined();
  });

  test('refuses Set, Map and the errors under STRICT', async ({ page }) => {
    for (const code of [`return new Set().size;`, `return new Map().size;`, `throw new Error('x');`]) {
      const result = await runInEnclave(page, code, { securityLevel: 'STRICT' });

      expect(result.error?.name).toBe('ValidationError');
    }
  });

  test('refuses WeakMap, WeakSet and WeakRef', async ({ page }) => {
    for (const code of [`return new WeakMap();`, `return new WeakSet();`, `return new WeakRef({});`]) {
      const result = await runInEnclave(page, code, { securityLevel: 'STANDARD' });

      expect(result.error?.name).toBe('ValidationError');
    }
  });
});
