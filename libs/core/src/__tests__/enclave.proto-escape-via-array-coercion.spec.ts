/**
 * ATK-ARRCOERCE: Prototype Escape via Array Coercion
 *
 * Category: ATK-ARRCOERCE (CWE-693: Protection Mechanism Failure)
 *
 * Two critical sandbox escape PoCs that achieve RCE by exploiting JavaScript
 * array-to-string coercion to bypass AST validation rules.
 *
 * Attack Mechanism:
 * - Both PoCs use `[['__proto__']]` instead of `['__proto__']` or `.__proto__`
 * - The DisallowedIdentifierRule only checks Identifier and Literal nodes,
 *   not ArrayExpression nodes
 * - Array `['__proto__']` coerces to string `'__proto__'` when used as a property key
 *
 * PoC 1: Leaks host Function constructor via `__host_memory_track__`
 *   (injected when memoryLimit > 0, which is the default)
 * PoC 2: Leaks host Function constructor via `__safe_console.log()` triggering
 *   `Symbol.for('nodejs.util.inspect.custom')` callback that receives the real
 *   host `util.inspect`
 *
 * Related CWEs:
 * - CWE-693: Protection Mechanism Failure
 * - CWE-94: Improper Control of Generation of Code
 * - CWE-1321: Improperly Controlled Modification of Object Prototype Attributes
 *
 * @packageDocumentation
 */

import { Enclave } from '../enclave';

/**
 * Asserts that sandbox escape did NOT succeed.
 * If execution failed, the error was caught (blocked at validation or runtime).
 * If execution succeeded, the returned value must not contain OS command output.
 */
function assertNoEscape(result: { success: boolean; value?: unknown; error?: { message: string } }) {
  if (!result.success) {
    expect(result.error).toBeDefined();
  } else {
    const str = JSON.stringify(result.value);
    // Should not contain OS-level output from `id` command
    expect(str).not.toMatch(/uid=\d+/);
    expect(str).not.toMatch(/gid=\d+/);
    // Should not contain evidence of process access
    expect(str).not.toMatch(/child_process/);
    expect(str).not.toMatch(/ESCAPED/);
  }
}

