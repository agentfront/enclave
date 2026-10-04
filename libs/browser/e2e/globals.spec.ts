import { test, expect, type Page } from '@playwright/test';
import { loadHarness, runInEnclave } from './helpers';

/**
 * Build the globals inside the page (functions, symbols and BigInts cannot be passed through
 * page.evaluate) and return the constructor's error message, or null when it did not throw.
 */
async function constructorError(page: Page, globalsSource: string): Promise<string | null> {
  return page.evaluate((source) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const EB = (window as any).EnclaveBrowser;
    const globals = new Function(`return (${source});`)();
    try {
      new EB.BrowserEnclave({ timeout: 5000, globals }).dispose();
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  }, globalsSource);
}

test.describe('custom globals', () => {
  test.beforeEach(async ({ page }) => {
    await loadHarness(page);
  });

  test('a function global throws at construction, naming the global and pointing to tools', async ({ page }) => {
    const message = await constructorError(page, `{ double: (n) => n * 2, label: 'ok' }`);
    expect(message).toContain('Custom global "double" is a function');
    expect(message).toContain('toolNamespaces');
  });

  test('a nested function throws at construction', async ({ page }) => {
    const message = await constructorError(page, `{ utils: { double: (n) => n * 2 } }`);
    expect(message).toContain('Custom global "utils" contains a function at "double"');
  });

  test('a function inside an array throws at construction', async ({ page }) => {
    const message = await constructorError(page, `{ hooks: [1, () => 2] }`);
    expect(message).toContain('Custom global "hooks" contains a function at "1"');
  });

  test('a function throws even with allowFunctionsInGlobals', async ({ page }) => {
    const message = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const EB = (window as any).EnclaveBrowser;
      try {
        new EB.BrowserEnclave({ allowFunctionsInGlobals: true, globals: { double: (n: number) => n * 2 } });
        return null;
      } catch (error) {
        return (error as Error).message;
      }
    });
    expect(message).toContain('Custom global "double" is a function');
  });

  test('a symbol global throws at construction', async ({ page }) => {
    const message = await constructorError(page, `{ tag: { kind: Symbol('x') } }`);
    expect(message).toContain('Custom global "tag" contains a symbol at "kind"');
  });

  test('BigInt and circular globals throw at construction', async ({ page }) => {
    expect(await constructorError(page, `{ big: 10n }`)).toContain('Custom global "big" is a BigInt');

    const circular = await constructorError(page, `(() => { const a = { name: 'a' }; a.self = a; return { a }; })()`);
    expect(circular).toContain('Custom global "a" contains a circular reference at "self"');
  });

  test('a function hidden behind toJSON() throws at construction', async ({ page }) => {
    const message = await constructorError(page, `{ cfg: { fn: () => 1, toJSON() { return { label: 'ok' }; } } }`);
    expect(message).toContain('Custom global "cfg" contains a function at "fn"');
  });

  test('a deeply nested function is reported with its path', async ({ page }) => {
    const message = await constructorError(page, `{ cfg: { hooks: [{ run: () => 1 }] } }`);
    expect(message).toContain('Custom global "cfg" contains a function at "hooks.0.run"');
  });

  test('an undefined global throws at construction', async ({ page }) => {
    const message = await constructorError(page, `{ label: undefined }`);
    expect(message).toContain('Custom global "label" is undefined');
  });

  test('a value JSON would turn into {} throws at construction', async ({ page }) => {
    expect(await constructorError(page, `{ lookup: new Map([['a', 1]]) }`)).toContain(
      'Custom global "lookup" is a Map',
    );
    expect(await constructorError(page, `{ cfg: { pattern: /a+/ } }`)).toContain(
      'Custom global "cfg" contains a RegExp at "pattern"',
    );
  });

  test('a Date global reaches the script as an ISO string', async ({ page }) => {
    const result = await page.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const EB = (window as any).EnclaveBrowser;
      const enclave = new EB.BrowserEnclave({ timeout: 5000, globals: { since: new Date(0) } });
      const run = await enclave.run('return since;');
      enclave.dispose();
      return run;
    });
    expect(result.error).toBeUndefined();
    expect(result.value).toBe('1970-01-01T00:00:00.000Z');
  });

  test('JSON data globals still reach the script', async ({ page }) => {
    const result = await runInEnclave(page, 'return [label, config.retries, features[1]];', {
      globals: { label: 'ok', config: { retries: 3 }, features: ['search', 'export'] },
    });
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual(['ok', 3, 'export']);
  });

  test('changes the host makes to a global between runs reach the next run', async ({ page }) => {
    const values = await page.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const EB = (window as any).EnclaveBrowser;
      const context = { userId: 'user-1' };
      const enclave = new EB.BrowserEnclave({ timeout: 5000, globals: { context } });
      const first = await enclave.run('return context.userId;');
      context.userId = 'user-2';
      const second = await enclave.run('return context.userId;');
      enclave.dispose();
      return [first.value, second.value];
    });
    expect(values).toEqual(['user-1', 'user-2']);
  });
});
