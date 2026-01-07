/**
 * Literal Constructor Escape Prevention Tests
 *
 * These tests verify that the security hardening prevents sandbox escape
 * via constructor chain attacks using array/object literals.
 *
 * Attack vector:
 * ```javascript
 * const c = 'con' + 'struc' + 'tor';
 * const arr = [];  // NOT wrapped by SecureProxy
 * const Fn = arr[c][c];  // Gets Function constructor
 * const payload = Fn('return process.env');  // Untransformed code!
 * payload();  // Executes outside sandbox protections
 * ```
 *
 * Defense layers:
 * 1. codeGeneration: { strings: false } - Disables new Function() from strings
 * 2. Frozen prototypes - Prevents prototype pollution
 */

import { Enclave } from '../enclave';

describe('Literal Constructor Escape Prevention', () => {
  describe('Array Literal Constructor Chain Attack', () => {
    it('should block Function constructor from array literal', async () => {
      const enclave = new Enclave();
      const code = `
        const c = 'con' + 'struc' + 'tor';
        const arr = [];
        const Fn = arr[c][c];
        return Fn('return 42')();
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(false);
      // Should fail at AST level (constructor obfuscation detected) or VM level (codeGeneration.strings disabled)
      expect(result.error?.message).toMatch(/code generation from strings|EvalError|AgentScript validation failed/i);
      enclave.dispose();
    });

    it('should block Function constructor with process.env access', async () => {
      const enclave = new Enclave();
      const code = `
        const part1 = 'con';
        const part2 = 'struc';
        const part3 = 'tor';
        const c = part1 + part2 + part3;
        const ArrayInstance = [];
        const FunctionConstructor = ArrayInstance[c][c];
        const payload = FunctionConstructor('return process.env');
        return payload();
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(false);
      enclave.dispose();
    });

    it('should block Function constructor with infinite loop', async () => {
      const enclave = new Enclave({ timeout: 1000 });
      const code = `
        const c = 'con' + 'struc' + 'tor';
        const Fn = [][c][c];
        const payload = Fn('while(true){}');
        return payload();
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(false);
      enclave.dispose();
    }, 5000);

    it('should block Function constructor with Error stack leak', async () => {
      const enclave = new Enclave();
      const code = `
        const c = 'con' + 'struc' + 'tor';
        const Fn = [][c][c];
        const payload = Fn('return new Error().stack');
        return payload();
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(false);
      enclave.dispose();
    });
  });

  describe('Object Literal Constructor Chain Attack', () => {
    it('should block Function constructor from object literal', async () => {
      const enclave = new Enclave();
      const code = `
        const c = 'con' + 'struc' + 'tor';
        const obj = {};
        const Fn = obj[c][c];
        return Fn('return 42')();
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(false);
      enclave.dispose();
    });

    it('should block Function constructor via Object.prototype chain', async () => {
      const enclave = new Enclave();
      const code = `
        const c = 'const' + 'ructor';
        const obj = { a: 1 };
        const ObjectCtor = obj[c];
        const FunctionCtor = ObjectCtor[c];
        return FunctionCtor('return this')();
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(false);
      enclave.dispose();
    });
  });

  describe('String/Number Literal Constructor Chain Attack', () => {
    it('should block Function constructor from string methods', async () => {
      const enclave = new Enclave();
      const code = `
        const c = 'con' + 'struc' + 'tor';
        const str = 'hello';
        const Fn = str.slice[c][c];
        return Fn('return 42')();
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(false);
      enclave.dispose();
    });
  });

  describe('Double VM Layer Protection', () => {
    it('should block attack in double VM mode', async () => {
      const enclave = new Enclave({
        doubleVm: {}, // Enable double VM with defaults
        toolHandler: async () => ({ data: 'test' }),
      });
      const code = `
        const c = 'con' + 'struc' + 'tor';
        const Fn = [][c][c];
        const payload = Fn('return process.env');
        return payload();
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(false);
      enclave.dispose();
    });
  });

  describe('Legitimate Code Still Works', () => {
    it('should allow normal array operations', async () => {
      const enclave = new Enclave();
      const code = `return [1, 2, 3].map(x => x * 2)`;
      const result = await enclave.run(code);
      expect(result.success).toBe(true);
      expect(result.value).toEqual([2, 4, 6]);
      enclave.dispose();
    });

    it('should allow normal object operations', async () => {
      const enclave = new Enclave();
      const code = `
        const obj = { foo: 'bar', count: 42 };
        const key = 'co' + 'unt';
        return obj[key];
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(true);
      expect(result.value).toBe(42);
      enclave.dispose();
    });

    it('should allow array methods', async () => {
      const enclave = new Enclave();
      const code = `
        const arr = [1, 2, 3, 4, 5];
        return arr.filter(x => x > 2).reduce((a, b) => a + b, 0);
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(true);
      expect(result.value).toBe(12); // 3 + 4 + 5
      enclave.dispose();
    });

    it('should allow string operations', async () => {
      const enclave = new Enclave();
      const code = `
        const str = 'hello world';
        return str.split(' ').map(s => s.toUpperCase()).join('-');
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(true);
      expect(result.value).toBe('HELLO-WORLD');
      enclave.dispose();
    });

    it('should allow Promise operations', async () => {
      const enclave = new Enclave({
        toolHandler: async () => ({ value: 42 }),
      });
      const code = `
        const result = await callTool('test', {});
        return result.value * 2;
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(true);
      expect(result.value).toBe(84);
      enclave.dispose();
    });
  });

  describe('Prototype Freezing', () => {
    it('should prevent prototype pollution via __proto__', async () => {
      const enclave = new Enclave();
      const code = `
        const obj = {};
        try {
          obj.__proto__.polluted = true;
          return { polluted: true };
        } catch (e) {
          return { polluted: false, error: e.message };
        }
      `;
      const result = await enclave.run(code);
      // Either blocked by SecureProxy or frozen prototype
      if (result.success) {
        expect((result.value as { polluted: boolean }).polluted).toBe(false);
      }
      enclave.dispose();
    });

    it('should prevent Object.prototype pollution', async () => {
      const enclave = new Enclave();
      const code = `
        try {
          Object.prototype.polluted = true;
          return { polluted: true };
        } catch (e) {
          return { polluted: false, frozen: true };
        }
      `;
      const result = await enclave.run(code);
      if (result.success) {
        expect((result.value as { frozen: boolean }).frozen).toBe(true);
      }
      enclave.dispose();
    });
  });
});

