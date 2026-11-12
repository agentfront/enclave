/**
 * The text of a script, and of the two documents it is placed in.
 *
 * A script is embedded in the inner iframe's document as written. Whatever its strings hold
 * (markup, line endings of another platform, characters outside ASCII) must reach it as data,
 * and must not change how the browser reads the document around it.
 */

import { test, expect } from '@playwright/test';
import { loadHarness, runInEnclave } from './helpers';

test.describe('script text', () => {
  test.beforeEach(async ({ page }) => {
    await loadHarness(page);
  });

  test('markup inside a string is data', async ({ page }) => {
    const cases: Array<[string, unknown]> = [
      ["return '<!--<script>'.length;", 12],
      ["return '<!--';", '<!--'],
      ["return '<!-- <script> -->';", '<!-- <script> -->'],
      ["return '<SCRIPT>' + '</SCRIPT>';", '<SCRIPT></SCRIPT>'],
      ["return ['<!--', '<script', '</script>', '-->'].join('|');", '<!--|<script|</script>|-->'],
      ['return `<!--<script>${1 + 1}</script>-->`;', '<!--<script>2</script>-->'],
      ["const tags = { open: '<!--<script>' }; return tags;", { open: '<!--<script>' }],
    ];
    for (const [code, expected] of cases) {
      const result = await runInEnclave(page, code, { timeout: 4000 });

      expect(result.error, code).toBeUndefined();
      expect(result.value, code).toEqual(expected);
    }
  });

  test('markup in a custom global and in a tool result is data', async ({ page }) => {
    const result = await page.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const EB = (window as any).EnclaveBrowser;
      const enclave = new EB.BrowserEnclave({
        timeout: 4000,
        globals: { snippet: '<!--<script></script>-->' },
        toolHandler: async () => '<!--<script>',
      });
      try {
        return await enclave.run("return [snippet, await callTool('page:get', {})];");
      } finally {
        enclave.dispose();
      }
    });

    expect(result.error).toBeUndefined();
    expect(result.value).toEqual(['<!--<script></script>-->', '<!--<script>']);
  });

  test('line endings of any platform do not keep a script from running', async ({ page }) => {
    const cases: Array<[string, unknown]> = [
      ['const a = 1;\r\nconst b = 2;\r\nreturn a + b;', 3],
      ['const a = 1;\rconst b = 2;\rreturn a + b;', 3],
      ['const text = `one\r\ntwo`;\r\nreturn text;', 'one\ntwo'],
    ];
    for (const [code, expected] of cases) {
      for (const transform of [true, false]) {
        const source = transform ? code : `async function __ag_main() {\r\n${code}\r\n}`;
        const result = await runInEnclave(page, source, { timeout: 4000, transform, validate: transform });

        expect(result.error, JSON.stringify(code)).toBeUndefined();
        expect(result.value, JSON.stringify(code)).toEqual(expected);
      }
    }
  });

  test('text outside ASCII reaches the script and comes back unchanged', async ({ page }) => {
    // The line separator is written as a number so that this file holds none
    const text = 'héllo ✓ 日本語 😀 ' + String.fromCharCode(0x2028) + ' end';
    const result = await runInEnclave(page, `const s = ${JSON.stringify(text)}; return [s, s.length];`, {
      timeout: 4000,
      globals: { label: text },
    });

    expect(result.error).toBeUndefined();
    expect(result.value).toEqual([text, text.length]);
  });

  test('a character the document cannot hold does not keep a script from running', async ({ page }) => {
    // Built in the page: a NUL character and half of a surrogate pair do not survive the trip there.
    const result = await page.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const EB = (window as any).EnclaveBrowser;
      const enclave = new EB.BrowserEnclave({ timeout: 4000, validate: false, transform: false });
      const nul = String.fromCharCode(0);
      const half = String.fromCharCode(0xd83d);
      try {
        const withNul = await enclave.run(`async function __ag_main() { return 'a${nul}b'.length; }`);
        const withHalf = await enclave.run(`async function __ag_main() { return 'a${half}b'.length; }`);
        return { withNul: withNul.value, nulError: withNul.error, withHalf: withHalf.value, halfError: withHalf.error };
      } finally {
        enclave.dispose();
      }
    });

    expect(result.nulError).toBeUndefined();
    expect(result.halfError).toBeUndefined();
    expect(result.withNul).toBe(3);
    expect(result.withHalf).toBe(3);
  });

  test('each frame document allows only the script this package wrote for it', async ({ page }) => {
    const policies = await page.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const EB = (window as any).EnclaveBrowser;
      let reachedHold: () => void = () => undefined;
      const holding = new Promise<void>((resolve) => (reachedHold = resolve));
      let release: (value: unknown) => void = () => undefined;
      const enclave = new EB.BrowserEnclave({
        timeout: 4000,
        toolHandler: () => {
          reachedHold();
          return new Promise((resolve) => (release = resolve));
        },
      });
      try {
        const running = enclave.run("return await callTool('hold', {});");
        await holding;
        const frames = document.querySelectorAll('iframe');
        const outerHtml = frames[frames.length - 1].srcdoc;
        const outer = new DOMParser().parseFromString(outerHtml, 'text/html');
        const outerPolicy = outer.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content');
        // The inner document is a string inside the outer document's script
        const innerPolicy = /content=\\"([^"\\]*)\\"/.exec(outer.querySelector('script')?.textContent ?? '')?.[1];
        release('done');
        const result = await running;
        return { outerPolicy, innerPolicy, value: result.value };
      } finally {
        enclave.dispose();
      }
    });

    const scriptSources = (policy: string | null | undefined) =>
      (policy ?? '')
        .split(';')
        .map((directive) => directive.trim().split(/\s+/))
        .find((tokens) => tokens[0] === 'script-src')
        ?.slice(1) ?? [];
    const HASH = /^'sha256-[A-Za-z0-9+/]{43}='$/;

    expect(policies.value).toBe('done');
    expect(policies.outerPolicy).toContain("default-src 'none'");
    expect(policies.innerPolicy).toContain("default-src 'none'");
    // The outer document: its own script, and the one of the document it creates
    expect(scriptSources(policies.outerPolicy)).toHaveLength(2);
    expect(scriptSources(policies.innerPolicy)).toHaveLength(1);
    for (const source of [...scriptSources(policies.outerPolicy), ...scriptSources(policies.innerPolicy)]) {
      expect(source).toMatch(HASH);
    }
    expect(scriptSources(policies.outerPolicy)).toContain(scriptSources(policies.innerPolicy)[0]);
  });
});
