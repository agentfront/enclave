import type { Page } from '@playwright/test';

/**
 * Navigate to the test harness and wait for the bundle to be ready.
 */
export async function loadHarness(page: Page) {
  await page.goto('/test-harness');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await page.waitForFunction(() => (window as any).__enclaveReady === true, null, {
    timeout: 10_000,
  });
}

/** Options forwarded to BrowserEnclave constructor inside evaluate(). */
export interface RunOptions {
  securityLevel?: string;
  timeout?: number;
  maxIterations?: number;
  maxToolCalls?: number;
  maxConsoleCalls?: number;
  globals?: Record<string, unknown>;
  validate?: boolean;
  transform?: boolean;
}

/**
 * Create a BrowserEnclave inside the page, run code, dispose, return result.
 */
export async function runInEnclave(page: Page, code: string, opts: RunOptions = {}) {
  return page.evaluate(
    ({ code, opts }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const EB = (window as any).EnclaveBrowser;
      const enclave = new EB.BrowserEnclave(opts);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return enclave.run(code).then((result: any) => {
        enclave.dispose();
        return result;
      });
    },
    { code, opts },
  );
}

/**
 * Run code that needs a tool handler.
 *
 * page.evaluate() cannot transfer functions across the serialization boundary.
 * Instead the caller passes the handler body as a string which is reconstructed
 * inside the page via `new Function()`.  The host page is NOT subject to the
 * iframe CSP so `new Function()` works fine there.
 */
export async function runWithToolHandler(page: Page, code: string, handlerBody: string, opts: RunOptions = {}) {
  return page.evaluate(
    ({ code, handlerBody, opts }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const EB = (window as any).EnclaveBrowser;
      // Reconstruct the handler inside the page
      const handler = new Function('name', 'args', handlerBody) as (
        name: string,
        args: Record<string, unknown>,
      ) => Promise<unknown>;
      const asyncHandler = (name: string, args: Record<string, unknown>) => Promise.resolve(handler(name, args));
      const enclave = new EB.BrowserEnclave({ ...opts, toolHandler: asyncHandler });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return enclave.run(code).then((result: any) => {
        enclave.dispose();
        return result;
      });
    },
    { code, handlerBody, opts },
  );
}
