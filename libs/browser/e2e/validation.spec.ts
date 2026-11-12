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

  test('validates without a Node.js Buffer global', async ({ page }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await page.evaluate(() => typeof (globalThis as any).Buffer)).toBe('undefined');

    const result = await runInEnclave(page, 'return "日本 😀";');
    expect(result.error).toBeUndefined();
    expect(result.value).toBe('日本 😀');
  });

  test('skips validation when disabled', async ({ page }) => {
    const result = await runInEnclave(page, 'return 42', {
      validate: false,
    });
    expect(result.success).toBe(true);
    expect(result.value).toBe(42);
  });
});

// AgentScript has no regular expressions. The validator refuses the ways to write one, and the
// realm of a validated script cannot run one: both halves are documented behaviour.
test.describe('regular expressions', () => {
  test.beforeEach(async ({ page }) => {
    await loadHarness(page);
  });

  test('the string methods that take a plain string keep working', async ({ page }) => {
    const result = await runInEnclave(
      page,
      "const text = 'a,b,c'; return [text.split(','), text.replace('a', 'x'), text.replaceAll(',', ';'), text.includes('b'), text.indexOf('c')];",
    );

    expect(result.error).toBeUndefined();
    expect(result.value).toEqual([['a', 'b', 'c'], 'x,b,c', 'a;b;c', true, 4]);
  });

  test('a call that would compile a pattern at run time fails with a TypeError', async ({ page }) => {
    // The validator lets a method called search through when its argument is an object of data,
    // because that is how a tool is called. On a string, the engine would turn the argument into
    // a pattern.
    const result = await runInEnclave(page, "const text = 'aaaa'; return text.search({ query: 1 });");

    expect(result.success).toBe(false);
    expect(result.error?.name).toBe('TypeError');
    expect(result.error?.message).toBe('Regular expressions are not available in this sandbox');
  });

  test('a script that is not validated as AgentScript can use them', async ({ page }) => {
    const code = "return [/a+/.test('caaat'), 'a1b22'.replace(/[0-9]+/g, '#')];";

    const unvalidated = await runInEnclave(page, code, { validate: false });
    expect(unvalidated.error).toBeUndefined();
    expect(unvalidated.value).toEqual([true, 'a#b#']);

    const otherPreset = await runInEnclave(page, code, { preset: 'permissive', securityLevel: 'PERMISSIVE' });
    expect(otherPreset.error).toBeUndefined();
    expect(otherPreset.value).toEqual([true, 'a#b#']);
  });
});

test.describe('the pre-scanner follows the AST preset', () => {
  test.beforeEach(async ({ page }) => {
    await loadHarness(page);
  });

  // A script of about 110 KB: comment lines of 1,900 characters, then a return
  const large = `${`// ${'x'.repeat(1897)}\n`.repeat(60)}return 1;`;

  test('agentscript (the default) refuses a script of more than 100 KB', async ({ page }) => {
    const result = await runInEnclave(page, large);
    expect(result.success).toBe(false);
    expect(result.error?.name).toBe('ValidationError');
    expect(result.error?.message).toContain('PRESCANNER_INPUT_TOO_LARGE');
  });

  test('agentscript refuses a line of more than 2,000 characters', async ({ page }) => {
    const result = await runInEnclave(page, `// ${'x'.repeat(3000)}\nreturn 1;`);
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('PRESCANNER_LINE_TOO_LONG');
  });

  test('preScan picks another preset', async ({ page }) => {
    const result = await runInEnclave(page, large, { preScan: { preset: 'standard' } });
    expect(result.error).toBeUndefined();
    expect(result.value).toBe(1);
  });

  test('preScan changes a single limit', async ({ page }) => {
    const result = await runInEnclave(page, large, { preScan: { config: { maxInputSize: 200 * 1024 } } });
    expect(result.error).toBeUndefined();
    expect(result.value).toBe(1);
  });

  test('a preset that does not exist is refused when the enclave is made', async ({ page }) => {
    await expect(runInEnclave(page, 'return 1;', { preScan: { preset: 'loose' } })).rejects.toThrow(
      /pre-scanner preset/i,
    );
  });
});
