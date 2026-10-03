import { test, expect } from '@playwright/test';
import { loadHarness, runInEnclave } from './helpers';

/** Builds `{ o: { o: ... { v: 1 } } }` nested `levels` deep. */
const nestedScript = (levels: number) => `
  let value = { v: 1 };
  for (let i = 0; i < ${levels}; i++) { value = { o: value }; }
  return value;
`;

/** Builds an object with `count` keys. */
const wideScript = (count: number) => `
  const value = {};
  for (let i = 0; i < ${count}; i++) { value['k' + i] = i; }
  return value;
`;

test.describe('script results', () => {
  test.beforeEach(async ({ page }) => {
    await loadHarness(page);
  });

  test('keep Date, NaN, Infinity and undefined as @enclave-vm/core does', async ({ page }) => {
    const result = await runInEnclave(
      page,
      'return { date: new Date(0), nan: NaN, inf: Infinity, undef: undefined, big: 10n };',
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({ date: new Date(0), nan: NaN, inf: Infinity, undef: undefined, big: '10' });
  });

  test('a circular result is marked, not dropped', async ({ page }) => {
    const result = await runInEnclave(page, "const a = { name: 'a' }; a.self = a; return a;");
    expect(result.success).toBe(true);
    expect(result.value).toEqual({ name: 'a', self: '[Circular]' });
  });

  test('__proto__ and constructor keys are removed', async ({ page }) => {
    const result = await runInEnclave(page, `return JSON.parse('{"__proto__": {"x": 1}, "constructor": 2, "ok": 3}');`);
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({ ok: 3 });
  });

  test('Map, Set, RegExp and Error values are converted', async ({ page }) => {
    const result = await runInEnclave(
      page,
      `async function __ag_main() {
        return { map: new Map([['a', 1], [2, 'skipped']]), set: new Set([1, 2]), pattern: /ab+c/gi, error: new TypeError('boom') };
      }`,
      { validate: false, transform: false },
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({
      map: { a: 1 },
      set: [1, 2],
      pattern: '/ab+c/gi',
      error: { name: 'TypeError', message: 'boom' },
    });
  });

  test('a function in the result fails the run', async ({ page }) => {
    const result = await runInEnclave(page, 'return { label: "x", run: () => 1 };');
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('contains a function');
  });

  test('a result deeper than maxSanitizeDepth fails the run', async ({ page }) => {
    const result = await runInEnclave(page, nestedScript(30), { securityLevel: 'STANDARD' });
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('maximum depth (20)');

    const raised = await runInEnclave(page, nestedScript(30), { securityLevel: 'STANDARD', maxSanitizeDepth: 40 });
    expect(raised.error).toBeUndefined();
  });

  test('a result with more than maxSanitizeProperties properties fails the run', async ({ page }) => {
    const result = await runInEnclave(page, wideScript(600), { securityLevel: 'STANDARD' });
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('maximum properties (500)');

    const raised = await runInEnclave(page, wideScript(600), {
      securityLevel: 'STANDARD',
      maxSanitizeProperties: 1000,
    });
    expect(raised.error).toBeUndefined();
    expect(Object.keys(raised.value as object)).toHaveLength(600);
  });
});
