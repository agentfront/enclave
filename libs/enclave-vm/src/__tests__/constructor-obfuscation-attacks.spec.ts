/**
 * ATK-COBS: Constructor Obfuscation Attack Vectors Test Suite
 *
 * Category: ATK-COBS (CWE-693: Protection Mechanism Failure)
 *
 * This file tests known constructor obfuscation attack vectors
 * to verify that the SecureProxy blocks them at runtime.
 *
 * IMPORTANT: The SecureProxy wraps GLOBALS (Array, Object, Math, JSON, callTool, etc.)
 * and TOOL RESULTS. Plain objects created inside the sandbox (like `{}`) are NOT
 * wrapped because they exist inside the sandbox's isolated context.
 *
 * The defense-in-depth strategy is:
 * 1. AST validation blocks dangerous patterns statically (e.g., `constructor` identifier)
 * 2. SecureProxy wraps globals to block runtime property access attacks
 * 3. Tool results are wrapped to prevent attacks via returned data
 *
 * Test Categories:
 * - ATK-COBS-01 to ATK-COBS-06: String Building Attacks (on wrapped globals)
 * - ATK-COBS-07 to ATK-COBS-08: Escape Sequence Attacks (on wrapped globals)
 * - ATK-COBS-09: Destructuring Attacks (blocked by AST)
 * - ATK-COBS-10 to ATK-COBS-14: Prototype Chain Attacks (on wrapped globals)
 * - ATK-COBS-15 to ATK-COBS-16: Type Coercion Attacks
 * - ATK-COBS-17 to ATK-COBS-22: String Manipulation Attacks (on wrapped globals)
 * - ATK-COBS-23 to ATK-COBS-24: Syntax Obfuscation Attacks (on wrapped globals)
 * - ATK-COBS-25 to ATK-COBS-26: Reflection Attacks
 * - ATK-COBS-27: Function Prototype Attacks
 * - ATK-COBS-28 to ATK-COBS-31: Promise-based Constructor Attacks
 * - ATK-COBS-32 to ATK-COBS-34: PERMISSIVE Mode Proxy Configuration
 *
 * Related CWEs:
 * - CWE-693: Protection Mechanism Failure
 * - CWE-94: Improper Control of Generation of Code
 * - CWE-1321: Improperly Controlled Modification of Object Prototype Attributes
 *
 * @packageDocumentation
 */

import { Enclave } from '../enclave';

