/**
 * Runtime Computed-Key Guard — Regression Tests (weakness 1)
 *
 * Static analysis cannot resolve a dangerous property name laundered through a variable
 * (`const c = String.fromCharCode(...); obj[c]`). The runtime guard rewrites dynamic computed
 * member access so the RESOLVED key is checked at runtime, throwing on prototype-chain
 * properties regardless of how the key was built. These tests lock in that behaviour and prove
 * ordinary computed access (array/object indexing) is unaffected.
 */

import { Enclave } from '../enclave';

describe('runtime computed-key guard', () => {
  it('blocks constructor access via a String.fromCharCode-built key on a local object', async () => {
    const enclave = new Enclave({ securityLevel: 'STANDARD', toolHandler: async () => ({ ok: true }) });
    const code = `
      async function __ag_main() {
        const c = String.fromCharCode(99,111,110,115,116,114,117,99,116,111,114);
        const o = {};
        const F = o[c];
        return typeof F;
      }
    `;
    const result = await enclave.run(code);
    // The guard throws on the resolved 'constructor' key; the run fails closed.
    expect(result.success).toBe(false);
    enclave.dispose();
  });

  it('blocks __proto__ access via a dynamically-built key', async () => {
    const enclave = new Enclave({ securityLevel: 'STANDARD', toolHandler: async () => ({ ok: true }) });
    const code = `
      async function __ag_main() {
        const parts = ['__pro', 'to__'];
        const k = parts.join('');
        const o = { a: 1 };
        return o[k];
      }
    `;
    const result = await enclave.run(code);
    expect(result.success).toBe(false);
    enclave.dispose();
  });

  it('allows ordinary numeric array indexing (no false positive)', async () => {
    const enclave = new Enclave({ securityLevel: 'STANDARD', toolHandler: async () => ({ ok: true }) });
    const code = `
      async function __ag_main() {
        const arr = [10, 20, 30];
        let sum = 0;
        for (let i = 0; i < arr.length; i++) { sum += arr[i]; }
        return sum;
      }
    `;
    const result = await enclave.run(code);
    expect(result.success).toBe(true);
    expect(result.value).toBe(60);
    enclave.dispose();
  });

  it('allows ordinary dynamic string-key object access (no false positive)', async () => {
    const enclave = new Enclave({ securityLevel: 'STANDARD', toolHandler: async () => ({ ok: true }) });
    const code = `
      async function __ag_main() {
        const obj = { alpha: 1, beta: 2 };
        const keys = ['alpha', 'beta'];
        let total = 0;
        for (const key of keys) { total += obj[key]; }
        return total;
      }
    `;
    const result = await enclave.run(code);
    expect(result.success).toBe(true);
    expect(result.value).toBe(3);
    enclave.dispose();
  });

  it('cannot be bypassed by a crafted toString (TOCTOU): guard uses the coerced key', async () => {
    const enclave = new Enclave({ securityLevel: 'STANDARD', toolHandler: async () => ({ ok: true }) });
    const code = `
      async function __ag_main() {
        let flip = 0;
        const evil = { toString: () => (flip++ === 0 ? 'safe' : 'constructor') };
        const o = {};
        return typeof o[evil];
      }
    `;
    const result = await enclave.run(code);
    // Either the guard resolves 'safe'/'constructor' consistently and the read is harmless, or it
    // throws — but it must NEVER return the Function constructor.
    if (result.success) {
      expect(result.value).not.toBe('function');
    } else {
      expect(result.error).toBeDefined();
    }
    enclave.dispose();
  });
});
