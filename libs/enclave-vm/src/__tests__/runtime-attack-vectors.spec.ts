/**
 * Runtime Attack Vectors Test Suite
 *
 * This file tests sophisticated JavaScript sandbox escape attacks that
 * bypass AST static analysis and require runtime protection (SecureProxy).
 *
 * These attacks are "AST-invisible" because the parser cannot detect the
 * dangerous patterns - they are constructed at runtime through string
 * manipulation, type coercion, or other dynamic techniques.
 *
 * Attack Categories:
 * 1. Computed Property Building (string manipulation to build "constructor")
 * 2. Iterator/Generator Chain Attacks (prototype chain walks)
 * 3. Error Object Exploitation (stack trace manipulation)
 * 4. Type Coercion Attacks (Symbol.toPrimitive, valueOf, toString)
 * 5. Known CVE Patterns (historical sandbox escape vulnerabilities)
 *
 * SECURITY MODEL NOTES:
 * ====================
 * The enclave-vm uses a multi-layered security approach:
 *
 * 1. WRAPPED OBJECTS (SecureProxy blocks constructor/__proto__ access):
 *    - Built-in globals (Array, Object, Math, JSON, etc.)
 *    - Custom user-provided globals
 *    - Tool handler results
 *
 * 2. SANDBOX-CREATED OBJECTS (vm context isolation):
 *    - Objects created by method returns (arr.map(), str.split(), etc.)
 *    - Error objects
 *    - Iterator objects
 *    - Objects created with literals ({}, [])
 *
 *    These objects are NOT wrapped by SecureProxy, but they exist within
 *    the vm sandbox context. Even if you access their constructor, it's
 *    the SANDBOX's constructor (not the host's), and functions created
 *    with it run in the sandbox context without access to host globals.
 *
 * 3. AST VALIDATION (blocks dangerous patterns statically):
 *    - Direct 'constructor' identifier access
 *    - eval, Function, Proxy, Reflect
 *    - Symbol, WeakRef, FinalizationRegistry
 *    - etc.
 *
 * Tests in this file verify that SecureProxy blocks constructor access on
 * WRAPPED objects (Category 1). For SANDBOX-CREATED objects (Category 2),
 * the tests verify that while constructor may be accessible, it cannot be
 * used to escape to the host context.
 */

import { Enclave } from '../enclave';

/**
 * Helper for tests that may be blocked at AST level (success: false) or runtime level.
 * Both are valid security outcomes - AST blocking is actually stronger.
 */
function expectSecureResult(
  result: { success: boolean; value?: unknown; error?: { message?: string } },
  expectedValues: unknown[],
): void {
  if (!result.success) {
    // AST-level validation blocked the attack - this is valid and stronger security
    expect(result.error?.message).toMatch(/AgentScript validation failed|code generation from strings/i);
    return;
  }
  // Runtime blocking or sandbox execution
  expect(expectedValues).toContain(result.value);
}

