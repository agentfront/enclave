import { test, expect } from '@playwright/test';
import { loadHarness, runInEnclave } from './helpers';

test.describe('timeout and iteration limits', () => {
  test.beforeEach(async ({ page }) => {
    await loadHarness(page);
  });

  test('infinite loop is killed by iteration limit', async ({ page }) => {
    // In browsers, while(true){} blocks the entire process (same-thread iframes).
    // The AST transform injects iteration counters that enforce limits.
    // validate: false bypasses static analysis that rejects while(true).
    const result = await runInEnclave(
      page,
      `
        while (true) {}
        return "never";
      `,
      { validate: false, maxIterations: 1000, timeout: 5000 },
    );
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/iteration limit/i);
  });

  test('iteration limit enforced', async ({ page }) => {
    // Use PERMISSIVE so loops pass validation, but set maxIterations low
    const result = await runInEnclave(
      page,
      `
        let x = 0;
        for (let i = 0; i < 999999; i++) { x++; }
        return x;
      `,
      { maxIterations: 100, securityLevel: 'PERMISSIVE' },
    );
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/iteration limit/i);
  });

  test('code within timeout succeeds', async ({ page }) => {
    // Simple delay that completes within timeout
    const result = await runInEnclave(
      page,
      `
        async function __ag_main() {
          await new Promise(function(r) { setTimeout(r, 50); });
          return "done";
        }
      `,
      { validate: false, transform: false, timeout: 5000 },
    );
    expect(result.success).toBe(true);
    expect(result.value).toBe('done');
  });

  test('delay exceeding timeout fails', async ({ page }) => {
    const result = await runInEnclave(
      page,
      `
        async function __ag_main() {
          await new Promise(function(r) { setTimeout(r, 10000); });
          return "late";
        }
      `,
      { validate: false, transform: false, timeout: 500 },
    );
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/timed out/i);
  });
});
