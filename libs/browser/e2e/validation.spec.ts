import { test, expect } from '@playwright/test';
import { loadHarness, runInEnclave } from './helpers';

test.describe('AST validation', () => {
  test.beforeEach(async ({ page }) => {
    await loadHarness(page);
  });

  test('blocks eval()', async ({ page }) => {
    const result = await runInEnclave(page, 'eval("1 + 1")', {
      securityLevel: 'STRICT',
    });
    expect(result.success).toBe(false);
    expect(result.error?.name).toBe('ValidationError');
  });

  test('blocks new Function()', async ({ page }) => {
    const result = await runInEnclave(page, 'new Function("return 1")', {
      securityLevel: 'STRICT',
    });
    expect(result.success).toBe(false);
    expect(result.error?.name).toBe('ValidationError');
  });

  test('blocks Function() without new', async ({ page }) => {
    const result = await runInEnclave(page, 'Function("return 1")', {
      securityLevel: 'STRICT',
    });
    expect(result.success).toBe(false);
    expect(result.error?.name).toBe('ValidationError');
  });

  test('blocks __proto__ access', async ({ page }) => {
    const result = await runInEnclave(page, 'const p = ({}).__proto__', {
      securityLevel: 'STRICT',
    });
    expect(result.success).toBe(false);
    expect(result.error?.name).toBe('ValidationError');
  });

  test('blocks constructor chain', async ({ page }) => {
    const result = await runInEnclave(page, 'const c = [].constructor.constructor; c("return 1")()', {
      securityLevel: 'STRICT',
    });
    expect(result.success).toBe(false);
    expect(result.error?.name).toBe('ValidationError');
  });

  test('blocks globalThis', async ({ page }) => {
    const result = await runInEnclave(page, 'const g = globalThis', {
      securityLevel: 'STRICT',
    });
    expect(result.success).toBe(false);
    expect(result.error?.name).toBe('ValidationError');
  });

  test('blocks __defineGetter__', async ({ page }) => {
    const result = await runInEnclave(page, '({}).__defineGetter__("x", function() { return 1; })', {
      securityLevel: 'STRICT',
    });
    expect(result.success).toBe(false);
    expect(result.error?.name).toBe('ValidationError');
  });

  test('blocks setTimeout with string argument', async ({ page }) => {
    const result = await runInEnclave(page, 'setTimeout("alert(1)", 100)', {
      securityLevel: 'STRICT',
    });
    expect(result.success).toBe(false);
    expect(result.error?.name).toBe('ValidationError');
  });

  test('blocks prototype property access', async ({ page }) => {
    const result = await runInEnclave(page, 'const p = String.prototype', {
      securityLevel: 'STRICT',
    });
    expect(result.success).toBe(false);
    expect(result.error?.name).toBe('ValidationError');
  });

  test('blocks constructor access', async ({ page }) => {
    const result = await runInEnclave(page, 'const c = ({}).constructor', {
      securityLevel: 'STRICT',
    });
    expect(result.success).toBe(false);
    expect(result.error?.name).toBe('ValidationError');
  });

  test('allows valid code to pass validation', async ({ page }) => {
    const result = await runInEnclave(page, 'return 1 + 2', {
      securityLevel: 'STANDARD',
    });
    expect(result.success).toBe(true);
    expect(result.value).toBe(3);
  });

  test('skips validation when disabled', async ({ page }) => {
    const result = await runInEnclave(page, 'return 42', {
      validate: false,
    });
    expect(result.success).toBe(true);
    expect(result.value).toBe(42);
  });
});
