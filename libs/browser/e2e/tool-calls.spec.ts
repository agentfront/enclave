import { test, expect } from '@playwright/test';
import { loadHarness, runWithToolHandler } from './helpers';

test.describe('tool calls', () => {
  test.beforeEach(async ({ page }) => {
    await loadHarness(page);
  });

  test('single tool call returns result', async ({ page }) => {
    const result = await runWithToolHandler(
      page,
      `
        const users = await callTool("users:list", { limit: 5 });
        return users;
      `,
      `return { items: [{ id: 1 }, { id: 2 }] };`,
      { timeout: 10000 },
    );
    expect(result.success).toBe(true);
    expect(result.value).toEqual({ items: [{ id: 1 }, { id: 2 }] });
  });

  test('sequential tool calls', async ({ page }) => {
    const result = await runWithToolHandler(
      page,
      `
        const a = await callTool("add", { x: 1, y: 2 });
        const b = await callTool("add", { x: 3, y: 4 });
        return [a, b];
      `,
      `return args.x + args.y;`,
      { timeout: 10000 },
    );
    expect(result.success).toBe(true);
    expect(result.value).toEqual([3, 7]);
  });

  test('tool handler error propagates', async ({ page }) => {
    const result = await runWithToolHandler(
      page,
      `
        const val = await callTool("fail", {});
        return val;
      `,
      `throw new Error("tool failed");`,
      { timeout: 10000 },
    );
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('tool failed');
  });

  test('no handler returns error', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const EB = (window as any).EnclaveBrowser;
      const enclave = new EB.BrowserEnclave({
        timeout: 10000,
      });
      const res = await enclave.run('const r = await callTool("test", {}); return r;');
      enclave.dispose();
      return res;
    });
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('No tool handler configured');
  });

  test('tool name validation rejects invalid names', async ({ page }) => {
    const result = await runWithToolHandler(
      page,
      `
        const val = await callTool("", {});
        return val;
      `,
      `return "ok";`,
      { timeout: 10000 },
    );
    expect(result.success).toBe(false);
  });

  test('max tool calls limit enforced', async ({ page }) => {
    const result = await runWithToolHandler(
      page,
      `
        for (let i = 0; i < 20; i++) {
          await callTool("ping", { i: i });
        }
        return "done";
      `,
      `return "pong";`,
      { maxToolCalls: 5, securityLevel: 'PERMISSIVE', timeout: 10000 },
    );
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/tool call limit/i);
  });

  test('tool call stats tracked', async ({ page }) => {
    const result = await runWithToolHandler(
      page,
      `
        await callTool("a", {});
        await callTool("b", {});
        return "done";
      `,
      `return "ok";`,
      { timeout: 10000 },
    );
    expect(result.success).toBe(true);
    expect(result.stats.toolCallCount).toBe(2);
  });
});
