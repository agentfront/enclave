import { test, expect } from '@playwright/test';
import { loadHarness, runInEnclave, runWithToolHandler } from './helpers';

/** Tool handler body resolving with 'done' after `ms` milliseconds. */
const slowTool = (ms: number) =>
  `return new Promise(function (resolve) { setTimeout(function () { resolve('done'); }, ${ms}); });`;

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

  test('time spent waiting for a tool call does not time the script out', async ({ page }) => {
    const result = await runWithToolHandler(page, "return await callTool('slow', {});", slowTool(2500), {
      timeout: 1000,
    });
    expect(result.error).toBeUndefined();
    expect(result.value).toBe('done');
  });

  test('parallel tool calls longer than the timeout complete', async ({ page }) => {
    const result = await runWithToolHandler(
      page,
      "return await parallel([() => callTool('a', {}), () => callTool('b', {}), () => callTool('c', {})]);",
      slowTool(1500),
      { timeout: 1000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual(['done', 'done', 'done']);
  });

  test('once the timeout has passed, the next tool call is refused', async ({ page }) => {
    const result = await runWithToolHandler(
      page,
      "const first = await callTool('slow', {}); const second = await callTool('slow', {}); return [first, second];",
      slowTool(1200),
      { timeout: 1000 },
    );
    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('Execution aborted');
  });

  test('a tool call that never settles ends the run when its grace is over', async ({ page }) => {
    // The grace is the value of the timeout unless it is set: 500 ms, then 500 ms more, on top
    // of the second the host gives the sandbox to report its own timeout.
    const result = await runWithToolHandler(
      page,
      "return await callTool('never', {});",
      'return new Promise(function () {});',
      { timeout: 500 },
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('EXECUTION_TIMEOUT');
    expect(result.error?.message).toBe('Execution timed out after 500ms');
    expect(result.error?.data).toEqual({ pendingHostCalls: 1 });
    expect(result.stats.duration).toBeGreaterThanOrEqual(1900);
    expect(result.stats.duration).toBeLessThan(5000);
  });

  test('toolCallGraceMs: 0 ends a run whose tool call is in progress at the hard stop', async ({ page }) => {
    const result = await runWithToolHandler(page, "return await callTool('slow', {});", slowTool(4000), {
      timeout: 500,
      toolCallGraceMs: 0,
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('EXECUTION_TIMEOUT');
    expect(result.stats.duration).toBeLessThan(3000);
  });

  test('toolCallGraceMs: Infinity waits for the handler however long it takes', async ({ page }) => {
    const result = await runWithToolHandler(page, "return await callTool('slow', {});", slowTool(3500), {
      timeout: 500,
      toolCallGraceMs: Infinity,
    });
    expect(result.error).toBeUndefined();
    expect(result.value).toBe('done');
  });

  test('a toolCallGraceMs that is not a duration is refused at construction', async ({ page }) => {
    for (const toolCallGraceMs of [-1, NaN, '100' as unknown as number]) {
      await expect(runInEnclave(page, 'return 1;', { toolCallGraceMs })).rejects.toThrow(
        /toolCallGraceMs must be a non-negative number/,
      );
    }
  });

  test('what an abandoned tool call returns does not reach the next run', async ({ page }) => {
    // One enclave, two runs, each with a hard stop after 2 s (the timeout and the second the
    // host adds) and no grace. The first run's tool call is abandoned there; its handler
    // resolves 1.2 s later, while the second run is waiting for a tool call of its own. (The
    // host drops what the handler returns; the sandbox would also ignore a response whose
    // request it does not know, so this pins the outcome, not which of the two prevented it.)
    const values = await page.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const EB = (window as any).EnclaveBrowser;
      const wait = (ms: number, value: string) =>
        new Promise<string>((resolve) => setTimeout(() => resolve(value), ms));
      const enclave = new EB.BrowserEnclave({
        timeout: 1000,
        toolCallGraceMs: 0,
        toolHandler: (name: string) => (name === 'late' ? wait(3200, 'from the first run') : wait(1600, 'second')),
      });
      try {
        const first = await enclave.run("return await callTool('late', {});");
        const second = await enclave.run("return await callTool('own', {});");
        return { first: first.error?.code, second: second.value, secondError: second.error?.message };
      } finally {
        enclave.dispose();
      }
    });
    expect(values).toEqual({ first: 'EXECUTION_TIMEOUT', second: 'second', secondError: undefined });
  });

  test('a system clock change between tool calls does not end the run', async ({ page }) => {
    // After the first call returns, the page's clock jumps an hour ahead. The timeout must keep
    // measuring elapsed time, not wall-clock time.
    const jumpClockAfterFirstCall = `
      if (name === 'first') {
        var realNow = Date.now;
        window.__restoreDateNow = function () { Date.now = realNow; };
        setTimeout(function () { Date.now = function () { return realNow() + 3600000; }; }, 0);
      }
      return 'done';
    `;
    try {
      const result = await runWithToolHandler(
        page,
        "await callTool('first', {}); return await callTool('second', {});",
        jumpClockAfterFirstCall,
        { timeout: 5000 },
      );
      expect(result.error).toBeUndefined();
      expect(result.value).toBe('done');
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await page.evaluate(() => (window as any).__restoreDateNow?.());
    }
  });

  test('the timeout still bounds the script after a tool call', async ({ page }) => {
    const result = await runWithToolHandler(
      page,
      `
        async function __ag_main() {
          await callTool('fast', {});
          await new Promise(function(r) { setTimeout(r, 10000); });
          return "late";
        }
      `,
      slowTool(300),
      { validate: false, transform: false, timeout: 1000 },
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('EXECUTION_TIMEOUT');
    expect(result.stats.duration).toBeLessThan(5000);
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
