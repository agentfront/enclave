/**
 * Minimal Buffer shim for the browser test bundle.
 * Only provides Buffer.byteLength which is used by @enclave-vm/ast's size-check.
 */
const encoder = new TextEncoder();

if (typeof globalThis.Buffer === 'undefined') {
  globalThis.Buffer = {
    byteLength(str) {
      return encoder.encode(String(str)).byteLength;
    },
  };
}
