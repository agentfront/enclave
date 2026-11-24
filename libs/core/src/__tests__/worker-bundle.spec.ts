import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

import type { AgentScriptRunner as Runner } from '../portable-enclave';

describe('the worker entry bundled and minified without --keep-names', () => {
  let directory: string;
  let AgentScriptRunner: typeof Runner;

  beforeAll(async () => {
    const bundled = await build({
      entryPoints: [join(__dirname, '..', 'worker.ts')],
      bundle: true,
      minify: true,
      keepNames: false,
      platform: 'node',
      format: 'cjs',
      write: false,
      logLevel: 'silent',
    });
    directory = mkdtempSync(join(tmpdir(), 'enclave-worker-bundle-'));
    const file = join(directory, 'worker.cjs');
    writeFileSync(file, bundled.outputFiles[0].text);
    ({ AgentScriptRunner } = require(file));
  });

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('runs a Set and a Map through the portable runner', async () => {
    const runner = new AgentScriptRunner({ hostFunctions: {}, maxHostFunctionCalls: 1 });
    try {
      const set = await runner.run('return new Set([1]).add(2).size;');
      const map = await runner.run(
        "const byId = new Map(); byId.set('a', { total: 1 }).set('b', { total: 2 }); return [byId.get('b').total, byId.size, [...byId.keys()], byId.has('a')];",
      );

      expect(set.error).toBeUndefined();
      expect(set.value).toBe(2);
      expect(map.error).toBeUndefined();
      expect(map.value).toEqual([2, 2, ['a', 'b'], true]);
    } finally {
      runner.dispose();
    }
  });
});