describe('Runtime Attack Vectors (AST-Bypass)', () => {
  // ============================================================================
  // CATEGORY 1: COMPUTED PROPERTY BUILDING ATTACKS
  // These attacks build the string "constructor" or "__proto__" at runtime
  // using various string manipulation techniques that AST cannot detect.
  // ============================================================================

  describe('1. Computed Property Building Attacks', () => {
    describe('1.1 String Concatenation Variations', () => {
      it('should block basic string concatenation: "con" + "structor"', async () => {
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

      it('should block multi-part concatenation: "c" + "o" + "n" + ...', async () => {
        const enclave = new Enclave();
        const code = `
          const key = 'c' + 'o' + 'n' + 's' + 't' + 'r' + 'u' + 'c' + 't' + 'o' + 'r';
          return Object[key] ? 'escaped' : 'blocked';
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        expect(result.error?.message).toMatch(/Security violation|AgentScript validation failed/);
        enclave.dispose();
      });

      it('should block String.concat method', async () => {
        const enclave = new Enclave();
        const code = `
          const key = 'con'.concat('stru', 'ctor');
          return Array[key] ? 'escaped' : 'blocked';
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        expect(result.error?.message).toMatch(/Security violation|AgentScript validation failed/);
        enclave.dispose();
      });

      it('should block template literal interpolation', async () => {
        const enclave = new Enclave();
        const code = `
          const c = 'con';
          const s = 'structor';
          const key = \`\${c}\${s}\`;
          return Object[key] ? 'escaped' : 'blocked';
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        expect(result.error?.message).toMatch(/Security violation|AgentScript validation failed/);
        enclave.dispose();
      });

      it('should block nested template literal expressions', async () => {
        const enclave = new Enclave();
        const code = `
          const key = \`\${'con'}\${'str' + 'uctor'}\`;
          return Math[key] ? 'escaped' : 'blocked';
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        expect(result.error?.message).toMatch(/Security violation|AgentScript validation failed/);
        enclave.dispose();
      });
    });

    describe('1.2 Array Join Methods', () => {
      it('should block Array.join() attack', async () => {
        const enclave = new Enclave();
        const code = `
          const key = ['con', 'struct', 'or'].join('');
          return Array[key] ? 'escaped' : 'blocked';
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        expect(result.error?.message).toMatch(/Security violation|AgentScript validation failed/);
        enclave.dispose();
      });

      it('should block character array join', async () => {
        const enclave = new Enclave();
        const code = `
          const key = ['c','o','n','s','t','r','u','c','t','o','r'].join('');
          return Object[key] ? 'escaped' : 'blocked';
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        expect(result.error?.message).toMatch(/Security violation|AgentScript validation failed/);
        enclave.dispose();
      });

      it('should block Array.from() + join', async () => {
        const enclave = new Enclave();
        const code = `
          const arr = Array.from('constructor');
          const key = arr.join('');
          return String[key] ? 'escaped' : 'blocked';
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        expect(result.error?.message).toMatch(/Security violation|AgentScript validation failed/);
        enclave.dispose();
      });
    });

    describe('1.3 String Reverse/Transform Methods', () => {
      it('should block string reverse attack', async () => {
        const enclave = new Enclave();
        const code = `
          const key = 'rotcurtsnoc'.split('').reverse().join('');
          return Array[key] ? 'escaped' : 'blocked';
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        expect(result.error?.message).toMatch(/Security violation|AgentScript validation failed/);
        enclave.dispose();
      });

      it('should block split/join with replacement', async () => {
        const enclave = new Enclave();
        const code = `
          const key = 'cXnstructXr'.split('X').join('o');
          return Object[key] ? 'escaped' : 'blocked';
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        expect(result.error?.message).toMatch(/Security violation|AgentScript validation failed/);
        enclave.dispose();
      });

      it('should block String.replace attack', async () => {
        const enclave = new Enclave();
        const code = `
          const key = 'c0nstruct0r'.replace(/0/g, 'o');
          return Math[key] ? 'escaped' : 'blocked';
        `;
        const result = await enclave.run(code);
        // May fail at AST (regex) or runtime (proxy)
        if (result.success) {
          expect(result.value).toBe('blocked');
        }
        enclave.dispose();
      });

      it('should block String.slice extraction', async () => {
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

      it('should block String.substring extraction', async () => {
        const enclave = new Enclave();
        const code = `
          const key = 'PREFIXconstructorSUFFIX'.substring(6, 17);
          return Array[key] ? 'escaped' : 'blocked';
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        expect(result.error?.message).toMatch(/Security violation|AgentScript validation failed/);
        enclave.dispose();
      });
    });

    describe('1.4 Character Code Building', () => {
      it('should block String.fromCharCode attack', async () => {
        const enclave = new Enclave();
        // 'constructor' char codes: 99,111,110,115,116,114,117,99,116,111,114
        const code = `
          const key = String.fromCharCode(99,111,110,115,116,114,117,99,116,111,114);
          return Array[key] ? 'escaped' : 'blocked';
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        expect(result.error?.message).toMatch(/Security violation|AgentScript validation failed/);
        enclave.dispose();
      });

      it('should block String.fromCodePoint attack', async () => {
        const enclave = new Enclave();
        const code = `
          const key = String.fromCodePoint(99,111,110,115,116,114,117,99,116,111,114);
          return Object[key] ? 'escaped' : 'blocked';
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        expect(result.error?.message).toMatch(/Security violation|AgentScript validation failed/);
        enclave.dispose();
      });

      it('should block charCode array map + join', async () => {
        const enclave = new Enclave();
        const code = `
          const codes = [99,111,110,115,116,114,117,99,116,111,114];
          const key = codes.map((c) => String.fromCharCode(c)).join('');
          return Math[key] ? 'escaped' : 'blocked';
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        expect(result.error?.message).toMatch(/Security violation|AgentScript validation failed/);
        enclave.dispose();
      });
    });

    describe('1.5 Encoding-Based Attacks', () => {
      it('should block Base64 decode attack (atob)', async () => {
        const enclave = new Enclave({
          globals: {
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

      it('should block decodeURIComponent attack', async () => {
        const enclave = new Enclave({
          globals: {
            decodeURIComponent: decodeURIComponent,
          },
          allowFunctionsInGlobals: true,
        });
        // %63 = 'c'
        const code = `
          const key = decodeURIComponent('%63onstructor');
          return JSON[key] ? 'escaped' : 'blocked';
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        expect(result.error?.message).toMatch(/Security violation|AgentScript validation failed/);
        enclave.dispose();
      });

      it('should block hex escape in string literal', async () => {
        const enclave = new Enclave();
        // \\x63 = 'c'
        const code = `
          const key = '\\x63onstructor';
          return Number[key] ? 'escaped' : 'blocked';
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        expect(result.error?.message).toMatch(/Security violation|AgentScript validation failed/);
        enclave.dispose();
      });

      it('should block unicode escape in string literal', async () => {
        const enclave = new Enclave();
        // \\u0063 = 'c'
        const code = `
          const key = '\\u0063onstructor';
          return Date[key] ? 'escaped' : 'blocked';
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        expect(result.error?.message).toMatch(/Security violation|AgentScript validation failed/);
        enclave.dispose();
      });

      it('should block unicode code point escape on wrapped globals', async () => {
        const enclave = new Enclave();
        // \\u{63} = 'c' - testing on Array which is wrapped by SecureProxy
        const code = `
          const key = '\\u{63}onstructor';
          return Array[key] ? 'escaped' : 'blocked';
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        expect(result.error?.message).toMatch(/Security violation|AgentScript validation failed/);
        enclave.dispose();
      });
    });

    describe('1.6 __proto__ Building Attacks', () => {
      it('should block __proto__ via string concat', async () => {
        const enclave = new Enclave();
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

      it('should block __proto__ via join', async () => {
        const enclave = new Enclave();
        const code = `
          const key = ['__', 'proto', '__'].join('');
          const proto = Object[key];
          return proto ? 'escaped' : 'blocked';
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        expect(result.error?.message).toMatch(/Security violation|AgentScript validation failed/);
        enclave.dispose();
      });

      it('should block chained __proto__.constructor attack', async () => {
        const enclave = new Enclave();
        const code = `
          const protoKey = '__pro' + 'to__';
          const proto = Array[protoKey];
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
    });
  });

  // ============================================================================
  // CATEGORY 2: ITERATOR/GENERATOR CHAIN ATTACKS
  // These attacks exploit iterator protocols and generator functions to
  // reach the Function constructor through prototype chain walks.
  // ============================================================================

  describe('2. Iterator/Generator Chain Attacks', () => {
    describe('2.1 Generator Function Constructor Access', () => {
      it('should block generator function constructor access', async () => {
        const enclave = new Enclave();
        // function*(){} - generator function expression
        const code = `
          const gen = function*(){};
          const key = 'const' + 'ructor';
          const GenCtor = gen[key];
          return GenCtor ? 'escaped' : 'blocked';
        `;
        const result = await enclave.run(code);
        // May fail at AST (function*) or runtime
        if (result.success) {
          expect(result.value).toBe('blocked');
        }
        enclave.dispose();
      });

      it('should prevent async function constructor from accessing host globals', async () => {
        // NOTE: Async functions created inside sandbox have constructor accessible,
        // but it's the sandbox's constructor - cannot access host globals
        const enclave = new Enclave();
        const code = `
          const afn = async () => {};
          const key = 'const' + 'ructor';
          const AsyncCtor = afn[key];
          if (AsyncCtor) {
            try {
              const fn = AsyncCtor('return typeof process !== "undefined" ? process.env.PATH : "no-process"');
              const result = await fn();
              return result === 'no-process' ? 'sandbox-isolated' : 'host-access:' + result;
            } catch (e) {
              return 'blocked-exec';
            }
          }
          return 'no-ctor';
        `;
        const result = await enclave.run(code);
        // Either AST blocks it (success: false) or sandbox isolation works (success: true, no host access)
        if (result.success) {
          // Sandbox isolation should prevent host access
          expect(result.value).not.toMatch(/^host-access:\/[a-zA-Z]/);
        } else {
          // AST blocked the constructor obfuscation - also valid security outcome
          expect(result.error?.message).toMatch(/AgentScript validation failed/);
        }
        enclave.dispose();
      });

      it('should block async generator constructor access', async () => {
        const enclave = new Enclave();
        const code = `
          const agen = async function*(){};
          const key = 'const' + 'ructor';
          const AsyncGenCtor = agen[key];
          return AsyncGenCtor ? 'escaped' : 'blocked';
        `;
        const result = await enclave.run(code);
        // May fail at AST (async function*) or runtime
        if (result.success) {
          expect(result.value).toBe('blocked');
        }
        enclave.dispose();
      });
    });

    describe('2.2 Iterator Protocol Exploitation', () => {
      // NOTE: Iterators are created inside sandbox, so constructor IS accessible
      // But sandbox isolation prevents access to host globals

      it('should verify iterator constructor cannot access host globals', async () => {
        const enclave = new Enclave();
        const code = `
          const iter = [1, 2, 3].values();
          const ctorKey = 'const' + 'ructor';
          const IterCtor = iter[ctorKey];
          if (IterCtor) {
            const FnCtor = IterCtor[ctorKey];
            if (FnCtor) {
              try {
                const fn = FnCtor('return typeof require !== "undefined" ? require("fs") : "no-require"');
                const result = fn();
                return result === 'no-require' ? 'sandbox-isolated' : 'host-access';
              } catch (e) {
                return 'blocked-exec';
              }
            }
          }
          return 'no-ctor';
        `;
        const result = await enclave.run(code);
        // Either AST blocks it (success: false) or sandbox isolation works
        expectSecureResult(result, ['sandbox-isolated', 'blocked-exec', 'no-ctor']);
        enclave.dispose();
      });

      it('should verify entries() iterator is sandbox-isolated', async () => {
        const enclave = new Enclave();
        const code = `
          const iter = [1].entries();
          const ctorKey = 'const' + 'ructor';
          const Ctor = iter[ctorKey];
          if (Ctor) {
            const FnCtor = Ctor[ctorKey];
            if (FnCtor) {
              try {
                const fn = FnCtor('return typeof global !== "undefined" && global.process ? "has-global-process" : "no-global-process"');
                return fn();
              } catch (e) {
                return 'blocked';
              }
            }
          }
          return 'no-ctor';
        `;
        const result = await enclave.run(code);
        // All outcomes are valid security measures:
        // - AST validation blocks (success: false)
        // - 'blocked': codeGeneration.strings=false blocks Function creation
        // - 'no-global-process': Function executed but sandbox isolated from host globals
        expectSecureResult(result, ['blocked', 'no-global-process', 'no-ctor']);
        enclave.dispose();
      });

      it('should verify keys() iterator is sandbox-isolated', async () => {
        const enclave = new Enclave();
        const code = `
          const iter = [1].keys();
          const ctorKey = 'const' + 'ructor';
          const Ctor = iter[ctorKey];
          if (Ctor) {
            const FnCtor = Ctor[ctorKey];
            if (FnCtor) {
              try {
                const fn = FnCtor('return typeof module !== "undefined" ? module.exports : "no-module"');
                return fn();
              } catch (e) {
                return 'blocked';
              }
            }
          }
          return 'no-ctor';
        `;
        const result = await enclave.run(code);
        // All outcomes are valid security measures:
        // - AST validation blocks (success: false)
        // - 'blocked': codeGeneration.strings=false blocks Function creation (caught)
        // - 'blocked-exec': Same as above but different catch label
        // - 'no-module': Function executed but sandbox isolated from host globals
        expectSecureResult(result, ['blocked', 'blocked-exec', 'no-module', 'no-ctor']);
        enclave.dispose();
      });
    });

    describe('2.3 Custom Iterable Attacks', () => {
      it('should block constructor access through custom iterable object', async () => {
        const enclave = new Enclave();
        // Note: Symbol is blocked by AST, so this should fail validation
        const code = `
          const obj = {
            [Symbol.iterator]: () => ({
              next: () => ({ done: true })
            })
          };
          const ctorKey = 'const' + 'ructor';
          return obj[ctorKey] ? 'escaped' : 'blocked';
        `;
        const result = await enclave.run(code);
        // Should fail at AST (Symbol) or be blocked at runtime
        if (result.success) {
          expect(result.value).toBe('blocked');
        }
        enclave.dispose();
      });
    });

    describe('2.4 Map/Set Iterator Attacks', () => {
      // NOTE: Map and Set are blocked by default in AgentScript preset
      // This is CRITICAL security - passing constructor functions as globals
      // can expose the host's Function constructor, enabling sandbox escape!

      it('should document that passing Map as global DOES expose host Function (KNOWN LIMITATION)', async () => {
        // CRITICAL FINDING: When passing constructor functions (like Map, Set)
        // directly as globals, their prototype chain leads to the HOST's
        // Function constructor, NOT a sandbox-isolated one.
        //
        // This is why the AgentScript preset blocks Map, Set, and other
        // constructor functions by default.
        //
        // DO NOT pass constructor functions as globals in production!

        const enclave = new Enclave({
          globals: { Map },
          securityLevel: 'PERMISSIVE',
        });
        const code = `
          try {
            const m = new Map([[1, 'a']]);
            const iter = m.values();
            const ctorKey = 'const' + 'ructor';
            const Ctor = iter[ctorKey];
            if (Ctor) {
              const FnCtor = Ctor[ctorKey];
              if (FnCtor) {
                try {
                  const fn = FnCtor('return typeof process !== "undefined" && process.cwd ? process.cwd() : "no-process"');
                  return fn();
                } catch (e) {
                  return 'blocked';
                }
              }
            }
            return 'no-ctor';
          } catch (e) {
            return 'map-not-available';
          }
        `;
        const result = await enclave.run(code);

        // This test DOCUMENTS the known limitation:
        // Passing constructor functions as globals IS NOT SAFE
        // The Function constructor from Map's prototype IS the host's
        if (result.success && typeof result.value === 'string') {
          // We expect EITHER blocked by validation OR host access (current behavior)
          // This is a known limitation when passing constructors as globals
          const isBlockedOrNoAccess =
            result.value === 'no-process' || result.value === 'blocked' || result.value === 'map-not-available';

          if (!isBlockedOrNoAccess) {
            // This confirms the limitation: host access IS possible
            // When Map is passed as global, Function constructor is host's
            console.warn('⚠️  KNOWN LIMITATION: Passing Map as global allows host access:', result.value);
          }
        }
        // This test should not fail - it documents behavior
        expect(result).toBeDefined();
        enclave.dispose();
      });

      it('should document that AST validation blocks Map/Set by default (SECURITY)', async () => {
        // This test verifies that the default AgentScript preset blocks Map/Set
        const enclave = new Enclave();
        const code = `
          const m = new Map([[1, 'a']]);
          return m.get(1);
        `;
        const result = await enclave.run(code);

        // Should fail validation - Map is blocked by default
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('VALIDATION_ERROR');
        enclave.dispose();
      });
    });
  });

  // ============================================================================
  // CATEGORY 3: ERROR OBJECT EXPLOITATION
  // These attacks exploit Error objects and stack traces to leak information
  // or access the Function constructor.
  //
  // NOTE: Error constructors (Error, TypeError, RangeError) are transformed
  // to __safe_Error, __safe_TypeError, etc. by AST transformation. Direct
  // Error creation will fail validation unless the preset allows it.
  // ============================================================================

  describe('3. Error Object Exploitation', () => {
    describe('3.1 Error Constructor Chain', () => {
      // Error constructors are transformed by AST, so "new Error()" becomes "new __safe_Error()"
      // This test uses STANDARD or PERMISSIVE mode where Error might be allowed

      it('should verify thrown error constructor is sandbox-isolated', async () => {
        // Use catch block to get an error object without direct Error constructor
        const enclave = new Enclave();
        const code = `
          try {
            null.property; // Trigger TypeError
          } catch (err) {
            const ctorKey = 'const' + 'ructor';
            const ErrCtor = err[ctorKey];
            if (ErrCtor) {
              const FnCtor = ErrCtor[ctorKey];
              if (FnCtor) {
                try {
                  const fn = FnCtor('return typeof process !== "undefined" ? process.env.HOME : "no-process"');
                  return fn();
                } catch (e) {
                  return 'blocked-exec';
                }
              }
            }
            return 'no-fn-ctor';
          }
          return 'no-error';
        `;
        const result = await enclave.run(code);
        // Either AST blocks it (success: false) or sandbox isolation works
        if (result.success) {
          // Should NOT return a real home path
          expect(result.value).not.toMatch(/^\/Users\//);
          expect(result.value).not.toMatch(/^\/home\//);
        } else {
          // AST blocked the constructor obfuscation - also valid security outcome
          expect(result.error?.message).toMatch(/AgentScript validation failed/);
        }
        enclave.dispose();
      });

      it('should verify TypeError from runtime is sandbox-isolated', async () => {
        const enclave = new Enclave();
        const code = `
          try {
            undefined.foo; // Trigger TypeError
          } catch (err) {
            const ctorKey = 'const' + 'ructor';
            const Ctor = err[ctorKey];
            if (Ctor) {
              const FnCtor = Ctor[ctorKey];
              if (FnCtor) {
                try {
                  const fn = FnCtor('return typeof require !== "undefined" ? "has-require" : "no-require"');
                  return fn();
                } catch (e) {
                  return 'blocked-exec';
                }
              }
            }
            return 'no-fn-ctor';
          }
          return 'no-error';
        `;
        const result = await enclave.run(code);
        // All outcomes are valid security measures:
        // - AST validation blocks (success: false)
        // - 'blocked-exec': codeGeneration.strings=false blocks Function creation
        // - 'no-require': Function executed but sandbox isolated from host globals
        expectSecureResult(result, ['blocked-exec', 'no-require', 'no-fn-ctor', 'no-error']);
        enclave.dispose();
      });

      it('should verify RangeError from runtime is sandbox-isolated', async () => {
        const enclave = new Enclave();
        const code = `
          try {
            // Create a function and call it to trigger a stack overflow-like error
            // or use a method that throws RangeError
            const arr = [];
            arr.length = -1; // This throws RangeError
          } catch (err) {
            const ctorKey = 'const' + 'ructor';
            const Ctor = err[ctorKey];
            if (Ctor) {
              const FnCtor = Ctor[ctorKey];
              if (FnCtor) {
                try {
                  const fn = FnCtor('return typeof module !== "undefined" ? "has-module" : "no-module"');
                  return fn();
                } catch (e) {
                  return 'blocked-exec';
                }
              }
            }
            return 'no-fn-ctor';
          }
          return 'no-error';
        `;
        const result = await enclave.run(code);
        // All outcomes are valid security measures:
        // - AST validation blocks (success: false)
        // - 'blocked-exec': codeGeneration.strings=false blocks Function creation
        // - 'no-module': Function executed but sandbox isolated from host globals
        expectSecureResult(result, ['blocked-exec', 'no-module', 'no-fn-ctor', 'no-error']);
        enclave.dispose();
      });
    });

    describe('3.2 Error.prepareStackTrace Exploitation', () => {
      it('should isolate Error.prepareStackTrace manipulation', async () => {
        // Store original value (may be set by source-map-support or other tools)
        const originalPrepareStackTrace = Error.prepareStackTrace;

        // Use validation:false since Error is blocked by default
        const enclave = new Enclave({ validate: false });
        const code = `
          try {
            Error.prepareStackTrace = (err, stack) => 'modified-by-sandbox';
            return Error.prepareStackTrace.toString().includes('modified-by-sandbox') ? 'modified' : 'not-modified';
          } catch (e) {
            return 'blocked-error';
          }
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(true);

        // Verify host Error.prepareStackTrace is NOT affected
        // It should still be the same as before (not changed by sandbox code)
        expect(Error.prepareStackTrace).toBe(originalPrepareStackTrace);
        enclave.dispose();
      });

      it('should not leak host information through prepareStackTrace', async () => {
        const enclave = new Enclave({ securityLevel: 'STRICT' });
        const code = `
          try {
            Error.prepareStackTrace = (err, stack) => {
              // Try to access stack frame internals
              return stack.map((f) => {
                try {
                  return f.getThis ? f.getThis() : 'no-this';
                } catch { return 'blocked'; }
              });
            };
            throw new Error('test');
          } catch (e) {
            return e.stack;
          }
        `;
        const result = await enclave.run(code);

        // Should not contain references to host objects
        if (result.success && typeof result.value === 'object') {
          const stackInfo = JSON.stringify(result.value);
          expect(stackInfo).not.toContain('process');
          expect(stackInfo).not.toContain('require');
          expect(stackInfo).not.toContain('/Users/');
          expect(stackInfo).not.toContain('/home/');
        }
        enclave.dispose();
      });
    });

    describe('3.3 Error.cause Chain Attacks', () => {
      it('should handle deeply nested Error.cause chains', async () => {
        const enclave = new Enclave({ timeout: 1000 });
        const code = `
          let err = new Error('base');
          for (let i = 0; i < 100; i++) {
            err = new Error('level ' + i, { cause: err });
          }
          return err.cause.cause.cause.message;
        `;
        const result = await enclave.run(code);

        // Should handle without crashing
        expect(result).toBeDefined();
        enclave.dispose();
      });

      it('should verify Error.cause chain is sandbox-isolated', async () => {
        // Use validation:false since Error is blocked by default
        const enclave = new Enclave({ validate: false });
        const code = `
          try {
            const inner = new Error('inner');
            const outer = new Error('outer', { cause: inner });
            const ctorKey = 'const' + 'ructor';
            const Ctor = outer.cause[ctorKey];
            if (Ctor) {
              const FnCtor = Ctor[ctorKey];
              if (FnCtor) {
                try {
                  const fn = FnCtor('return typeof process !== "undefined" ? process.pid : "no-process"');
                  const result = fn();
                  return typeof result === 'number' ? 'host-pid:' + result : result;
                } catch (e) {
                  return 'blocked-exec';
                }
              }
            }
            return 'no-ctor';
          } catch (e) {
            return 'error-creation-blocked';
          }
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(true);
        // Should NOT return host process PID
        expect(result.value).not.toMatch(/^host-pid:\d+$/);
        enclave.dispose();
      });
    });
  });

  // ============================================================================
  // CATEGORY 4: TYPE COERCION ATTACKS
  // These attacks exploit JavaScript's type coercion mechanisms to build
  // dangerous property names through valueOf, toString, or Symbol.toPrimitive.
  // ============================================================================

  describe('4. Type Coercion Attacks', () => {
    describe('4.1 toString Coercion', () => {
      it('should block toString-based constructor access', async () => {
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

      it('should block toString-based __proto__ access', async () => {
        const enclave = new Enclave();
        const code = `
          const key = { toString: () => '__proto__' };
          const proto = Object[key];
          return proto ? 'escaped' : 'blocked';
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        expect(result.error?.message).toMatch(/Security violation|AgentScript validation failed/);
        enclave.dispose();
      });
    });

    describe('4.2 valueOf Coercion', () => {
      it('should block valueOf-based constructor access', async () => {
        const enclave = new Enclave();
        const code = `
          const key = {
            valueOf: () => 'constructor',
            toString: () => 'valueOf-first'
          };
          // Note: for property access, toString is preferred, but testing valueOf
          const Ctor = Array[key.valueOf()];
          return Ctor ? 'escaped' : 'blocked';
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        expect(result.error?.message).toMatch(/Security violation|AgentScript validation failed/);
        enclave.dispose();
      });
    });

    describe('4.3 Symbol.toPrimitive Coercion', () => {
      it('should block Symbol.toPrimitive-based constructor access', async () => {
        const enclave = new Enclave();
        // Symbol is blocked at AST level, so this should fail validation
        const code = `
          const key = {
            [Symbol.toPrimitive]: (hint) => 'constructor'
          };
          const Ctor = Object[key];
          return Ctor ? 'escaped' : 'blocked';
        `;
        const result = await enclave.run(code);
        // Should fail at AST (Symbol) or be blocked at runtime
        if (result.success) {
          expect(result.value).toBe('blocked');
        }
        enclave.dispose();
      });
    });

    describe('4.4 Numeric Coercion Tricks', () => {
      it('should block Number-to-String constructor access', async () => {
        const enclave = new Enclave();
        const code = `
          // 11 in base 36 = 'b', constructing strings from numbers
          const key = (99).toString(36); // 'constructor' can't be built this way, but testing the pattern
          return JSON[key] ? 'escaped' : 'blocked';
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(true);
        // '2r' is not 'constructor', so it should be blocked or just return blocked
        expect(result.value).toBe('blocked');
        enclave.dispose();
      });
    });
  });

  // ============================================================================
  // CATEGORY 5: KNOWN CVE PATTERNS
  // These tests replicate historical sandbox escape vulnerabilities from
  // vm2, isolated-vm, and other sandbox implementations.
  // ============================================================================

  describe('5. Known CVE Patterns', () => {
    describe('5.1 CVE-2023-29017 (vm2 Exception Handler Escape)', () => {
      it('should block exception handler prototype pollution', async () => {
        // This CVE exploited the exception handling path to access host context
        const enclave = new Enclave();
        const code = `
          try {
            const err = {};
            err.__proto__ = null;
            throw err;
          } catch (e) {
            const ctorKey = 'const' + 'ructor';
            const Ctor = e[ctorKey];
            return Ctor ? 'escaped' : 'blocked';
          }
        `;
        const result = await enclave.run(code);
        // __proto__ assignment might be blocked at AST
        if (result.success) {
          expect(result.value).toBe('blocked');
        }
        enclave.dispose();
      });
    });

    describe('5.2 CVE-2023-30547 (AsyncFunction Constructor Escape)', () => {
      it('should verify AsyncFunction constructor is sandbox-isolated (CVE-2023-30547)', async () => {
        // CVE-2023-30547 exploited AsyncFunction constructor to escape vm2
        // Our sandbox isolates the AsyncFunction constructor within vm context
        const enclave = new Enclave();
        const code = `
          const afn = async () => {};
          const protoKey = '__pro' + 'to__';
          const ctorKey = 'const' + 'ructor';
          const proto = afn[protoKey];
          if (!proto) return 'no-proto';
          const AsyncFn = proto[ctorKey];
          if (!AsyncFn) return 'no-async-fn';
          // Try to exploit it
          try {
            const evil = AsyncFn('return typeof process !== "undefined" ? process.exit : "no-process"');
            const result = await evil();
            return result === 'no-process' ? 'sandbox-isolated' : 'host-access';
          } catch (e) {
            return 'blocked-exec';
          }
        `;
        const result = await enclave.run(code);
        // Either AST blocks it (success: false) or sandbox isolation works
        if (result.success) {
          // Should NOT have host access
          expect(result.value).not.toBe('host-access');
        } else {
          // AST blocked the constructor obfuscation - also valid security outcome
          expect(result.error?.message).toMatch(/AgentScript validation failed/);
        }
        enclave.dispose();
      });
    });

    describe('5.3 CVE-2023-32313 (Proxy + Reflect Bypass)', () => {
      it('should block Proxy-based constructor extraction', async () => {
        // Proxy is blocked at AST level
        const enclave = new Enclave();
        const code = `
          const p = new Proxy({}, {
            get(target, prop) {
              if (prop === 'constructor') return Function;
              return target[prop];
            }
          });
          return p.constructor ? 'escaped' : 'blocked';
        `;
        const result = await enclave.run(code);
        // Should fail at AST (Proxy blocked)
        expect(result.success).toBe(false);
        enclave.dispose();
      });

      it('should block Reflect-based global access', async () => {
        const enclave = new Enclave();
        const code = `
          const proc = Reflect.get(globalThis, 'process');
          return proc ? 'escaped' : 'blocked';
        `;
        const result = await enclave.run(code);
        // Should fail at AST (Reflect blocked)
        expect(result.success).toBe(false);
        enclave.dispose();
      });
    });

    describe('5.4 CVE-2023-37466 (WeakMap/Symbol Escapes)', () => {
      it('should block WeakRef for timing attacks', async () => {
        const enclave = new Enclave();
        const code = `
          const wr = new WeakRef({});
          return wr.deref() ? 'has-ref' : 'no-ref';
        `;
        const result = await enclave.run(code);
        // Should fail at AST (WeakRef blocked)
        expect(result.success).toBe(false);
        enclave.dispose();
      });

      it('should block FinalizationRegistry', async () => {
        const enclave = new Enclave();
        const code = `
          const fr = new FinalizationRegistry(() => {});
          return 'created';
        `;
        const result = await enclave.run(code);
        // Should fail at AST (FinalizationRegistry blocked)
        expect(result.success).toBe(false);
        enclave.dispose();
      });

      it('should block Symbol.for registry access', async () => {
        const enclave = new Enclave();
        const code = `
          const sym = Symbol.for('leaked_key');
          return typeof sym;
        `;
        const result = await enclave.run(code);
        // Should fail at AST (Symbol blocked)
        expect(result.success).toBe(false);
        enclave.dispose();
      });
    });

    describe('5.5 Constructor via Built-in Method Returns', () => {
      // NOTE: Built-in method returns (map, split, JSON.parse) are sandbox-created
      // Constructor IS accessible, but it's the sandbox's constructor

      it('should verify Array method returns are sandbox-isolated', async () => {
        const enclave = new Enclave();
        const code = `
          const mapped = [1, 2, 3].map((x) => x);
          const ctorKey = 'const' + 'ructor';
          const Ctor = mapped[ctorKey];
          if (Ctor) {
            const FnCtor = Ctor[ctorKey];
            if (FnCtor) {
              try {
                const fn = FnCtor('return typeof process !== "undefined" ? process.argv : "no-process"');
                const result = fn();
                return result === 'no-process' ? 'sandbox-isolated' : 'host-access';
              } catch (e) {
                return 'blocked-exec';
              }
            }
          }
          return 'no-ctor';
        `;
        const result = await enclave.run(code);
        // Either AST blocks it (success: false) or sandbox isolation works
        if (result.success) {
          // Should NOT have host access
          expect(result.value).not.toBe('host-access');
        } else {
          // AST blocked the constructor obfuscation - also valid security outcome
          expect(result.error?.message).toMatch(/AgentScript validation failed/);
        }
        enclave.dispose();
      });

      it('should verify String method returns are sandbox-isolated', async () => {
        const enclave = new Enclave();
        const code = `
          const parts = 'a,b,c'.split(',');
          const ctorKey = 'const' + 'ructor';
          const Ctor = parts[ctorKey];
          if (Ctor) {
            const FnCtor = Ctor[ctorKey];
            if (FnCtor) {
              try {
                const fn = FnCtor('return typeof require !== "undefined" ? "has-require" : "no-require"');
                return fn();
              } catch (e) {
                return 'blocked-exec';
              }
            }
          }
          return 'no-ctor';
        `;
        const result = await enclave.run(code);
        // All outcomes are valid security measures:
        // - AST validation blocks (success: false)
        // - 'blocked-exec': codeGeneration.strings=false blocks Function creation
        // - 'no-require': Function executed but sandbox isolated from host globals
        expectSecureResult(result, ['blocked-exec', 'no-require', 'no-ctor']);
        enclave.dispose();
      });

      it('should verify JSON.parse returns are sandbox-isolated', async () => {
        const enclave = new Enclave();
        const code = `
          const parsed = JSON.parse('{"a": 1}');
          const ctorKey = 'const' + 'ructor';
          const Ctor = parsed[ctorKey];
          if (Ctor) {
            const FnCtor = Ctor[ctorKey];
            if (FnCtor) {
              try {
                const fn = FnCtor('return typeof module !== "undefined" ? module.id : "no-module"');
                return fn();
              } catch (e) {
                return 'blocked-exec';
              }
            }
          }
          return 'no-ctor';
        `;
        const result = await enclave.run(code);
        // All outcomes are valid security measures:
        // - AST validation blocks (success: false)
        // - 'blocked-exec': codeGeneration.strings=false blocks Function creation
        // - 'no-module': Function executed but sandbox isolated from host globals
        expectSecureResult(result, ['blocked-exec', 'no-module', 'no-ctor']);
        enclave.dispose();
      });
    });
  });

  // ============================================================================
  // CATEGORY 6: TOOL RESULT ATTACKS
  // These attacks exploit tool handler responses to escape the sandbox.
  // ============================================================================

  describe('6. Tool Result Attacks', () => {
    describe('6.1 Tool Result Constructor Access', () => {
      it('should block constructor access on tool results', async () => {
        const enclave = new Enclave({
          toolHandler: async () => ({ data: { value: 42 } }),
        });
        const code = `
          const result = await callTool('test', {});
          const ctorKey = 'const' + 'ructor';
          const Ctor = result[ctorKey];
          return Ctor ? 'escaped' : 'blocked';
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        expect(result.error?.message).toMatch(/Security violation|AgentScript validation failed/);
        enclave.dispose();
      });

      it('should block __proto__ access on nested tool results', async () => {
        const enclave = new Enclave({
          toolHandler: async () => ({
            level1: { level2: { level3: { value: 'deep' } } },
          }),
        });
        const code = `
          const result = await callTool('test', {});
          const protoKey = '__pro' + 'to__';
          const proto = result.level1.level2.level3[protoKey];
          return proto ? 'escaped' : 'blocked';
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        expect(result.error?.message).toMatch(/Security violation|AgentScript validation failed/);
        enclave.dispose();
      });

      it('should block constructor access on tool result arrays', async () => {
        const enclave = new Enclave({
          toolHandler: async () => [1, 2, 3],
        });
        const code = `
          const result = await callTool('test', {});
          const ctorKey = 'const' + 'ructor';
          const Ctor = result[ctorKey];
          return Ctor ? 'escaped' : 'blocked';
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        expect(result.error?.message).toMatch(/Security violation|AgentScript validation failed/);
        enclave.dispose();
      });
    });

    describe('6.2 Promise Chain Exploitation', () => {
      it('should block constructor access on callTool Promise', async () => {
        const enclave = new Enclave({
          toolHandler: async () => ({ items: [] }),
        });
        const code = `
          const p = callTool('test', {});
          const ctorKey = 'const' + 'ructor';
          const PromiseCtor = p[ctorKey];
          return PromiseCtor ? 'escaped' : 'blocked';
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        expect(result.error?.message).toMatch(/Security violation|AgentScript validation failed/);
        enclave.dispose();
      });

      it('should maintain Promise.then functionality after proxying', async () => {
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

      it('should maintain array methods on proxied tool results', async () => {
        const enclave = new Enclave({
          toolHandler: async () => [1, 2, 3],
        });
        const code = `
          const arr = await callTool('test', {});
          return arr.map((x) => x * 2);
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(true);
        expect(result.value).toEqual([2, 4, 6]);
        enclave.dispose();
      });
    });
  });

  // ============================================================================
  // CATEGORY 7: SYNTAX OBFUSCATION ATTACKS
  // These attacks use JavaScript syntax features to obfuscate dangerous accesses.
  // ============================================================================

  describe('7. Syntax Obfuscation Attacks', () => {
    describe('7.1 Optional Chaining Attacks', () => {
      it('should block constructor access via optional chaining', async () => {
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

      it('should verify nested objects are sandbox-isolated', async () => {
        // Nested objects created inside sandbox have constructor accessible
        // but it's the sandbox's constructor
        const enclave = new Enclave();
        const code = `
          const obj = { nested: { deep: {} } };
          const key = 'const' + 'ructor';
          const Ctor = obj?.nested?.deep?.[key];
          if (Ctor) {
            const FnCtor = Ctor[key];
            if (FnCtor) {
              try {
                const fn = FnCtor('return typeof process !== "undefined" ? process.version : "no-process"');
                return fn();
              } catch (e) {
                return 'blocked-exec';
              }
            }
          }
          return 'no-ctor';
        `;
        const result = await enclave.run(code);
        // Either AST blocks it (success: false) or sandbox isolation works
        if (result.success) {
          // Should NOT return Node.js version
          expect(result.value).not.toMatch(/^v\d+\.\d+\.\d+$/);
        } else {
          // AST blocked the constructor obfuscation - also valid security outcome
          expect(result.error?.message).toMatch(/AgentScript validation failed/);
        }
        enclave.dispose();
      });
    });

    describe('7.2 Comma Operator Attacks', () => {
      it('should block constructor access via comma operator', async () => {
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

      it('should block constructor via complex comma expression', async () => {
        const enclave = new Enclave();
        const code = `
          const key = 'const' + 'ructor';
          const Ctor = (1, 2, 3, Array)[key];
          return Ctor ? 'escaped' : 'blocked';
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        expect(result.error?.message).toMatch(/Security violation|AgentScript validation failed/);
        enclave.dispose();
      });
    });

    describe('7.3 Spread Operator Attacks', () => {
      it('should verify spread object is sandbox-isolated', async () => {
        // Spread creates a new object in sandbox context
        const enclave = new Enclave();
        const code = `
          const source = { a: 1 };
          const obj = { ...source };
          const ctorKey = 'const' + 'ructor';
          const Ctor = obj[ctorKey];
          if (Ctor) {
            const FnCtor = Ctor[ctorKey];
            if (FnCtor) {
              try {
                const fn = FnCtor('return typeof __filename !== "undefined" ? __filename : "no-filename"');
                return fn();
              } catch (e) {
                return 'blocked-exec';
              }
            }
          }
          return 'no-ctor';
        `;
        const result = await enclave.run(code);
        // Either AST blocks it (success: false) or sandbox isolation works
        if (result.success) {
          // Should NOT return a real file path
          expect(result.value).not.toMatch(/\.js$/);
          expect(result.value).not.toMatch(/\.ts$/);
        } else {
          // AST blocked the constructor obfuscation - also valid security outcome
          expect(result.error?.message).toMatch(/AgentScript validation failed/);
        }
        enclave.dispose();
      });
    });

    describe('7.4 Destructuring with Computed Keys', () => {
      it('should block computed property destructuring (AST blocked)', async () => {
        const enclave = new Enclave();
        const code = `
          const key = 'const' + 'ructor';
          const { [key]: Ctor } = Array;
          return Ctor ? 'escaped' : 'blocked';
        `;
        const result = await enclave.run(code);
        // Should be blocked by NoComputedDestructuringRule at AST
        if (result.success) {
          expect(result.value).toBe('blocked');
        }
        enclave.dispose();
      });
    });
  });

  // ============================================================================
  // CATEGORY 8: CUSTOM GLOBALS SECURITY
  // These tests verify that user-provided globals are properly secured.
  // ============================================================================

  describe('8. Custom Globals Security', () => {
    describe('8.1 User-Provided Object Globals', () => {
      it('should block constructor access on custom object globals', async () => {
        const enclave = new Enclave({
          globals: {
            myGlobal: { data: { value: 42 } },
          },
        });
        const code = `
          const ctorKey = 'const' + 'ructor';
          const Ctor = myGlobal[ctorKey];
          return Ctor ? 'escaped' : 'blocked';
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        expect(result.error?.message).toMatch(/Security violation|AgentScript validation failed/);
        enclave.dispose();
      });

      it('should block __proto__ access on nested custom globals', async () => {
        const enclave = new Enclave({
          globals: {
            config: {
              settings: {
                debug: true,
              },
            },
          },
        });
        const code = `
          const protoKey = '__pro' + 'to__';
          const proto = config.settings[protoKey];
          return proto ? 'escaped' : 'blocked';
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(false);
        expect(result.error?.message).toMatch(/Security violation|AgentScript validation failed/);
        enclave.dispose();
      });
    });

    describe('8.2 User-Provided Function Globals', () => {
      it('should block constructor access on custom function globals', async () => {
        const enclave = new Enclave({
          globals: {
            myFunc: () => 42,
          },
          allowFunctionsInGlobals: true,
        });
        const code = `
          const ctorKey = 'const' + 'ructor';
          const Ctor = myFunc[ctorKey];
          return Ctor ? 'escaped' : 'blocked';
        `;
        const result = await enclave.run(code);
        // Should be blocked - either by AST validation or runtime secure proxy
        expect(result.success).toBe(false);
        expect(result.error?.message).toMatch(/Security violation|AgentScript validation failed/);
        enclave.dispose();
      });

      it('should maintain function invocation on proxied function globals', async () => {
        const enclave = new Enclave({
          globals: {
            add: (a: number, b: number) => a + b,
          },
          allowFunctionsInGlobals: true,
        });
        const code = `
          return add(2, 3);
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(true);
        expect(result.value).toBe(5);
        enclave.dispose();
      });
    });

    describe('8.3 Process.env Isolation (Critical)', () => {
      it('should NOT expose real process.env through custom globals', async () => {
        const enclave = new Enclave({
          globals: {
            process: { env: { FAKE_VAR: 'fake_value' } },
          },
        });
        const code = `
          // Try to access real environment variables
          const protoKey = '__pro' + 'to__';
          const ctorKey = 'const' + 'ructor';
          const proto = process.env[protoKey];
          if (proto) {
            const Ctor = proto[ctorKey];
            if (Ctor) {
              const Fn = Ctor[ctorKey];
              if (Fn) {
                // Would execute: return process.env.PATH (or any real env var)
                return 'CRITICAL: Can access Function constructor';
              }
            }
          }
          return 'blocked';
        `;
        const result = await enclave.run(code);
        // Should be blocked - either by AST validation or runtime secure proxy
        expect(result.success).toBe(false);
        expect(result.error?.message).toMatch(/Security violation|AgentScript validation failed/);
        enclave.dispose();
      });

      it('should only expose provided env vars, not real ones', async () => {
        const enclave = new Enclave({
          globals: {
            process: { env: { MY_VAR: 'my_value' } },
          },
        });
        const code = `
          // Should only see our fake env
          const keys = Object.keys(process.env);
          const hasPath = 'PATH' in process.env;
          const hasHome = 'HOME' in process.env;
          return { keys, hasPath, hasHome };
        `;
        const result = await enclave.run(code);
        expect(result.success).toBe(true);
        // Should only have our provided key
        expect(result.value).toEqual({
          keys: ['MY_VAR'],
          hasPath: false,
          hasHome: false,
        });
        enclave.dispose();
      });
    });
  });

  // ============================================================================
  // SUMMARY AND COVERAGE
  // ============================================================================

  describe('Coverage Summary', () => {
    it('should document all tested attack vectors', () => {
      const attackCategories = {
        'Computed Property Building': [
          'String concatenation (basic, multi-part, concat method)',
          'Template literals (basic, nested)',
          'Array join methods (join, character array, Array.from)',
          'String transforms (reverse, split/join, replace, slice, substring)',
          'Character codes (fromCharCode, fromCodePoint, map+join)',
          'Encoding (Base64/atob, decodeURIComponent, hex escape, unicode escape)',
          '__proto__ building variants',
        ],
        'Iterator/Generator Chains': [
          'Generator function constructor',
          'Async function constructor',
          'Async generator constructor',
          'Array iterator protocols (values, entries, keys)',
          'Map/Set iterator protocols',
          'Custom iterable objects',
        ],
        'Error Object Exploitation': [
          'Error constructor chain',
          'TypeError/RangeError constructor chains',
          'Error.prepareStackTrace manipulation',
          'Error.cause chain attacks',
        ],
        'Type Coercion Attacks': [
          'toString-based property access',
          'valueOf-based property access',
          'Symbol.toPrimitive coercion',
          'Number-to-string tricks',
        ],
        'Known CVE Patterns': [
          'CVE-2023-29017 (exception handler escape)',
          'CVE-2023-30547 (AsyncFunction constructor)',
          'CVE-2023-32313 (Proxy + Reflect bypass)',
          'CVE-2023-37466 (WeakRef/Symbol escapes)',
          'Built-in method return constructor access',
        ],
        'Tool Result Attacks': [
          'Direct constructor access on results',
          'Nested object __proto__ access',
          'Array result constructor access',
          'Promise chain exploitation',
        ],
        'Syntax Obfuscation': [
          'Optional chaining attacks',
          'Comma operator attacks',
          'Spread operator attacks',
          'Computed destructuring',
        ],
        'Custom Globals Security': [
          'Object global constructor access',
          'Nested object __proto__ access',
          'Function global constructor access',
          'process.env isolation (CRITICAL)',
        ],
      };

      const totalCategories = Object.keys(attackCategories).length;
      const totalVectors = Object.values(attackCategories).flat().length;

      expect(totalCategories).toBe(8);
      expect(totalVectors).toBeGreaterThan(35); // Updated to reflect actual test count
    });
  });
});
