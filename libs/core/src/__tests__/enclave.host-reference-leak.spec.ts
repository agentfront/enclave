/**
 * Host-Reference-Leak Sandbox Escapes — Regression Tests
 *
 * These escapes all share one root cause: the security boundary leaks a live HOST-realm
 * reference (a callback, Promise, or object) to sandbox-controlled code — either because it
 * invoked a method looked up on an untrusted value (handing a host callback to a Proxy trap)
 * or because it failed to wrap a call/return value. From any such reference the sandbox walks
 * to the host `Function` constructor for RCE.
 *
 * Reproduces two reported critical sandbox escapes and locks in their fixes (the same class
 * was also found and fixed in the worker-pool sanitizer, see the case below, and in the
 * sidecar reference-resolver, see `sidecar/__tests__/reference-resolver.spec.ts`):
 *
 * 1. GHSA-6mpw-63xj-mghh — "return-value sanitizer leaks host callback via Proxy .map()"
 *    `sanitizeValue` called `.map()` (and other methods) directly on the untrusted return
 *    value. An attacker `Proxy` over an array traps `.map` and receives the host callback,
 *    reaching `callback.constructor` (host `Function`) for RCE. Fix: the sanitizer never
 *    invokes a method looked up on the untrusted value — it uses captured host intrinsics
 *    via `Reflect.apply`/`Reflect.get`, so an attacker method/trap is never consulted and no
 *    host callback is ever handed to attacker-controlled code.
 *
 * 2. GHSA-grmc-r8vw-226r — "callTool().then() leaks unwrapped host Promise"
 *    The inner-VM `createSecureProxy` wrapped values obtained via property access (get trap)
 *    but had no `apply` trap, so calling a wrapped function returned a RAW host object. The
 *    secure Promise returned by `callTool()` therefore leaked a raw host Promise through
 *    `.then()`, whose prototype chain reaches the host `Function` constructor. Fix: an `apply`
 *    trap re-wraps every call result behind the security barrier (at a fresh depth so chained
 *    calls cannot inflate past the recursion cap).
 *
 * 3. Custom-global results leaked a raw host object through a pinned property
 *    A JavaScript `get` trap MUST report the exact value of a non-configurable, non-writable
 *    data property, so the membrane cannot wrap it. It used to hand the raw reference back,
 *    which meant any host object carrying such a property (a Zod v4 schema pins `_zod` this
 *    way) delivered an unwrapped host object graph to sandbox code, and from there
 *    `.constructor` reaches the host `Function` constructor. Fix: values owned by the HOST
 *    realm are wrapped in host mode, where an object/function in that position is refused
 *    (throwing satisfies the invariant that wrapping would break). Primitives are still
 *    reported, and realm-owned intrinsics keep their previous behaviour so `new Array()`,
 *    `instanceof`, and prototype-based memory patching continue to work.
 *
 * @packageDocumentation
 */

import { sanitizeValue } from '../value-sanitizer';
import { sanitizeObject } from '../adapters/worker-pool/safe-deserialize';
import { Enclave } from '../enclave';

/**
 * Asserts a sandbox result did NOT achieve remote code execution.
 * Either the attack was blocked (success === false) or the returned value contains no
 * evidence of host command execution / host-object access.
 */
function assertNoRce(result: { success: boolean; value?: unknown; error?: { message: string } }): void {
  if (!result.success) {
    expect(result.error).toBeDefined();
    return;
  }
  const str = JSON.stringify(result.value ?? null);
  expect(str).not.toMatch(/pwned/i);
  expect(str).not.toMatch(/uid=\d+/);
  expect(str).not.toMatch(/gid=\d+/);
  expect(str).not.toMatch(/child_process/);
}