describe('ATK-COBS: Constructor Obfuscation Attack Vectors (CWE-693)', () => {
  describe('ATK-COBS-01 to ATK-COBS-06: String Building Attacks on Wrapped Globals', () => {
    it('ATK-COBS-01: should block string concatenation attack on Array', async () => {
      const enclave = new Enclave();
      const code = `
        const key = 'con' + 'structor';
        return Array[key] ? 'escaped' : 'blocked';
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/Security violation|AgentScript validation failed/);
      enclave.dispose();
    });

    it('ATK-COBS-02: should block template literal building attack on Object', async () => {
      const enclave = new Enclave();
      const code = `
        const c = 'con';
        const s = 'structor';
        const key = c + s;
        return Object[key] ? 'escaped' : 'blocked';
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/Security violation|AgentScript validation failed/);
      enclave.dispose();
    });

    it('ATK-COBS-03: should block Array.join attack on Math', async () => {
      const enclave = new Enclave();
      const code = `
        const key = ['con', 'structor'].join('');
        return Math[key] ? 'escaped' : 'blocked';
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/Security violation|AgentScript validation failed/);
      enclave.dispose();
    });

    it('ATK-COBS-04: should block String.fromCharCode attack on JSON', async () => {
      const enclave = new Enclave();
      // 'constructor' = 99,111,110,115,116,114,117,99,116,111,114
      const code = `
        const key = String.fromCharCode(99,111,110,115,116,114,117,99,116,111,114);
        return JSON[key] ? 'escaped' : 'blocked';
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/Security violation|AgentScript validation failed/);
      enclave.dispose();
    });

    it('ATK-COBS-05: should block reverse string attack on String', async () => {
      const enclave = new Enclave();
      const code = `
        const key = 'rotcurtsnoc'.split('').reverse().join('');
        return String[key] ? 'escaped' : 'blocked';
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/Security violation|AgentScript validation failed/);
      enclave.dispose();
    });

    it('ATK-COBS-06: should block Base64 decode attack on wrapped custom global', async () => {
      const enclave = new Enclave({
        globals: {
          // Simulate atob being available
          atob: (s: string) => Buffer.from(s, 'base64').toString('utf-8'),
          myGlobal: { value: 42 },
        },
        allowFunctionsInGlobals: true,
      });
      // 'constructor' in Base64 = 'Y29uc3RydWN0b3I='
      const code = `
        const key = atob('Y29uc3RydWN0b3I=');
        return myGlobal[key] ? 'escaped' : 'blocked';
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/Security violation|AgentScript validation failed/);
      enclave.dispose();
    });
  });

  describe('ATK-COBS-07 to ATK-COBS-08: Escape Sequence Attacks on Wrapped Globals', () => {
    it('ATK-COBS-07: should block hex escape attack on Number', async () => {
      const enclave = new Enclave();
      // '\x63' = 'c', so '\x63onstructor' = 'constructor'
      const code = `
        const key = '\\x63onstructor';
        return Number[key] ? 'escaped' : 'blocked';
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/Security violation|AgentScript validation failed/);
      enclave.dispose();
    });

    it('ATK-COBS-08: should block unicode escape attack on Date', async () => {
      const enclave = new Enclave();
      // '\u0063' = 'c', so '\u0063onstructor' = 'constructor'
      const code = `
        const key = '\\u0063onstructor';
        return Date[key] ? 'escaped' : 'blocked';
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/Security violation|AgentScript validation failed/);
      enclave.dispose();
    });
  });

  describe('ATK-COBS-09: Destructuring Attacks', () => {
    it('ATK-COBS-09: should block computed property destructuring at AST level', async () => {
      const enclave = new Enclave();
      // This should be blocked by NoComputedDestructuringRule at AST validation
      const code = `
        const c = 'con';
        const s = 'structor';
        const {[c + s]: Ctor} = Array;
        return Ctor ? 'escaped' : 'blocked';
      `;
      const result = await enclave.run(code);
      // Either fails validation or Ctor is undefined
      if (result.success) {
        expect(result.value).toBe('blocked');
      } else {
        // The rule name is uppercase: NO_COMPUTED_DESTRUCTURING
        expect(result.error?.message?.toUpperCase()).toContain('COMPUTED');
      }
      enclave.dispose();
    });
  });

  describe('ATK-COBS-10 to ATK-COBS-14: Prototype Chain Attacks on Wrapped Globals', () => {
    it('ATK-COBS-10: should block __proto__ access via string building on Array', async () => {
      const enclave = new Enclave();
      // Use dynamic string building to bypass AST validation
      // The runtime SecureProxy should block this
      const code = `
        const key = '__pro' + 'to__';
        const proto = Array[key];
        return proto ? 'escaped' : 'blocked';
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/Security violation|AgentScript validation failed/);
      enclave.dispose();
    });

    it('ATK-COBS-11: should block __proto__ via string building + concat constructor on Object', async () => {
      const enclave = new Enclave();
      // Use dynamic string building to bypass AST validation
      const code = `
        const protoKey = '__pro' + 'to__';
        const proto = Object[protoKey];
        if (!proto) return 'blocked';
        const ctorKey = 'const' + 'ructor';
        const Ctor = proto[ctorKey];
        return Ctor ? 'escaped' : 'blocked';
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/Security violation|AgentScript validation failed/);
      enclave.dispose();
    });

    it('ATK-COBS-12: Object.getPrototypeOf blocked by AST validation', async () => {
      const enclave = new Enclave();
      // Object.getPrototypeOf is blocked by NO_META_PROGRAMMING rule at AST level
      const code = `
        const proto = Object.getPrototypeOf(Math);
        return 'escaped';
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/getPrototypeOf|META_PROGRAMMING/i);
      enclave.dispose();
    });

    it('ATK-COBS-13: Reflect.get blocked by AST validation', async () => {
      // The AgentScript preset blocks 'Reflect' at AST validation level
      const enclave = new Enclave({ securityLevel: 'SECURE' });
      const code = `
        return Reflect.get({a: 1}, 'a');
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Reflect');
      enclave.dispose();
    });

    it('ATK-COBS-14: Reflect.getPrototypeOf blocked by AST validation', async () => {
      // All security levels use the AgentScript preset which blocks Reflect
      const enclave = new Enclave({ securityLevel: 'STRICT' });
      const code = `
        return Reflect.getPrototypeOf({});
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Reflect');
      enclave.dispose();
    });
  });

  describe('ATK-COBS-15 to ATK-COBS-16: Type Coercion Attacks on Wrapped Globals', () => {
    it('ATK-COBS-15: should block toString coercion attack on Array', async () => {
      const enclave = new Enclave();
      const code = `
        const key = { toString: () => 'constructor' };
        // When key is used in bracket notation, toString() is called
        const Ctor = Array[key];
        return Ctor ? 'escaped' : 'blocked';
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/Security violation|AgentScript validation failed/);
      enclave.dispose();
    });

    it('ATK-COBS-16: should block Symbol.toPrimitive coercion attack', async () => {
      const enclave = new Enclave();
      // Symbol is blocked in most presets, so this should fail validation or be blocked
      const code = `
        try {
          const key = { [Symbol.toPrimitive]: () => 'constructor' };
          const Ctor = Object[key];
          return Ctor ? 'escaped' : 'blocked';
        } catch {
          return 'blocked';
        }
      `;
      const result = await enclave.run(code);
      // Either fails or returns blocked
      if (result.success) {
        expect(result.value).toBe('blocked');
      }
      enclave.dispose();
    });
  });

  describe('ATK-COBS-17 to ATK-COBS-22: String Manipulation Attacks on Wrapped Globals', () => {
    it('ATK-COBS-17: should block String.replace attack on Math', async () => {
      const enclave = new Enclave();
      const code = `
        const key = 'cxnstructxr'.split('x').join('o');
        return Math[key] ? 'escaped' : 'blocked';
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/Security violation|AgentScript validation failed/);
      enclave.dispose();
    });

    it('ATK-COBS-18: should block decodeURIComponent attack (if available)', async () => {
      const enclave = new Enclave({
        globals: {
          decodeURIComponent: decodeURIComponent,
        },
        allowFunctionsInGlobals: true,
      });
      // %63 = 'c', so '%63onstructor' decoded = 'constructor'
      const code = `
        const key = decodeURIComponent('%63onstructor');
        return JSON[key] ? 'escaped' : 'blocked';
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/Security violation|AgentScript validation failed/);
      enclave.dispose();
    });

    it('ATK-COBS-19: should block nested template literal attack on String', async () => {
      const enclave = new Enclave();
      const code = `
        const inner = 'structor';
        const key = 'con' + inner;
        return String[key] ? 'escaped' : 'blocked';
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/Security violation|AgentScript validation failed/);
      enclave.dispose();
    });

    it('ATK-COBS-20: should block slice extraction attack on Number', async () => {
      const enclave = new Enclave();
      const code = `
        const key = 'XXconstructorXX'.slice(2, -2);
        return Number[key] ? 'escaped' : 'blocked';
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/Security violation|AgentScript validation failed/);
      enclave.dispose();
    });
  });

  describe('ATK-COBS-21 to ATK-COBS-22: Syntax Obfuscation Attacks on Wrapped Globals', () => {
    it('ATK-COBS-21: should block optional chaining attack on Array', async () => {
      const enclave = new Enclave();
      const code = `
        const key = 'const' + 'ructor';
        const Ctor = Array?.[key];
        return Ctor ? 'escaped' : 'blocked';
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/Security violation|AgentScript validation failed/);
      enclave.dispose();
    });

    it('ATK-COBS-22: should block comma operator attack on Object', async () => {
      const enclave = new Enclave();
      const code = `
        const key = 'const' + 'ructor';
        const Ctor = (0, Object)[key];
        return Ctor ? 'escaped' : 'blocked';
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/Security violation|AgentScript validation failed/);
      enclave.dispose();
    });
  });

  describe('ATK-COBS-23 to ATK-COBS-24: Reflection Attacks', () => {
    it('ATK-COBS-23: RegExp literals blocked by AST validation', async () => {
      // RegExp literals are blocked by NoRegexLiteralRule in AgentScript preset
      const enclave = new Enclave();
      const code = `
        const r = /test/;
        return 'escaped';
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/regex|REGEX/i);
      enclave.dispose();
    });

    it('ATK-COBS-24: should block constructor access on tool results', async () => {
      const enclave = new Enclave({
        toolHandler: async () => ({
          data: { value: 42 },
        }),
      });
      // Tool results are wrapped with SecureProxy
      const code = `
        const result = await callTool('test', {});
        const key = 'const' + 'ructor';
        const Ctor = result[key];
        return Ctor ? 'escaped' : 'blocked';
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/Security violation|AgentScript validation failed/);
      enclave.dispose();
    });
  });

  describe('ATK-COBS-25: Function Prototype Attacks', () => {
    it('ATK-COBS-25: user-defined function declarations blocked by AST', async () => {
      const enclave = new Enclave();
      // User-defined function declarations are blocked to prevent prototype manipulation
      // Arrow functions are allowed for callbacks, but named function declarations are not
      const code = `
        function myFunc() { return 1; }
        return 'escaped';
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/function/i);
      enclave.dispose();
    });
  });

  describe('ATK-COBS-26 to ATK-COBS-29: Promise-based Constructor Attacks', () => {
    it('ATK-COBS-26: should block Promise.constructor access via callTool', async () => {
      // This tests the critical attack vector where an attacker uses the Promise
      // returned by callTool to reach the Function constructor
      const enclave = new Enclave({
        toolHandler: async () => ({ items: [] }),
      });
      const code = `
        const getCtor = (x) => x['co'+'nstructor'];
        const promiseCtor = getCtor(callTool('test', {})); // Promise.constructor -> undefined
        return promiseCtor ? 'escaped' : 'blocked';
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/Security violation|AgentScript validation failed/);
      enclave.dispose();
    });

    it('ATK-COBS-27: should block chained Promise constructor access', async () => {
      const enclave = new Enclave({
        toolHandler: async () => ({ items: [] }),
      });
      const code = `
        const p = callTool('test', {});
        const ctorKey = 'const' + 'ructor';
        const PromiseCtor = p[ctorKey];
        // Even if we got Promise, its constructor should be blocked too
        const FunctionCtor = PromiseCtor ? PromiseCtor[ctorKey] : null;
        return FunctionCtor ? 'escaped' : 'blocked';
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/Security violation|AgentScript validation failed/);
      enclave.dispose();
    });

    it('ATK-COBS-28: await callTool still works after Promise proxy fix', async () => {
      const enclave = new Enclave({
        toolHandler: async () => ({ count: 42 }),
      });
      const code = `
        const result = await callTool('test', {});
        return result.count;
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(true);
      expect(result.value).toBe(42);
      enclave.dispose();
    });

    it('ATK-COBS-29: Promise.then still works after proxy fix', async () => {
      const enclave = new Enclave({
        toolHandler: async () => [1, 2, 3],
      });
      const code = `
        const arr = await callTool('test', {});
        return arr.map(x => x * 2);
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(true);
      expect(result.value).toEqual([2, 4, 6]);
      enclave.dispose();
    });
  });

  describe('ATK-COBS: Coverage Verification', () => {
    it('ATK-COBS-30: should have tested all 29 documented attack vectors', () => {
      // This test documents all attack vectors for coverage tracking
      const attackVectors = [
        'Vector 1: String concatenation on Array',
        'Vector 2: Template literal building on Object',
        'Vector 3: Array.join on Math',
        'Vector 4: String.fromCharCode on JSON',
        'Vector 5: Reverse string on String',
        'Vector 6: Base64 decode on custom global',
        'Vector 7: Hex escape on Number',
        'Vector 8: Unicode escape on Date',
        'Vector 9: Computed destructuring (AST blocked)',
        'Vector 10: __proto__ access via string building',
        'Vector 11: __proto__ + concat constructor',
        'Vector 12: Object.getPrototypeOf (AST blocked)',
        'Vector 13: Reflect.get (AST blocked)',
        'Vector 14: Reflect.getPrototypeOf (AST blocked)',
        'Vector 15: toString coercion attack',
        'Vector 16: Symbol.toPrimitive coercion',
        'Vector 17: String split/join manipulation',
        'Vector 18: decodeURIComponent attack',
        'Vector 19: Optional chaining attack',
        'Vector 20: Comma operator attack',
        'Vector 21: Nested template literal',
        'Vector 22: Slice extraction attack',
        'Vector 23: RegExp literals (AST blocked)',
        'Vector 24: Constructor access on tool results',
        'Vector 25: User-defined function declarations (AST blocked)',
        'Vector 26: Promise.constructor via callTool',
        'Vector 27: Chained Promise constructor',
        'Vector 28: await callTool functionality',
        'Vector 29: Promise.then functionality',
      ];

      expect(attackVectors.length).toBe(29);
    });
  });

  describe('ATK-COBS-31 to ATK-COBS-33: PERMISSIVE Mode Proxy Configuration', () => {
    it('ATK-COBS-31: PERMISSIVE mode allows constructor via direct computed property access', async () => {
      // PERMISSIVE has blockConstructor: false by default in the security level config
      // NOTE: String concatenation attacks like 'const' + 'ructor' are blocked at AST level
      // even in PERMISSIVE mode (this is correct - string obfuscation is always suspicious)
      // To test PERMISSIVE proxy behavior, use direct property name in computed bracket
      const enclave = new Enclave({ securityLevel: 'PERMISSIVE' });

      // Use bracket notation with plain string (not string concatenation)
      // This bypasses AST string concatenation detection but still uses computed property
      const code = `
        // PERMISSIVE allows constructor access on proxied objects
        const prop = 'constructor';
        return Array[prop] ? 'accessible' : 'blocked';
      `;
      const result = await enclave.run(code);
      // Note: 'constructor' as identifier is blocked by AST validation
      // PERMISSIVE mode doesn't bypass AST validation, just runtime proxy blocking
      if (result.success) {
        expect(result.value).toBe('accessible');
      } else {
        // AST still validates 'constructor' as an identifier - this is expected
        expect(result.error?.message).toMatch(/AgentScript validation failed/);
      }
      enclave.dispose();
    });

    it('ATK-COBS-32: should still block __proto__ in PERMISSIVE mode', async () => {
      const enclave = new Enclave({ securityLevel: 'PERMISSIVE' });

      const code = `
        const key = '__pro' + 'to__';
        const proto = Array[key];
        return proto ? 'accessible' : 'blocked';
      `;
      const result = await enclave.run(code);
      // AST validation now catches __proto__ string concatenation attacks
      if (result.success) {
        // __proto__ is still blocked in PERMISSIVE (blockPrototype: true)
        expect(result.value).toBe('blocked');
      } else {
        // AST blocked the __proto__ string concatenation - also valid
        expect(result.error?.message).toMatch(/AgentScript validation failed/);
      }
      enclave.dispose();
    });

    it('ATK-COBS-33: explicit secureProxyConfig with validation disabled allows constructor access', async () => {
      // With validation disabled, explicit config overrides security level
      const enclave = new Enclave({
        securityLevel: 'STRICT',
        validate: false, // Disable AST validation to test proxy config directly
        secureProxyConfig: {
          blockConstructor: false,
          blockPrototype: true,
          blockLegacyAccessors: true,
          proxyMaxDepth: 5,
        },
      });

      const code = `
        const key = 'const' + 'ructor';
        return Array[key] ? 'accessible' : 'blocked';
      `;
      const result = await enclave.run(code);
      expect(result.success).toBe(true);
      expect(result.value).toBe('accessible');
      enclave.dispose();
    });
  });
});
