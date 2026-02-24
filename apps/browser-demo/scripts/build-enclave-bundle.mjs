/**
 * Build a self-contained ESM bundle of @enclave-vm/browser for the demo app.
 *
 * Inlines all dependencies (ast, acorn, astring, zod) into a single ESM file.
 * Output goes to vendor/ so Vite can import it as a normal module.
 */

import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../..');

await build({
  entryPoints: [path.resolve(root, 'libs/browser/src/index.ts')],
  bundle: true,
  format: 'esm',
  outfile: path.resolve(__dirname, '../vendor/enclave-browser-bundle.mjs'),
  platform: 'browser',
  target: 'es2022',
  external: [],
  alias: {
    '@enclave-vm/ast': path.resolve(root, 'libs/ast/src/index.ts'),
  },
  inject: [path.resolve(__dirname, 'buffer-shim.mjs')],
  sourcemap: false,
  minify: false,
  logLevel: 'info',
});