describe('Memory Exhaustion Prevention', () => {
  describe('Single VM Mode', () => {
    it('should block large Array.join operations', async () => {
      const enclave = new Enclave({
        memoryLimit: 1024 * 1024, // 1MB
        doubleVm: { enabled: false },
      });
      const code = `
        const huge = new Array(12 * 1024 * 1024).join('x');
        return huge.length;
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/memory limit/i);
      enclave.dispose();
    }, 10000);

    it('should allow small Array.join operations', async () => {
      const enclave = new Enclave({
        memoryLimit: 1024 * 1024, // 1MB
        doubleVm: { enabled: false },
      });
      const code = `
        const small = new Array(100).fill('x').join(',');
        return small.length;
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(true);
      enclave.dispose();
    });
  });

  describe('Double VM Mode', () => {
    // Double VM memory protection works because we use the inner context's
    // intrinsic constructors (Array, String, etc.) in safeGlobals, ensuring
    // that new Array() creates arrays with the patched prototype chain.
    it('should block large Array.join via constructor', async () => {
      const enclave = new Enclave({ memoryLimit: 1024 * 1024 }); // 1MB, double VM by default
      const code = `
        const huge = new Array(12 * 1024 * 1024).join('x');
        return huge.length;
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/memory limit/i);
      enclave.dispose();
    }, 10000);

    it('should block large Array.join via literal', async () => {
      const enclave = new Enclave({ memoryLimit: 1024 * 1024 }); // 1MB
      const code = `
        const arr = [];
        arr.length = 12 * 1024 * 1024;
        return arr.join('x').length;
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/memory limit/i);
      enclave.dispose();
    }, 10000);

    it('should block large String.repeat', async () => {
      const enclave = new Enclave({ memoryLimit: 1024 * 1024 }); // 1MB
      const code = `
        const huge = 'x'.repeat(12 * 1024 * 1024);
        return huge.length;
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/memory limit/i);
      enclave.dispose();
    }, 10000);

    it('should allow small Array.join operations', async () => {
      const enclave = new Enclave({ memoryLimit: 1024 * 1024 }); // 1MB
      const code = `
        const small = new Array(100).fill('x').join(',');
        return small.length;
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(true);
      enclave.dispose();
    });

    it('should allow small String.repeat operations', async () => {
      const enclave = new Enclave({ memoryLimit: 1024 * 1024 }); // 1MB
      const code = `
        return 'abc'.repeat(100);
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(true);
      expect(result.value).toBe('abc'.repeat(100));
      enclave.dispose();
    });
  });
});

describe('CPU Exhaustion Prevention', () => {
  // Note: BigInt exponentiation performance varies by platform
  // This test verifies timeout mechanism works for CPU-heavy operations
  it('should timeout on heavy BigInt operations (platform-dependent)', async () => {
    const enclave = new Enclave({ timeout: 100 }); // 100ms - very short timeout
    const code = `
      const result = 10n ** 100000n;
      return result.toString().length;
    `;
    const result = await enclave.run(code);
    expect(result.success).toBe(false);
    enclave.dispose();
  }, 5000);

  it('should allow reasonable BigInt operations', async () => {
    const enclave = new Enclave({ timeout: 5000 });
    const code = `
      const a = 123456789n;
      const b = 987654321n;
      return (a * b).toString();
    `;
    const result = await enclave.run(code);
    expect(result.success).toBe(true);
    enclave.dispose();
  });
});
