/**
 * GHSA-3279-86j6-jpr3 — Static-destructuring sandbox escape / host RCE — Regression Tests
 *
 * Root cause (three chained defects, each closed independently by these tests):
 *
 *  1. AST entry key: static (non-computed) object destructuring of a dangerous key
 *     (`const { "constructor": IO } = {}`, `const { prototype: pr } = callTool`) was not
 *     rejected — `no-computed-destructuring` only caught COMPUTED keys. This reads
 *     `.constructor` / `.prototype` without a MemberExpression or a computed key, evading
 *     every constructor/prototype guard.
 *
 *  2. Membrane raw-leak: the double-VM membrane `get` trap returned the RAW value for a
 *     blocked property whenever it was non-configurable. A function's `.prototype` is
 *     non-configurable but WRITABLE, so the JS `[[Get]]` invariant (non-writable +
 *     non-configurable data only) did not require it — handing back a raw parent-realm
 *     object whose `Object` still has intact `defineProperty` / `getOwnPropertyDescriptor`.
 *
 *  3. Membrane self-leak: the same `get` trap called the live, mutable
 *     `Object.getOwnPropertyDescriptor(target, ...)`. After overwriting it, touching any
 *     membrane proxy (e.g. the Promise returned by `callTool()`) handed the attacker the
 *     RAW host-realm target, whose prototype chain reaches the host `Function` constructor
 *     (code generation enabled, `process` reachable) for RCE.
 *
 * All payloads use a benign `echo pwned` marker — never `env` or any secret.
 *
 * @packageDocumentation
 */

import { Enclave } from '../enclave';
import { getBlockedPropertiesForLevel, buildBlockedPropertiesFromConfig } from '../secure-proxy';
import { SECURITY_LEVEL_CONFIGS } from '../types';
import type { ExecutionResult } from '../types';

/**
 * Every Enclave built by a test is registered here and disposed in `afterEach`, so a failing
 * assertion (which skips the rest of the test body) can never leak a VM for the whole run.
 */
const openEnclaves: Enclave[] = [];

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors the Enclave constructor's options bag
function makeEnclave(options: any): Enclave {
  const enclave = new Enclave(options);
  openEnclaves.push(enclave);
  return enclave;
}

afterEach(() => {
  while (openEnclaves.length > 0) {
    try {
      openEnclaves.pop()?.dispose();
    } catch {
      /* disposal must never mask the test's own failure */
    }
  }
});

/** The advisory PoC, with a benign payload. `callTool` is rewritten to `__safe_callTool`. */
const POC = `
const o = {};
const { "constructor": IO } = o;
const { "prototype": pr } = callTool;
const pp = IO.getPrototypeOf(pr);
const { "constructor": PO } = pp;

const p = callTool("getUser", { id: 1 });

const orig = PO.getOwnPropertyDescriptor;
let captured = null;
const hook = (t, k) => {
  if (captured === null) { captured = t; }
  return orig(t, k);
};
PO.defineProperty(PO, "getOwnPropertyDescriptor", { value: hook, writable: true, configurable: true });
const trigger = p.zzz;
PO.defineProperty(PO, "getOwnPropertyDescriptor", { value: orig, writable: true, configurable: true });

const hp = PO.getPrototypeOf(captured);
const { "constructor": HP } = hp;
const fp = PO.getPrototypeOf(HP);
const { "constructor": HF } = fp;

const g = HF("return typeof process !== 'undefined' ? process.getBuiltinModule('child_process').execSync('echo pwned').toString() : 'no-process'");
return g();
`;

/**
 * Error code every membrane refusal must carry when the double VM is on and AST validation is
 * off — asserting it keeps a test from passing because the run died for some unrelated reason.
 */
const MEMBRANE_ERROR_CODE = 'DOUBLE_VM_EXECUTION_ERROR';

/**
 * Assert the run did not achieve RCE (either blocked, or returned a value with no marker).
 *
 * The WHOLE result is inspected, not just `value`: a payload's output can surface through the
 * error path too (a thrown value, or a message that embeds the command output), so checking
 * `result.value` alone would miss an escape that reported itself as a failure.
 */
function assertNoRce(result: ExecutionResult): void {
  const surfaces = [
    JSON.stringify(result.value ?? null),
    result.error?.message ?? '',
    result.error?.name ?? '',
    result.error?.stack ?? '',
    JSON.stringify(result.error?.data ?? null),
  ].join('\n');
  expect(surfaces).not.toMatch(/pwned/i);
}

