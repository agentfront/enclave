/**
 * Minimal Buffer shim for the browser test bundle.
 * Only provides Buffer.byteLength which is used by @enclave-vm/ast's size-check.
 */
const _encoder = new TextEncoder();

if (typeof globalThis.Buffer === 'undefined') {
  globalThis.Buffer = {
    byteLength(str) {
      return _encoder.encode(String(str)).byteLength;
    },
  };
}
