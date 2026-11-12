/**
 * Which pre-scanner configuration an enclave runs a script through.
 *
 * The pre-scanner (layer 0) looks at the text of a script before anything parses it. It runs
 * with the preset named like the AST preset (`agentscript` by default; `babel` runs with
 * `standard`), on the script as the caller wrote it, and the `preScan` option picks another
 * preset or changes single limits.
 */

import { Enclave } from '../enclave';
import type { CreateEnclaveOptions } from '../types';

async function run(code: string, options: CreateEnclaveOptions = {}) {
  const enclave = new Enclave({ toolHandler: async () => null, ...options });
  try {
    return await enclave.run(code);
  } finally {
    enclave.dispose();
  }
}

/** A script of at least `size` characters in lines of `width`: comments, then `return 1;` */
function scriptOfSize(size: number, width = 1900): string {
  const line = `// ${'x'.repeat(width - 3)}`;
  const lines: string[] = [];
  for (let length = 0; length < size; length += width + 1) lines.push(line);
  return `${lines.join('\n')}\nreturn 1;`;
}

const KB = 1024;

describe('the pre-scanner an enclave uses', () => {
  describe('follows the AST preset', () => {
    it('agentscript (the default): a script of more than 100 KB is refused', async () => {
      const result = await run(scriptOfSize(110 * KB));

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('VALIDATION_ERROR');
      expect(result.error?.message).toMatch(/PRESCANNER_INPUT_TOO_LARGE|too large/i);
    });

    it('agentscript: a script below 100 KB runs', async () => {
      const result = await run(scriptOfSize(60 * KB));

      expect(result.error).toBeUndefined();
      expect(result.value).toBe(1);
    });

    it('agentscript: a line of more than 2,000 characters is refused', async () => {
      const result = await run(`// ${'x'.repeat(3000)}\nreturn 1;`);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(result.error?.data)).toContain('PRESCANNER_LINE_TOO_LONG');
    });

    it('agentscript: a bidirectional control character in the text is refused', async () => {
      // U+202E, written as an escape here so this file holds no such character
      const result = await run(`const label = 'a${String.fromCharCode(0x202e)}b';\nreturn 1;`);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(result.error?.data)).toContain('PRESCANNER_BIDI_ATTACK');
    });

    it('standard: the limits are those of the standard pre-scanner preset', async () => {
      const result = await run(scriptOfSize(110 * KB, 5000).replace(/return 1;$/, '1;'), {
        preset: 'standard',
        transform: false,
      });

      // Larger than the agentscript preset takes, and with longer lines: not refused for its size
      expect(JSON.stringify(result.error ?? {})).not.toMatch(/PRESCANNER_|too large/i);
    });
  });

  describe('looks at the script as it was written', () => {
    it('a script within the limit is not refused for the size of its transformed form', async () => {
      // Just below 100 KB of script, with 400 loops that each gain a counter in the transform
      const loops = Array.from({ length: 400 }, (_unused, i) => `for (const v${i} of [1]) { total += v${i}; }`);
      const body = `let total = 0;\n${loops.join('\n')}\nreturn total;`;
      const comment = `// ${'x'.repeat(1500)}\n`;
      const script = comment.repeat(Math.floor((99 * KB - body.length) / comment.length)) + body;
      expect(script.length).toBeGreaterThan(96 * KB);
      expect(script.length).toBeLessThan(100 * KB);

      const result = await run(script, { maxIterations: 100000 });

      expect(result.error).toBeUndefined();
      expect(result.value).toBe(400);
    });
  });

  describe('the preScan option', () => {
    it('picks another preset', async () => {
      const result = await run(scriptOfSize(110 * KB), { preScan: { preset: 'standard' } });

      expect(result.error).toBeUndefined();
      expect(result.value).toBe(1);
    });

    it('changes a single limit of the preset', async () => {
      const raised = await run(scriptOfSize(110 * KB), { preScan: { config: { maxInputSize: 200 * KB } } });
      expect(raised.error).toBeUndefined();

      const lowered = await run(scriptOfSize(20 * KB), { preScan: { config: { maxInputSize: 10 * KB } } });
      expect(lowered.success).toBe(false);
      expect(lowered.error?.code).toBe('VALIDATION_ERROR');
    });

    it.each([
      ['a preset that does not exist', { preset: 'loose' }],
      ['a preset that is not a text', { preset: 5 }],
      ['a configuration that is not an object', { config: 'standard' }],
      ['a limit that is not finite', { config: { maxInputSize: Infinity } }],
      ['a limit that is not a number', { config: { maxLines: '10' } }],
      ['a negative limit', { config: { maxNestingDepth: -1 } }],
      ['a switch that is not a boolean', { config: { blockBidiPatterns: 'yes' } }],
      ['a regex mode that does not exist', { config: { regexMode: 'ignore' } }],
      ['a limit the pre-scanner does not have', { config: { maxEverything: 1 } }],
      ['a member the option does not have', { enabled: false }],
    ])('refuses %s at construction', (_what, preScan) => {
      expect(() => new Enclave({ preScan } as unknown as CreateEnclaveOptions)).toThrow(TypeError);
      expect(() => new Enclave({ preScan } as unknown as CreateEnclaveOptions)).toThrow(/preScan/);
    });

    it('is not consulted with validate: false, where the maximum script size still holds', async () => {
      const result = await run(scriptOfSize(110 * KB), { validate: false });
      expect(result.error).toBeUndefined();
      expect(result.value).toBe(1);

      const tooLarge = await run(scriptOfSize(6 * 1024 * KB, 9000), { validate: false });
      expect(tooLarge.success).toBe(false);
      expect(tooLarge.error?.message).toMatch(/too large/i);
    });
  });
});
