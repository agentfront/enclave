/**
 * Build a self-contained ESM bundle for Playwright e2e tests.
 *
 * The production build externalises @enclave-vm/ast, acorn, astring, zod.
 * This script inlines everything so the test-harness.html can load a single
 * file with no import-map or network requests.
 */

import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../..');

await build({
  entryPoints: [path.resolve(__dirname, '../src/index.ts')],
  bundle: true,
  format: 'esm',
  outfile: path.resolve(__dirname, 'fixtures/enclave-browser-bundle.mjs'),
  platform: 'browser',
  target: 'es2022',
  // Inline ALL dependencies (no externals)
  external: [],
  // Resolve workspace paths
  alias: {
    '@enclave-vm/ast': path.resolve(root, 'libs/ast/src/index.ts'),
  },
  // Inject a minimal Buffer shim (ast package uses Buffer.byteLength)
  inject: [path.resolve(__dirname, 'buffer-shim.mjs')],
  sourcemap: false,
  minify: false,
  logLevel: 'info',
});