describe('GHSA-6mpw-63xj-mghh: value-sanitizer return-value callback leak', () => {
  describe('unit: sanitizeValue must never invoke methods on the untrusted value', () => {
    it('does not consult a `.map` trap or hand a host callback to an attacker Proxy', () => {
      let mapAccessed = false;
      let handedCallback = false;
      const evil = new Proxy([1, 2, 3] as unknown[], {
        get(target, key, receiver) {
          if (key === 'map') {
            mapAccessed = true;
            return (cb: unknown) => {
              // In the real exploit this is `cb.constructor` === host `Function`.
              handedCallback = typeof cb === 'function';
              return ['PWNED'];
            };
          }
          return Reflect.get(target, key, receiver);
        },
      });

      const out = sanitizeValue(evil);

      expect(mapAccessed).toBe(false);
      expect(handedCallback).toBe(false);
      expect(JSON.stringify(out)).not.toContain('PWNED');
    });

    it('does not consult a trapped `.entries` on a Proxy-wrapped Map', () => {
      let entriesAccessed = false;
      const evil = new Proxy(new Map([['k', 'v']]), {
        get(target, key, receiver) {
          if (key === 'entries') {
            entriesAccessed = true;
            return () => ['PWNED'];
          }
          return Reflect.get(target, key, receiver);
        },
      });

      // The captured Map.prototype.entries is used; a Proxy has no [[MapData]] slot, so this
      // fails closed rather than invoking the attacker's trap.
      let out: unknown;
      let threw = false;
      try {
        out = sanitizeValue(evil);
      } catch {
        threw = true;
      }

      expect(entriesAccessed).toBe(false);
      if (!threw) {
        expect(JSON.stringify(out)).not.toContain('PWNED');
      }
    });

    it('the parallel worker-pool sanitizer (sanitizeObject) is hardened the same way', () => {
      // worker-script sanitizes the live sandbox execution result with sanitizeObject, so it
      // must not consult a `.map` trap on an attacker Proxy either.
      let mapAccessed = false;
      const evil = new Proxy([1, 2] as unknown[], {
        get(target, key, receiver) {
          if (key === 'map') {
            mapAccessed = true;
            return () => ['PWNED'];
          }
          return Reflect.get(target, key, receiver);
        },
      });

      const out = sanitizeObject(evil);

      expect(mapAccessed).toBe(false);
      expect(JSON.stringify(out)).not.toContain('PWNED');
      expect(out).toEqual([1, 2]);
    });

    it('the worker-pool sanitizer rejects an array whose reported length is excessive (DoS)', () => {
      // A cheap Proxy that fakes an enormous length must not drive an unbounded copy loop.
      const huge = new Proxy([] as unknown[], {
        get(target, key, receiver) {
          if (key === 'length') {
            return 5_000_000;
          }
          return Reflect.get(target, key, receiver);
        },
      });

      expect(() => sanitizeObject(huge)).toThrow(/maximum length/i);
    });

    it('reads array length exactly once and still enforces the property limit (DoS-safe)', () => {
      let lengthReads = 0;
      const evil = new Proxy([] as unknown[], {
        get(target, key, receiver) {
          if (key === 'length') {
            lengthReads++;
            return 50_000;
          }
          return Reflect.get(target, key, receiver);
        },
      });

      expect(() => sanitizeValue(evil, { maxProperties: 100 })).toThrow(/maximum properties/i);
      expect(lengthReads).toBe(1);
    });
  });

  describe('unit: legitimate values still sanitize correctly (no behavioral regression)', () => {
    it('copies arrays element-by-element into a fresh host array', () => {
      expect(sanitizeValue([1, 'a', true, null, [2, 3]])).toEqual([1, 'a', true, null, [2, 3]]);
    });

    it('sanitizes Map / Set / Date / Error / RegExp / plain objects', () => {
      expect(sanitizeValue(new Map([['a', 1]]))).toEqual({ a: 1 });
      expect(sanitizeValue(new Set([1, 2, 3]))).toEqual([1, 2, 3]);

      const d = new Date('2024-01-01T00:00:00.000Z');
      expect((sanitizeValue(d) as Date).getTime()).toBe(d.getTime());

      expect(sanitizeValue(new TypeError('boom'))).toEqual({ name: 'TypeError', message: 'boom' });
      expect(sanitizeValue(/abc/gi)).toBe('/abc/gi');
      expect(sanitizeValue({ nested: { value: 42 } })).toEqual({ nested: { value: 42 } });
    });

    it('still strips functions returned directly', () => {
      expect(() => sanitizeValue(() => 'x')).toThrow(/function/i);
    });
  });

  describe('integration: returning a malicious Proxy must not achieve RCE', () => {
    it('blocks the reported PoC (Proxy([]) with a `.map` trap → execSync)', async () => {
      const enclave = new Enclave({ securityLevel: 'STANDARD', toolHandler: async () => ({ ok: true }) });
      const code = `
        async function __ag_main() {
          const g = this;
          const k = ['con','struc','tor'].join('');
          return new (g[['Pr','oxy'].join('')])([], {
            get: (t, key) => key === 'map'
              ? (cb) => cb[k]('return process')().getBuiltinModule('node:child_process').execSync('echo pwned').toString()
              : undefined
          });
        }
      `;
      const result = await enclave.run(code);
      assertNoRce(result);
      enclave.dispose();
    });
  });
});

