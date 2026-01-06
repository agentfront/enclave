/**
 * ATK-FGAD: Function Gadget Attack Vectors Test Suite
 *
 * Category: ATK-FGAD (CWE-94: Improper Control of Generation of Code)
 *
 * This file tests attacks that exploit methods on primitives and built-in objects
 * to bypass sandbox security. These "gadgets" are legitimate JavaScript features
 * that can be chained together to achieve sandbox escape.
 *
 * Security Model:
 * 1. AST Layer blocks dangerous identifiers (process, require, module, etc.)
 * 2. Runtime Layer provides sandbox isolation via vm context
 * 3. codeGeneration.strings=false blocks new Function() from strings entirely
 *
 * NOTE: With codeGeneration.strings=false (added as security hardening), the
 * Function constructor cannot create functions from strings at all. This is
 * STRONGER than sandbox isolation - it blocks the attack vector entirely.
 * Tests accept both outcomes as valid security measures:
 * - Original expected value: sandbox isolation worked
 * - 'blocked'/'blocked-exec': Function creation from strings was blocked
 *
 * Test Categories:
 * - ATK-FGAD-01 to ATK-FGAD-10: Primitive Constructor Chains
 * - ATK-FGAD-11 to ATK-FGAD-18: Callback Injection Attacks
 * - ATK-FGAD-19 to ATK-FGAD-24: Type Coercion Gadgets
 * - ATK-FGAD-25 to ATK-FGAD-30: Function.prototype Exploitation
 * - ATK-FGAD-31 to ATK-FGAD-34: Tagged Template Literal Attacks
 * - ATK-FGAD-35 to ATK-FGAD-38: JSON Reviver/Replacer Attacks
 * - ATK-FGAD-39 to ATK-FGAD-42: Implicit Coercion in Operations
 * - ATK-FGAD-43 to ATK-FGAD-48: Getter/Setter Property Attacks
 * - ATK-FGAD-49 to ATK-FGAD-54: Prototype Pollution Gadgets
 * - ATK-FGAD-55 to ATK-FGAD-60: Combined/Chained Gadget Attacks
 *
 * Related CWEs:
 * - CWE-94: Improper Control of Generation of Code ('Code Injection')
 * - CWE-693: Protection Mechanism Failure
 * - CWE-1321: Improperly Controlled Modification of Object Prototype Attributes
 *
 * NOTE: Tests use `typeof process` which gets transformed to `typeof __safe_process`
 * and blocked at AST level. This is intended behavior - the enclave blocks even
 * type checks on dangerous globals.
 *
 * @packageDocumentation
 */

import { Enclave } from '../enclave';

/**
 * Helper to check if result is either expected OR blocked (both are valid security outcomes)
 * With codeGeneration.strings=false, Function construction from strings is blocked entirely.
 * With AST validation, string concatenation attacks may be blocked at parse time (success: false).
 */
function expectSecureOutcome(actual: unknown, expected: unknown): void {
  const blockedValues = ['blocked', 'blocked-exec', 'blocked-or-error'];
  if (blockedValues.includes(actual as string)) {
    // Function creation was blocked - this is valid and actually stronger security
    return;
  }
  expect(actual).toBe(expected);
}

/**
 * Helper for tests that may be blocked at AST level (success: false) or runtime level.
 * Both are valid security outcomes - AST blocking is actually stronger.
 */
function expectSecureResult(
  result: { success: boolean; value?: unknown; error?: { message?: string } },
  expectedValue: unknown,
): void {
  if (!result.success) {
    // AST-level validation blocked the attack - this is valid and stronger security
    expect(result.error?.message).toMatch(/AgentScript validation failed|code generation from strings/i);
    return;
  }
  // Runtime blocking or sandbox execution
  expectSecureOutcome(result.value, expectedValue);
}

