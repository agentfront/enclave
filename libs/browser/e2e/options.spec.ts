/**
 * Numeric options of the enclave.
 *
 * Every limit is a number. A value that is not one (text read from a form or a query string,
 * NaN from a failed conversion, a negative number) is refused when the enclave is created,
 * instead of producing a sandbox whose limit means something else.
 */

import { test, expect, type Page } from '@playwright/test';
import { loadHarness } from './helpers';

/** Name and message of the error the constructor throws for these options, or null. */
async function constructorError(page: Page, source: string): Promise<string | null> {
  return page.evaluate((optionsSource) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const EB = (window as any).EnclaveBrowser;
    // Built in the page: NaN and Infinity do not survive being passed to it
    const options = new Function(`return (${optionsSource});`)();
    try {
      new EB.BrowserEnclave(options).dispose();
      return null;
    } catch (e) {
      return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    }
  }, source);
}

const LIMITS = [
  'timeout',
  'maxIterations',
  'maxToolCalls',
  'memoryLimit',
  'maxConsoleCalls',
  'maxConsoleOutputBytes',
  'maxSanitizeDepth',
  'maxSanitizeProperties',
];

test.describe('numeric options', () => {
  test.beforeEach(async ({ page }) => {
    await loadHarness(page);
  });

  test('a limit that is not a finite, non-negative number is refused at construction', async ({ page }) => {
    for (const option of LIMITS) {
      for (const value of [`'100'`, 'NaN', 'Infinity', '-1', 'true', '{}', '[5]']) {
        const message = await constructorError(page, `{ ${option}: ${value} }`);

        expect(message, `${option}: ${value}`).toMatch(new RegExp(`^TypeError: ${option} must be a finite number`));
      }
    }
  });

  test('zero, a fraction and a large number are numbers', async ({ page }) => {
    expect(
      await constructorError(
        page,
        `{ timeout: 1500.5, maxIterations: 0, maxToolCalls: 0, memoryLimit: 0, maxConsoleCalls: 0,
           maxConsoleOutputBytes: Number.MAX_SAFE_INTEGER, maxSanitizeDepth: 0, maxSanitizeProperties: 1e6 }`,
      ),
    ).toBeNull();
  });

  test('an option that is left out or undefined takes the default of the security level', async ({ page }) => {
    expect(await constructorError(page, `{ timeout: undefined, maxToolCalls: undefined }`)).toBeNull();
  });

  test('a timeout longer than a timer can wait is refused', async ({ page }) => {
    expect(await constructorError(page, `{ timeout: 2147483648 }`)).toMatch(/^TypeError: timeout must be/);
    expect(await constructorError(page, `{ timeout: 2147483647 }`)).toBeNull();
  });

  test('doubleIframe.parentTimeoutBuffer must be a finite, non-negative number', async ({ page }) => {
    for (const value of [`'2000'`, 'NaN', 'Infinity', '-1']) {
      const message = await constructorError(page, `{ doubleIframe: { parentTimeoutBuffer: ${value} } }`);

      expect(message, value).toMatch(/^TypeError: doubleIframe\.parentTimeoutBuffer must be a finite number/);
    }
    expect(await constructorError(page, `{ doubleIframe: { parentTimeoutBuffer: 0 } }`)).toBeNull();
  });
});
