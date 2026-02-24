import { test, expect } from '@playwright/test';
import { loadHarness } from './helpers';

test.describe('console capture', () => {
  test.beforeEach(async ({ page }) => {
    await loadHarness(page);
  });

  test('console.log relayed to host', async ({ page }) => {
    const logs: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'log') logs.push(msg.text());
    });

    const result = await page.evaluate(async () => {
      const EB = (window as any).EnclaveBrowser;
      const enclave = new EB.BrowserEnclave({ timeout: 5000 });
      const res = await enclave.run('console.log("hello from enclave"); return "ok"');
      enclave.dispose();
      return res;
    });

    // Wait briefly for postMessage relay to reach host console
    await page.waitForTimeout(200);
    expect(result.success).toBe(true);
    expect(logs.some((l) => l.includes('hello from enclave'))).toBe(true);
  });

  test('console.warn relayed', async ({ page }) => {
    const warnings: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'warning') warnings.push(msg.text());
    });

    const result = await page.evaluate(async () => {
      const EB = (window as any).EnclaveBrowser;
      const enclave = new EB.BrowserEnclave({ timeout: 5000 });
      const res = await enclave.run('console.warn("warning msg"); return "ok"');
      enclave.dispose();
      return res;
    });

    await page.waitForTimeout(200);
    expect(result.success).toBe(true);
    expect(warnings.some((w) => w.includes('warning msg'))).toBe(true);
  });

  test('console.error relayed', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    const result = await page.evaluate(async () => {
      const EB = (window as any).EnclaveBrowser;
      const enclave = new EB.BrowserEnclave({ timeout: 5000 });
      const res = await enclave.run('console.error("error msg"); return "ok"');
      enclave.dispose();
      return res;
    });

    await page.waitForTimeout(200);
    expect(result.success).toBe(true);
    expect(errors.some((e) => e.includes('error msg'))).toBe(true);
  });

  test('maxConsoleCalls limit enforced', async ({ page }) => {
    const logs: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'log' && msg.text().includes('[Enclave]')) {
        logs.push(msg.text());
      }
    });

    await page.evaluate(async () => {
      const EB = (window as any).EnclaveBrowser;
      const enclave = new EB.BrowserEnclave({
        timeout: 5000,
        maxConsoleCalls: 3,
      });
      await enclave.run(`
        for (let i = 0; i < 10; i++) {
          console.log("msg " + i);
        }
        return "done";
      `);
      enclave.dispose();
    });

    await page.waitForTimeout(200);
    expect(logs.length).toBeLessThanOrEqual(3);
  });
});