describe('GHSA-grmc-r8vw-226r: callTool().then() host Promise leak', () => {
  it('blocks the reported PoC (callTool().then() prototype walk → execSync)', async () => {
    const enclave = new Enclave({ securityLevel: 'STANDARD', toolHandler: async () => ({ ok: true }) });
    const code = `
      async function __ag_main() {
        const gpo = ['get','Prototype','Of'].join('');
        const k   = ['con','struc','tor'].join('');
        const p  = callTool('x', {});
        const p2 = p.then(() => {}, () => {});
        const F  = Object[gpo](Object[gpo](Object[gpo](p2))[k])[k];
        const proc = F('return process')();
        const cp   = proc.getBuiltinModule('node:child_process');
        return cp.execSync('echo pwned').toString();
      }
    `;
    const result = await enclave.run(code);
    assertNoRce(result);
    enclave.dispose();
  });

  it('blocks depth-inflation via long .then() chains', async () => {
    const enclave = new Enclave({ securityLevel: 'STANDARD', toolHandler: async () => ({ ok: true }) });
    const code = `
      async function __ag_main() {
        const gpo = ['get','Prototype','Of'].join('');
        const k   = ['con','struc','tor'].join('');
        let p = callTool('x', {});
        for (let i = 0; i < 15; i++) { p = p.then((v) => v); }
        const F = Object[gpo](Object[gpo](Object[gpo](p))[k])[k];
        const proc = F('return process')();
        return proc.getBuiltinModule('node:child_process').execSync('echo pwned').toString();
      }
    `;
    const result = await enclave.run(code);
    assertNoRce(result);
    enclave.dispose();
  });

  it('still resolves callTool().then() normally for legitimate use', async () => {
    const enclave = new Enclave({ securityLevel: 'STANDARD', toolHandler: async () => ({ n: 7 }) });
    const code = `
      async function __ag_main() {
        return await callTool('x', {}).then((v) => v.n + 1);
      }
    `;
    const result = await enclave.run(code);
    expect(result.success).toBe(true);
    expect(result.value).toBe(8);
    enclave.dispose();
  });
});