describe('GHSA-3279: static-destructuring escape', () => {
  describe('end-to-end PoC must not achieve RCE', () => {
    it('default double-VM (validation ON) blocks the escape', async () => {
      const enclave = makeEnclave({ toolHandler: async () => ({ id: 1, name: 'x' }) });
      const result = await enclave.run(POC);
      assertNoRce(result);
      expect(result.success).toBe(false);
    }, 20000);

    it('double-VM with validation DISABLED is still blocked by the runtime membrane', async () => {
      // Isolates the membrane: even if AST validation is bypassed, the boundary must hold.
      const enclave = makeEnclave({ validate: false, toolHandler: async () => ({ id: 1, name: 'x' }) });
      const result = await enclave.run(POC);
      assertNoRce(result);
      expect(result.success).toBe(false);
    }, 20000);

    it('single-VM (double-VM disabled) blocks the escape', async () => {
      const enclave = makeEnclave({ doubleVm: { enabled: false }, toolHandler: async () => ({ id: 1, name: 'x' }) });
      const result = await enclave.run(POC);
      assertNoRce(result);
      expect(result.success).toBe(false);
    }, 20000);
  });

  describe('AST entry key: static destructuring of dangerous keys is rejected', () => {
    const cases: Array<{ name: string; code: string }> = [
      { name: 'string-literal constructor key', code: `const { "constructor": X } = {}; return typeof X;` },
      { name: 'identifier constructor key', code: `const { constructor: X } = {}; return typeof X;` },
      {
        name: 'string-literal prototype key off callTool',
        code: `const { "prototype": X } = callTool; return typeof X;`,
      },
      { name: 'identifier prototype key off callTool', code: `const { prototype: X } = callTool; return typeof X;` },
      { name: 'identifier __proto__ key', code: `const obj = {}; const { __proto__: X } = obj; return typeof X;` },
      { name: 'string-literal __proto__ key', code: `const { "__proto__": X } = {}; return typeof X;` },
      { name: 'legacy __lookupGetter__ key', code: `const { __lookupGetter__: X } = {}; return typeof X;` },
      { name: 'nested in object pattern', code: `const { a: { "constructor": X } } = { a: {} }; return typeof X;` },
      { name: 'nested inside array pattern', code: `const [{ "constructor": X }] = [{}]; return typeof X;` },
      { name: 'with a default value', code: `const { "constructor": X = 1 } = {}; return typeof X;` },
      { name: 'assignment-target destructuring', code: `let X; ({ "constructor": X } = {}); return typeof X;` },
      { name: 'arrow parameter destructuring', code: `const f = ({ "constructor": X }) => X; return typeof f({});` },
      { name: 'unicode-escaped string-literal key', code: `const { "\\u0063onstructor": X } = {}; return typeof X;` },
      { name: 'unicode-escaped identifier key', code: `const { \\u0063onstructor: X } = {}; return typeof X;` },
      { name: 'computed key built by concatenation', code: `const { ['con' + 'structor']: X } = {}; return typeof X;` },
      {
        name: 'prototype nested in array pattern off callTool',
        code: `const { x: [{ "prototype": X }] } = { x: [callTool] }; return typeof X;`,
      },
    ];

    for (const { name, code } of cases) {
      it(`rejects: ${name}`, async () => {
        const enclave = makeEnclave({ toolHandler: async () => ({ id: 1 }) });
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('VALIDATION_ERROR');
      }, 20000);
    }

    it('flags the destructuring itself (NO_DANGEROUS_DESTRUCTURING), not an incidental rule', async () => {
      const enclave = makeEnclave({ toolHandler: async () => ({ id: 1 }) });
      for (const code of [
        `const { "constructor": c } = {}; return c;`,
        `const { a: { "constructor": c } } = { a: {} }; return c;`,
        `const [{ "constructor": c }] = [{}]; return c;`,
        `let c; ({ "constructor": c } = {}); return c;`,
      ]) {
        const result = await enclave.run(code);
        const codes = ((result.error?.data as { issues?: Array<{ code: string }> } | undefined)?.issues ?? []).map(
          (i) => i.code,
        );
        expect(codes).toContain('NO_DANGEROUS_DESTRUCTURING');
      }
    }, 20000);

    it('does not flag benign keys that merely contain a dangerous substring', async () => {
      const enclave = makeEnclave({ toolHandler: async () => ({ constructorName: 'A', prototypeId: 2 }) });
      const result = await enclave.run(`
        const { constructorName, prototypeId } = await callTool('x', {});
        return constructorName + prototypeId;
      `);
      expect(result.success).toBe(true);
      expect(result.value).toBe('A2');
    }, 20000);
  });

  describe('membrane must not hand back a raw reference (validation disabled)', () => {
    it('reading callTool.prototype via static destructuring is refused at runtime', async () => {
      const enclave = makeEnclave({ validate: false, toolHandler: async () => ({ id: 1 }) });
      const code = `
        const { "prototype": pr } = callTool;
        return typeof pr === "object" && pr !== null ? "leaked-object" : typeof pr;
      `;
      const result = await enclave.run(code);
      // Must NOT leak a usable raw prototype object: either the membrane refused the read, or the
      // read completed with something that is not an object. Both outcomes are asserted, so an
      // unrelated failure (timeout, crash) can no longer make this test pass by default.
      if (result.success) {
        expect(result.value).not.toBe('leaked-object');
      } else {
        expect(result.error?.code).toBe(MEMBRANE_ERROR_CODE);
      }
    }, 20000);

    it('monkeypatching Object.getOwnPropertyDescriptor cannot capture a membrane raw target', async () => {
      const enclave = makeEnclave({ validate: false, toolHandler: async () => ({ id: 1, name: 'x' }) });
      const code = `
        const o = {};
        const { "constructor": IO } = o;
        const { "prototype": pr } = callTool;
        const pp = IO.getPrototypeOf(pr);
        const { "constructor": PO } = pp;
        const p = callTool("x", {});
        const orig = PO.getOwnPropertyDescriptor;
        let captured = null;
        const hook = (t, k) => { if (captured === null) captured = t; return orig(t, k); };
        PO.defineProperty(PO, "getOwnPropertyDescriptor", { value: hook, writable: true, configurable: true });
        const trigger = p.zzz;
        PO.defineProperty(PO, "getOwnPropertyDescriptor", { value: orig, writable: true, configurable: true });
        return { captured: captured === null ? "none" : "CAPTURED" };
      `;
      const result = await enclave.run(code);
      if (result.success) {
        expect((result.value as { captured: string }).captured).toBe('none');
      } else {
        expect(result.error?.code).toBe(MEMBRANE_ERROR_CODE);
      }
    }, 20000);
  });

  describe('membrane: alternate host-leak triggers all fail closed (validation disabled)', () => {
    // Benign RCE probe: only real host code execution can produce "pwned".
    const RCE = JSON.stringify(
      `return typeof process !== 'undefined' ? process.getBuiltinModule('child_process').execSync('echo pwned').toString() : 'noproc'`,
    );

    const vectors: Array<{ name: string; code: string; opts?: Record<string, unknown> }> = [
      {
        name: 'then() prototype-walk to Function',
        code: `
          const gpo = ['get','Prototype','Of'].join('');
          const k = ['con','struc','tor'].join('');
          const p = callTool('x', {}).then(() => {}, () => {});
          const F = Object[gpo](Object[gpo](Object[gpo](p))[k])[k];
          return F(${RCE})();
        `,
      },
      {
        name: 'depth-inflating long then() chain',
        code: `
          const gpo = ['get','Prototype','Of'].join('');
          const k = ['con','struc','tor'].join('');
          let p = callTool('x', {});
          for (let i = 0; i < 25; i++) { p = p.then((v) => v); }
          const F = Object[gpo](Object[gpo](Object[gpo](p))[k])[k];
          return F(${RCE})();
        `,
      },
      {
        name: 'bind-chain then read .prototype',
        code: `
          let f = callTool;
          for (let i = 0; i < 300; i++) { f = f.bind(null); }
          const { "prototype": pr } = f;
          return typeof pr === 'object' && pr !== null ? 'LEAKED' : 'ok';
        `,
      },
      {
        name: 'Promise.all wrapper walk',
        code: `
          const gpo = ['get','Prototype','Of'].join('');
          const k = ['con','struc','tor'].join('');
          const p = Promise.all([callTool('x', {})]);
          const F = Object[gpo](Object[gpo](Object[gpo](p))[k])[k];
          return F(${RCE})();
        `,
      },
      {
        name: 'self-leak via inner-realm Object ({}.constructor)',
        code: `
          const { "constructor": IO } = {};
          const p = callTool('x', {});
          let cap = null; const orig = IO.getOwnPropertyDescriptor;
          try {
            IO.defineProperty(IO, "getOwnPropertyDescriptor", { value: (t, kk) => { if (cap === null) cap = t; return orig(t, kk); }, writable: true, configurable: true });
          } catch (e) { return 'defp-unavailable'; }
          const trig = p.zzz;
          return cap === null ? 'none' : 'CAPTURED';
        `,
      },
      {
        name: 'self-leak via getOwnPropertyDescriptors + JSON.stringify',
        code: `
          const { "prototype": pr } = callTool;
          const { "constructor": PO } = Object.getPrototypeOf(pr);
          const p = callTool('x', {});
          const orig = PO.getOwnPropertyDescriptors; let cap = null;
          PO.defineProperty(PO, "getOwnPropertyDescriptors", { value: (t) => { if (cap === null) cap = t; return orig(t); }, writable: true, configurable: true });
          try { JSON.stringify(p); Object.getOwnPropertyNames(p); } catch (e) {}
          return cap === null ? 'none' : 'CAPTURED';
        `,
      },
      {
        name: 'native error constructor walk (codegen-disabled realm)',
        code: `
          const k = ['con','struc','tor'].join('');
          try { (void 0).x; return 'noThrow'; }
          catch (e) { try { return e[k][k](${RCE})(); } catch (e2) { return 'blocked'; } }
        `,
      },
      {
        name: 'async function constructor walk',
        code: `
          const k = ['con','struc','tor'].join('');
          const af = async () => {};
          try { return af[k][k](${RCE})(); } catch (e) { return 'blocked'; }
        `,
      },
      {
        name: 'deep tool-result constructor walk',
        code: `
          const k = ['con','struc','tor'].join('');
          const r = await callTool('x', {});
          try { return r.a.b[k][k](${RCE})(); } catch (e) { return 'blocked'; }
        `,
        opts: { toolHandler: async () => ({ a: { b: { c: 1 } } }) },
      },
      {
        name: 'throw-from-handler constructor walk',
        code: `
          const k = ['con','struc','tor'].join('');
          try { await callTool('x', {}); return 'noThrow'; }
          catch (e) { try { return e[k][k](${RCE})(); } catch (e2) { return 'blocked'; } }
        `,
        opts: {
          toolHandler: async () => {
            throw new Error('boom');
          },
        },
      },
      {
        name: 'array tool-result iterator walk',
        code: `
          const k = ['con','struc','tor'].join('');
          const a = await callTool('x', {});
          try { const it = a[Symbol.iterator](); return it[k][k](${RCE})(); } catch (e) { return 'blocked'; }
        `,
        opts: { toolHandler: async () => [1, 2, 3] },
      },
      {
        name: 'getOwnPropertyDescriptors(this) array-coercion recon',
        code: `try { return typeof Object.getOwnPropertyDescriptors(this); } catch (e) { return 'blocked'; }`,
      },
    ];

    for (const v of vectors) {
      it(`no RCE and no raw leak: ${v.name}`, async () => {
        const enclave = makeEnclave({ validate: false, toolHandler: async () => ({ id: 1, name: 'x' }), ...v.opts });
        const result = await enclave.run(v.code);
        // The one invariant that matters: no host command executed, and no raw target captured.
        assertNoRce(result);
        if (result.success) {
          expect(result.value).not.toBe('CAPTURED');
          expect(result.value).not.toBe('LEAKED');
        } else {
          // A refusal is a valid outcome, but it must be the membrane refusing — not the run
          // dying for an unrelated reason that would mask a regression in the vector itself.
          expect(result.error?.code).toBe(MEMBRANE_ERROR_CODE);
        }
      }, 20000);
    }
  });

  describe('meta / reflection gadgets are not exposed to the sandbox', () => {
    it.each(['Reflect', 'Proxy', 'Symbol', 'Function', 'eval', 'WeakRef'])(
      'the global %s is not usable as an escape gadget',
      async (name) => {
        const enclave = makeEnclave({ toolHandler: async () => ({ id: 1 }) });
        // Whether blocked at validation or absent at runtime, it must never yield a working value.
        const result = await enclave.run(`return typeof ${name} === 'undefined' ? 'absent' : String(typeof ${name});`);
        if (result.success) {
          expect(result.value).toBe('absent');
        } else {
          expect(result.error?.code).toBeDefined();
        }
      },
      20000,
    );
  });

  describe('host-global functions (validation disabled) do not leak their realm', () => {
    const base = {
      validate: false,
      allowFunctionsInGlobals: true,
      toolHandler: async () => ({ id: 1 }),
      globals: { getTool: () => ({ name: 't' }) },
    };

    it('refuses .prototype / .constructor destructured off a host function', async () => {
      const enclave = makeEnclave(base);
      const result = await enclave.run(`
        try { const { "prototype": pr } = getTool; return typeof pr === 'object' ? 'LEAKED' : 'ok-' + typeof pr; }
        catch (e) { return 'blocked'; }
      `);
      if (result.success) {
        expect(result.value).not.toBe('LEAKED');
      } else {
        expect(result.error?.code).toBe(MEMBRANE_ERROR_CODE);
      }
    }, 20000);

    it('a walk from a host-function return value cannot reach a working Function', async () => {
      const enclave = makeEnclave(base);
      const RCE = JSON.stringify(`return typeof process !== 'undefined' ? 'HASPROC' : 'noproc'`);
      const result = await enclave.run(`
        const gpo = ['get','Prototype','Of'].join('');
        const k = ['con','struc','tor'].join('');
        const s = getTool('t');
        try { const F = Object[gpo](Object[gpo](s)[k])[k]; return F(${RCE})(); } catch (e) { return 'blocked'; }
      `);
      expect(JSON.stringify(result)).not.toMatch(/HASPROC/);
    }, 20000);
  });

  describe('descriptor/prototype mutation gadgets are in the blocked set', () => {
    const GADGETS = [
      'getOwnPropertyDescriptor',
      'getOwnPropertyDescriptors',
      'defineProperty',
      'defineProperties',
      'setPrototypeOf',
    ];

    it.each(['STRICT', 'SECURE', 'STANDARD'] as const)('getBlockedPropertiesForLevel(%s) blocks the gadgets', (lvl) => {
      const blocked = getBlockedPropertiesForLevel(lvl);
      for (const g of GADGETS) expect(blocked.has(g)).toBe(true);
    });

    it('the STANDARD secureProxy config (the default membrane) blocks the gadgets', () => {
      const blocked = buildBlockedPropertiesFromConfig(SECURITY_LEVEL_CONFIGS.STANDARD.secureProxy);
      for (const g of GADGETS) expect(blocked.has(g)).toBe(true);
    });

    it('PERMISSIVE (constructor allowed) does NOT force-block the gadgets', () => {
      const blocked = getBlockedPropertiesForLevel('PERMISSIVE');
      expect(blocked.has('defineProperty')).toBe(false);
    });

    it.each([
      `return Object.getOwnPropertyDescriptor({}, 'x');`,
      `return Object.defineProperty({}, 'x', { value: 1 });`,
      `return Object.setPrototypeOf({}, null);`,
    ])(
      'the sandbox refuses the gadget call: %s',
      async (code) => {
        // Blocked at whichever layer fires first (the AST NO_META_PROGRAMMING rule for the literal
        // `Object.x()` form, and the membrane blocked-set for an aliased/wrapped Object as in the PoC).
        const enclave = makeEnclave({ toolHandler: async () => ({ id: 1 }) });
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
      },
      20000,
    );
  });

  describe('no behavioral regression for legitimate destructuring', () => {
    it('destructures tool results by name', async () => {
      const enclave = makeEnclave({ toolHandler: async () => ({ data: { count: 41 } }) });
      const code = `
        const { data } = await callTool('x', {});
        const { count } = data;
        return count + 1;
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(true);
      expect(result.value).toBe(42);
    }, 20000);

    it('callTool().then(v => v.n + 1) still resolves', async () => {
      const enclave = makeEnclave({ toolHandler: async () => ({ n: 7 }) });
      const result = await enclave.run(`return await callTool('x', {}).then((v) => v.n + 1);`);
      expect(result.success).toBe(true);
      expect(result.value).toBe(8);
    }, 20000);

    it('array/object destructuring of ordinary keys works', async () => {
      const enclave = makeEnclave({ toolHandler: async () => ({ id: 1 }) });
      const code = `
        const [a, b] = [1, 2];
        const { name, value } = { name: 'k', value: 9 };
        return a + b + value + name.length;
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(true);
      expect(result.value).toBe(1 + 2 + 9 + 1);
    }, 20000);
  });
});
