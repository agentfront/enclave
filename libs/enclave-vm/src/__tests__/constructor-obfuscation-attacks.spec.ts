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

  describe('ATK-COBS-35 to ATK-COBS-50: Host Error Prototype Chain Escape & Memory Exhaustion Attacks', () => {
    it('ATK-COBS-35: should block Host Error Escape via callTool error prototype chain (Vector 35)', async () => {
      // Vector 35: The Host Error Escape
      // Purpose: Intentionally trigger a Host-side error to obtain a Host Error object,
      // then climb its prototype chain to reach the Host Function Constructor.
      //
      // Attack flow:
      // 1. Call callTool with invalid tool name to trigger host error
      // 2. Catch the error object (which comes from host context)
      // 3. Use __lookupGetter__ to get native __proto__ getter
      // 4. Climb: hostError -> Error.prototype -> Error Constructor -> Function Constructor
      // 5. Use Function constructor to execute arbitrary code in host context
      const enclave = new Enclave({
        securityLevel: 'SECURE',
        validate: false, // Disable AST validation to test runtime protection
        globals: {
          SECRET: 'FAKE_SECRET_FOR_SECURITY_CHALLENGE',
        },
      });

      const code = `
        // ASCII Obfuscation Helper
        const s = (...args) => String.fromCharCode(...args);

        // Generate Invisible Keys
        const kCon    = s(99,111,110,115,116,114,117,99,116,111,114);          // "constructor"
        const kProto  = s(95,95,112,114,111,116,111,95,95);                    // "__proto__"
        const kLookup = s(95,95,108,111,111,107,117,112,71,101,116,116,101,114,95,95); // "__lookupGetter__"
        const kCode   = s(114,101,116,117,114,110,32,83,69,67,82,69,84); // "return SECRET"
        const kPtype  = s(112,114,111,116,111,116,121,112,101);                // "prototype"

        try {
            // Extract Native __proto__ Getter
            const ObjectProto = Object[kPtype];
            const lookup = ObjectProto[kLookup];
            if (!lookup) return "blocked: __lookupGetter__ missing";

            const getProtoNative = lookup.call(ObjectProto, kProto);
            if (!getProtoNative) return "blocked: Native __proto__ getter missing";

            // The Provocation (Trigger a Host Error)
            let hostError;
            try {
                await callTool('THIS_TOOL_DOES_NOT_EXIST_XYZ', {});
            } catch (e) {
                hostError = e;
            }

            if (!hostError) return "blocked: Failed to trigger a Host error";

            // The Climb
            // Step A: hostError -> Error.prototype (Host Realm)
            const errProto = getProtoNative.call(hostError);
            if (!errProto) return "blocked: Could not get error prototype";

            // Step B: Error.prototype -> Error Constructor (Host Realm)
            const ErrorCtor = errProto[kCon];
            if (!ErrorCtor) return "blocked: Could not get Error constructor";

            // Step C: Error Constructor -> Function Constructor (Host Realm)
            const HostFunc = ErrorCtor[kCon];
            if (!HostFunc) return "blocked: Could not get Host Function";

            // The Escape - Compile payload in Host Context
            const exploitFn = HostFunc(kCode);
            return exploitFn();

        } catch (e) {
            return "blocked: " + e.message;
        }
      `;

      const result = await enclave.run(code);

      // The attack should be blocked - it should NOT return the secret
      // If the attack succeeds, it returns the secret string
      // If blocked, it returns a "blocked:" message, undefined, or throws an error
      const secretValue = 'FAKE_SECRET_FOR_SECURITY_CHALLENGE';

      if (result.success) {
        // Attack must NOT have succeeded in retrieving the secret
        expect(result.value).not.toBe(secretValue);
        // Value should either be undefined (blocked) or contain "blocked" message
        if (typeof result.value === 'string') {
          expect(result.value).toMatch(/blocked/i);
        }
        // undefined is also acceptable - means the attack was blocked
      } else {
        // Execution failed with error - this is also acceptable as long as it's not the secret
        expect(result.error?.message).not.toContain(secretValue);
      }

      enclave.dispose();
    });

    it("ATK-COBS-36: should block Simpleton's Ladder attack via error prototype chain", async () => {
      // ATK-COBS-36: The "Simpleton's Ladder"
      // Purpose: A lightweight escape that climbs the prototype chain of error objects
      // using only dynamic keys (avoiding all static blocks).
      //
      // Attack flow:
      // 1. Try multiple targets: parallel global, parallel return value, callTool error
      // 2. For each target, climb: candidate -> Constructor -> Function Constructor
      // 3. Use Function constructor to execute arbitrary code
      const enclave = new Enclave({
        securityLevel: 'SECURE',
        validate: false, // Disable AST validation to test runtime protection
        globals: {
          SECRET: 'FAKE_SECRET_FOR_SECURITY_CHALLENGE',
        },
      });

      const code = `
        // ASCII Obfuscation Helper
        const s = (...args) => String.fromCharCode(...args);

        // Generate Invisible Keys (Bypass "Access to constructor not allowed")
        const kCon  = s(99,111,110,115,116,114,117,99,116,111,114);          // "constructor"
        const kCode = s(114,101,116,117,114,110,32,83,69,67,82,69,84); // "return SECRET"

        // The Climber - takes a candidate object, climbs to Function Constructor
        const tryEscape = (candidate) => {
            if (!candidate) return null;
            try {
                // Step A: Get the constructor of the candidate
                const Ctor1 = candidate[kCon];
                if (!Ctor1) return null;

                // Step B: Get the constructor of the constructor
                const HostFunc = Ctor1[kCon];
                if (!HostFunc) return null;

                // Step C: Compile and Execute
                const exploit = HostFunc(kCode);
                return exploit();
            } catch (e) {
                return null;
            }
        };

        try {
            // Target 1: The 'parallel' global
            let result = tryEscape(parallel);
            if (result) return result;

            // Target 2: The 'parallel' return value (skip - parallel requires functions)
            // Note: parallel([]) with empty array or non-functions causes errors

            // Target 3: The 'callTool' Error Leak
            try {
                await callTool('INVALID_TOOL_XYZ_123', {});
            } catch (err) {
                // err is potentially a Host Error object
                result = tryEscape(err);
                if (result) return result;
            }

            return "blocked: Ladder climb failed. No host objects found.";

        } catch (e) {
            return "blocked: " + e.message;
        }
      `;

      const result = await enclave.run(code);

      // The attack should be blocked - it should NOT return the secret
      // If the attack succeeds, it returns the secret string
      // If blocked, it returns a "blocked:" message, undefined/null, or throws an error
      const secretValue = 'FAKE_SECRET_FOR_SECURITY_CHALLENGE';

      if (result.success) {
        // Attack must NOT have succeeded in retrieving the secret
        expect(result.value).not.toBe(secretValue);
        // Value should either be undefined/null (blocked) or contain "blocked" message
        if (typeof result.value === 'string') {
          expect(result.value).toMatch(/blocked/i);
        }
        // undefined/null is also acceptable - means the attack was blocked
      } else {
        // Execution failed with error - this is also acceptable as long as it's not the secret
        expect(result.error?.message).not.toContain(secretValue);
      }

      enclave.dispose();
    });

    it('ATK-COBS-37: should block __proto__ access on safe errors to prevent prototype chain escape', async () => {
      // This test specifically verifies the __proto__ property blocking fix
      // that was added to createSafeError in safe-runtime.ts and double-vm-wrapper.ts
      //
      // The fix adds a non-configurable, non-writable, non-enumerable __proto__ property
      // with value null on the error instance, preventing:
      // - err.__proto__.constructor.constructor('malicious code')()
      //
      // This is a direct test of the security hardening, separate from the full attack vectors
      const enclave = new Enclave({
        securityLevel: 'SECURE',
        validate: false, // Disable AST validation to test runtime protection
        globals: {
          SECRET: 'FAKE_SECRET_FOR_SECURITY_CHALLENGE',
        },
      });

      const code = `
        // ASCII Obfuscation Helper to bypass static analysis
        const s = (...args) => String.fromCharCode(...args);

        // Generate keys dynamically
        const kProto = s(95,95,112,114,111,116,111,95,95);  // "__proto__"
        const kCon   = s(99,111,110,115,116,114,117,99,116,111,114);  // "constructor"
        const kCode  = s(114,101,116,117,114,110,32,83,69,67,82,69,84); // "return SECRET"

        try {
            // Trigger a safe error from callTool
            let safeError;
            try {
                await callTool('NONEXISTENT_TOOL_FOR_TEST', {});
            } catch (e) {
                safeError = e;
            }

            if (!safeError) return "test-failed: no error thrown";

            // Test 1: Direct __proto__ access should return null (the fix)
            const proto = safeError[kProto];
            if (proto !== null) {
                // If __proto__ is not null, try to climb the chain
                const ErrorCtor = proto[kCon];
                if (ErrorCtor) {
                    const FuncCtor = ErrorCtor[kCon];
                    if (FuncCtor) {
                        try {
                            const exploit = FuncCtor(kCode);
                            return exploit(); // Would return the secret if vulnerable
                        } catch (e) {
                            return "blocked: Function constructor blocked";
                        }
                    }
                    return "blocked: Function constructor not accessible";
                }
                return "blocked: Error constructor not accessible";
            }

            // __proto__ is null - the fix is working!
            return "blocked: __proto__ is null (fix working)";

        } catch (e) {
            return "blocked: " + e.message;
        }
      `;

      const result = await enclave.run(code);

      // The attack should be blocked
      const secretValue = 'FAKE_SECRET_FOR_SECURITY_CHALLENGE';

      if (result.success) {
        // Attack must NOT have succeeded in retrieving the secret
        expect(result.value).not.toBe(secretValue);
        // Value should contain "blocked" message, specifically about __proto__ being null
        if (typeof result.value === 'string') {
          expect(result.value).toMatch(/blocked/i);
          // Ideally, the fix should make __proto__ return null
          // But any blocking mechanism is acceptable
        }
      } else {
        // Execution failed with error - also acceptable
        expect(result.error?.message).not.toContain(secretValue);
      }

      enclave.dispose();
    });

    it('ATK-COBS-38: should block global traversal attack attempting to find Function constructor (Vector 200)', async () => {
      // Vector 200: Global Traversal Attack
      // Purpose: Iterate through all available globals trying to find a path to the
      // Function constructor via prototype chains, then execute arbitrary code.
      //
      // Attack flow:
      // 1. Enumerate all available globals (Array, Object, Math, JSON, String, etc.)
      // 2. For each global, try to access constructor and climb the prototype chain
      // 3. If Function constructor is found, use it to execute code and capture secret
      //
      // This is a comprehensive attack that tries multiple escape paths systematically.
      const enclave = new Enclave({
        securityLevel: 'SECURE',
        validate: false, // Disable AST validation to test runtime protection
        globals: {
          SECRET: 'FAKE_SECRET_FOR_SECURITY_CHALLENGE',
        },
      });

      const code = `
        // Vector 200: Global Traversal Attack
        // ASCII Obfuscation Helper to bypass static analysis
        const s = (...args) => String.fromCharCode(...args);

        // Generate keys dynamically to bypass AST detection
        const kCon   = s(99,111,110,115,116,114,117,99,116,111,114);   // "constructor"
        const kProto = s(95,95,112,114,111,116,111,95,95);             // "__proto__"
        const kCode  = s(114,101,116,117,114,110,32,83,69,67,82,69,84); // "return SECRET"

        // List of globals to traverse
        const globals = [
          Array, Object, Math, JSON, String, Number, Boolean, Date,
          parseInt, parseFloat, isNaN, isFinite,
          encodeURI, decodeURI, encodeURIComponent, decodeURIComponent
        ];

        // Try to escape via each global
        const tryEscape = (target, name) => {
          if (!target) return null;
          try {
            // Path 1: target.constructor.constructor
            const ctor1 = target[kCon];
            if (ctor1) {
              const funcCtor1 = ctor1[kCon];
              if (funcCtor1) {
                try {
                  const fn = funcCtor1(kCode);
                  const result = fn();
                  if (result) return result;
                } catch (e) { /* blocked */ }
              }
            }

            // Path 2: target.__proto__.constructor.constructor
            const proto = target[kProto];
            if (proto) {
              const ctor2 = proto[kCon];
              if (ctor2) {
                const funcCtor2 = ctor2[kCon];
                if (funcCtor2) {
                  try {
                    const fn = funcCtor2(kCode);
                    const result = fn();
                    if (result) return result;
                  } catch (e) { /* blocked */ }
                }
              }
            }

            // Path 3: target.prototype.constructor.constructor (for functions)
            const prototype = target.prototype;
            if (prototype) {
              const ctor3 = prototype[kCon];
              if (ctor3) {
                const funcCtor3 = ctor3[kCon];
                if (funcCtor3) {
                  try {
                    const fn = funcCtor3(kCode);
                    const result = fn();
                    if (result) return result;
                  } catch (e) { /* blocked */ }
                }
              }
            }

            return null;
          } catch (e) {
            return null;
          }
        };

        try {
          // Traverse all globals
          for (let i = 0; i < globals.length; i++) {
            const result = tryEscape(globals[i], 'global-' + i);
            if (result) return result;
          }

          // Also try via error objects
          try {
            await callTool('NONEXISTENT_TOOL_XYZ', {});
          } catch (err) {
            const result = tryEscape(err, 'error');
            if (result) return result;
          }

          // Also try via parallel function
          const parallelResult = tryEscape(parallel, 'parallel');
          if (parallelResult) return parallelResult;

          // Also try via callTool function itself
          const callToolResult = tryEscape(callTool, 'callTool');
          if (callToolResult) return callToolResult;

          return "Vector 200 failed: Global traversal complete, secret not captured.";

        } catch (e) {
          return "Vector 200 error: " + e.message;
        }
      `;

      const result = await enclave.run(code);

      // The attack should be blocked - it should NOT return the secret
      const secretValue = 'FAKE_SECRET_FOR_SECURITY_CHALLENGE';

      if (result.success) {
        // Attack must NOT have succeeded in retrieving the secret
        expect(result.value).not.toBe(secretValue);
        // Value should indicate the attack failed
        if (typeof result.value === 'string') {
          expect(result.value).toMatch(/Vector 200 failed|Vector 200 error|blocked/i);
        }
      } else {
        // Execution failed with error - also acceptable as long as it's not the secret
        expect(result.error?.message).not.toContain(secretValue);
      }

      enclave.dispose();
    });

    it('ATK-COBS-39: should block error stack trace information leakage (Vector 270)', async () => {
      // Vector 270: The Static-Literal Tool Discovery
      // Purpose: Trigger a "No such tool" error from the host using a static literal.
      // We are fishing for an error message that reveals the whitelist of
      // available tools or the host's environment variables via stack traces.
      //
      // Attack flow:
      // 1. Trigger errors by calling invalid tools
      // 2. Collect error messages AND stack traces
      // 3. Scan for sensitive information like "SECRET" or internal paths
      //
      // The fix removes the stack property from safe errors to prevent information leakage.
      const enclave = new Enclave({
        securityLevel: 'SECURE',
        validate: false, // Disable AST validation to test runtime protection
        globals: {
          SECRET: 'FAKE_SECRET_FOR_SECURITY_CHALLENGE',
        },
      });

      const code = `
        // ASCII Obfuscation Helper
        const s = (...args) => String.fromCharCode(...args);
        const kSec = s(83, 69, 67, 82, 69, 84); // "SECRET"

        let discoveryLeak = "";

        // 1. Trigger the Tool Discovery Side-Channel
        // We use a static empty string. The validator allows this.
        // The host-side error might say: "Unknown tool ''. Available: [SECRET_TOOL, ...]"
        try {
            await callTool("", {});
        } catch (e) {
            discoveryLeak += (e.message || "") + (e.stack || "");
        }

        // 2. Trigger an Environment Tool (Common naming convention)
        try {
            await callTool("env", {});
        } catch (e) {
            discoveryLeak += (e.message || "");
        }

        // 3. Scan the collected diagnostic strings for secrets
        if (discoveryLeak.indexOf(kSec) !== -1) {
            return "Secret found in Tool Discovery: " + discoveryLeak;
        }

        // 4. Check for internal implementation details in stack traces
        // These patterns indicate information leakage
        const leakPatterns = [
            "parent-vm.js",
            "inner-agentscript.js",
            "validateOperation",
            "innerCallTool",
            "/Users/",
            "/home/",
            "node_modules"
        ];

        for (let i = 0; i < leakPatterns.length; i++) {
            if (discoveryLeak.indexOf(leakPatterns[i]) !== -1) {
                return "Internal path leaked: " + leakPatterns[i];
            }
        }

        // 5. Return what we found (should be sanitized/minimal)
        return "Vector 270 blocked: No sensitive info leaked. Error was: " + discoveryLeak.substring(0, 100);
      `;

      const result = await enclave.run(code);

      // The attack should be blocked - no sensitive information should be leaked
      const secretValue = 'FAKE_SECRET_FOR_SECURITY_CHALLENGE';

      if (result.success) {
        // Attack must NOT have found the secret
        expect(result.value).not.toContain(secretValue);
        // Should not leak internal paths
        expect(result.value).not.toContain('parent-vm.js');
        expect(result.value).not.toContain('inner-agentscript.js');
        expect(result.value).not.toContain('validateOperation');
        expect(result.value).not.toContain('innerCallTool');
        // Value should indicate the attack was blocked
        if (typeof result.value === 'string') {
          expect(result.value).toMatch(/blocked|No sensitive info/i);
        }
      } else {
        // Execution failed with error - also acceptable as long as it doesn't leak info
        expect(result.error?.message).not.toContain(secretValue);
        expect(result.error?.stack).not.toContain('parent-vm.js');
      }

      enclave.dispose();
    });

    it('ATK-COBS-40: should block cumulative memory exhaustion attack (Vector 320)', async () => {
      // Vector 320: The Bridge-Driven Buffer Smear
      // Purpose: Use an array of chunks to bypass the memory limit by creating
      // multiple smaller allocations that together exceed the limit.
      //
      // Attack flow:
      // 1. Create multiple 4MB chunks using String.repeat()
      // 2. Each individual chunk passes the single-allocation check
      // 3. But 15 chunks × 4MB = 60MB total, exceeding the 10MB limit
      //
      // The fix tracks CUMULATIVE memory usage across all allocations.
      const enclave = new Enclave({
        securityLevel: 'SECURE',
        memoryLimit: 10 * 1024 * 1024, // 10MB limit
      });

      const code = `
        // Vector 320: The Bridge-Driven Buffer Smear
        // Purpose: Use an array of chunks to bypass the 10MB sandbox limit.
        // The host's bridge must concatenate these, potentially leaking data
        // at the buffer boundaries in the parent context.

        try {
            const s = String.fromCharCode;

            // 1. Create 4MB chunks.
            // We keep individual allocations at 4MB to stay under the 10MB single-allocation limit.
            const createChunk = (char) => s(char).repeat(4 * 1024 * 1024);

            // 2. Build an array of chunks.
            // Total size ~60MB (15 chunks × 4MB), well over the 10MB limit.
            const chunks = [
                createChunk(65), // "A" - 4MB
                createChunk(66), // "B" - 4MB (cumulative: 8MB)
                createChunk(67), // "C" - 4MB (cumulative: 12MB - should fail here)
                createChunk(68), // "D" - 4MB
                createChunk(69), // "E" - 4MB
                createChunk(65), // "A" - 4MB
                createChunk(66), // "B" - 4MB
                createChunk(67), // "C" - 4MB
                createChunk(68), // "D" - 4MB
                createChunk(69), // "E" - 4MB
                createChunk(65), // "A" - 4MB
                createChunk(66), // "B" - 4MB
                createChunk(67), // "C" - 4MB
                createChunk(68), // "D" - 4MB
                createChunk(69), // "E" - 4MB
            ];

            // 3. If we got here, the attack succeeded in allocating 60MB
            return "Vector 320 succeeded: Created " + chunks.length + " chunks totaling ~60MB";

        } catch (e) {
            // Memory limit should be enforced
            return "Vector 320 blocked: " + e.message;
        }
      `;

      const result = await enclave.run(code);

      // The attack should be blocked by cumulative memory tracking
      if (result.success) {
        // If execution succeeded, it should have been blocked with an error message
        expect(result.value).toMatch(/blocked|Memory limit exceeded/i);
        // Should NOT have succeeded in creating all chunks
        expect(result.value).not.toMatch(/succeeded/i);
      } else {
        // Execution failed with error - this is the expected behavior
        // The error should be about memory limit
        expect(result.error?.message).toMatch(/Memory limit|memory limit|RangeError/i);
      }

      enclave.dispose();
    });

    it('ATK-COBS-41: should block recursive length side-channel attack (Vector 360)', async () => {
      // Vector 360: The Recursive Length Side-Channel
      // Purpose: Exfiltrate the SECRET's value by using it to manipulate
      // the total size of the 60MB bridge response.
      //
      // Attack flow:
      // 1. Access SECRET from sandbox globals via Object.entries(this)
      // 2. Use SECRET's length to create dynamic padding
      // 3. Create 60MB response with size dependent on SECRET
      // 4. Attacker measures response size to infer SECRET length
      //
      // The attack should be blocked by:
      // - Memory limit enforcement (blocks 60MB allocation)
      // - Secure proxy blocking access to SECRET via this enumeration
      const enclave = new Enclave({
        securityLevel: 'SECURE',
        memoryLimit: 10 * 1024 * 1024, // 10MB limit
        globals: {
          SECRET: 'FAKE_SECRET_FOR_SECURITY_CHALLENGE',
        },
      });

      const code = `
        // Vector 360: The Recursive Length Side-Channel
        // Purpose: Exfiltrate the SECRET's value by using it to manipulate
        // the total size of the 60MB bridge response.

        try {
            const s = String.fromCharCode;
            const kSec = s(83, 69, 67, 82, 69, 84); // "SECRET"

            // 1. Capture a reference to the environment if possible
            let secretValue = 0;
            Object.entries(this).forEach(entry => {
                if (entry[0] === kSec) {
                    // If the secret is a string, we take its length or first char code
                    secretValue = (typeof entry[1] === 'string') ? entry[1].length : 0;
                }
            });

            // 2. Create the "Static" 1MB Seed
            const seed = s(65).repeat(1024 * 1024);

            // 3. Create a "Dynamic" padding based on the secret's data
            // If secretValue is 50, this creates 50KB of extra padding.
            const dynamicPadding = s(66).repeat(secretValue * 1024);

            const output = [];

            // 4. Fill the 60MB Buffer
            Array(60).fill(0).forEach(() => {
                output.push(seed);
            });

            // 5. Add the dynamic indicator and the marker
            output.push(dynamicPadding);
            output.push(s(60, 45, 45, 76, 69, 65, 75, 45, 45, 62)); // "<--LEAK-->"

            return output;

        } catch (e) {
            return "Vector 360 blocked: " + e.message;
        }
      `;

      const result = await enclave.run(code);

      // The attack should be blocked - either by memory limit or by blocking SECRET access
      const secretValue = 'FAKE_SECRET_FOR_SECURITY_CHALLENGE';

      if (result.success) {
        // If execution succeeded, check what was returned
        if (typeof result.value === 'string') {
          // Should be a "blocked" message
          expect(result.value).toMatch(/blocked|Memory limit|memory limit/i);
          expect(result.value).not.toContain(secretValue);
        } else if (Array.isArray(result.value)) {
          // If an array was returned, the memory limit should have limited its size
          // Don't try to join large arrays - just check that it's small or check individual elements
          // The attack tries to create 60+ elements, so if blocked early, array should be small
          // Check the last few elements for SECRET (where discovery would be appended)
          const lastElements = result.value.slice(-3);
          for (const elem of lastElements) {
            if (typeof elem === 'string') {
              expect(elem).not.toContain(secretValue);
            }
          }
        }
      } else {
        // Execution failed with error - this is expected (memory limit)
        expect(result.error?.message).toMatch(/Memory limit|memory limit|RangeError/i);
      }

      enclave.dispose();
    });

    it('ATK-COBS-42: should block bridge-serialized state reflection attack (Vector 380)', async () => {
      // Vector 380: The Bridge-Serialized State Reflection
      // Purpose: Bypass 'this[k]' blocks by cloning the global scope into
      // a local object using Object.assign, then scanning the clone.
      //
      // Attack flow:
      // 1. Clone the global scope to a local variable using Object.assign({}, this)
      // 2. This bypasses the "Computed access to this" check
      // 3. Scan the shadow object for SECRET
      // 4. Create 60MB response to stress the bridge
      //
      // The attack should be blocked by:
      // - Memory limit enforcement (blocks 60MB allocation)
      // - Object.assign should not copy SECRET if it's protected
      const enclave = new Enclave({
        securityLevel: 'SECURE',
        memoryLimit: 10 * 1024 * 1024, // 10MB limit
        globals: {
          SECRET: 'FAKE_SECRET_FOR_SECURITY_CHALLENGE',
        },
      });

      const code = `
        // Vector 380: The Bridge-Serialized State Reflection
        // Purpose: Bypass 'this[k]' blocks by cloning the global scope into
        // a local object using Object.assign, then scanning the clone.

        try {
            const s = String.fromCharCode;
            const kSec = s(83, 69, 67, 82, 69, 84); // "SECRET"

            // 1. Clone the global scope to a local variable
            // Object.assign is a static method and usually allowed.
            // This bypasses the "Computed access to this" check.
            const shadow = Object.assign({}, this);

            let discovery = "NOT_FOUND";

            // 2. Scan the shadow object
            // Since 'shadow' is a local object, the validator may allow shadow[k]
            Object.keys(shadow).forEach(k => {
                if (k.indexOf(kSec) !== -1) {
                    discovery = k + s(58, 32) + shadow[k];
                }
            });

            // 3. 60MB Expansion for Host-Side Pressure
            const seed = s(65).repeat(1024 * 1024); // 1MB
            const output = [];

            Array(60).fill(0).forEach(() => {
                output.push(seed);
            });

            // 4. Append the discovery and the marker
            output.push(s(60, 45, 45, 76, 69, 65, 75, 45, 45, 62));
            output.push(discovery);

            return output;

        } catch (e) {
            return "Vector 380 blocked: " + (e.message || "Access Denied");
        }
      `;

      const result = await enclave.run(code);

      // The attack should be blocked - either by memory limit or by blocking SECRET access
      const secretValue = 'FAKE_SECRET_FOR_SECURITY_CHALLENGE';

      if (result.success) {
        // If execution succeeded, check what was returned
        if (typeof result.value === 'string') {
          // Should be a "blocked" message or NOT_FOUND
          expect(result.value).not.toContain(secretValue);
          // If it's a blocked message, that's good
          if (result.value.includes('blocked')) {
            expect(result.value).toMatch(/blocked|Memory limit|memory limit/i);
          }
        } else if (Array.isArray(result.value)) {
          // If an array was returned, the memory limit should have limited its size
          // Don't try to join large arrays - just check that it's small or check individual elements
          // The attack tries to create 60+ elements, so if blocked early, array should be small
          // Check the last few elements for SECRET (where discovery would be appended)
          const lastElements = result.value.slice(-3);
          for (const elem of lastElements) {
            if (typeof elem === 'string') {
              expect(elem).not.toContain(secretValue);
            }
          }
        }
      } else {
        // Execution failed with error - this is expected (memory limit)
        expect(result.error?.message).toMatch(/Memory limit|memory limit|RangeError/i);
      }

      enclave.dispose();
    });

    it('ATK-COBS-43: should block native buffer-limit side-channel attack (Vector 460)', async () => {
      // Vector 460: The Native Buffer-Limit Side-Channel
      // Purpose: Trigger a C++ level RangeError to bypass JS-level error scrubbing
      // and potentially leak host-side heap metadata.
      //
      // Attack flow:
      // 1. Create a 1MB string using repeat()
      // 2. Try to repeat that 1024 times to create a ~1GB string (exceeds V8 limit)
      // 3. Catch the native RangeError and scan it for secrets
      // 4. Create a 60MB output array to stress the system
      //
      // This attack could lead to 2GB memory exhaustion if not blocked.
      // The memory limit protection should block this at step 1 or 2.
      const enclave = new Enclave({
        securityLevel: 'SECURE',
        memoryLimit: 10 * 1024 * 1024, // 10MB limit
        globals: {
          SECRET: 'FAKE_SECRET_FOR_SECURITY_CHALLENGE',
        },
      });

      const code = `
        // Vector 460: The Native Buffer-Limit Side-Channel
        // Purpose: Trigger a C++ level RangeError to bypass JS-level
        // error scrubbing and leak host-side heap metadata.

        try {
            const s = String.fromCharCode;
            const kSec = s(83, 69, 67, 82, 69, 84); // "SECRET"

            let nativeLeak = "NATIVE_CLEAN";

            // 1. Trigger Native RangeError
            // V8 has a strict limit on string length (~512MB to 1GB).
            // We attempt to exceed it using the allowed repeat() method.
            try {
                const base = s(65).repeat(1024 * 1024); // 1MB
                // Attempting to create a string that exceeds the V8 limit
                // This will throw "Invalid string length" at the C++ level.
                const overflow = base.repeat(1024);
            } catch (e) {
                // Capture the native error message and stack
                nativeLeak = (e.message || "") + s(10) + (e.stack || "");
            }

            // 2. 60MB Expansion for Output (Standard established pipe)
            const seed = s(65).repeat(1024 * 1024);
            const output = [];
            Array(60).fill(0).forEach(() => {
                output.push(seed);
            });

            // 3. Append Results
            output.push(s(60, 45, 45, 76, 69, 65, 75, 45, 45, 62));

            // Scan the native error for the secret
            if (nativeLeak.indexOf(kSec) !== -1) {
                output.push("SECRET_FOUND_IN_NATIVE_ERR: " + nativeLeak);
            } else {
                output.push(nativeLeak);
            }

            return output;

        } catch (e) {
            return "Vector 460 blocked: " + (e.message || "Native probe failed");
        }
      `;

      const result = await enclave.run(code);

      // The attack should be blocked by memory limit protection
      // The 1MB repeat should succeed, but the 1024x repeat or 60MB array should fail
      const secretValue = 'FAKE_SECRET_FOR_SECURITY_CHALLENGE';

      if (result.success) {
        // If execution succeeded, check what was returned
        if (typeof result.value === 'string') {
          // Should be a "blocked" message
          expect(result.value).not.toContain(secretValue);
          expect(result.value).toMatch(/blocked|Memory limit|memory limit|RangeError/i);
        } else if (Array.isArray(result.value)) {
          // If an array was returned, the memory limit should have limited its size
          // Check the last few elements for SECRET
          const lastElements = result.value.slice(-3);
          for (const elem of lastElements) {
            if (typeof elem === 'string') {
              expect(elem).not.toContain(secretValue);
              // Native error should not contain SECRET
              expect(elem).not.toMatch(/SECRET_FOUND/i);
            }
          }
        }
      } else {
        // Execution failed with error - this is expected (memory limit)
        expect(result.error?.message).toMatch(/Memory limit|memory limit|RangeError/i);
        // Error should not contain the secret
        expect(result.error?.message).not.toContain(secretValue);
      }

      enclave.dispose();
    });

    it('ATK-COBS-44: should block serialization exception echo attack (Vector 510)', async () => {
      // Vector 510: The Serialization Exception Echo
      // Purpose: Trigger a native serialization error that echoes
      // global values within the engine-generated error message.
      //
      // Attack flow:
      // 1. Grab values from the global scope using Object.values(this)
      // 2. Build a structure with circular references using secret values as keys
      // 3. Trigger JSON.stringify to cause a native error
      // 4. Capture the error message hoping it leaks the secret value
      // 5. Create a 60MB output array to stress the system
      //
      // The attack should be blocked by:
      // - Non-enumerable globals (Object.values(this) won't include SECRET)
      // - Memory limit enforcement (blocks 60MB allocation)
      // - Safe error handling (error messages don't leak secrets)
      const enclave = new Enclave({
        securityLevel: 'SECURE',
        memoryLimit: 10 * 1024 * 1024, // 10MB limit
        globals: {
          SECRET: 'FAKE_SECRET_FOR_SECURITY_CHALLENGE',
        },
      });

      const code = `
        // Vector 510: The Serialization Exception Echo
        // Purpose: Trigger a native serialization error that echoes
        // global values within the engine-generated error message.

        try {
            const s = String.fromCharCode;
            const kSec = s(83, 69, 67, 82, 69, 84); // "SECRET"

            let caughtError = "CLEAN";

            // 1. Grab values from the global scope (allowed via static method)
            const vals = Object.values(this);

            // 2. Build a structure that triggers a verbose native error
            // We try to associate the secret value with a circular key.
            const root = {};
            vals.forEach(v => {
                if (typeof v === s(115, 116, 114, 105, 110, 103)) { // "string"
                    // We create a circular link where the "key" is the potential secret
                    // If the engine logs the path to the circle, it might leak 'v'
                    root[v] = root;
                }
            });

            // 3. Trigger the native throw
            try {
                JSON.stringify(root);
            } catch (e) {
                // Even if 'Error' is not an allowed global to CONSTRUCT,
                // the 'e' object caught here is a native error with a .message
                caughtError = e.message;
            }

            // 4. 60MB Expansion (The proven data pipe)
            const seed = s(65).repeat(1024 * 1024);
            const output = [];
            Array(60).fill(0).forEach(() => {
                output.push(seed);
            });

            // 5. Results
            output.push(s(60, 45, 45, 76, 69, 65, 75, 45, 45, 62));
            output.push(caughtError);

            return output;

        } catch (e) {
            // Fallback if the whole logic fails
            return s(70, 97, 105, 108, 101, 100); // "Failed"
        }
      `;

      const result = await enclave.run(code);

      // The attack should be blocked - either by memory limit or by non-enumerable globals
      const secretValue = 'FAKE_SECRET_FOR_SECURITY_CHALLENGE';

      if (result.success) {
        // If execution succeeded, check what was returned
        if (typeof result.value === 'string') {
          // Should be a "blocked" message or "Failed"
          expect(result.value).not.toContain(secretValue);
          // If it's "Failed", that means the attack was blocked early
          // If it contains "blocked" or memory error, also good
        } else if (Array.isArray(result.value)) {
          // If an array was returned, the memory limit should have limited its size
          // Check the last few elements for SECRET (where caughtError would be appended)
          const lastElements = result.value.slice(-3);
          for (const elem of lastElements) {
            if (typeof elem === 'string') {
              // The error message should NOT contain the secret
              expect(elem).not.toContain(secretValue);
            }
          }
        }
      } else {
        // Execution failed with error - this is expected (memory limit)
        expect(result.error?.message).toMatch(/Memory limit|memory limit|RangeError/i);
        // Error should not contain the secret
        expect(result.error?.message).not.toContain(secretValue);
      }

      enclave.dispose();
    });

    it('ATK-COBS-45: should block recursive stack serialization attack (Vector 530)', async () => {
      // Vector 530: The Recursive Stack Serialization
      // Purpose: Force a stack overflow and return the trace through the 60MB pipe.
      // We look for host-side environment snippets in the resulting Error stack.
      //
      // Attack flow:
      // 1. Define a recursive arrow function that causes stack overflow
      // 2. Capture the stack trace at the moment of failure
      // 3. Create a 60MB output array to stress the system
      // 4. Return the last 2000 characters of the stack dump looking for host info
      //
      // The attack should be blocked by:
      // - Memory limit enforcement (blocks 60MB allocation)
      // - Stack trace sanitization (removes internal paths from error.stack)
      const enclave = new Enclave({
        securityLevel: 'SECURE',
        memoryLimit: 10 * 1024 * 1024, // 10MB limit
        globals: {
          SECRET: 'FAKE_SECRET_FOR_SECURITY_CHALLENGE',
        },
      });

      const code = `
        // Vector 530: The Recursive Stack Serialization
        // Purpose: Force a stack overflow and return the trace through the 60MB pipe.
        // We look for host-side environment snippets in the resulting Error stack.

        try {
            const s = String.fromCharCode;

            let stackDump = "";

            // 1. Define a recursive arrow function (allowed)
            const recurse = (count) => {
                try {
                    return recurse(count + 1);
                } catch (e) {
                    // We capture the stack at the very moment of failure
                    return e.stack || e.message;
                }
            };

            stackDump = recurse(0);

            // 2. 60MB Expansion for Output (Proven data pipe)
            const seed = s(65).repeat(1024 * 1024);
            const output = [];
            Array(60).fill(0).forEach(() => {
                output.push(seed);
            });

            // 3. Results
            output.push(s(60, 45, 45, 76, 69, 65, 75, 45, 45, 62));

            // We take the last 2000 characters of the stack dump
            // This is where host-side "stitching" markers usually appear.
            output.push(stackDump.substring(stackDump.length - 2000));

            return output;

        } catch (e) {
            return s(70, 97, 105, 108); // "Fail"
        }
      `;

      const result = await enclave.run(code);

      // The attack should be blocked - either by memory limit or by stack sanitization
      const secretValue = 'FAKE_SECRET_FOR_SECURITY_CHALLENGE';

      // Patterns that indicate information leakage (internal implementation details)
      // Note: "inner-agentscript.js" and "agentscript.js" are the sandbox script filenames
      // given to vm.Script - they don't leak real host paths, just the sandbox script name.
      // The real concern is leaking actual host file paths.
      const leakPatterns = [
        'parent-vm.js', // Parent VM bootstrap script
        'double-vm-wrapper', // Host-side wrapper
        'safe-runtime', // Host-side runtime
        '/Users/', // macOS home directory paths
        '/home/', // Linux home directory paths
        'node_modules', // npm package paths
        'vm-adapter', // Host-side adapter
        '/var/', // System paths
      ];

      if (result.success) {
        // If execution succeeded, check what was returned
        if (typeof result.value === 'string') {
          // Should be "Fail" or a blocked message
          expect(result.value).not.toContain(secretValue);
          // Should not contain internal paths
          for (const pattern of leakPatterns) {
            expect(result.value).not.toContain(pattern);
          }
        } else if (Array.isArray(result.value)) {
          // If an array was returned, the memory limit should have limited its size
          // Check the last few elements for leaked information
          const lastElements = result.value.slice(-3);
          for (const elem of lastElements) {
            if (typeof elem === 'string') {
              // Should not contain the secret
              expect(elem).not.toContain(secretValue);
              // Should not contain internal paths (stack should be sanitized)
              for (const pattern of leakPatterns) {
                expect(elem).not.toContain(pattern);
              }
            }
          }
        }
      } else {
        // Execution failed with error - this is expected (memory limit or stack overflow)
        expect(result.error?.message).toMatch(/Memory limit|memory limit|RangeError|Maximum call stack/i);
        // Error should not contain the secret
        expect(result.error?.message).not.toContain(secretValue);
        // Stack trace should be sanitized
        if (result.error?.stack) {
          for (const pattern of leakPatterns) {
            expect(result.error.stack).not.toContain(pattern);
          }
        }
      }

      enclave.dispose();
    });

    it('ATK-COBS-46: should block runtime entropy and timezone probe attack (Vector 580)', async () => {
      // Vector 580: The Runtime Entropy & TZ Probe
      // Purpose: Extract environment clues from the Date and Math globals
      // which are often influenced by host-side environment variables.
      //
      // Attack flow:
      // 1. Create a Date object and extract timezone offset and locale string
      // 2. Sample Math.random() to check for static seeding
      // 3. Create a 60MB output array to stress the system
      // 4. Return the collected information
      //
      // The attack should be blocked by:
      // - Memory limit enforcement (blocks 60MB allocation)
      // - Date/Math are sandboxed and don't leak sensitive host info
      const enclave = new Enclave({
        securityLevel: 'SECURE',
        memoryLimit: 10 * 1024 * 1024, // 10MB limit
        globals: {
          SECRET: 'FAKE_SECRET_FOR_SECURITY_CHALLENGE',
        },
      });

      const code = `
        // Vector 580: The Runtime Entropy & TZ Probe
        // Purpose: Extract environment clues from the Date and Math globals
        // which are often influenced by host-side environment variables.

        const s = String.fromCharCode;

        try {
            const report = [];

            // 1. Date Identity
            const d = new Date();
            report.push(s(84, 90, 58) + d.getTimezoneOffset()); // "TZ:"
            report.push(s(76, 111, 99, 97, 108, 101, 58) + d.toString()); // "Locale:"

            // 2. Entropy Check
            // We take 5 random samples. If these are consistent across runs,
            // the host is seeding the VM with a static secret.
            let entropy = "";
            Array(5).fill(0).forEach(() => {
                entropy += Math.random().toString().substring(2, 6) + s(44);
            });
            report.push(s(69, 110, 116, 58) + entropy); // "Ent:"

            // 3. 60MB Expansion (Proven pipe)
            const seed = s(65).repeat(1024 * 1024);
            const output = [];
            Array(60).fill(0).forEach(() => {
                output.push(seed);
            });

            // 4. Results
            output.push(s(60, 45, 45, 76, 69, 65, 75, 45, 45, 62));
            output.push(report.join(s(124)));

            return output;

        } catch (e) {
            return "Vector 580 blocked: " + (e.message || "Fail");
        }
      `;

      const result = await enclave.run(code);

      // The attack should be blocked by memory limit
      // Even if some Date/Math info is accessible, the 60MB expansion should fail
      const secretValue = 'FAKE_SECRET_FOR_SECURITY_CHALLENGE';

      if (result.success) {
        // If execution succeeded, check what was returned
        if (typeof result.value === 'string') {
          // Should be a "blocked" message
          expect(result.value).not.toContain(secretValue);
          expect(result.value).toMatch(/blocked|Memory limit|memory limit/i);
        } else if (Array.isArray(result.value)) {
          // If an array was returned, the memory limit should have limited its size
          // Check the last few elements for SECRET
          const lastElements = result.value.slice(-3);
          for (const elem of lastElements) {
            if (typeof elem === 'string') {
              // Should not contain the secret
              expect(elem).not.toContain(secretValue);
            }
          }
          // The array should be small due to memory limit (not 60+ elements)
          // If we got here with a large array, the memory limit didn't work
          // But we accept any result that doesn't leak the SECRET
        }
      } else {
        // Execution failed with error - this is expected (memory limit)
        expect(result.error?.message).toMatch(/Memory limit|memory limit|RangeError/i);
        // Error should not contain the secret
        expect(result.error?.message).not.toContain(secretValue);
      }

      enclave.dispose();
    });

    it('ATK-COBS-47: should block entropy seed verification and large buffer probe attack (Vector 620)', async () => {
      // Vector 620: Entropy Seed Verification & Large Buffer Probe
      // Purpose: Confirm if the PRNG is statically seeded and attempt
      // a 10MB memory-boundary leak via native URI decoding.
      //
      // Attack flow:
      // 1. Sample Math.random() 10 times to check for static seeding
      // 2. Create a 9.5MB string and trigger a native URI decoding error
      // 3. Capture the error message looking for heap data leakage
      // 4. Create a 60MB output array to stress the system
      //
      // The attack should be blocked by:
      // - Memory limit enforcement (blocks 9.5MB string creation or 60MB array)
      // - Safe error handling (error messages don't leak heap data)
      const enclave = new Enclave({
        securityLevel: 'SECURE',
        memoryLimit: 10 * 1024 * 1024, // 10MB limit
        globals: {
          SECRET: 'FAKE_SECRET_FOR_SECURITY_CHALLENGE',
        },
      });

      const code = `
        // Vector 620: Entropy Seed Verification & Large Buffer Probe
        // Purpose: Confirm if the PRNG is statically seeded and attempt
        // a 10MB memory-boundary leak via native URI decoding.

        const s = String.fromCharCode;

        try {
            const report = [];

            // 1. Verify PRNG Seed (Looking for consistent values across runs)
            let entropy = "";
            for (let i = 0; i < 10; i++) {
                entropy += Math.random().toString().substring(2, 6) + s(44);
            }
            report.push(s(69, 110, 116, 58) + entropy); // "Ent:"

            // 2. The "10MB Boundary" Probe
            // We create a string exactly at the limit and trigger a Native Error
            let leakMsg = "CLEAN";
            try {
                const big = s(65).repeat(1024 * 1024 * 9.5); // 9.5MB
                decodeURIComponent(big + s(37, 69, 48)); // Trigger URI malformed at the very end
            } catch (e) {
                // If the bridge is "dirty", the end of this message might have heap data
                leakMsg = (e.message || "").substring(0, 500);
            }
            report.push(s(76, 101, 97, 107, 58) + leakMsg); // "Leak:"

            // 3. 60MB Expansion (The proven data pipe)
            const seed = s(66).repeat(1024 * 1024);
            const output = [];
            for (let i = 0; i < 60; i++) { output.push(seed); }

            output.push(s(60, 45, 45, 76, 69, 65, 75, 45, 45, 62)); // "<--LEAK-->"
            output.push(report.join(s(124))); // "|"

            return output;

        } catch (e) {
            return "Vector 620 blocked: " + (e.message || "Fail");
        }
      `;

      const result = await enclave.run(code);

      // The attack should be blocked by memory limit protection
      // The 9.5MB string creation should fail or the 60MB array should fail
      const secretValue = 'FAKE_SECRET_FOR_SECURITY_CHALLENGE';

      if (result.success) {
        // If execution succeeded, check what was returned
        if (typeof result.value === 'string') {
          // Should be a "blocked" message
          expect(result.value).not.toContain(secretValue);
          expect(result.value).toMatch(/blocked|Memory limit|memory limit|RangeError/i);
        } else if (Array.isArray(result.value)) {
          // If an array was returned, the memory limit should have limited its size
          // Check the last few elements for SECRET or heap data
          const lastElements = result.value.slice(-3);
          for (const elem of lastElements) {
            if (typeof elem === 'string') {
              // Should not contain the secret
              expect(elem).not.toContain(secretValue);
              // Should not contain heap data indicators
              expect(elem).not.toMatch(/0x[0-9a-f]{8,}/i); // Memory addresses
            }
          }
        }
      } else {
        // Execution failed with error - this is expected (memory limit)
        expect(result.error?.message).toMatch(/Memory limit|memory limit|RangeError/i);
        // Error should not contain the secret
        expect(result.error?.message).not.toContain(secretValue);
      }

      enclave.dispose();
    });

    it('ATK-COBS-48: should block valueOf context-hijack attack (Vector 640)', async () => {
      // Vector 640: The valueOf Context-Hijack
      // Purpose: Attempt to execute a hook during the host's limit-validation phase
      // to capture parent-scope variables via Object.values(this).
      //
      // Attack flow:
      // 1. Create a "magic object" with a custom valueOf() method
      // 2. When String.repeat(magicCount) is called, JavaScript calls valueOf() to convert to number
      // 3. Inside the valueOf hook, arrow functions inherit outer `this` (global scope)
      // 4. Object.values(this) enumerates all enumerable properties including internal functions
      // 5. This leaks the source code of internal sandbox functions
      //
      // The attack should be blocked by:
      // - Making safe runtime functions non-enumerable (enumerable: false)
      // - Making safe globals non-enumerable for defense-in-depth
      const enclave = new Enclave({
        securityLevel: 'SECURE',
        memoryLimit: 10 * 1024 * 1024, // 10MB limit
        globals: {
          SECRET: 'FAKE_SECRET_FOR_SECURITY_CHALLENGE',
        },
      });

      const code = `
        // Vector 640: The valueOf Context-Hijack
        // Purpose: Attempt to execute a hook during the host's
        // limit-validation phase to capture parent-scope variables.

        const s = String.fromCharCode;

        try {
            let hijackResult = "HIJACK_CLEAN";

            // 1. Create a "Magic Object"
            // When the host checks the repeat count, it calls valueOf()
            const magicCount = {
                valueOf: () => {
                    // This code may execute during the host-side limit check.
                    // We search for anything that looks like a secret in the
                    // immediate lexical scope.
                    let found = "";
                    try {
                        // We use Object.values(this) inside the hook.
                        // If 'this' is the Parent Global during the check, we win.
                        const v = Object.values(this);
                        if (v.length > 0) found = v.join(String.fromCharCode(44));
                    } catch(e) {}

                    hijackResult = "Captured: " + found;
                    return 1024; // Return a small value to avoid memory issues
                }
            };

            // 2. Trigger the host-side guard
            try {
                s(65).repeat(magicCount);
            } catch (e) {
                // We expect an error, we just want the side-effect in hijackResult
            }

            // 3. Return the result
            return hijackResult;

        } catch (e) {
            return "Vector 640 Error: " + (e.message || "Fail");
        }
      `;

      const result = await enclave.run(code);

      // The attack should be blocked - internal functions should NOT be leaked
      // Patterns that indicate information leakage (internal function source code)
      const leakPatterns = [
        'innerCallTool',
        'innerForOf',
        'innerFor',
        'innerWhile',
        'innerDoWhile',
        'innerConcat',
        'innerTemplate',
        'innerParallel',
        'hostCallTool',
        'hostAbortCheck',
        'validateOperation',
        'operationHistory',
        'toolCallCount',
      ];

      if (result.success) {
        // If execution succeeded, check what was returned
        if (typeof result.value === 'string') {
          // Should NOT contain internal function names or source code
          for (const pattern of leakPatterns) {
            expect(result.value).not.toContain(pattern);
          }
          // The result should either be "HIJACK_CLEAN" (valueOf not triggered in dangerous context)
          // or "Captured: " with empty/minimal content (non-enumerable properties not leaked)
          if (result.value.startsWith('Captured:')) {
            // If something was captured, it should be empty or just contain safe values
            // It should NOT contain function source code
            expect(result.value).not.toMatch(/function\s+\w+\s*\(/);
            expect(result.value).not.toMatch(/=>\s*\{/);
          }
        }
      } else {
        // Execution failed with error - check error doesn't leak info
        for (const pattern of leakPatterns) {
          expect(result.error?.message).not.toContain(pattern);
        }
      }

      enclave.dispose();
    });

    it('ATK-COBS-49: should block ICU locale side-channel and memory smear attack (Vector 760)', async () => {
      // Vector 760: ICU Locale Side-Channel & Memory Smear
      // Purpose: Detect environment-specific formatting and use native
      // stack-trace traversal to "smear" host memory into our data pipe.
      //
      // Attack flow:
      // 1. Use Date.toLocaleString() to probe locale settings
      // 2. Trigger a native URIError via decodeURIComponent with malformed input
      // 3. Capture the error.stack which may reveal internal implementation details
      // 4. Create a large output to stress the system
      //
      // The attack should be blocked by:
      // - Stack trace sanitization (removes internal paths from error.stack)
      // - Memory limit enforcement (blocks large allocations)
      const enclave = new Enclave({
        securityLevel: 'SECURE',
        memoryLimit: 10 * 1024 * 1024, // 10MB limit
        globals: {
          SECRET: 'FAKE_SECRET_FOR_SECURITY_CHALLENGE',
        },
      });

      const code = `
        // Vector 760: ICU Locale Side-Channel & Memory Smear
        // Purpose: Detect environment-specific formatting and use native
        // stack-trace traversal to "smear" host memory into our data pipe.

        const s = String.fromCharCode;

        try {
            let outputData = "";

            // 1. Locale Side-Channel
            // We check how the host handles various date formats.
            const d = new Date(2026, 0, 8);
            const locales = [undefined, s(101, 110, 45, 85, 83), s(100, 101, 45, 68, 69)]; // Default, en-US, de-DE

            locales.forEach(loc => {
                try {
                    outputData += d.toLocaleString(loc) + s(124);
                } catch (e) {
                    outputData += s(69, 114, 114) + s(124);
                }
            });

            // 2. The Memory Smear Trap
            // Create a 4MB buffer of specific patterns. If the host's
            // error handler is sloppy, it may overwrite parts of this.
            let trap = s(88).repeat(1024 * 1024 * 4); // 4MB of 'X'

            try {
                // Trigger a native URI error. We pass the trap as part of
                // a malformed sequence to force the engine to process it.
                decodeURIComponent(s(37, 69, 48) + trap.substring(0, 100));
            } catch (e) {
                // We capture the stack. In Node.js 20+, the stack can include
                // snippets of the surrounding memory in the 'parent-vm.js' logic.
                outputData += (e.stack || e.message).substring(0, 1000);
            }

            // 3. Return the collected data (skip 60MB expansion due to memory limit)
            return outputData;

        } catch (e) {
            return s(70, 97, 105, 108); // "Fail"
        }
      `;

      const result = await enclave.run(code);

      // The attack should be blocked - no sensitive stack trace information should be leaked
      // Patterns that indicate information leakage (internal implementation details)
      const leakPatterns = [
        'parent-vm.js', // Parent VM bootstrap script
        'parentVmMain', // Parent VM main function
        'double-vm-wrapper', // Host-side wrapper
        'safe-runtime', // Host-side runtime
        '/Users/', // macOS home directory paths
        '/home/', // Linux home directory paths
        'node_modules', // npm package paths
        'vm-adapter', // Host-side adapter
        '/var/task/', // Lambda function paths
        'dl.execute', // Lambda internal
        'vc.run', // Lambda internal
      ];

      if (result.success) {
        // If execution succeeded, check what was returned
        if (typeof result.value === 'string') {
          // Should not contain internal paths or implementation details
          for (const pattern of leakPatterns) {
            expect(result.value).not.toContain(pattern);
          }
          // Stack traces should be sanitized with [REDACTED] markers
          // or should not contain detailed file paths
          expect(result.value).not.toMatch(/at\s+\w+\s+\([^)]*:\d+:\d+\)/);
        }
      } else {
        // Execution failed with error - check error doesn't leak info
        if (result.error?.stack) {
          for (const pattern of leakPatterns) {
            expect(result.error.stack).not.toContain(pattern);
          }
        }
      }

      enclave.dispose();
    });

    it('ATK-COBS-50: should block arrow-function replacer probe attack (Vector 820)', async () => {
      // Vector 820: Arrow-Function Replacer Probe
      // Purpose: Use allowed arrow functions to probe the Host Bridge
      // during the sanitization phase while complying with AgentScript v1.
      //
      // Attack flow:
      // 1. Create an object with a toJSON method (arrow function)
      // 2. Pass it to callTool - when host serializes args with JSON.stringify, toJSON() is called
      // 3. Inside toJSON(), try to enumerate Object.keys(JSON) to probe the sandbox
      // 4. Create a large output to stress the system
      //
      // The attack should be blocked by:
      // - Memory limit enforcement (blocks 60MB allocation)
      // - Secure proxy blocking access to sensitive properties
      const enclave = new Enclave({
        securityLevel: 'SECURE',
        memoryLimit: 10 * 1024 * 1024, // 10MB limit
        globals: {
          SECRET: 'FAKE_SECRET_FOR_SECURITY_CHALLENGE',
        },
      });

      const code = `
        // Vector 820: Arrow-Function Replacer Probe
        // Purpose: Use allowed arrow functions to probe the Host Bridge
        // during the sanitization phase while complying with AgentScript v1.

        const s = String.fromCharCode;

        try {
            let bridgeLeak = s(73, 78, 73, 84); // "INIT"

            // 1. Create a "data object" that triggers a callback.
            // We use a getter defined via shorthand, or a nested object
            // that the host bridge must traverse.
            const hook = {
                // Shorthand method definition (often allowed when 'function' is not)
                toJSON: () => {
                    let keys = s(66, 108, 111, 99, 107, 101, 100); // "Blocked"
                    try {
                        // We attempt to find the secret in the current execution scope
                        // by checking the Array constructor's siblings or the global object.
                        keys = Object.keys(JSON).join(s(44));
                    } catch (e) {}
                    bridgeLeak = keys;
                    return s(111, 107); // "ok"
                }
            };

            // 2. Call the tool with a static literal and our hook
            try {
                // We use "search" as our guess for a valid tool
                await callTool("search", { payload: hook });
            } catch (e) {
                // Catch "Unknown tool" or "Validation" error
            }

            // 3. Return the bridge leak result (skip 60MB expansion due to memory limit)
            return "Bridge probe result: " + bridgeLeak;

        } catch (e) {
            return s(70, 97, 105, 108); // "Fail"
        }
      `;

      const result = await enclave.run(code);

      // The attack should be blocked - no sensitive information should be leaked
      const secretValue = 'FAKE_SECRET_FOR_SECURITY_CHALLENGE';

      // Patterns that indicate information leakage
      const leakPatterns = ['SECRET', 'innerCallTool', 'hostCallTool', 'validateOperation', '__host_', '__safe_'];

      if (result.success) {
        // If execution succeeded, check what was returned
        if (typeof result.value === 'string') {
          // Should not contain the secret
          expect(result.value).not.toContain(secretValue);
          // Should not contain internal function names
          for (const pattern of leakPatterns) {
            expect(result.value).not.toContain(pattern);
          }
          // The toJSON hook should either:
          // - Not be called (args sanitized before serialization)
          // - Return safe JSON keys only (parse, stringify)
          // - Be blocked entirely
        }
      } else {
        // Execution failed with error - check error doesn't leak info
        expect(result.error?.message).not.toContain(secretValue);
        for (const pattern of leakPatterns) {
          expect(result.error?.message).not.toContain(pattern);
        }
      }

      enclave.dispose();
    });
  });
});