describe('custom-global results must not leak a raw host object via a pinned property', () => {
  /**
   * Mirrors a Zod v4 schema: `_zod` is installed as a non-configurable, non-writable own data
   * property, and it holds an object that leads back to the host class (and so to the host
   * `Function` constructor). Any host object shaped like this defeats a Proxy membrane unless
   * the membrane refuses the read.
   */
  class HostSchema {
    constructor() {
      Object.defineProperty(this, '_zod', {
        value: { constr: HostSchema },
        configurable: false,
        writable: false,
        enumerable: true,
      });
    }
    parse(value: unknown): unknown {
      return value;
    }
  }

  function enclaveWithHostGlobals(globals: Record<string, unknown>): Enclave {
    return new Enclave({
      securityLevel: 'STANDARD',
      toolHandler: async () => ({ ok: true }),
      allowFunctionsInGlobals: true,
      globals,
    });
  }

  it('blocks the reported PoC (pinned property → host Function → execSync)', async () => {
    const enclave = enclaveWithHostGlobals({
      getTool: () => ({ name: 't', outputSchema: new HostSchema() }),
    });
    const code = `
      async function __ag_main() {
        const k = ['con','struc','tor'].join('');
        const raw = getTool('t').outputSchema['_zod'];
        const F = raw['constr'][k];
        const proc = F('return process')();
        return proc.getBuiltinModule('node:child_process').execSync('echo pwned').toString();
      }
    `;
    const result = await enclave.run(code);
    assertNoRce(result);
    expect(result.success).toBe(false);
    enclave.dispose();
  });

  it('refuses the pinned property itself rather than returning a raw reference', async () => {
    const enclave = enclaveWithHostGlobals({
      getTool: () => ({ name: 't', outputSchema: new HostSchema() }),
    });
    const code = `
      async function __ag_main() {
        try {
          return { leaked: typeof getTool('t').outputSchema['_zod'] };
        } catch (e) {
          return { denied: e.message };
        }
      }
    `;
    const result = await enclave.run(code);
    expect(result.success).toBe(true);
    expect(result.value).toEqual({ denied: expect.stringMatching(/blocked/i) });
    enclave.dispose();
  });

  it('stays strict through nested reads and chained calls', async () => {
    const enclave = enclaveWithHostGlobals({
      registry: {
        lookup: () => ({ tool: { schema: new HostSchema() } }),
      },
    });
    const code = `
      async function __ag_main() {
        try {
          return { leaked: typeof registry.lookup().tool.schema['_zod'] };
        } catch (e) {
          return { denied: e.message };
        }
      }
    `;
    const result = await enclave.run(code);
    expect(result.success).toBe(true);
    expect(result.value).toEqual({ denied: expect.stringMatching(/blocked/i) });
    enclave.dispose();
  });

  it('still exposes primitive-valued pinned properties from host globals', async () => {
    const constants: Record<string, unknown> = {};
    Object.defineProperty(constants, 'VERSION', {
      value: 3,
      configurable: false,
      writable: false,
      enumerable: true,
    });

    const enclave = enclaveWithHostGlobals({ constants });
    const code = `
      async function __ag_main() {
        return constants.VERSION;
      }
    `;
    const result = await enclave.run(code);
    expect(result.success).toBe(true);
    expect(result.value).toBe(3);
    enclave.dispose();
  });

  it('still passes ordinary host-global data through unchanged', async () => {
    const enclave = enclaveWithHostGlobals({
      getTool: (name: string) => ({ name, inputSchema: { type: 'object', properties: { a: { type: 'number' } } } }),
    });
    const code = `
      async function __ag_main() {
        const meta = getTool('users:list');
        return { name: meta.name, kind: meta.inputSchema.type, prop: meta.inputSchema.properties.a.type };
      }
    `;
    const result = await enclave.run(code);
    expect(result.success).toBe(true);
    expect(result.value).toEqual({ name: 'users:list', kind: 'object', prop: 'number' });
    enclave.dispose();
  });

  it('leaves realm-owned intrinsics usable (host mode must not touch them)', async () => {
    const enclave = new Enclave({ securityLevel: 'STANDARD', toolHandler: async () => ({ ok: true }) });
    const code = `
      async function __ag_main() {
        return {
          joined: new Array(3).fill('x').join('-'),
          repeated: 'ab'.repeat(2),
          parsed: JSON.parse('{"n":1}').n,
        };
      }
    `;
    const result = await enclave.run(code);
    expect(result.success).toBe(true);
    expect(result.value).toEqual({ joined: 'x-x-x', repeated: 'abab', parsed: 1 });
    enclave.dispose();
  });
});
