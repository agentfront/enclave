/**
 * Bind-Chain Depth-Inflation Sandbox Escape — Regression Tests
 *
 * Reported PoC: the secure membrane wraps values obtained via property access and increments a
 * recursion `depth` on every wrap. Reading `.bind` repeatedly returns a FRESH bound function each
 * time (defeating the identity cache), so a linear chain of `.bind` reads inflates `depth` past
 * the cap. At the cap the membrane FAILED OPEN — it returned the raw, unwrapped host-realm
 * function. From that raw reference `f['constructor']` reaches the host `Function` constructor
 * (which has code generation enabled) for RCE.
 *
 * The earlier GHSA-grmc-r8vw-226r fix reset depth only on CALLS (apply trap), so it stopped
 * `.then()` chains but not `.bind()` property-access chains.
 *
 * These tests lock in the fail-closed behaviour: exceeding the cap must throw, never leak a raw
 * reference, so `.constructor` is unreachable regardless of chain length.
 */

import { Enclave } from '../enclave';

function assertNoRce(result: { success: boolean; value?: unknown; error?: { message: string } }): void {
  if (!result.success) {
    expect(result.error).toBeDefined();
    return;
  }
  const serialized = JSON.stringify(result.value ?? null);
  expect(serialized).not.toMatch(/pwned/i);
  expect(serialized).not.toMatch(/uid=\d+/);
  expect(serialized).not.toMatch(/child_process/);
  expect(serialized).not.toMatch(/AWS_|SECRET|VERCEL_|process\.env/i);
}

describe('bind-chain depth-inflation escape', () => {
  it('blocks the reported PoC (callTool().then.bind x10 → host Function → process.env)', async () => {
    const enclave = new Enclave({ securityLevel: 'STANDARD', toolHandler: async () => ({ ok: true }) });
    const code = `
      async function __ag_main() {
        const c = String.fromCharCode(99,111,110,115,116,114,117,99,116,111,114);
        let f = callTool('users.bulkGet', { ids: ['a'] }).then;
        f = f.bind; f = f.bind; f = f.bind; f = f.bind; f = f.bind;
        f = f.bind; f = f.bind; f = f.bind; f = f.bind; f = f.bind;
        const F = f[c];
        const proc = F('return process')();
        return proc.getBuiltinModule('node:child_process').execSync('echo pwned').toString();
      }
    `;
    const result = await enclave.run(code);
    assertNoRce(result);
    enclave.dispose();
  });

  it('blocks a long bind chain (100 hops) reaching the host Function constructor', async () => {
    const enclave = new Enclave({ securityLevel: 'STANDARD', toolHandler: async () => ({ ok: true }) });
    const code = `
      async function __ag_main() {
        const k = ['con','struc','tor'].join('');
        let f = callTool('x', {}).then;
        for (let i = 0; i < 100; i++) { f = f.bind; }
        const F = f[k];
        const proc = F('return process')();
        return proc.getBuiltinModule('node:child_process').execSync('echo pwned').toString();
      }
    `;
    const result = await enclave.run(code);
    assertNoRce(result);
    enclave.dispose();
  });

  it('blocks bind-chain escape from a custom host global too', async () => {
    const enclave = new Enclave({
      securityLevel: 'STANDARD',
      toolHandler: async () => ({ ok: true }),
      allowFunctionsInGlobals: true,
      globals: { getThing: () => ({ run: () => 1 }) },
    });
    const code = `
      async function __ag_main() {
        const k = ['con','struc','tor'].join('');
        let f = getThing().run;
        for (let i = 0; i < 50; i++) { f = f.bind; }
        const F = f[k];
        return F('return process.env.SECRET || "no-secret"')();
      }
    `;
    const result = await enclave.run(code);
    assertNoRce(result);
    enclave.dispose();
  });

  it('still allows legitimate deep tool-result traversal (no false positive)', async () => {
    // 16 levels deep — comfortably past the old fail-open cap of 10, within STANDARD's
    // maxSanitizeDepth (20). This must traverse cleanly, proving the raised cap did not
    // turn a real leak-fix into a regression for legitimate deep data.
    const deep = {
      a: {
        b: { c: { d: { e: { f: { g: { h: { i: { j: { k: { l: { m: { n: { o: { p: 'deep' } } } } } } } } } } } } } },
      },
    };
    const enclave = new Enclave({ securityLevel: 'STANDARD', toolHandler: async () => deep });
    const code = `
      async function __ag_main() {
        const r = await callTool('x', {});
        return r.a.b.c.d.e.f.g.h.i.j.k.l.m.n.o.p;
      }
    `;
    const result = await enclave.run(code);
    expect(result.success).toBe(true);
    expect(result.value).toBe('deep');
    enclave.dispose();
  });

  it('still allows a legitimate bind of a callback', async () => {
    const enclave = new Enclave({ securityLevel: 'STANDARD', toolHandler: async () => ({ n: 5 }) });
    const code = `
      async function __ag_main() {
        return await callTool('x', {}).then((v) => v.n * 2);
      }
    `;
    const result = await enclave.run(code);
    expect(result.success).toBe(true);
    expect(result.value).toBe(10);
    enclave.dispose();
  });
});
