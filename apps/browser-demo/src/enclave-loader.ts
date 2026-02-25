/**
 * Lazy loader for the pre-built @enclave-vm/browser bundle.
 * The bundle is built by esbuild into vendor/enclave-browser-bundle.mjs
 * and imported as a normal module by Vite.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cached: Promise<any> | null = null;

export async function loadEnclaveModule() {
  if (!cached) {
    cached = import('../vendor/enclave-browser-bundle.mjs');
  }
  return cached;
}
