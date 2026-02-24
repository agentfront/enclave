import { test, expect } from '@playwright/test';
import { loadHarness, runInEnclave } from './helpers';

test.describe('security isolation', () => {
  test.beforeEach(async ({ page }) => {
    await loadHarness(page);
  });

  test('parent window not accessible from sandbox', async ({ page }) => {
    const result = await runInEnclave(
      page,
      `
        async function __ag_main() {
          try {
            var p = window.parent;
            var title = p.document.title;
            return title;
          } catch (e) {
            return "blocked";
          }
        }
      `,
      { validate: false, transform: false, timeout: 5000 },
    );
    expect(result.success).toBe(true);
    expect(result.value).toBe('blocked');
  });

  test('fetch is removed from sandbox', async ({ page }) => {
    const result = await runInEnclave(
      page,
      `
        async function __ag_main() {
          return typeof fetch;
        }
      `,
      { validate: false, transform: false, timeout: 5000 },
    );
    expect(result.success).toBe(true);
    expect(result.value).toBe('undefined');
  });

  test('document is removed from sandbox', async ({ page }) => {
    const result = await runInEnclave(
      page,
      `
        async function __ag_main() {
          return typeof document;
        }
      `,
      { validate: false, transform: false, timeout: 5000 },
    );
    expect(result.success).toBe(true);
    expect(result.value).toBe('undefined');
  });

  test('XMLHttpRequest is removed from sandbox', async ({ page }) => {
    const result = await runInEnclave(
      page,
      `
        async function __ag_main() {
          return typeof XMLHttpRequest;
        }
      `,
      { validate: false, transform: false, timeout: 5000 },
    );
    expect(result.success).toBe(true);
    expect(result.value).toBe('undefined');
  });

  test('CSP blocks eval at runtime', async ({ page }) => {
    const result = await runInEnclave(
      page,
      `
        async function __ag_main() {
          try {
            eval("1+1");
            return "eval worked";
          } catch(e) {
            return "eval blocked: " + e.message;
          }
        }
      `,
      { validate: false, transform: false, timeout: 5000 },
    );
    expect(result.success).toBe(true);
    expect(String(result.value)).toContain('eval blocked');
  });

  test('CSP blocks Function constructor at runtime', async ({ page }) => {
    const result = await runInEnclave(
      page,
      `
        async function __ag_main() {
          try {
            var fn = new Function("return 1");
            return "Function worked";
          } catch(e) {
            return "Function blocked: " + e.message;
          }
        }
      `,
      { validate: false, transform: false, timeout: 5000 },
    );
    expect(result.success).toBe(true);
    expect(String(result.value)).toContain('Function blocked');
  });

  test('dispose cleans up iframes', async ({ page }) => {
    const iframeCount = await page.evaluate(async () => {
      const EB = (window as any).EnclaveBrowser;
      const enclave = new EB.BrowserEnclave({ timeout: 5000 });
      await enclave.run('return 1');
      enclave.dispose();
      return document.querySelectorAll('iframe').length;
    });
    expect(iframeCount).toBe(0);
  });
});