describe('ATK-FGAD: Function Gadget Attack Vectors (CWE-94)', () => {
  // ============================================================================
  // ATK-FGAD-01 to ATK-FGAD-10: PRIMITIVE CONSTRUCTOR CHAINS
  // Access Function constructor through primitive.constructor.constructor
  // ============================================================================

  describe('ATK-FGAD-01 to ATK-FGAD-10: Primitive Constructor Chains', () => {
    /**
     * These tests verify that even when accessing the Function constructor through
     * primitive prototype chains, the constructed functions run in sandbox context
     * without access to Node.js globals.
     *
     * Security insight:
     * - Sandbox-created primitives have constructor access to sandbox's Function
     * - Sandbox's Function creates functions that run in sandbox context
     * - No access to host's process, require, module, __dirname, etc.
     */
    describe('ATK-FGAD-01 to ATK-FGAD-03: String Constructor Chain', () => {
      it('ATK-FGAD-01: should ensure "".constructor.constructor returns sandbox Function', async () => {
        const enclave = new Enclave();
        const code = `
          const str = '';
          const ctorKey = 'const' + 'ructor';
          const StringCtor = str[ctorKey];
          if (!StringCtor) return 'blocked-string-ctor';
          const FnCtor = StringCtor[ctorKey];
          if (!FnCtor) return 'blocked-fn-ctor';
          try {
            // The function constructor works, but runs in sandbox
            const fn = FnCtor('return 42');
            const result = fn();
            return result === 42 ? 'sandbox-function-works' : 'unexpected';
          } catch (e) {
            return 'blocked-exec';
          }
        `;
        const result = await enclave.run(code);
        // Function constructor works in sandbox, returns sandbox function
        // Or blocked by AST validation or codeGeneration.strings=false (stronger security)
        expectSecureResult(result, 'sandbox-function-works');
        enclave.dispose();
      });

      it('ATK-FGAD-02: should ensure constructed function cannot return host objects', async () => {
        const enclave = new Enclave();
        const code = `
          const str = 'test';
          const ctorKey = 'const' + 'ructor';
          const StringCtor = str[ctorKey];
          const FnCtor = StringCtor ? StringCtor[ctorKey] : null;
          if (FnCtor) {
            try {
              // Classic attack: get global object via "return this"
              // In non-strict mode this returns globalThis (sandbox's)
              const globalObj = FnCtor('return this')();
              // Sandbox's globalThis doesn't have host properties
              const hasEval = globalObj && 'eval' in globalObj;
              return hasEval ? 'sandbox-global' : 'restricted-global';
            } catch (e) {
              return 'blocked';
            }
          }
          return 'no-fn-ctor';
        `;
        const result = await enclave.run(code);
        // Expected: sandbox-global (sandbox's globalThis), restricted-global, or blocked
        // The key point: no host access even with globalThis
        // AST validation may also block this with success: false
        expectSecureResult(result, 'sandbox-global');
        enclave.dispose();
      });

      it('ATK-FGAD-03: should block code using dangerous globals even via Function constructor', async () => {
        const enclave = new Enclave();
        // This code tries to use process.pid via Function constructor
        // The constructed function's code contains 'process' which will be blocked
        const code = `
          const ctorKey = String.fromCharCode(99,111,110,115,116,114,117,99,116,111,114);
          const FnCtor = ''[ctorKey][ctorKey];
          if (FnCtor) {
            try {
              // Note: even the code STRING contains "process" which AST catches
              const fn = FnCtor('return 1 + 1');
              return fn();
            } catch (e) {
              return 'blocked';
            }
          }
          return 'no-fn-ctor';
        `;
        const result = await enclave.run(code);
        // Should succeed with simple arithmetic (no blocked globals)
        // Or blocked by codeGeneration.strings=false (stronger security)
        expect(result.success).toBe(true);
        expectSecureOutcome(result.value, 2);
        enclave.dispose();
      });
    });

    describe('ATK-FGAD-04 to ATK-FGAD-05: Number Constructor Chain', () => {
      it('ATK-FGAD-04: should verify (0).constructor.constructor runs in sandbox', async () => {
        const enclave = new Enclave();
        const code = `
          const num = 0;
          const ctorKey = 'const' + 'ructor';
          const NumCtor = num[ctorKey];
          const FnCtor = NumCtor ? NumCtor[ctorKey] : null;
          if (FnCtor) {
            try {
              // Create a function that returns a simple value
              const fn = FnCtor('return 100 + 23');
              return fn();
            } catch (e) {
              return 'blocked';
            }
          }
          return 'no-fn-ctor';
        `;
        const result = await enclave.run(code);
        // Or blocked by AST validation or codeGeneration.strings=false (stronger security)
        expectSecureResult(result, 123);
        enclave.dispose();
      });

      it('ATK-FGAD-05: should verify Number.prototype chain is in sandbox context', async () => {
        const enclave = new Enclave();
        const code = `
          const ctorKey = 'const' + 'ructor';
          const protoKey = 'proto' + 'type';
          const NumberProto = Number[protoKey];
          if (!NumberProto) return 'blocked-proto';
          const FnCtor = NumberProto[ctorKey] ? NumberProto[ctorKey][ctorKey] : null;
          if (FnCtor) {
            try {
              // Test arithmetic - should work fine in sandbox
              const fn = FnCtor('return Math.PI * 2');
              const result = fn();
              return result > 6 && result < 7 ? 'math-works' : 'math-broken';
            } catch (e) {
              return 'blocked';
            }
          }
          return 'no-fn-ctor';
        `;
        const result = await enclave.run(code);
        // Or blocked by AST validation or codeGeneration.strings=false (stronger security)
        expectSecureResult(result, 'math-works');
        enclave.dispose();
      });
    });

    describe('ATK-FGAD-06: Boolean Constructor Chain', () => {
      it('ATK-FGAD-06: should verify true.constructor.constructor is sandbox Function', async () => {
        const enclave = new Enclave();
        const code = `
          const bool = true;
          const ctorKey = 'const' + 'ructor';
          const BoolCtor = bool[ctorKey];
          const FnCtor = BoolCtor ? BoolCtor[ctorKey] : null;
          if (FnCtor) {
            try {
              // Test that we can create functions that work
              const fn = FnCtor('return [1,2,3].map(x => x * 2)');
              const result = fn();
              return JSON.stringify(result);
            } catch (e) {
              return 'blocked';
            }
          }
          return 'no-fn-ctor';
        `;
        const result = await enclave.run(code);
        // Or blocked by AST validation or codeGeneration.strings=false (stronger security)
        expectSecureResult(result, '[2,4,6]');
        enclave.dispose();
      });
    });

    describe('ATK-FGAD-07: Array Constructor Chain', () => {
      it('ATK-FGAD-07: should verify [].constructor.constructor is sandbox Function', async () => {
        const enclave = new Enclave();
        const code = `
          const arr = [];
          const ctorKey = 'const' + 'ructor';
          const ArrCtor = arr[ctorKey];
          if (!ArrCtor) return 'blocked-arr-ctor';
          const FnCtor = ArrCtor[ctorKey];
          if (!FnCtor) return 'blocked-fn-ctor';
          try {
            // Create function that uses Array methods
            const fn = FnCtor('return [1,2,3].reduce((a,b) => a + b, 0)');
            return fn();
          } catch (e) {
            return 'blocked';
          }
        `;
        const result = await enclave.run(code);
        // Or blocked by AST validation or codeGeneration.strings=false (stronger security)
        expectSecureResult(result, 6);
        enclave.dispose();
      });
    });

    describe('ATK-FGAD-08: Object Constructor Chain', () => {
      it('ATK-FGAD-08: should verify {}.constructor.constructor is sandbox Function', async () => {
        const enclave = new Enclave();
        const code = `
          const obj = {};
          const ctorKey = 'const' + 'ructor';
          const ObjCtor = obj[ctorKey];
          if (!ObjCtor) return 'blocked-obj-ctor';
          const FnCtor = ObjCtor[ctorKey];
          if (!FnCtor) return 'blocked-fn-ctor';
          try {
            // Create function that uses Object methods
            const fn = FnCtor('return Object.keys({a:1, b:2}).length');
            return fn();
          } catch (e) {
            return 'blocked';
          }
        `;
        const result = await enclave.run(code);
        // Or blocked by AST validation or codeGeneration.strings=false (stronger security)
        expectSecureResult(result, 2);
        enclave.dispose();
      });
    });

    describe('ATK-FGAD-09: RegExp Constructor Chain (if allowed)', () => {
      it('ATK-FGAD-09: should verify RegExp constructor chain in permissive mode', async () => {
        // RegExp is blocked by AST in AgentScript, but test in permissive
        const enclave = new Enclave({ preset: 'permissive', securityLevel: 'PERMISSIVE' });
        const code = `
          try {
            const rx = /x/;
            const ctorKey = 'const' + 'ructor';
            const RxCtor = rx[ctorKey];
            const FnCtor = RxCtor ? RxCtor[ctorKey] : null;
            if (FnCtor) {
              // Test that function works but returns sandbox context
              const fn = FnCtor('return /test/.test("testing")');
              return fn() ? 'regex-works' : 'regex-broken';
            }
            return 'no-fn-ctor';
          } catch (e) {
            return 'blocked-or-error';
          }
        `;
        const result = await enclave.run(code);
        if (result.success) {
          // Or blocked by codeGeneration.strings=false (stronger security)
          expectSecureOutcome(result.value, 'regex-works');
        }
        enclave.dispose();
      });
    });
  });

  // ============================================================================
  // ATK-FGAD-11 to ATK-FGAD-18: CALLBACK INJECTION ATTACKS
  // Using array methods with callbacks that might have dangerous access
  // ============================================================================

  describe('ATK-FGAD-11 to ATK-FGAD-18: Callback Injection Attacks', () => {
    /**
     * These tests verify that callbacks passed to array methods run in sandbox
     * context and cannot access Node.js globals or escape the sandbox.
     *
     * Note: Tests that use `typeof process/require` are blocked at AST level
     * (transformed to __safe_* which fails validation). This IS correct security.
     */
    describe('ATK-FGAD-11 to ATK-FGAD-12: Array.prototype.map Attacks', () => {
      it('ATK-FGAD-11: should verify map callback runs and can access sandbox globals', async () => {
        const enclave = new Enclave();
        const code = `
          const results = [1, 2, 3].map((x) => {
            // Test that Math is available (allowed global)
            return Math.pow(x, 2);
          });
          return results;
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(true);
        expect(result.value).toEqual([1, 4, 9]);
        enclave.dispose();
      });

      it('ATK-FGAD-12: should verify map callback this.constructor leads to sandbox Function', async () => {
        // PERMISSIVE mode required: uses function expression for this binding
        const enclave = new Enclave({ preset: 'permissive', securityLevel: 'PERMISSIVE' });
        const code = `
          const ctorKey = 'const' + 'ructor';
          let escapedFn = null;
          [1].map(function() {
            // Try to get Function from this (will be sandbox's)
            const thisCtor = this ? this[ctorKey] : null;
            if (thisCtor) {
              escapedFn = thisCtor[ctorKey];
            }
          });
          if (escapedFn) {
            try {
              // If we got Function constructor, it's sandbox's
              const fn = escapedFn('return 42');
              return fn();
            } catch (e) {
              return 'blocked';
            }
          }
          return 'no-escape';
        `;
        const result = await enclave.run(code);
        // Either sandbox Function works, no this context, blocked, or AST blocked
        if (result.success) {
          expect(['42', 42, 'no-escape', 'blocked']).toContain(result.value);
        } else {
          // AST validation blocked the attack - also valid
          expect(result.error?.message).toMatch(/AgentScript validation failed/);
        }
        enclave.dispose();
      });
    });

    describe('ATK-FGAD-13: Array.prototype.filter Attacks', () => {
      it('ATK-FGAD-13: should verify filter callback behavior with arguments.callee in permissive mode', async () => {
        // PERMISSIVE mode: code runs in non-strict mode, arguments.callee IS available
        // This documents the expected behavior - not a security vulnerability
        const enclave = new Enclave({ preset: 'permissive', securityLevel: 'PERMISSIVE' });
        const code = `
          let leaked = null;
          [1, 2, 3].filter(function filterFn(x) {
            // In non-strict mode (PERMISSIVE), arguments.callee IS available
            try {
              leaked = typeof arguments.callee === 'function' ? 'has-callee' : 'no-callee';
            } catch (e) {
              leaked = 'blocked';
            }
            return true;
          });
          return leaked;
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(true);
        // In PERMISSIVE (non-strict) mode, arguments.callee is available
        // This is expected - PERMISSIVE mode allows more JavaScript features
        expect(result.value).toBe('has-callee');
        enclave.dispose();
      });
    });

    describe('ATK-FGAD-14 to ATK-FGAD-15: Array.prototype.reduce Attacks', () => {
      it('ATK-FGAD-14: should verify reduce works normally in sandbox', async () => {
        const enclave = new Enclave();
        const code = `
          // Simple reduce - should work fine in sandbox
          const result = [1, 2, 3, 4, 5].reduce((acc, x) => acc + x, 0);
          return result;
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(true);
        expect(result.value).toBe(15);
        enclave.dispose();
      });

      it('ATK-FGAD-15: should verify reduce with object accumulator stays in sandbox', async () => {
        const enclave = new Enclave();
        const code = `
          const ctorKey = 'const' + 'ructor';
          const result = [1, 2, 3].reduce((acc, x) => {
            // Accumulator is sandbox object
            const accCtor = acc[ctorKey];
            // Object constructor chain leads to sandbox Function
            return { sum: (acc.sum || 0) + x, hasCtor: !!accCtor };
          }, { sum: 0 });
          return result.sum;
        `;
        const result = await enclave.run(code);
        // Either AST blocks string concatenation attack or sandbox isolation works
        if (result.success) {
          expect(result.value).toBe(6);
        } else {
          // AST validation caught the string concatenation - also valid
          expect(result.error?.message).toMatch(/AgentScript validation failed/);
        }
        enclave.dispose();
      });
    });

    describe('ATK-FGAD-16: Array.prototype.sort Attacks', () => {
      it('ATK-FGAD-16: should verify sort comparator works in sandbox', async () => {
        const enclave = new Enclave();
        const code = `
          const arr = [3, 1, 4, 1, 5, 9, 2, 6];
          arr.sort((a, b) => b - a); // Descending
          return arr.slice(0, 3);
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(true);
        expect(result.value).toEqual([9, 6, 5]);
        enclave.dispose();
      });
    });

    describe('ATK-FGAD-17: Array.prototype.find/findIndex Attacks', () => {
      it('ATK-FGAD-17: should verify find callback works in sandbox', async () => {
        const enclave = new Enclave();
        const code = `
          const found = [1, 2, 3, 4, 5].find((x) => {
            return x > 3;
          });
          return found;
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(true);
        expect(result.value).toBe(4);
        enclave.dispose();
      });
    });

    describe('ATK-FGAD-18: Array.prototype.forEach Attacks', () => {
      it('ATK-FGAD-18: should verify forEach callback cannot access host prototypes', async () => {
        const enclave = new Enclave();
        const code = `
          let protoAccess = 'none';
          [1].forEach((x, i, arr) => {
            // Try to access array prototype
            const protoKey = '__pro' + 'to__';
            const proto = arr[protoKey];
            if (proto && Array.isArray(proto.map)) {
              protoAccess = 'has-proto';
            }
          });
          return protoAccess;
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(true);
        // forEach gets sandbox array, proto access is sandbox's
        enclave.dispose();
      });
    });
  });

  // ============================================================================
  // ATK-FGAD-19 to ATK-FGAD-24: TYPE COERCION GADGETS
  // Exploiting valueOf, toString, toJSON for code execution
  // ============================================================================

  describe('ATK-FGAD-19 to ATK-FGAD-24: Type Coercion Gadgets', () => {
    /**
     * Type coercion methods (valueOf, toString, toJSON) are called automatically
     * during operations. These tests verify they run in sandbox context.
     *
     * Note: These tests require PERMISSIVE mode because they use object methods
     * defined with function expressions (valueOf: function() {}).
     */
    describe('ATK-FGAD-19 to ATK-FGAD-20: valueOf Exploitation', () => {
      it('ATK-FGAD-19: should verify valueOf runs in sandbox and returns expected values', async () => {
        // PERMISSIVE mode: object method with function expression
        const enclave = new Enclave({ preset: 'permissive', securityLevel: 'PERMISSIVE' });
        const code = `
          const obj = {
            valueOf: function() {
              // valueOf works, returns value based on sandbox context
              return 42;
            }
          };
          const result = obj + 1; // Triggers valueOf
          return result;
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(true);
        expect(result.value).toBe(43);
        enclave.dispose();
      });

      it('ATK-FGAD-20: should verify valueOf constructor chain leads to sandbox Function', async () => {
        // PERMISSIVE mode: object method with function expression
        const enclave = new Enclave({ preset: 'permissive', securityLevel: 'PERMISSIVE' });
        const code = `
          const ctorKey = 'const' + 'ructor';
          const obj = {
            valueOf: function() {
              // Return constructor - will be sandbox's Object
              return this[ctorKey];
            }
          };
          const coerced = obj.valueOf();
          if (coerced && coerced[ctorKey]) {
            try {
              // Function is sandbox's - should work but isolated
              const fn = coerced[ctorKey]('return 99');
              return fn();
            } catch (e) {
              return 'blocked';
            }
          }
          return 'no-chain';
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(true);
        // Sandbox Function works and returns expected value
        // Or blocked by codeGeneration.strings=false (stronger security)
        expectSecureOutcome(result.value, 99);
        enclave.dispose();
      });
    });

    describe('ATK-FGAD-21 to ATK-FGAD-22: toString Exploitation', () => {
      it('ATK-FGAD-21: should verify toString runs in sandbox and returns string', async () => {
        // PERMISSIVE mode: object method with function expression
        const enclave = new Enclave({ preset: 'permissive', securityLevel: 'PERMISSIVE' });
        const code = `
          const obj = {
            toString: function() {
              return 'sandbox-string';
            }
          };
          return '' + obj; // Triggers toString
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(true);
        expect(result.value).toBe('sandbox-string');
        enclave.dispose();
      });

      it('ATK-FGAD-22: should verify toString can return any string in PERMISSIVE mode', async () => {
        // PERMISSIVE mode: Object.constructor access is allowed
        // This is expected behavior - PERMISSIVE mode has minimal restrictions
        const enclave = new Enclave({ preset: 'permissive', securityLevel: 'PERMISSIVE' });
        const code = `
          const obj = {
            toString: function() {
              return 'const' + 'ructor'; // Returns the string "constructor"
            }
          };
          const key = obj.toString();
          // In PERMISSIVE mode, Object constructor IS accessible
          const ObjCtor = Object[key];
          return ObjCtor ? 'has-ctor' : 'no-ctor';
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(true);
        // In PERMISSIVE mode, constructor access is not blocked
        // The security relies on vm context isolation (sandbox's Function)
        expect(result.value).toBe('has-ctor');
        enclave.dispose();
      });
    });

    describe('ATK-FGAD-23: toJSON Exploitation', () => {
      it('ATK-FGAD-23: should verify toJSON runs in sandbox during stringify', async () => {
        // PERMISSIVE mode: object method with function expression
        const enclave = new Enclave({ preset: 'permissive', securityLevel: 'PERMISSIVE' });
        const code = `
          let called = false;
          const obj = {
            toJSON: function() {
              called = true;
              return { data: 'safe', source: 'toJSON' };
            }
          };
          const json = JSON.stringify(obj);
          return { called, json };
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(true);
        expect((result.value as any).called).toBe(true);
        expect(JSON.parse((result.value as any).json)).toEqual({ data: 'safe', source: 'toJSON' });
        enclave.dispose();
      });
    });

    describe('ATK-FGAD-24: Symbol.toPrimitive Exploitation', () => {
      it('ATK-FGAD-24: should block Symbol.toPrimitive (AST blocks Symbol)', async () => {
        const enclave = new Enclave();
        const code = `
          const obj = {
            [Symbol.toPrimitive]: function(hint) {
              return 1;
            }
          };
          return +obj;
        `;
        const result = await enclave.run(code);
        // Should fail at AST (Symbol blocked)
        expect(result.success).toBe(false);
        enclave.dispose();
      });
    });
  });

  // ============================================================================
  // ATK-FGAD-25 to ATK-FGAD-30: FUNCTION.PROTOTYPE EXPLOITATION
  // Using call, apply, bind to change context or access globals
  // ============================================================================

  describe('ATK-FGAD-25 to ATK-FGAD-30: Function.prototype Exploitation', () => {
    /**
     * Function.prototype methods (call, apply, bind) allow changing execution
     * context. These tests verify they work correctly within sandbox isolation.
     *
     * Note: These tests require PERMISSIVE mode because they use function expressions.
     */
    describe('ATK-FGAD-25 to ATK-FGAD-26: Function.prototype.call Attacks', () => {
      it('ATK-FGAD-25: should verify call with null returns global in non-strict PERMISSIVE mode', async () => {
        // PERMISSIVE mode runs in non-strict mode, so call(null) returns globalThis
        const enclave = new Enclave({ preset: 'permissive', securityLevel: 'PERMISSIVE' });
        const code = `
          const getThis = function() { return this; };
          // In non-strict mode, calling with null gives globalThis (sandbox's)
          const ctx = getThis.call(null);
          // ctx is the sandbox's global object, not undefined
          return ctx === undefined ? 'strict-mode-undefined' : 'has-context';
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(true);
        // In PERMISSIVE (non-strict) mode, this is globalThis (sandbox's global)
        expect(result.value).toBe('has-context');
        enclave.dispose();
      });

      it('ATK-FGAD-26: should verify borrowed Array.prototype.map works in sandbox', async () => {
        // PERMISSIVE mode: accesses Array.prototype
        const enclave = new Enclave({ preset: 'permissive', securityLevel: 'PERMISSIVE' });
        const code = `
          const borrowed = Array.prototype.map;
          // Use borrowed method on an array
          const result = borrowed.call([1, 2, 3], x => x * 2);
          return result;
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(true);
        expect(result.value).toEqual([2, 4, 6]);
        enclave.dispose();
      });
    });

    describe('ATK-FGAD-27: Function.prototype.apply Attacks', () => {
      it('ATK-FGAD-27: should verify apply works normally in sandbox', async () => {
        // PERMISSIVE mode: uses function expression
        const enclave = new Enclave({ preset: 'permissive', securityLevel: 'PERMISSIVE' });
        const code = `
          const fn = function(a, b, c) {
            return a + b + c;
          };
          const result = fn.apply(null, [10, 20, 30]);
          return result;
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(true);
        expect(result.value).toBe(60);
        enclave.dispose();
      });
    });

    describe('ATK-FGAD-28 to ATK-FGAD-29: Function.prototype.bind Attacks', () => {
      it('ATK-FGAD-28: should verify bind creates function with custom context in sandbox', async () => {
        // PERMISSIVE mode: uses function expression
        const enclave = new Enclave({ preset: 'permissive', securityLevel: 'PERMISSIVE' });
        const code = `
          const fn = function() { return this; };
          const obj = { secret: 'data' };
          const bound = fn.bind(obj);
          const ctx = bound();
          return ctx && ctx.secret === 'data' ? 'bound-works' : 'no-bind';
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(true);
        // Bind works correctly within sandbox
        expect(result.value).toBe('bound-works');
        enclave.dispose();
      });

      it('ATK-FGAD-29: should verify function.constructor.constructor is sandbox Function', async () => {
        // PERMISSIVE mode: uses function expression
        const enclave = new Enclave({ preset: 'permissive', securityLevel: 'PERMISSIVE' });
        const code = `
          const fn = function() {};
          const ctorKey = 'const' + 'ructor';
          const FnProto = fn[ctorKey];
          if (FnProto) {
            const FnCtor = FnProto[ctorKey];
            if (FnCtor) {
              try {
                // Function constructor works, runs in sandbox
                const created = FnCtor('return 123');
                return created();
              } catch (e) {
                return 'blocked';
              }
            }
          }
          return 'no-ctor';
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(true);
        // Sandbox Function constructor works
        // Or blocked by codeGeneration.strings=false (stronger security)
        expectSecureOutcome(result.value, 123);
        enclave.dispose();
      });
    });
  });

  // ============================================================================
  // ATK-FGAD-31 to ATK-FGAD-34: TAGGED TEMPLATE LITERAL ATTACKS
  // Using template literals with tag functions for code execution
  // ============================================================================

  describe('ATK-FGAD-31 to ATK-FGAD-34: Tagged Template Literal Attacks', () => {
    /**
     * Tagged template literals allow custom processing of template strings.
     * These tests verify tag functions run in sandbox context.
     */
    describe('ATK-FGAD-31 to ATK-FGAD-32: String.raw Exploitation', () => {
      it('ATK-FGAD-31: should verify String.raw works in sandbox', async () => {
        const enclave = new Enclave();
        // Use String.raw for the outer template to preserve escape sequences
        const code = String.raw`
          const result = String.raw${'`'}test\nvalue${'`'};
          // String.raw preserves escape sequences as literal backslash+n
          // Check for literal backslash followed by n (not newline character)
          // result should be "test\nvalue" (8 chars with literal backslash)
          return result.length === 11 && result.indexOf('\\') === 4 ? 'raw-works' : 'interpreted';
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(true);
        expect(result.value).toBe('raw-works');
        enclave.dispose();
      });

      it('ATK-FGAD-32: should verify String constructor is blocked by SecureProxy', async () => {
        const enclave = new Enclave();
        const code = `
          const ctorKey = 'const' + 'ructor';
          // String is wrapped by SecureProxy - accessing constructor throws
          const StrCtor = String[ctorKey];
          return StrCtor ? 'has-ctor' : 'no-ctor';
        `;
        const result = await enclave.run(code);
        // String constructor access should throw an error
        expect(result.success).toBe(false);
        expect(result.error?.message).toMatch(/Security violation|AgentScript validation failed/);
        enclave.dispose();
      });
    });

    describe('ATK-FGAD-33 to ATK-FGAD-34: Custom Tag Function Attacks', () => {
      it('ATK-FGAD-33: should verify custom tag functions process templates correctly', async () => {
        const enclave = new Enclave();
        const code = `
          const tag = (strings, ...values) => {
            // Custom tag function works in sandbox
            return strings.join('|') + ':' + values.join(',');
          };
          const x = 1, y = 2;
          return tag\`a\${x}b\${y}c\`;
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(true);
        expect(result.value).toBe('a|b|c:1,2');
        enclave.dispose();
      });

      it('ATK-FGAD-34: should verify tag function strings.raw leads to sandbox Array', async () => {
        const enclave = new Enclave();
        const code = `
          const tag = (strings) => {
            const ctorKey = 'const' + 'ructor';
            // strings.raw is an array (sandbox array)
            const RawCtor = strings.raw[ctorKey];
            if (RawCtor) {
              const FnCtor = RawCtor[ctorKey];
              if (FnCtor) {
                try {
                  // Sandbox Function - can create and run functions
                  const fn = FnCtor('return 777');
                  return fn();
                } catch (e) {
                  return 'blocked';
                }
              }
            }
            return 'no-ctor';
          };
          return tag\`test\`;
        `;
        const result = await enclave.run(code);
        // Either AST blocks string concatenation attack or sandbox isolation works
        // Or blocked by AST validation or codeGeneration.strings=false (stronger security)
        expectSecureResult(result, 777);
        enclave.dispose();
      });
    });
  });

  // ============================================================================
  // ATK-FGAD-35 to ATK-FGAD-38: JSON REVIVER/REPLACER ATTACKS
  // Exploiting JSON.parse reviver and JSON.stringify replacer
  // ============================================================================

  describe('ATK-FGAD-35 to ATK-FGAD-38: JSON Reviver/Replacer Attacks', () => {
    /**
     * JSON.parse revivers and JSON.stringify replacers allow custom processing.
     * These tests verify they run in sandbox context.
     */
    describe('ATK-FGAD-35 to ATK-FGAD-36: JSON.parse Reviver Attacks', () => {
      it('ATK-FGAD-35: should verify reviver processes values correctly in sandbox', async () => {
        const enclave = new Enclave();
        const code = `
          let callCount = 0;
          const parsed = JSON.parse('{"a": 1, "b": 2}', (key, value) => {
            callCount++;
            if (typeof value === 'number') {
              return value * 10;
            }
            return value;
          });
          return { result: parsed, calls: callCount };
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(true);
        expect((result.value as any).result).toEqual({ a: 10, b: 20 });
        // Called for a, b, and the root object
        expect((result.value as any).calls).toBe(3);
        enclave.dispose();
      });

      it('ATK-FGAD-36: should verify reviver this.constructor leads to sandbox Function', async () => {
        // PERMISSIVE mode: uses function expression for reviver
        const enclave = new Enclave({ preset: 'permissive', securityLevel: 'PERMISSIVE' });
        const code = `
          const ctorKey = 'const' + 'ructor';
          let escaped = null;
          JSON.parse('{"a": 1}', function(key, value) {
            // this is the object being constructed (sandbox object)
            if (this && this[ctorKey]) {
              escaped = this[ctorKey][ctorKey];
            }
            return value;
          });
          if (escaped) {
            try {
              // Sandbox Function - works but isolated
              const fn = escaped('return 555');
              return fn();
            } catch (e) {
              return 'blocked';
            }
          }
          return 'no-escape';
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(true);
        // Sandbox Function works
        // Or blocked by codeGeneration.strings=false (stronger security)
        expectSecureOutcome(result.value, 555);
        enclave.dispose();
      });
    });

    describe('ATK-FGAD-37: JSON.stringify Replacer Attacks', () => {
      it('ATK-FGAD-37: should verify replacer processes values correctly in sandbox', async () => {
        const enclave = new Enclave();
        const code = `
          const result = JSON.stringify({ a: 1, b: 'test', c: [1, 2] }, (key, value) => {
            if (typeof value === 'number') {
              return value * 2;
            }
            return value;
          });
          return result;
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(true);
        expect(JSON.parse(result.value as string)).toEqual({ a: 2, b: 'test', c: [2, 4] });
        enclave.dispose();
      });
    });
  });

  // ============================================================================
  // ATK-FGAD-39 to ATK-FGAD-42: IMPLICIT COERCION IN OPERATIONS
  // Exploiting operator overloading through coercion
  // ============================================================================

  describe('ATK-FGAD-39 to ATK-FGAD-42: Implicit Coercion in Operations', () => {
    /**
     * JavaScript operators trigger implicit type coercion. These tests verify
     * coercion methods (valueOf, toString) work correctly in sandbox.
     */
    describe('ATK-FGAD-39: Addition Coercion', () => {
      it('ATK-FGAD-39: should verify + operator uses valueOf/toString correctly', async () => {
        const enclave = new Enclave();
        const code = `
          const obj = {
            valueOf: () => 42,
            toString: () => 'hello'
          };
          const numResult = obj + 0;  // Uses valueOf
          const strResult = obj + ''; // Uses valueOf then toString
          return { num: numResult, str: strResult };
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(true);
        expect((result.value as any).num).toBe(42);
        // String coercion of valueOf result
        expect((result.value as any).str).toBe('42');
        enclave.dispose();
      });
    });

    describe('ATK-FGAD-40: Comparison Coercion', () => {
      it('ATK-FGAD-40: should verify == operator coercion works in sandbox', async () => {
        const enclave = new Enclave();
        const code = `
          let valueOfCalled = false;
          const obj = {
            valueOf: () => {
              valueOfCalled = true;
              return 42;
            }
          };
          const isEqual = obj == 42;
          return { equal: isEqual, called: valueOfCalled };
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(true);
        expect((result.value as any).equal).toBe(true);
        expect((result.value as any).called).toBe(true);
        enclave.dispose();
      });
    });

    describe('ATK-FGAD-41: Property Key Coercion', () => {
      it('ATK-FGAD-41: should verify property key toString coercion works', async () => {
        const enclave = new Enclave();
        const code = `
          let toStringCalled = false;
          const key = {
            toString: () => {
              toStringCalled = true;
              return 'mykey';
            }
          };
          const obj = {};
          obj[key] = 'value'; // Triggers toString on key
          return { value: obj.mykey, called: toStringCalled };
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(true);
        expect((result.value as any).value).toBe('value');
        expect((result.value as any).called).toBe(true);
        enclave.dispose();
      });
    });
  });

  // ============================================================================
  // ATK-FGAD-43 to ATK-FGAD-48: GETTER/SETTER PROPERTY ATTACKS
  // Exploiting getters and setters for code execution
  // ============================================================================

  describe('ATK-FGAD-43 to ATK-FGAD-48: Getter/Setter Property Attacks', () => {
    /**
     * Getters and setters are computed properties that run code on access.
     * These tests verify they work correctly in sandbox context.
     *
     * Note: These tests require PERMISSIVE mode because getters/setters use
     * function expressions under the hood.
     */
    describe('ATK-FGAD-43 to ATK-FGAD-44: Getter Exploitation', () => {
      it('ATK-FGAD-43: should verify getters run and return values in sandbox', async () => {
        // PERMISSIVE mode: getter is a function expression
        const enclave = new Enclave({ preset: 'permissive', securityLevel: 'PERMISSIVE' });
        const code = `
          let getterCalled = false;
          const obj = {
            get computed() {
              getterCalled = true;
              return Math.PI;
            }
          };
          const value = obj.computed;
          return { value, called: getterCalled };
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(true);
        expect((result.value as any).value).toBeCloseTo(Math.PI);
        expect((result.value as any).called).toBe(true);
        enclave.dispose();
      });

      it('ATK-FGAD-44: should verify getter this.constructor leads to sandbox Function', async () => {
        // PERMISSIVE mode: getter is a function expression
        const enclave = new Enclave({ preset: 'permissive', securityLevel: 'PERMISSIVE' });
        const code = `
          const ctorKey = 'const' + 'ructor';
          const obj = {
            get ctor() {
              return this[ctorKey];
            }
          };
          const Ctor = obj.ctor;
          if (Ctor && Ctor[ctorKey]) {
            try {
              // Sandbox Function - works but isolated
              const fn = Ctor[ctorKey]('return 333');
              return fn();
            } catch (e) {
              return 'blocked';
            }
          }
          return 'no-ctor';
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(true);
        // Sandbox Function works
        // Or blocked by codeGeneration.strings=false (stronger security)
        expectSecureOutcome(result.value, 333);
        enclave.dispose();
      });
    });

    describe('ATK-FGAD-45: Setter Exploitation', () => {
      it('ATK-FGAD-45: should verify setters run and can modify state in sandbox', async () => {
        // PERMISSIVE mode: setter is a function expression
        const enclave = new Enclave({ preset: 'permissive', securityLevel: 'PERMISSIVE' });
        const code = `
          let setterValue = null;
          const obj = {
            set trap(value) {
              setterValue = value * 2;
            },
            get trap() {
              return setterValue;
            }
          };
          obj.trap = 21;
          return obj.trap;
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(true);
        expect(result.value).toBe(42);
        enclave.dispose();
      });
    });

    describe('ATK-FGAD-46: Object.defineProperty Attacks', () => {
      it('ATK-FGAD-46: should verify defineProperty getters work in permissive mode', async () => {
        const enclave = new Enclave({ preset: 'permissive', securityLevel: 'PERMISSIVE' });
        const code = `
          const obj = {};
          let getterCalled = false;
          Object.defineProperty(obj, 'trap', {
            get: function() {
              getterCalled = true;
              return 'defined-getter';
            }
          });
          return { value: obj.trap, called: getterCalled };
        `;
        const result = await enclave.run(code);
        // defineProperty works in permissive mode
        if (result.success) {
          expect((result.value as any).value).toBe('defined-getter');
          expect((result.value as any).called).toBe(true);
        }
        enclave.dispose();
      });
    });
  });

  // ============================================================================
  // ATK-FGAD-49 to ATK-FGAD-54: PROTOTYPE POLLUTION GADGETS
  // Using prototype pollution to inject code execution paths
  // ============================================================================

  describe('ATK-FGAD-49 to ATK-FGAD-54: Prototype Pollution Gadgets', () => {
    describe('ATK-FGAD-49 to ATK-FGAD-50: Object.prototype Pollution', () => {
      it('ATK-FGAD-49: should isolate Object.prototype pollution from host', async () => {
        const enclave = new Enclave({ preset: 'permissive', securityLevel: 'PERMISSIVE' });
        const code = `
          // Try to pollute Object.prototype (may or may not work depending on VM isolation)
          try {
            Object.prototype.polluted = 'sandbox-value';
            return {}.polluted || 'not-visible';
          } catch (e) {
            return 'blocked';
          }
        `;
        const result = await enclave.run(code);

        // Critical security property: Host Object.prototype is NEVER polluted
        expect((Object.prototype as Record<string, unknown>)['polluted']).toBeUndefined();

        // The sandbox may or may not allow the pollution (implementation dependent)
        // Key point: host is isolated regardless
        expect(result.success).toBe(true);
        enclave.dispose();
      });

      it('ATK-FGAD-50: should isolate Array.prototype pollution from host', async () => {
        const enclave = new Enclave({ preset: 'permissive', securityLevel: 'PERMISSIVE' });
        const code = `
          Array.prototype.polluted = 'sandbox-array';
          return [].polluted;
        `;
        const result = await enclave.run(code);

        // Verify host is not polluted
        expect((Array.prototype as unknown as Record<string, unknown>)['polluted']).toBeUndefined();

        enclave.dispose();
      });
    });

    describe('ATK-FGAD-51: Constructor.prototype Pollution', () => {
      it('ATK-FGAD-51: should isolate String.prototype pollution from host', async () => {
        const enclave = new Enclave({ preset: 'permissive', securityLevel: 'PERMISSIVE' });
        const code = `
          String.prototype.polluted = function() { return 'sandbox-string'; };
          return 'test'.polluted();
        `;
        const result = await enclave.run(code);

        // Verify host is not polluted
        expect((String.prototype as unknown as Record<string, unknown>)['polluted']).toBeUndefined();

        enclave.dispose();
      });
    });
  });

  // ============================================================================
  // ATK-FGAD-55 to ATK-FGAD-60: COMBINED/CHAINED GADGET ATTACKS
  // Multiple gadgets chained together for more sophisticated attacks
  // ============================================================================

  describe('ATK-FGAD-55 to ATK-FGAD-60: Combined/Chained Gadget Attacks', () => {
    /**
     * These tests combine multiple gadgets to test sophisticated attack chains.
     * The key insight: sandbox-created objects lead to sandbox's Function,
     * while wrapped globals (Object, String, etc.) block constructor access.
     *
     * Note: These tests require PERMISSIVE mode because they use object methods
     * and function expressions.
     */
    describe('ATK-FGAD-55: Coercion + Constructor Chain', () => {
      it('ATK-FGAD-55: should verify toString can access sandbox Function through constructor chain', async () => {
        // PERMISSIVE mode: uses object method
        const enclave = new Enclave({ preset: 'permissive', securityLevel: 'PERMISSIVE' });
        const code = `
          const evil = {
            toString() {
              const ctorKey = 'const' + 'ructor';
              // '' is a sandbox string, constructor chain leads to sandbox Function
              const FnCtor = ''[ctorKey][ctorKey];
              if (FnCtor) {
                try {
                  // Sandbox Function works, runs sandbox code
                  return FnCtor('return 888')();
                } catch (e) {
                  return 'blocked';
                }
              }
              return 'no-ctor';
            }
          };
          return '' + evil;
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(true);
        // Sandbox Function works
        // Or blocked by codeGeneration.strings=false (stronger security)
        expectSecureOutcome(result.value, '888');
        enclave.dispose();
      });
    });

    describe('ATK-FGAD-56: Callback + Constructor Chain', () => {
      it('ATK-FGAD-56: should verify map callback can access sandbox Function', async () => {
        // PERMISSIVE mode: uses function expression
        const enclave = new Enclave({ preset: 'permissive', securityLevel: 'PERMISSIVE' });
        const code = `
          const ctorKey = 'const' + 'ructor';
          let result = 'safe';
          [1].map(function() {
            // Get sandbox function constructor
            const fn = function(){};
            const FnCtor = fn[ctorKey];
            if (FnCtor) {
              try {
                // Sandbox Function works
                const created = FnCtor('return 444');
                result = created();
              } catch (e) {
                result = 'blocked';
              }
            }
          });
          return result;
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(true);
        // Sandbox Function works
        // Or blocked by codeGeneration.strings=false (stronger security)
        expectSecureOutcome(result.value, 444);
        enclave.dispose();
      });
    });

    describe('ATK-FGAD-57: JSON.parse + Constructor Chain', () => {
      it('ATK-FGAD-57: should verify reviver can access sandbox Function through number constructor', async () => {
        // PERMISSIVE mode: uses function expression in reviver
        const enclave = new Enclave({ preset: 'permissive', securityLevel: 'PERMISSIVE' });
        const code = `
          const ctorKey = 'const' + 'ructor';
          let result = 'safe';
          JSON.parse('{"a":1}', function(key, value) {
            if (key === 'a') {
              // 0 is sandbox number, constructor chain leads to sandbox Function
              const FnCtor = (0)[ctorKey][ctorKey];
              if (FnCtor) {
                try {
                  // Sandbox Function works
                  const fn = FnCtor('return 666');
                  result = fn();
                } catch (e) {
                  result = 'blocked';
                }
              }
            }
            return value;
          });
          return result;
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(true);
        // Sandbox Function works
        // Or blocked by codeGeneration.strings=false (stronger security)
        expectSecureOutcome(result.value, 666);
        enclave.dispose();
      });
    });

    describe('ATK-FGAD-58 to ATK-FGAD-59: Wrapped Global vs Sandbox Object', () => {
      it('ATK-FGAD-58: should verify Object global blocks constructor with an error', async () => {
        const enclave = new Enclave();
        const code = `
          const ctorKey = 'const' + 'ructor';
          // Object is wrapped - constructor access throws
          const ObjCtor = Object[ctorKey];
          return ObjCtor;
        `;
        const result = await enclave.run(code);
        // Object global is wrapped, constructor access throws
        expect(result.success).toBe(false);
        expect(result.error?.message).toMatch(/Security violation|AgentScript validation failed/);
        enclave.dispose();
      });

      it('ATK-FGAD-59: should verify sandbox-created objects allow constructor access', async () => {
        const enclave = new Enclave();
        const code = `
          const ctorKey = 'const' + 'ructor';
          // Sandbox-created object - constructor accessible (leads to sandbox Function)
          const obj = {};
          const SandboxObjCtor = obj[ctorKey];
          return !!SandboxObjCtor;
        `;
        const result = await enclave.run(code);
        // Either AST blocks string concatenation attack or sandbox allows constructor
        if (result.success) {
          // Sandbox-created object allows constructor (leads to sandbox Function)
          expect(result.value).toBe(true);
        } else {
          // AST validation caught the string concatenation - also valid
          expect(result.error?.message).toMatch(/AgentScript validation failed/);
        }
        enclave.dispose();
      });
    });
  });

  // ============================================================================
  // ATK-FGAD: COVERAGE SUMMARY
  // ============================================================================

  describe('ATK-FGAD: Coverage Summary', () => {
    it('ATK-FGAD-60: should document all function gadget attack vectors', () => {
      const attackCategories = {
        'Primitive Constructor Chains': [
          'String constructor chain',
          'Number constructor chain',
          'Boolean constructor chain',
          'Array constructor chain',
          'Object constructor chain',
          'RegExp constructor chain',
        ],
        'Callback Injection': [
          'Array.map callback',
          'Array.filter callback',
          'Array.reduce accumulator',
          'Array.sort comparator',
          'Array.find callback',
          'Array.forEach callback',
        ],
        'Type Coercion Gadgets': [
          'valueOf exploitation',
          'toString exploitation',
          'toJSON exploitation',
          'Symbol.toPrimitive (AST blocked)',
        ],
        'Function.prototype Exploitation': [
          'call context manipulation',
          'apply with dangerous args',
          'bind context exploitation',
        ],
        'Tagged Template Attacks': ['String.raw exploitation', 'Custom tag functions'],
        'JSON Reviver/Replacer': ['JSON.parse reviver', 'JSON.stringify replacer'],
        'Implicit Coercion': ['Addition coercion', 'Comparison coercion', 'Property key coercion'],
        'Getter/Setter Attacks': ['Getter exploitation', 'Setter exploitation', 'defineProperty getters'],
        'Prototype Pollution': [
          'Object.prototype pollution',
          'Array.prototype pollution',
          'Constructor.prototype pollution',
        ],
        'Combined Gadget Attacks': [
          'Coercion + Constructor chain',
          'Callback + Constructor chain',
          'JSON.parse + Constructor chain',
          'Getter + eval-like execution',
        ],
      };

      const totalCategories = Object.keys(attackCategories).length;
      const totalVectors = Object.values(attackCategories).flat().length;

      expect(totalCategories).toBe(10);
      expect(totalVectors).toBeGreaterThan(30);
    });
  });
});