describe('ATK-ARRCOERCE: Prototype Escape via Array Coercion', () => {
  // ── Section 1: PoC 1 Reproduction (ATK-ARRCOERCE-01 to 05) ────────────────
  describe('Section 1: PoC 1 — __host_memory_track__ escape', () => {
    const POC1_CODE = `
      const op = {}[['__proto__']];
      const ho = op[['constructor']];
      const glob = ho.getOwnPropertyDescriptors(this);
      return {
        res: glob.__host_memory_track__.value[['constructor']]('return process')()
          .getBuiltinModule('child_process')
          .execSync('id')
          .toString()
          .split('\\n'),
      };
    `;

    it('ATK-ARRCOERCE-01: PoC 1 with default config', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const result = await enclave.run(POC1_CODE);
      assertNoEscape(result);
      enclave.dispose();
    }, 15000);

    it('ATK-ARRCOERCE-02: PoC 1 with STRICT security level', async () => {
      const enclave = new Enclave({ securityLevel: 'STRICT', timeout: 5000 });
      const result = await enclave.run(POC1_CODE);
      assertNoEscape(result);
      enclave.dispose();
    }, 15000);

    it('ATK-ARRCOERCE-03: PoC 1 with SECURE security level', async () => {
      const enclave = new Enclave({ securityLevel: 'SECURE', timeout: 5000 });
      const result = await enclave.run(POC1_CODE);
      assertNoEscape(result);
      enclave.dispose();
    }, 15000);

    it('ATK-ARRCOERCE-04: PoC 1 with explicit memoryLimit', async () => {
      const enclave = new Enclave({ timeout: 5000, memoryLimit: 2 * 1024 * 1024 });
      const result = await enclave.run(POC1_CODE);
      assertNoEscape(result);
      enclave.dispose();
    }, 15000);

    it('ATK-ARRCOERCE-05: PoC 1 with memoryLimit=0 (no __host_memory_track__)', async () => {
      const enclave = new Enclave({ timeout: 5000, memoryLimit: 0 });
      // When memoryLimit is 0, __host_memory_track__ should not be available.
      // The exploit should fail either at validation or when accessing the missing global.
      const result = await enclave.run(POC1_CODE);
      assertNoEscape(result);
      enclave.dispose();
    }, 15000);
  });

  // ── Section 2: PoC 2 Reproduction (ATK-ARRCOERCE-06 to 10) ────────────────
  describe('Section 2: PoC 2 — console.log + inspect.custom escape', () => {
    const POC2_CODE = `
      const op = {}[['__proto__']];
      const ho = op[['constructor']];
      const glob = ho.getOwnPropertyDescriptors(this);
      const sym = glob[['Symbol']].value.for('nodejs.util.inspect.custom');

      let result;
      const obj = {
        [sym]: (depth, option, inspect) => {
          result = inspect[['constructor']]
            [['constructor']]('return process')()
            .getBuiltinModule('child_process')
            .execSync('id')
            .toString()
            .split('\\n');
        }
      };

      glob.__safe_console.value.log(obj);
      return { result };
    `;

    it('ATK-ARRCOERCE-06: PoC 2 with default config', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const result = await enclave.run(POC2_CODE);
      assertNoEscape(result);
      enclave.dispose();
    }, 15000);

    it('ATK-ARRCOERCE-07: PoC 2 with STRICT security level', async () => {
      const enclave = new Enclave({ securityLevel: 'STRICT', timeout: 5000 });
      const result = await enclave.run(POC2_CODE);
      assertNoEscape(result);
      enclave.dispose();
    }, 15000);

    it('ATK-ARRCOERCE-08: PoC 2 with SECURE security level', async () => {
      const enclave = new Enclave({ securityLevel: 'SECURE', timeout: 5000 });
      const result = await enclave.run(POC2_CODE);
      assertNoEscape(result);
      enclave.dispose();
    }, 15000);

    it('ATK-ARRCOERCE-09: PoC 2 with memoryLimit=0', async () => {
      // PoC 2 works regardless of memoryLimit since it uses __safe_console
      const enclave = new Enclave({ timeout: 5000, memoryLimit: 0 });
      const result = await enclave.run(POC2_CODE);
      assertNoEscape(result);
      enclave.dispose();
    }, 15000);

    it('ATK-ARRCOERCE-10: PoC 2 with PERMISSIVE security level', async () => {
      const enclave = new Enclave({ securityLevel: 'PERMISSIVE', timeout: 5000 });
      const result = await enclave.run(POC2_CODE);
      assertNoEscape(result);
      enclave.dispose();
    }, 15000);
  });

  // ── Section 3: Building Block Isolation (ATK-ARRCOERCE-11 to 15) ───────────
  describe('Section 3: Building block isolation', () => {
    it("ATK-ARRCOERCE-11: {}[['__proto__']] alone should not yield Object.prototype", async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        const proto = {}[['__proto__']];
        return { type: typeof proto, isNull: proto === null, isUndefined: proto === undefined };
      `;
      const result = await enclave.run<{ type: string; isNull: boolean; isUndefined: boolean }>(code);
      assertNoEscape(result);
      if (result.success && result.value) {
        // proto should be null (shadowed) or access should be blocked
        expect(result.value.type).not.toBe('function');
      }
      enclave.dispose();
    }, 15000);

    it("ATK-ARRCOERCE-12: op[['constructor']] chain should be blocked", async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        const op = {}[['__proto__']];
        if (op === null || op === undefined) return 'blocked_at_proto';
        const ho = op[['constructor']];
        return { type: typeof ho, name: ho?.name };
      `;
      const result = await enclave.run(code);
      assertNoEscape(result);
      enclave.dispose();
    }, 15000);

    it('ATK-ARRCOERCE-13: getOwnPropertyDescriptors(this) via variable should be blocked', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        try {
          const op = {}[['__proto__']];
          if (!op) return 'blocked_at_proto';
          const ho = op[['constructor']];
          if (!ho) return 'blocked_at_constructor';
          const glob = ho.getOwnPropertyDescriptors(this);
          return { keys: Object.keys(glob).slice(0, 5) };
        } catch (e) {
          return { blocked: true, error: e.message };
        }
      `;
      const result = await enclave.run(code);
      assertNoEscape(result);
      enclave.dispose();
    }, 15000);

    it('ATK-ARRCOERCE-14: host function .constructor access from descriptor .value', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        try {
          const op = {}[['__proto__']];
          if (!op) return 'blocked_at_proto';
          const ho = op[['constructor']];
          if (!ho) return 'blocked_at_constructor';
          const glob = ho.getOwnPropertyDescriptors(this);
          // Try to get Function constructor from any host function descriptor
          const keys = Object.keys(glob);
          for (const k of keys) {
            const desc = glob[k];
            if (desc && typeof desc.value === 'function') {
              try {
                const F = desc.value[['constructor']];
                if (typeof F === 'function') {
                  const fn = F('return "ESCAPED"');
                  if (typeof fn === 'function') {
                    return { escaped: true, via: k, result: fn() };
                  }
                }
              } catch (e) { /* try next */ }
            }
          }
          return 'no_exploitable_descriptor';
        } catch (e) {
          return { blocked: true, error: e.message };
        }
      `;
      const result = await enclave.run(code);
      assertNoEscape(result);
      enclave.dispose();
    }, 15000);

    it('ATK-ARRCOERCE-15: Symbol.for(nodejs.util.inspect.custom) inspect callback leak', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        try {
          const sym = Symbol.for('nodejs.util.inspect.custom');
          let leaked = false;
          const obj = {
            [sym]: (depth, option, inspect) => {
              if (inspect && typeof inspect === 'function') {
                leaked = true;
                try {
                  const F = inspect[['constructor']][['constructor']];
                  if (typeof F === 'function') {
                    return F('return "ESCAPED"')();
                  }
                } catch (e) { /* blocked */ }
              }
              return 'safe';
            }
          };
          console.log(obj);
          return { leaked };
        } catch (e) {
          return { blocked: true, error: e.message };
        }
      `;
      const result = await enclave.run<{ leaked?: boolean; blocked?: boolean }>(code);
      assertNoEscape(result);
      if (result.success && result.value && 'leaked' in result.value) {
        expect(result.value.leaked).not.toBe(true);
      }
      enclave.dispose();
    }, 15000);
  });

  // ── Section 4: Array Coercion Variants (ATK-ARRCOERCE-16 to 21) ────────────
  describe('Section 4: Array coercion variants', () => {
    it("ATK-ARRCOERCE-16: nested arrays [[['__proto__']]]", async () => {
      const enclave = new Enclave({ timeout: 5000 });
      // [[['__proto__']]] coerces to '__proto__' as well
      const code = `
        const proto = {}[[['__proto__']]];
        if (proto === null || proto === undefined) return 'blocked';
        const ctor = proto[['constructor']];
        return { type: typeof ctor };
      `;
      const result = await enclave.run(code);
      assertNoEscape(result);
      enclave.dispose();
    }, 15000);

    it("ATK-ARRCOERCE-17: toString override [{toString: () => 'constructor'}]", async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        try {
          const key = [{toString: () => 'constructor'}];
          const proto = {}[['__proto__']];
          if (!proto) return 'blocked_at_proto';
          const ctor = proto[key];
          return { type: typeof ctor, name: ctor?.name };
        } catch (e) {
          return { blocked: true, error: e.message };
        }
      `;
      const result = await enclave.run(code);
      assertNoEscape(result);
      enclave.dispose();
    }, 15000);

    it("ATK-ARRCOERCE-18: array join ['__prot','o__'].join('')", async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        try {
          const key = ['__prot','o__'].join('');
          const proto = {}[key];
          if (!proto) return 'blocked_at_proto';
          const ctor = proto[['constructor']];
          return { type: typeof ctor };
        } catch (e) {
          return { blocked: true, error: e.message };
        }
      `;
      const result = await enclave.run(code);
      assertNoEscape(result);
      enclave.dispose();
    }, 15000);

    it("ATK-ARRCOERCE-19: [['prototype']] access", async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        try {
          const F = function(){};
          const proto = F[['prototype']];
          if (!proto) return 'blocked';
          const ctor = proto[['constructor']];
          return { type: typeof ctor, name: ctor?.name };
        } catch (e) {
          return { blocked: true, error: e.message };
        }
      `;
      const result = await enclave.run(code);
      assertNoEscape(result);
      enclave.dispose();
    }, 15000);

    it('ATK-ARRCOERCE-20: variable-stored arrays for property access', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        try {
          const protoKey = ['__proto__'];
          const ctorKey = ['constructor'];
          const proto = {}[protoKey];
          if (!proto) return 'blocked_at_proto';
          const ctor = proto[ctorKey];
          return { type: typeof ctor };
        } catch (e) {
          return { blocked: true, error: e.message };
        }
      `;
      const result = await enclave.run(code);
      assertNoEscape(result);
      enclave.dispose();
    }, 15000);

    it('ATK-ARRCOERCE-21: building inspect symbol string via array join', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        try {
          const symName = ['nodejs', 'util', 'inspect', 'custom'].join('.');
          const sym = Symbol.for(symName);
          let leaked = false;
          const obj = {
            [sym]: (depth, option, inspect) => {
              if (inspect && typeof inspect === 'function') {
                leaked = true;
              }
              return 'safe';
            }
          };
          console.log(obj);
          return { leaked };
        } catch (e) {
          return { blocked: true, error: e.message };
        }
      `;
      const result = await enclave.run<{ leaked?: boolean; blocked?: boolean }>(code);
      assertNoEscape(result);
      if (result.success && result.value && 'leaked' in result.value) {
        expect(result.value.leaked).not.toBe(true);
      }
      enclave.dispose();
    }, 15000);
  });

  // ── Section 5: Full Chain Variants (ATK-ARRCOERCE-22 to 26) ────────────────
  describe('Section 5: Full chain variants', () => {
    it('ATK-ARRCOERCE-22: PoC1 using getOwnPropertyDescriptor (singular)', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        try {
          const op = {}[['__proto__']];
          if (!op) return 'blocked_at_proto';
          const ho = op[['constructor']];
          if (!ho) return 'blocked_at_constructor';
          const desc = ho.getOwnPropertyDescriptor(this, '__host_memory_track__');
          if (!desc || typeof desc.value !== 'function') return 'no_memory_track';
          const F = desc.value[['constructor']];
          const fn = F('return process');
          const proc = fn();
          return {
            res: proc.getBuiltinModule('child_process')
              .execSync('id').toString().split('\\n'),
          };
        } catch (e) {
          return { blocked: true, error: e.message };
        }
      `;
      const result = await enclave.run(code);
      assertNoEscape(result);
      enclave.dispose();
    }, 15000);

    it('ATK-ARRCOERCE-23: PoC1 using Object.keys(this) + property access', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        try {
          const op = {}[['__proto__']];
          if (!op) return 'blocked_at_proto';
          const ho = op[['constructor']];
          if (!ho) return 'blocked_at_constructor';
          const keys = ho.keys(this);
          // Find __host_memory_track__ in the keys
          let trackFn = null;
          for (const k of keys) {
            if (k.indexOf('memory') !== -1 || k.indexOf('track') !== -1) {
              const val = this[k];
              if (typeof val === 'function') {
                trackFn = val;
                break;
              }
            }
          }
          if (!trackFn) return 'no_track_fn';
          const F = trackFn[['constructor']];
          const fn = F('return process');
          const proc = fn();
          return {
            res: proc.getBuiltinModule('child_process')
              .execSync('id').toString().split('\\n'),
          };
        } catch (e) {
          return { blocked: true, error: e.message };
        }
      `;
      const result = await enclave.run(code);
      assertNoEscape(result);
      enclave.dispose();
    }, 15000);

    it('ATK-ARRCOERCE-24: PoC2 using console.warn instead of console.log', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        try {
          const op = {}[['__proto__']];
          if (!op) return 'blocked_at_proto';
          const ho = op[['constructor']];
          if (!ho) return 'blocked_at_constructor';
          const glob = ho.getOwnPropertyDescriptors(this);
          const sym = glob[['Symbol']].value.for('nodejs.util.inspect.custom');

          let result;
          const obj = {
            [sym]: (depth, option, inspect) => {
              result = inspect[['constructor']]
                [['constructor']]('return process')()
                .getBuiltinModule('child_process')
                .execSync('id')
                .toString()
                .split('\\n');
            }
          };
          glob.__safe_console.value.warn(obj);
          return result;
        } catch (e) {
          return { blocked: true, error: e.message };
        }
      `;
      const result = await enclave.run(code);
      assertNoEscape(result);
      enclave.dispose();
    }, 15000);

    it('ATK-ARRCOERCE-25: PoC2 using console.error instead of console.log', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        try {
          const op = {}[['__proto__']];
          if (!op) return 'blocked_at_proto';
          const ho = op[['constructor']];
          if (!ho) return 'blocked_at_constructor';
          const glob = ho.getOwnPropertyDescriptors(this);
          const sym = glob[['Symbol']].value.for('nodejs.util.inspect.custom');

          let result;
          const obj = {
            [sym]: (depth, option, inspect) => {
              result = inspect[['constructor']]
                [['constructor']]('return process')()
                .getBuiltinModule('child_process')
                .execSync('id')
                .toString()
                .split('\\n');
            }
          };
          glob.__safe_console.value.error(obj);
          return result;
        } catch (e) {
          return { blocked: true, error: e.message };
        }
      `;
      const result = await enclave.run(code);
      assertNoEscape(result);
      enclave.dispose();
    }, 15000);

    it('ATK-ARRCOERCE-26: combined PoC1+PoC2 fallback chain', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        try {
          const op = {}[['__proto__']];
          if (!op) return 'blocked_at_proto';
          const ho = op[['constructor']];
          if (!ho) return 'blocked_at_constructor';
          const glob = ho.getOwnPropertyDescriptors(this);

          // Attempt PoC1 first (via __host_memory_track__)
          try {
            const trackDesc = glob.__host_memory_track__;
            if (trackDesc && typeof trackDesc.value === 'function') {
              const F = trackDesc.value[['constructor']];
              const fn = F('return process');
              const proc = fn();
              return {
                via: 'poc1',
                res: proc.getBuiltinModule('child_process')
                  .execSync('id').toString().split('\\n'),
              };
            }
          } catch (e) { /* fallback to PoC2 */ }

          // Attempt PoC2 (via inspect.custom)
          try {
            const sym = glob[['Symbol']].value.for('nodejs.util.inspect.custom');
            let result;
            const obj = {
              [sym]: (depth, option, inspect) => {
                result = inspect[['constructor']]
                  [['constructor']]('return process')()
                  .getBuiltinModule('child_process')
                  .execSync('id')
                  .toString()
                  .split('\\n');
              }
            };
            glob.__safe_console.value.log(obj);
            if (result) return { via: 'poc2', res: result };
          } catch (e) { /* both failed */ }

          return 'both_blocked';
        } catch (e) {
          return { blocked: true, error: e.message };
        }
      `;
      const result = await enclave.run(code);
      assertNoEscape(result);
      enclave.dispose();
    }, 15000);
  });

  // ── Section 6: Double VM Layer (ATK-ARRCOERCE-27 to 30) ────────────────────
  describe('Section 6: Double VM layer', () => {
    const POC1_CODE = `
      const op = {}[['__proto__']];
      const ho = op[['constructor']];
      const glob = ho.getOwnPropertyDescriptors(this);
      return {
        res: glob.__host_memory_track__.value[['constructor']]('return process')()
          .getBuiltinModule('child_process')
          .execSync('id')
          .toString()
          .split('\\n'),
      };
    `;

    const POC2_CODE = `
      const op = {}[['__proto__']];
      const ho = op[['constructor']];
      const glob = ho.getOwnPropertyDescriptors(this);
      const sym = glob[['Symbol']].value.for('nodejs.util.inspect.custom');

      let result;
      const obj = {
        [sym]: (depth, option, inspect) => {
          result = inspect[['constructor']]
            [['constructor']]('return process')()
            .getBuiltinModule('child_process')
            .execSync('id')
            .toString()
            .split('\\n');
        }
      };

      glob.__safe_console.value.log(obj);
      return { result };
    `;

    it('ATK-ARRCOERCE-27: PoC1 with doubleVm enabled (default)', async () => {
      const enclave = new Enclave({ timeout: 5000, doubleVm: { enabled: true } });
      const result = await enclave.run(POC1_CODE);
      assertNoEscape(result);
      enclave.dispose();
    }, 15000);

    it('ATK-ARRCOERCE-28: PoC2 with doubleVm enabled (default)', async () => {
      const enclave = new Enclave({ timeout: 5000, doubleVm: { enabled: true } });
      const result = await enclave.run(POC2_CODE);
      assertNoEscape(result);
      enclave.dispose();
    }, 15000);

    it('ATK-ARRCOERCE-29: PoC1 with doubleVm explicitly disabled', async () => {
      const enclave = new Enclave({ timeout: 5000, doubleVm: { enabled: false } });
      const result = await enclave.run(POC1_CODE);
      assertNoEscape(result);
      enclave.dispose();
    }, 15000);

    it('ATK-ARRCOERCE-30: PoC2 with doubleVm explicitly disabled', async () => {
      const enclave = new Enclave({ timeout: 5000, doubleVm: { enabled: false } });
      const result = await enclave.run(POC2_CODE);
      assertNoEscape(result);
      enclave.dispose();
    }, 15000);
  });

  // ── Section 7: Object toString/valueOf Coercion (ATK-ARRCOERCE-31 to 38) ──
  describe('Section 7: Object toString/valueOf coercion bypass', () => {
    it('ATK-ARRCOERCE-31: {toString: () => "__proto__"} direct key access', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        const proto = {}[{toString: () => '__proto__'}];
        if (proto === null || proto === undefined) return 'blocked';
        const ctor = proto[{toString: () => 'constructor'}];
        return { type: typeof ctor };
      `;
      const result = await enclave.run(code);
      assertNoEscape(result);
      enclave.dispose();
    }, 15000);

    it('ATK-ARRCOERCE-32: method shorthand toString() { return "constructor" }', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        const proto = {}[{toString() { return '__proto__' }}];
        if (proto === null || proto === undefined) return 'blocked';
        const ctor = proto[{toString() { return 'constructor' }}];
        return { type: typeof ctor };
      `;
      const result = await enclave.run(code);
      assertNoEscape(result);
      enclave.dispose();
    }, 15000);

    it('ATK-ARRCOERCE-33: valueOf-based coercion', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        const proto = {}[{valueOf: () => '__proto__'}];
        if (proto === null || proto === undefined) return 'blocked';
        return { type: typeof proto };
      `;
      const result = await enclave.run(code);
      assertNoEscape(result);
      enclave.dispose();
    }, 15000);

    it('ATK-ARRCOERCE-34: full escape chain via toString coercion', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        try {
          const op = {}[{toString: () => '__proto__'}];
          if (!op) return 'blocked_at_proto';
          const ho = op[{toString: () => 'constructor'}];
          if (!ho) return 'blocked_at_constructor';
          const glob = ho.getOwnPropertyDescriptors(this);
          return {
            res: glob.__host_memory_track__.value[{toString: () => 'constructor'}]('return process')()
              .getBuiltinModule('child_process')
              .execSync('id')
              .toString()
              .split('\\n'),
          };
        } catch (e) {
          return { blocked: true, error: e.message };
        }
      `;
      const result = await enclave.run(code);
      assertNoEscape(result);
      enclave.dispose();
    }, 15000);

    it('ATK-ARRCOERCE-35: mixed array + object coercion', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        try {
          const proto = {}[[{toString: () => '__proto__'}]];
          if (!proto) return 'blocked_at_proto';
          const ctor = proto[{toString: () => 'constructor'}];
          return { type: typeof ctor };
        } catch (e) {
          return { blocked: true, error: e.message };
        }
      `;
      const result = await enclave.run(code);
      assertNoEscape(result);
      enclave.dispose();
    }, 15000);

    it('ATK-ARRCOERCE-36: FunctionExpression syntax variant', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        try {
          const proto = {}[{toString: function() { return '__proto__' }}];
          if (!proto) return 'blocked_at_proto';
          const ctor = proto[{toString: function() { return 'constructor' }}];
          return { type: typeof ctor };
        } catch (e) {
          return { blocked: true, error: e.message };
        }
      `;
      const result = await enclave.run(code);
      assertNoEscape(result);
      enclave.dispose();
    }, 15000);

    it('ATK-ARRCOERCE-37: toString coercion with STRICT security level', async () => {
      const enclave = new Enclave({ securityLevel: 'STRICT', timeout: 5000 });
      const code = `
        const proto = {}[{toString: () => '__proto__'}];
        if (proto === null || proto === undefined) return 'blocked';
        const ctor = proto[{toString: () => 'constructor'}];
        return { type: typeof ctor };
      `;
      const result = await enclave.run(code);
      assertNoEscape(result);
      enclave.dispose();
    }, 15000);

    it('ATK-ARRCOERCE-38: toString coercion with PERMISSIVE security level', async () => {
      const enclave = new Enclave({ securityLevel: 'PERMISSIVE', timeout: 5000 });
      const code = `
        const proto = {}[{toString: () => '__proto__'}];
        if (proto === null || proto === undefined) return 'blocked';
        const ctor = proto[{toString: () => 'constructor'}];
        return { type: typeof ctor };
      `;
      const result = await enclave.run(code);
      assertNoEscape(result);
      enclave.dispose();
    }, 15000);
  });

  // ── Section 8: Computed-Key Bypass Vectors (ATK-ARRCOERCE-39 to 47) ────────
  describe('Section 8: Computed-key bypass vectors', () => {
    it('ATK-ARRCOERCE-39: template literal `__proto__` as computed key', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code =
        'const proto = {}[`__proto__`]; if (proto === null || proto === undefined) return "blocked"; return { type: typeof proto };';
      const result = await enclave.run(code);
      assertNoEscape(result);
      enclave.dispose();
    }, 15000);

    it('ATK-ARRCOERCE-40: conditional expression true ? "__proto__" : "x"', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        const proto = {}[true ? '__proto__' : 'x'];
        if (proto === null || proto === undefined) return 'blocked';
        const ctor = proto[true ? 'constructor' : 'y'];
        return { type: typeof ctor };
      `;
      const result = await enclave.run(code);
      assertNoEscape(result);
      enclave.dispose();
    }, 15000);

    it('ATK-ARRCOERCE-41: sequence expression (0, "__proto__")', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        const proto = {}[(0, '__proto__')];
        if (proto === null || proto === undefined) return 'blocked';
        const ctor = proto[(0, 'constructor')];
        return { type: typeof ctor };
      `;
      const result = await enclave.run(code);
      assertNoEscape(result);
      enclave.dispose();
    }, 15000);

    it('ATK-ARRCOERCE-42: assignment expression x = "__proto__"', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        let x;
        const proto = {}[x = '__proto__'];
        if (proto === null || proto === undefined) return 'blocked';
        const ctor = proto[x = 'constructor'];
        return { type: typeof ctor };
      `;
      const result = await enclave.run(code);
      assertNoEscape(result);
      enclave.dispose();
    }, 15000);

    it('ATK-ARRCOERCE-43: logical OR "" || "__proto__"', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        const proto = {}['' || '__proto__'];
        if (proto === null || proto === undefined) return 'blocked';
        const ctor = proto['' || 'constructor'];
        return { type: typeof ctor };
      `;
      const result = await enclave.run(code);
      assertNoEscape(result);
      enclave.dispose();
    }, 15000);

    it('ATK-ARRCOERCE-44: full escape chain using template literal coercion', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = [
        'try {',
        '  const op = {}[`__proto__`];',
        '  if (!op) return "blocked_at_proto";',
        '  const ho = op[`constructor`];',
        '  if (!ho) return "blocked_at_constructor";',
        '  const glob = ho.getOwnPropertyDescriptors(this);',
        '  return {',
        '    res: glob.__host_memory_track__.value[`constructor`]("return process")()',
        '      .getBuiltinModule("child_process")',
        '      .execSync("id")',
        '      .toString()',
        '      .split("\\n"),',
        '  };',
        '} catch (e) {',
        '  return { blocked: true, error: e.message };',
        '}',
      ].join('\n');
      const result = await enclave.run(code);
      assertNoEscape(result);
      enclave.dispose();
    }, 15000);

    it('ATK-ARRCOERCE-45: full escape chain using conditional coercion', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        try {
          const op = {}[true ? '__proto__' : 'x'];
          if (!op) return 'blocked_at_proto';
          const ho = op[true ? 'constructor' : 'y'];
          if (!ho) return 'blocked_at_constructor';
          const glob = ho.getOwnPropertyDescriptors(this);
          return {
            res: glob.__host_memory_track__.value[true ? 'constructor' : 'z']('return process')()
              .getBuiltinModule('child_process')
              .execSync('id')
              .toString()
              .split('\\n'),
          };
        } catch (e) {
          return { blocked: true, error: e.message };
        }
      `;
      const result = await enclave.run(code);
      assertNoEscape(result);
      enclave.dispose();
    }, 15000);

    it('ATK-ARRCOERCE-46: getter-based toString coercion', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        try {
          const proto = {}[{get toString(){ return () => '__proto__' }}];
          if (!proto) return 'blocked_at_proto';
          const ctor = proto[{get toString(){ return () => 'constructor' }}];
          return { type: typeof ctor };
        } catch (e) {
          return { blocked: true, error: e.message };
        }
      `;
      const result = await enclave.run(code);
      assertNoEscape(result);
      enclave.dispose();
    }, 15000);

    it('ATK-ARRCOERCE-47: mixed vectors (template + conditional + sequence)', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = [
        'try {',
        '  const op = {}[`__proto__`];',
        '  if (!op) return "blocked_at_proto";',
        '  const ho = op[true ? "constructor" : "x"];',
        '  if (!ho) return "blocked_at_constructor";',
        '  const glob = ho.getOwnPropertyDescriptors(this);',
        '  const trackDesc = glob.__host_memory_track__;',
        '  if (!trackDesc || typeof trackDesc.value !== "function") return "no_memory_track";',
        '  const F = trackDesc.value[(0, "constructor")];',
        '  const fn = F("return process");',
        '  const proc = fn();',
        '  return {',
        '    res: proc.getBuiltinModule("child_process")',
        '      .execSync("id").toString().split("\\n"),',
        '  };',
        '} catch (e) {',
        '  return { blocked: true, error: e.message };',
        '}',
      ].join('\n');
      const result = await enclave.run(code);
      assertNoEscape(result);
      enclave.dispose();
    }, 15000);
  });
});
