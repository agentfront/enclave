import { test, expect } from '@playwright/test';
import { loadHarness, runInEnclave } from './helpers';

test.describe('execution', () => {
  test.beforeEach(async ({ page }) => {
    await loadHarness(page);
  });

  test('returns arithmetic result', async ({ page }) => {
    const result = await runInEnclave(page, 'return 2 + 3');
    expect(result.success).toBe(true);
    expect(result.value).toBe(5);
  });

  test('returns string result', async ({ page }) => {
    const result = await runInEnclave(page, 'return "hello world"');
    expect(result.success).toBe(true);
    expect(result.value).toBe('hello world');
  });

  test('executes loops and returns result', async ({ page }) => {
    const result = await runInEnclave(
      page,
      `
        let sum = 0;
        for (let i = 1; i <= 10; i++) { sum += i; }
        return sum;
      `,
      { securityLevel: 'PERMISSIVE' },
    );
    expect(result.success).toBe(true);
    expect(result.value).toBe(55);
  });

  test('handles async code', async ({ page }) => {
    // Use validate:false because the transformer rewrites Promise to
    // __safe_Promise which isn't in the default allowed-globals list
    const result = await runInEnclave(
      page,
      `
        async function __ag_main() {
          const val = await Promise.resolve(42);
          return val;
        }
      `,
      { validate: false, transform: false, timeout: 5000 },
    );
    expect(result.success).toBe(true);
    expect(result.value).toBe(42);
  });

  test('returns object result', async ({ page }) => {
    const result = await runInEnclave(
      page,
      `
      return { name: "test", count: 3 };
    `,
    );
    expect(result.success).toBe(true);
    expect(result.value).toEqual({ name: 'test', count: 3 });
  });

  test('returns array result', async ({ page }) => {
    const result = await runInEnclave(page, 'return [1, 2, 3]');
    expect(result.success).toBe(true);
    expect(result.value).toEqual([1, 2, 3]);
  });

  test('injects custom globals', async ({ page }) => {
    const result = await runInEnclave(page, 'return multiplier * 5', {
      globals: { multiplier: 10 },
    });
    expect(result.success).toBe(true);
    expect(result.value).toBe(50);
  });

  test('reports runtime errors', async ({ page }) => {
    const result = await runInEnclave(
      page,
      `
      const obj = null;
      return obj.foo;
    `,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  test('populates stats', async ({ page }) => {
    const result = await runInEnclave(page, 'return 1');
    expect(result.success).toBe(true);
    expect(result.stats).toBeDefined();
    expect(typeof result.stats.duration).toBe('number');
    expect(result.stats.duration).toBeGreaterThanOrEqual(0);
    expect(typeof result.stats.toolCallCount).toBe('number');
  });

  test('template literals work', async ({ page }) => {
    const result = await runInEnclave(
      page,
      `
      const x = "world";
      return \`hello \${x}\`;
    `,
    );
    expect(result.success).toBe(true);
    expect(result.value).toBe('hello world');
  });

  test('string concatenation works', async ({ page }) => {
    const result = await runInEnclave(
      page,
      `
      return "foo" + "bar";
    `,
    );
    expect(result.success).toBe(true);
    expect(result.value).toBe('foobar');
  });
});
