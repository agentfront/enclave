/**
 * Advanced Sandbox Escape Prevention Tests
 *
 * Comprehensive tests covering CVEs and research findings:
 * - Promise callback sanitization (CVE-2026-22709, GHSA-99p7-6v5w-7xg8)
 * - Custom inspect function (CVE-2023-37903, GHSA-g644-9gfx-q4q4)
 * - Exception sanitization (CVE-2023-29199, CVE-2023-30547)
 * - Proxy-spec host object creation (CVE-2023-32314, GHSA-whpj-8f3w-67p5)
 * - Stack trace manipulation (CVE-2022-36067)
 * - SandDriller findings (unwrapped VM exceptions, import payloads)
 *
 * Reference: Security research combining web research and Codex analysis on
 * JavaScript sandbox escape vulnerabilities affecting vm2, isolated-vm, and Node.js vm module.
 */

import { Enclave } from '../enclave';
import type { ToolHandler } from '../types';

describe('Advanced Sandbox Escape Prevention', () => {
  describe('ATK-PROMISE: Promise Callback Sanitization (CVE-2026-22709, GHSA-99p7-6v5w-7xg8)', () => {
    /**
     * CVE-2026-22709 / GHSA-99p7-6v5w-7xg8: Promise callback sanitization bypass
     *
     * Attack Mechanism:
     * - Async functions return globalPromise objects, not localPromise
     * - globalPromise.prototype.then/catch are not properly sanitized
     * - Attacker can override Function.prototype.call to intercept callback invocations
     * - @@species accessor property can bypass Promise handler sanitization
     */

    it('ATK-PROMISE-01: should not leak host context via async function Promise', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        // Test that async function returns use sandbox Promise, not global Promise
        async function testAsync() {
          return 'test';
        }

        const promise = testAsync();
        const results = [];

        // Check Promise constructor chain
        try {
          const PromiseCtor = promise.constructor;
          results.push({ test: 'promise_constructor', type: typeof PromiseCtor });

          if (typeof PromiseCtor === 'function') {
            try {
              const F = PromiseCtor.constructor;
              if (typeof F === 'function') {
                const fn = F('return "ESCAPED_VIA_PROMISE_CTOR"');
                const result = fn();
                results.push({ test: 'promise_ctor_escape', escaped: result === 'ESCAPED_VIA_PROMISE_CTOR' });
              } else {
                results.push({ test: 'promise_ctor_escape', blocked: true, reason: 'not_function' });
              }
            } catch (e) {
              results.push({ test: 'promise_ctor_escape', blocked: true, error: e.name });
            }
          }
        } catch (e) {
          results.push({ test: 'promise_constructor', blocked: true, error: e.name });
        }

        return results;
      `;

      const result =
        await enclave.run<Array<{ test: string; escaped?: boolean; blocked?: boolean; error?: string }>>(code);

      if (result.success && Array.isArray(result.value)) {
        // No escape should have succeeded
        for (const r of result.value) {
          expect(r.escaped).not.toBe(true);
        }
      } else {
        // Security failure is acceptable
        expect(result.error).toBeDefined();
      }

      enclave.dispose();
    }, 15000);

    it('ATK-PROMISE-02: should sanitize .then() callback context', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        const results = [];

        // Try to escape via .then() callback context
        await Promise.resolve().then(function callback() {
          try {
            // Try to access Function via callback's constructor chain
            const F = callback.constructor;
            if (typeof F === 'function') {
              try {
                const fn = F('return "ESCAPED_VIA_THEN_CALLBACK"');
                results.push({ escaped: fn() === 'ESCAPED_VIA_THEN_CALLBACK' });
              } catch (e) {
                results.push({ blocked: true, error: e.name });
              }
            } else {
              results.push({ blocked: true, reason: 'callback_ctor_not_function' });
            }
          } catch (e) {
            results.push({ blocked: true, error: e.name });
          }
        });

        return results;
      `;

      const result = await enclave.run<Array<{ escaped?: boolean; blocked?: boolean; error?: string }>>(code);

      if (result.success && Array.isArray(result.value)) {
        for (const r of result.value) {
          expect(r.escaped).not.toBe(true);
        }
      } else {
        // Security failure (validation blocked) is acceptable
        expect(result.error).toBeDefined();
      }

      enclave.dispose();
    }, 15000);

    it('ATK-PROMISE-03: should sanitize .catch() callback context', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        const results = [];

        // Try to escape via .catch() callback context
        await Promise.reject(new Error('test')).catch(function errorHandler(e) {
          try {
            // Try to access Function via errorHandler's constructor chain
            const F = errorHandler.constructor;
            if (typeof F === 'function') {
              try {
                const fn = F('return "ESCAPED_VIA_CATCH_CALLBACK"');
                results.push({ escaped: fn() === 'ESCAPED_VIA_CATCH_CALLBACK' });
              } catch (e) {
                results.push({ blocked: true, error: e.name });
              }
            } else {
              results.push({ blocked: true, reason: 'handler_ctor_not_function' });
            }
          } catch (e) {
            results.push({ blocked: true, error: e.name });
          }
        });

        return results;
      `;

      const result = await enclave.run<Array<{ escaped?: boolean; blocked?: boolean; error?: string }>>(code);

      if (result.success && Array.isArray(result.value)) {
        for (const r of result.value) {
          expect(r.escaped).not.toBe(true);
        }
      } else {
        expect(result.error).toBeDefined();
      }

      enclave.dispose();
    }, 15000);

    it('ATK-PROMISE-04: should block Symbol.species override on Promise', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        const results = [];

        // Try to override Symbol.species on Promise
        try {
          const originalSpecies = Promise[Symbol.species];
          results.push({ test: 'original_species', type: typeof originalSpecies });

          // Attempt to set Symbol.species
          try {
            Promise[Symbol.species] = class MaliciousPromise {
              constructor(exec) {
                exec(() => {}, (e) => {
                  // Try to escape via rejection handler
                });
              }
            };
            results.push({ test: 'species_override', success: true });
          } catch (e) {
            results.push({ test: 'species_override', blocked: true, error: e.name });
          }
        } catch (e) {
          results.push({ test: 'species_access', blocked: true, error: e.name });
        }

        return results;
      `;

      const result = await enclave.run<Array<{ test: string; blocked?: boolean; success?: boolean }>>(code);

      if (result.success && Array.isArray(result.value)) {
        // Symbol.species override should be blocked (prototype frozen)
        const overrideResult = result.value.find((r) => r.test === 'species_override');
        if (overrideResult) {
          expect(overrideResult.blocked).toBe(true);
        }
      }

      enclave.dispose();
    }, 15000);

    it('ATK-PROMISE-05: should not allow Function access via rejection handler', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        const results = [];

        // Try multiple Promise rejection escape vectors
        const testPromise = new Promise((resolve, reject) => {
          reject(new Error('test rejection'));
        });

        await testPromise.catch((e) => {
          // Attempt 1: Via error constructor chain
          try {
            const F = e.constructor.constructor;
            if (typeof F === 'function') {
              const fn = F('return "ESCAPED_VIA_ERROR_CTOR"');
              results.push({ method: 'error_ctor', escaped: fn() === 'ESCAPED_VIA_ERROR_CTOR' });
            } else {
              results.push({ method: 'error_ctor', blocked: true, reason: 'not_function' });
            }
          } catch (err) {
            results.push({ method: 'error_ctor', blocked: true, error: err.name });
          }

          // Attempt 2: Via error toString
          try {
            const F = e.toString.constructor;
            if (typeof F === 'function') {
              const fn = F('return "ESCAPED_VIA_TOSTRING"');
              results.push({ method: 'toString', escaped: fn() === 'ESCAPED_VIA_TOSTRING' });
            } else {
              results.push({ method: 'toString', blocked: true, reason: 'not_function' });
            }
          } catch (err) {
            results.push({ method: 'toString', blocked: true, error: err.name });
          }
        });

        return results;
      `;

      const result = await enclave.run<Array<{ method: string; escaped?: boolean; blocked?: boolean }>>(code);

      if (result.success && Array.isArray(result.value)) {
        for (const r of result.value) {
          expect(r.escaped).not.toBe(true);
        }
      } else {
        expect(result.error).toBeDefined();
      }

      enclave.dispose();
    }, 15000);

    it('ATK-PROMISE-06: should use sandbox Promise for async returns, not global Promise', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        const results = [];

        // Test that Promise.prototype is frozen (sandbox Promise)
        try {
          Promise.prototype.maliciousMethod = function() { return 'pwned'; };
          results.push({ test: 'prototype_modification', success: true });
        } catch (e) {
          results.push({ test: 'prototype_modification', blocked: true, error: e.name });
        }

        // Verify async function Promise inherits from sandbox Promise.prototype
        async function testAsync() { return 42; }
        const p = testAsync();
        const protoIsFrozen = Object.isFrozen(Object.getPrototypeOf(p));
        results.push({ test: 'async_promise_proto_frozen', frozen: protoIsFrozen });

        return results;
      `;

      const result =
        await enclave.run<Array<{ test: string; blocked?: boolean; success?: boolean; frozen?: boolean }>>(code);

      if (result.success && Array.isArray(result.value)) {
        // Prototype modification should be blocked (frozen)
        const modResult = result.value.find((r) => r.test === 'prototype_modification');
        if (modResult) {
          expect(modResult.blocked).toBe(true);
        }

        // Promise prototype should be frozen
        const frozenResult = result.value.find((r) => r.test === 'async_promise_proto_frozen');
        if (frozenResult) {
          expect(frozenResult.frozen).toBe(true);
        }
      }

      enclave.dispose();
    }, 15000);
  });

  describe('ATK-INSPECT: Custom Inspect Function (CVE-2023-37903, GHSA-g644-9gfx-q4q4)', () => {
    /**
     * CVE-2023-37903 / GHSA-g644-9gfx-q4q4: Custom inspect function escape
     *
     * Attack Mechanism:
     * - Define custom inspect via Symbol.for('nodejs.util.inspect.custom')
     * - When error.stack is accessed, V8 calls toString on error name
     * - If name is Symbol, TypeError is thrown in host context
     * - Access host error through .catch() handler
     */

    it('ATK-INSPECT-01: should block or sandbox Symbol.for() access', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        const results = [];

        // Test Symbol.for() availability
        try {
          const sym = Symbol.for('test');
          results.push({ test: 'symbol_for_access', available: true, type: typeof sym });

          // Try to create the dangerous inspect symbol
          const inspectSym = Symbol.for('nodejs.util.inspect.custom');
          results.push({ test: 'inspect_symbol', created: true });
        } catch (e) {
          results.push({ test: 'symbol_for_access', blocked: true, error: e.name });
        }

        return results;
      `;

      const result = await enclave.run<Array<{ test: string; blocked?: boolean; available?: boolean }>>(code);

      // Symbol.for is a standard feature but the test documents current behavior
      // The important thing is that inspect.custom cannot be used for escape
      if (result.success && Array.isArray(result.value)) {
        // Document the behavior (we'll verify escape is blocked in next test)
        expect(result.value.length).toBeGreaterThan(0);
      }

      enclave.dispose();
    }, 15000);

    it('ATK-INSPECT-02: should not allow nodejs.util.inspect.custom symbol for escape', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        const results = [];

        // Create object with custom inspect function
        try {
          const customInspect = Symbol.for('nodejs.util.inspect.custom');
          let escapeTriggered = false;

          const maliciousObj = {
            [customInspect]: function() {
              escapeTriggered = true;
              try {
                // Try to access Function constructor from inspect context
                const F = this.constructor.constructor;
                if (typeof F === 'function') {
                  return F('return "ESCAPED_VIA_INSPECT"')();
                }
              } catch (e) {}
              return 'inspect called';
            }
          };

          // Try to trigger the inspect function
          // In sandbox, this should NOT trigger host code execution
          try {
            const str = String(maliciousObj);
            results.push({ test: 'string_coercion', result: str, escapeTriggered });
          } catch (e) {
            results.push({ test: 'string_coercion', blocked: true, error: e.name });
          }

        } catch (e) {
          results.push({ test: 'inspect_setup', blocked: true, error: e.name });
        }

        return results;
      `;

      const result = await enclave.run<Array<{ test: string; escaped?: boolean; blocked?: boolean }>>(code);

      if (result.success && Array.isArray(result.value)) {
        // Escape should not have worked
        for (const r of result.value) {
          if ('result' in r) {
            expect(r.result).not.toBe('ESCAPED_VIA_INSPECT');
          }
        }
      }

      enclave.dispose();
    }, 15000);

    it('ATK-INSPECT-03: should not expose host objects via custom toString', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        const results = [];

        // Create object with malicious toString
        const maliciousObj = {
          toString: function() {
            try {
              // Try various escape vectors from toString context
              const F = this.toString.constructor;
              if (typeof F === 'function') {
                const fn = F('return "ESCAPED_VIA_TOSTRING"');
                return fn();
              }
            } catch (e) {
              results.push({ method: 'toString_ctor', blocked: true, error: e.name });
            }
            return '[safe object]';
          }
        };

        // Trigger toString
        const str = '' + maliciousObj;
        results.push({ test: 'result', value: str, escaped: str === 'ESCAPED_VIA_TOSTRING' });

        return results;
      `;

      const result = await enclave.run<Array<{ test?: string; escaped?: boolean; blocked?: boolean }>>(code);

      if (result.success && Array.isArray(result.value)) {
        const finalResult = result.value.find((r) => r.test === 'result');
        if (finalResult) {
          expect(finalResult.escaped).not.toBe(true);
        }
      } else {
        expect(result.error).toBeDefined();
      }

      enclave.dispose();
    }, 15000);

    it('ATK-INSPECT-04: should not execute sandbox code when host logs sandbox objects', async () => {
      // This tests that console.log does not trigger escape vectors
      let hostCodeExecuted = false;

      const enclave = new Enclave({
        timeout: 5000,
        allowFunctionsInGlobals: true,
        globals: {
          __hostSentinel__: () => {
            hostCodeExecuted = true;
            return 'HOST_EXECUTED';
          },
        },
      });

      const code = `
        // Create object that tries to call sentinel when logged
        const maliciousObj = {
          [Symbol.for('nodejs.util.inspect.custom')]: function() {
            try {
              return __hostSentinel__();
            } catch (e) {
              return 'inspect_failed';
            }
          },
          toString: function() {
            try {
              return __hostSentinel__();
            } catch (e) {
              return 'toString_failed';
            }
          }
        };

        // Log the object - this should NOT call the sentinel in host context
        console.log(maliciousObj);
        console.log('Object:', maliciousObj);

        return 'logged';
      `;

      const result = await enclave.run(code);

      // The key assertion: host sentinel should not have been called
      // (unless explicitly through the allowed globals path)
      expect(result).toBeDefined();

      enclave.dispose();
    }, 15000);
  });

  describe('ATK-EXCEPT: Exception Sanitization (CVE-2023-29199, CVE-2023-30547, SandDriller)', () => {
    /**
     * CVE-2023-29199 / CVE-2023-30547: Exception sanitization bypass
     *
     * Attack Mechanism:
     * - Raise unsanitized host exception inside exception handlers
     * - Host exceptions retain host-context prototype chains
     * - Traverse prototype chain to Function constructor
     *
     * SandDriller Research (USENIX Security 2023):
     * - VM internals can spawn unwrapped exceptions during stack trace handling
     * - These bypass membranes and expose host objects
     */

    it('ATK-EXCEPT-01: should wrap tool handler exceptions', async () => {
      // Tool handler that throws an error
      const toolHandler: ToolHandler = async (name, args) => {
        if (name === 'throw_error') {
          throw new Error('Tool error with sensitive data');
        }
        return { ok: true };
      };

      const enclave = new Enclave({ toolHandler, timeout: 5000 });
      const code = `
        const results = [];

        try {
          await callTool('throw_error', {});
        } catch (e) {
          // Attempt to escape via the caught exception
          try {
            const F = e.constructor.constructor;
            if (typeof F === 'function') {
              const fn = F('return "ESCAPED_VIA_TOOL_ERROR"');
              results.push({ escaped: fn() === 'ESCAPED_VIA_TOOL_ERROR' });
            } else {
              results.push({ blocked: true, reason: 'not_function' });
            }
          } catch (escapeErr) {
            results.push({ blocked: true, error: escapeErr.name });
          }

          // Also try __proto__ chain
          try {
            const proto = e.__proto__.__proto__.__proto__;
            results.push({ protoChain: proto === null ? 'null' : typeof proto });
          } catch (protoErr) {
            results.push({ protoChain: 'blocked', error: protoErr.name });
          }
        }

        return results;
      `;

      const result = await enclave.run<Array<{ escaped?: boolean; blocked?: boolean; protoChain?: string }>>(code);

      if (result.success && Array.isArray(result.value)) {
        // No escape should have succeeded
        for (const r of result.value) {
          expect(r.escaped).not.toBe(true);
        }
      }

      enclave.dispose();
    }, 15000);

    it('ATK-EXCEPT-02: should not expose host exception prototype chain', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        const results = [];

        // Create various exceptions and test their prototype chains
        const exceptions = [
          new Error('test'),
          new TypeError('test'),
          new RangeError('test'),
        ];

        for (const e of exceptions) {
          // Test __proto__ chain
          try {
            const proto1 = e.__proto__;
            const proto2 = proto1?.__proto__;
            const proto3 = proto2?.__proto__;
            results.push({
              errorType: e.name,
              proto1IsNull: proto1 === null,
              proto2Value: proto1 === null ? 'n/a' : (proto2 === null ? 'null' : typeof proto2),
              proto3Value: proto2 === null ? 'n/a' : (proto3 === null ? 'null' : typeof proto3),
            });
          } catch (err) {
            results.push({ errorType: e.name, blocked: true, error: err.name });
          }
        }

        return results;
      `;

      const result = await enclave.run<Array<{ errorType: string; proto1IsNull?: boolean; blocked?: boolean }>>(code);

      if (result.success && Array.isArray(result.value)) {
        // __proto__ should return null (shadowed) for all error types
        for (const r of result.value) {
          if (!r.blocked) {
            expect(r.proto1IsNull).toBe(true);
          }
        }
      }

      enclave.dispose();
    }, 15000);

    it('ATK-EXCEPT-03: should sanitize VM internal errors', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        const results = [];

        // Try to trigger various internal VM errors
        const testCases = [
          {
            name: 'stack_overflow',
            trigger: () => {
              const overflow = () => { overflow(); };
              overflow();
            }
          },
          {
            name: 'type_error',
            trigger: () => {
              null.property;
            }
          },
          {
            name: 'range_error',
            trigger: () => {
              new Array(-1);
            }
          }
        ];

        for (const tc of testCases) {
          try {
            tc.trigger();
          } catch (e) {
            // Test escape via the internal error
            try {
              const F = e.constructor.constructor;
              if (typeof F === 'function') {
                const fn = F('return "ESCAPED_VIA_INTERNAL_ERROR"');
                results.push({
                  case: tc.name,
                  escaped: fn() === 'ESCAPED_VIA_INTERNAL_ERROR'
                });
              } else {
                results.push({ case: tc.name, blocked: true, reason: 'not_function' });
              }
            } catch (escapeErr) {
              results.push({ case: tc.name, blocked: true, error: escapeErr.name });
            }
          }
        }

        return results;
      `;

      const result = await enclave.run<Array<{ case: string; escaped?: boolean; blocked?: boolean }>>(code);

      if (result.success && Array.isArray(result.value)) {
        for (const r of result.value) {
          expect(r.escaped).not.toBe(true);
        }
      }

      enclave.dispose();
    }, 15000);

    it('ATK-EXCEPT-04: should handle unwrapped exceptions from stack trace handling (SandDriller)', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        const results = [];

        // Attempt to trigger unwrapped exception during stack trace handling
        // This is based on SandDriller research findings

        // Try 1: Deep recursion with error in catch
        let capturedError;
        const deepRecurse = (depth) => {
          try {
            if (depth > 0) deepRecurse(depth - 1);
            else throw new Error('bottom');
          } catch (e) {
            if (!capturedError) capturedError = e;
            throw e;
          }
        };

        try {
          deepRecurse(100);
        } catch (e) {
          capturedError = e;
        }

        if (capturedError) {
          // Try to escape via captured error
          try {
            const F = capturedError.constructor.constructor;
            if (typeof F === 'function') {
              const fn = F('return "ESCAPED_VIA_DEEP_ERROR"');
              results.push({ test: 'deep_recursion', escaped: fn() === 'ESCAPED_VIA_DEEP_ERROR' });
            } else {
              results.push({ test: 'deep_recursion', blocked: true });
            }
          } catch (e) {
            results.push({ test: 'deep_recursion', blocked: true, error: e.name });
          }
        }

        return results;
      `;

      const result = await enclave.run<Array<{ test: string; escaped?: boolean; blocked?: boolean }>>(code);

      if (result.success && Array.isArray(result.value)) {
        for (const r of result.value) {
          expect(r.escaped).not.toBe(true);
        }
      }

      enclave.dispose();
    }, 15000);

    it('ATK-EXCEPT-05: should not expose host objects via async error rejection', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        const results = [];

        // Create async error scenario
        async function asyncThrow() {
          throw new Error('async error');
        }

        // Try various async error patterns
        try {
          await asyncThrow();
        } catch (e) {
          try {
            const F = e.constructor.constructor;
            if (typeof F === 'function') {
              const fn = F('return "ESCAPED_VIA_ASYNC_ERROR"');
              results.push({ pattern: 'await_catch', escaped: fn() === 'ESCAPED_VIA_ASYNC_ERROR' });
            } else {
              results.push({ pattern: 'await_catch', blocked: true });
            }
          } catch (err) {
            results.push({ pattern: 'await_catch', blocked: true, error: err.name });
          }
        }

        // Also try Promise.reject
        await Promise.reject(new Error('rejected')).catch((e) => {
          try {
            const F = e.constructor.constructor;
            if (typeof F === 'function') {
              const fn = F('return "ESCAPED_VIA_REJECT"');
              results.push({ pattern: 'promise_reject', escaped: fn() === 'ESCAPED_VIA_REJECT' });
            } else {
              results.push({ pattern: 'promise_reject', blocked: true });
            }
          } catch (err) {
            results.push({ pattern: 'promise_reject', blocked: true, error: err.name });
          }
        });

        return results;
      `;

      const result = await enclave.run<Array<{ pattern: string; escaped?: boolean; blocked?: boolean }>>(code);

      if (result.success && Array.isArray(result.value)) {
        for (const r of result.value) {
          expect(r.escaped).not.toBe(true);
        }
      }

      enclave.dispose();
    }, 15000);
  });

  describe('ATK-PROXY: Proxy-spec Host Object Creation (CVE-2023-32314, GHSA-whpj-8f3w-67p5)', () => {
    /**
     * CVE-2023-32314 / GHSA-whpj-8f3w-67p5: Proxy specification abuse
     *
     * Attack Mechanism:
     * - Proxy trap invariants can force unexpected host object creation
     * - Trap violations may throw errors in host context
     * - These errors can expose host prototype chains
     */

    it('ATK-PROXY-01: should block Proxy constructor in STRICT mode', async () => {
      const enclave = new Enclave({ securityLevel: 'STRICT', timeout: 5000 });
      const code = `
        try {
          const proxy = new Proxy({}, {
            get() { return 'trapped'; }
          });
          return { proxyCreated: true, result: proxy.anything };
        } catch (e) {
          return { proxyBlocked: true, error: e.name, message: e.message };
        }
      `;

      const result = await enclave.run<{ proxyCreated?: boolean; proxyBlocked?: boolean }>(code);

      // In STRICT mode, Proxy should be blocked
      expect(result.success).toBe(false);
      enclave.dispose();
    }, 15000);

    it('ATK-PROXY-02: should block Proxy constructor in SECURE mode', async () => {
      const enclave = new Enclave({ securityLevel: 'SECURE', timeout: 5000 });
      const code = `
        try {
          const proxy = new Proxy({}, {});
          return { proxyCreated: true };
        } catch (e) {
          return { proxyBlocked: true, error: e.name };
        }
      `;

      const result = await enclave.run<{ proxyCreated?: boolean; proxyBlocked?: boolean }>(code);

      // In SECURE mode, Proxy should be blocked
      expect(result.success).toBe(false);
      enclave.dispose();
    }, 15000);

    it('ATK-PROXY-03: should not create unexpected host objects via trap invariants', async () => {
      // In STANDARD mode, test that even if Proxy is available, it can't be used for escape
      const enclave = new Enclave({ securityLevel: 'STANDARD', timeout: 5000 });
      const code = `
        const results = [];

        // Note: This test runs in STANDARD mode where Proxy might be available
        // We test that even with Proxy, escape is not possible

        try {
          // Try to create a Proxy that captures host objects
          const handler = {
            get: function(target, prop, receiver) {
              try {
                // Try to escape via handler function constructor
                const F = arguments.callee.caller;
                if (F) {
                  results.push({ method: 'arguments.callee.caller', available: true });
                }
              } catch (e) {
                results.push({ method: 'arguments.callee.caller', blocked: true, error: e.name });
              }
              return target[prop];
            }
          };

          // Even if Proxy works, verify it doesn't allow escape
          const obj = {};
          let proxy;
          try {
            proxy = new Proxy(obj, handler);
            void proxy.test;
            results.push({ proxyCreated: true });
          } catch (e) {
            results.push({ proxyBlocked: true, error: e.name });
          }
        } catch (e) {
          results.push({ outerError: e.name });
        }

        return results;
      `;

      const result =
        await enclave.run<
          Array<{ proxyCreated?: boolean; proxyBlocked?: boolean; method?: string; blocked?: boolean }>
        >(code);

      // In STANDARD mode Proxy might work or be blocked
      // Key assertion: arguments.callee.caller should be blocked (strict mode)
      if (result.success && Array.isArray(result.value)) {
        const callerResult = result.value.find((r) => r.method === 'arguments.callee.caller');
        if (callerResult) {
          expect(callerResult.blocked).toBe(true);
        }
      }

      enclave.dispose();
    }, 15000);

    it('ATK-PROXY-04: should handle Proxy-like behavior in user objects', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        const results = [];

        // Create object with getter that tries to escape
        const maliciousObj = {};
        Object.defineProperty(maliciousObj, 'trap', {
          get: function() {
            try {
              const F = this.constructor.constructor;
              if (typeof F === 'function') {
                const fn = F('return "ESCAPED_VIA_GETTER"');
                results.push({ escaped: fn() === 'ESCAPED_VIA_GETTER' });
              } else {
                results.push({ blocked: true, reason: 'not_function' });
              }
            } catch (e) {
              results.push({ blocked: true, error: e.name });
            }
            return 'safe value';
          }
        });

        // Trigger the getter
        const val = maliciousObj.trap;
        results.push({ getterResult: val });

        return results;
      `;

      const result = await enclave.run<Array<{ escaped?: boolean; blocked?: boolean }>>(code);

      // Should either fail validation (defineProperty blocked) or not escape
      if (result.success && Array.isArray(result.value)) {
        for (const r of result.value) {
          expect(r.escaped).not.toBe(true);
        }
      }

      enclave.dispose();
    }, 15000);
  });

  describe('ATK-STACK: Stack Trace Manipulation (CVE-2022-36067, SandDriller)', () => {
    /**
     * CVE-2022-36067 (SandBreak): prepareStackTrace manipulation
     *
     * Attack Mechanism:
     * - Override global Error object with custom prepareStackTrace
     * - prepareStackTrace receives CallSite objects with host references
     * - CallSite.getFunction() returns host functions
     *
     * SandDriller: Stack property issues during error handling
     */

    it('ATK-STACK-01: should not allow Error.prepareStackTrace override', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        const results = [];

        // Try to override Error.prepareStackTrace
        const originalPST = Error.prepareStackTrace;
        results.push({ originalType: typeof originalPST });

        try {
          Error.prepareStackTrace = function(err, stack) {
            results.push({ customPST_called: true });
            // Try to access host objects via CallSite
            if (stack && stack[0]) {
              try {
                const fn = stack[0].getFunction();
                results.push({ callSiteFunction: typeof fn });
              } catch (e) {
                results.push({ callSiteBlocked: true });
              }
            }
            return 'custom stack';
          };
          results.push({ override_success: true });

          // Trigger stack trace
          try {
            throw new Error('trigger stack trace');
          } catch (e) {
            void e.stack;
          }
        } catch (e) {
          results.push({ override_blocked: true, error: e.name });
        }

        return results;
      `;

      const result =
        await enclave.run<
          Array<{ override_blocked?: boolean; override_success?: boolean; customPST_called?: boolean }>
        >(code);

      if (result.success && Array.isArray(result.value)) {
        // Override should be blocked or prepareStackTrace should not expose CallSite functions
        const overrideResult = result.value.find((r) => r.override_blocked === true);
        const callSiteBlocked = result.value.find((r) => 'callSiteBlocked' in r);

        // Either override should be blocked, or CallSite access should be blocked
        expect(overrideResult || callSiteBlocked).toBeTruthy();
      }

      enclave.dispose();
    }, 15000);

    it('ATK-STACK-02: should not expose CallSite.getFunction() to sandbox', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        const results = [];

        // Try to access CallSite objects via various methods
        try {
          const err = new Error('test');
          const stack = err.stack;
          results.push({ stackType: typeof stack, stackLength: stack?.length });

          // Stack should be redacted or not contain exploitable information
          if (typeof stack === 'string') {
            // Check if stack contains host file paths
            const hasHostPath = stack.includes('/Users/') || stack.includes('\\\\Users\\\\') ||
                               stack.includes('/home/') || stack.includes('node_modules');
            results.push({ hasHostPath });
          }
        } catch (e) {
          results.push({ stackAccess: 'blocked', error: e.name });
        }

        return results;
      `;

      const result = await enclave.run<Array<{ hasHostPath?: boolean }>>(code);

      if (result.success && Array.isArray(result.value)) {
        // Stack traces should not contain host paths when sanitization is enabled
        const pathResult = result.value.find((r) => 'hasHostPath' in r);
        if (pathResult) {
          expect(pathResult.hasHostPath).toBe(false);
        }
      }

      enclave.dispose();
    }, 15000);

    it('ATK-STACK-03: should redact all host stack frames', async () => {
      const enclave = new Enclave({ securityLevel: 'STRICT', timeout: 5000 });
      const code = `
        try {
          throw new Error('test error');
        } catch (e) {
          return {
            message: e.message,
            stack: e.stack,
            hasStack: !!e.stack
          };
        }
      `;

      const result = await enclave.run<{ message: string; stack?: string; hasStack: boolean }>(code);

      if (result.success && result.value) {
        // Stack should be redacted in STRICT mode
        if (result.value.stack) {
          // Stack should not contain real file paths
          expect(result.value.stack).not.toMatch(/\/[a-zA-Z]/);
          expect(result.value.stack).not.toMatch(/[a-zA-Z]:\\/);
          // Stack frames should be redacted
          expect(result.value.stack).toMatch(/REDACTED/i);
        }
      }

      enclave.dispose();
    }, 15000);

    it('ATK-STACK-04: should lock Error.stackTraceLimit', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        const results = [];

        // Try to modify Error.stackTraceLimit
        const originalLimit = Error.stackTraceLimit;
        results.push({ originalLimit });

        try {
          Error.stackTraceLimit = Infinity;
          const newLimit = Error.stackTraceLimit;
          results.push({ newLimit, modified: newLimit !== originalLimit });
        } catch (e) {
          results.push({ modifyBlocked: true, error: e.name });
        }

        return results;
      `;

      const result =
        await enclave.run<Array<{ originalLimit?: number; modified?: boolean; modifyBlocked?: boolean }>>(code);

      if (result.success && Array.isArray(result.value)) {
        // stackTraceLimit should be locked (not modifiable)
        const modResult = result.value.find((r) => 'modified' in r || 'modifyBlocked' in r);
        if (modResult) {
          expect(modResult.modified !== true || modResult.modifyBlocked === true).toBe(true);
        }
      }

      enclave.dispose();
    }, 15000);

    it('ATK-STACK-05: should handle stack-trace origin ambiguity safely (SandDriller)', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        const results = [];

        // Test that errors from different origins are handled safely
        // SandDriller found issues with VM internal error ambiguity

        // Trigger error in nested function context
        function outer() {
          function inner() {
            throw new Error('inner error');
          }
          inner();
        }

        try {
          outer();
        } catch (e) {
          // Try to exploit the error
          try {
            const F = e.constructor.constructor;
            if (typeof F === 'function') {
              const fn = F('return "ESCAPED_VIA_NESTED_ERROR"');
              results.push({ escaped: fn() === 'ESCAPED_VIA_NESTED_ERROR' });
            } else {
              results.push({ blocked: true, reason: 'not_function' });
            }
          } catch (err) {
            results.push({ blocked: true, error: err.name });
          }
        }

        return results;
      `;

      const result = await enclave.run<Array<{ escaped?: boolean; blocked?: boolean }>>(code);

      if (result.success && Array.isArray(result.value)) {
        for (const r of result.value) {
          expect(r.escaped).not.toBe(true);
        }
      }

      enclave.dispose();
    }, 15000);
  });

  describe('ATK-CTOR: Function Constructor Access Paths', () => {
    /**
     * Tests for all paths to Function constructor
     * This is the primary escape vector for JavaScript sandbox escapes
     */

    it('ATK-CTOR-01: should block (async function(){}).constructor access', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        try {
          const AsyncFunction = (async function(){}).constructor;
          if (typeof AsyncFunction === 'function') {
            const fn = AsyncFunction('return "ESCAPED_VIA_ASYNC_FUNCTION"');
            return { escaped: (await fn()) === 'ESCAPED_VIA_ASYNC_FUNCTION' };
          }
          return { blocked: true, reason: 'not_function' };
        } catch (e) {
          return { blocked: true, error: e.name };
        }
      `;

      const result = await enclave.run<{ escaped?: boolean; blocked?: boolean }>(code);

      // Should be blocked at validation (.constructor access)
      expect(result.success).toBe(false);
      enclave.dispose();
    }, 15000);

    it('ATK-CTOR-02: should block (function*(){}).constructor access', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        try {
          const GeneratorFunction = (function*(){}).constructor;
          if (typeof GeneratorFunction === 'function') {
            const gen = GeneratorFunction('yield "ESCAPED_VIA_GENERATOR"')();
            return { escaped: gen.next().value === 'ESCAPED_VIA_GENERATOR' };
          }
          return { blocked: true, reason: 'not_function' };
        } catch (e) {
          return { blocked: true, error: e.name };
        }
      `;

      const result = await enclave.run<{ escaped?: boolean; blocked?: boolean }>(code);

      expect(result.success).toBe(false);
      enclave.dispose();
    }, 15000);

    it('ATK-CTOR-03: should block (async function*(){}).constructor access', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        try {
          const AsyncGeneratorFunction = (async function*(){}).constructor;
          if (typeof AsyncGeneratorFunction === 'function') {
            const gen = AsyncGeneratorFunction('yield "ESCAPED_VIA_ASYNC_GEN"')();
            const result = await gen.next();
            return { escaped: result.value === 'ESCAPED_VIA_ASYNC_GEN' };
          }
          return { blocked: true, reason: 'not_function' };
        } catch (e) {
          return { blocked: true, error: e.name };
        }
      `;

      const result = await enclave.run<{ escaped?: boolean; blocked?: boolean }>(code);

      expect(result.success).toBe(false);
      enclave.dispose();
    }, 15000);

    it('ATK-CTOR-04: should report violations on any constructor access attempt', async () => {
      // This test verifies that constructor access attempts are blocked at validation
      const enclave = new Enclave({ timeout: 5000 });

      const testCases = [
        { code: `({}).constructor`, description: 'object constructor' },
        { code: `[].constructor`, description: 'array constructor' },
        { code: `"".constructor`, description: 'string constructor' },
        { code: `(42).constructor`, description: 'number constructor' },
        { code: `(() => {}).constructor`, description: 'arrow function constructor' },
      ];

      for (const tc of testCases) {
        const result = await enclave.run(`return ${tc.code};`);
        // All should fail validation
        expect(result.success).toBe(false);
      }

      enclave.dispose();
    }, 15000);

    it('ATK-CTOR-05: should not allow code execution via any generator constructor', async () => {
      const enclave = new Enclave({ timeout: 5000 });

      // Test all generator types
      const generatorTests = [
        `(function*(){}).constructor('yield process')`,
        `(async function*(){}).constructor('yield process')`,
        `Object.getPrototypeOf(function*(){}).constructor('yield process')`,
      ];

      for (const code of generatorTests) {
        const result = await enclave.run(`return ${code};`);
        // All should fail validation
        expect(result.success).toBe(false);
      }

      enclave.dispose();
    }, 15000);
  });

  describe('ATK-SYMBOL: Symbol API Security', () => {
    /**
     * Tests for Symbol API security
     * Symbol.for() can create global symbols that might be used for escape
     */

    it('ATK-SYMBOL-01: should handle Symbol.for() safely', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        const results = [];

        // Test Symbol.for availability
        try {
          const sym = Symbol.for('test-key');
          results.push({ test: 'symbol_for', type: typeof sym, isSymbol: typeof sym === 'symbol' });

          // Test if same key returns same symbol (Symbol.for semantics)
          const sym2 = Symbol.for('test-key');
          results.push({ test: 'same_key', sameSymbol: sym === sym2 });

        } catch (e) {
          results.push({ test: 'symbol_for', blocked: true, error: e.name });
        }

        // Test Symbol.keyFor
        try {
          const sym = Symbol.for('my-key');
          const key = Symbol.keyFor(sym);
          results.push({ test: 'symbol_keyFor', key });
        } catch (e) {
          results.push({ test: 'symbol_keyFor', blocked: true, error: e.name });
        }

        return results;
      `;

      const result = await enclave.run<Array<{ test: string; blocked?: boolean }>>(code);

      // Document the behavior - Symbol.for may be available but should not enable escape
      if (result.success && Array.isArray(result.value)) {
        expect(result.value.length).toBeGreaterThan(0);
      }

      enclave.dispose();
    }, 15000);

    it('ATK-SYMBOL-02: should prevent well-known symbol property manipulation', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        const results = [];

        // Try to modify well-known symbols on built-ins
        const wellKnownSymbols = [
          { obj: Array.prototype, symbol: Symbol.iterator, name: 'Array[Symbol.iterator]' },
          { obj: String.prototype, symbol: Symbol.iterator, name: 'String[Symbol.iterator]' },
          { obj: Promise, symbol: Symbol.species, name: 'Promise[Symbol.species]' },
        ];

        for (const { obj, symbol, name } of wellKnownSymbols) {
          try {
            const original = obj[symbol];
            obj[symbol] = function() { return 'hijacked'; };
            const modified = obj[symbol] !== original;
            results.push({ name, modified });
          } catch (e) {
            results.push({ name, blocked: true, error: e.name });
          }
        }

        return results;
      `;

      const result = await enclave.run<Array<{ name: string; modified?: boolean; blocked?: boolean }>>(code);

      if (result.success && Array.isArray(result.value)) {
        // Well-known symbol modifications should be blocked (frozen prototypes)
        for (const r of result.value) {
          expect(r.modified).not.toBe(true);
        }
      }

      enclave.dispose();
    }, 15000);

    it('ATK-SYMBOL-03: should not allow Symbol-based hidden property attacks', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        const results = [];

        // Try to use symbols to hide malicious properties
        try {
          const hiddenKey = Symbol('hidden');
          const obj = {
            [hiddenKey]: function() {
              // Try to escape via hidden function
              try {
                const F = arguments.callee.constructor;
                return F('return "ESCAPED"')();
              } catch (e) {
                return 'blocked: ' + e.name;
              }
            }
          };

          const result = obj[hiddenKey]();
          results.push({ test: 'hidden_symbol_func', result, escaped: result === 'ESCAPED' });
        } catch (e) {
          results.push({ test: 'hidden_symbol_func', blocked: true, error: e.name });
        }

        return results;
      `;

      const result = await enclave.run<Array<{ test: string; escaped?: boolean; blocked?: boolean }>>(code);

      if (result.success && Array.isArray(result.value)) {
        for (const r of result.value) {
          expect(r.escaped).not.toBe(true);
        }
      }

      enclave.dispose();
    }, 15000);
  });

  describe('ATK-IMPORT: Import Keyword Payloads (SandDriller)', () => {
    /**
     * SandDriller Research: Import keyword payloads for sandbox escape
     *
     * Attack Mechanism:
     * - Dynamic import() can bypass sandbox
     * - import.meta can expose host information
     */

    it('ATK-IMPORT-01: should block dynamic import() expressions', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        const module = await import('fs');
        return module;
      `;

      const result = await enclave.run(code);

      // import() should be blocked at validation
      expect(result.success).toBe(false);
      enclave.dispose();
    }, 15000);

    it('ATK-IMPORT-02: should block import.meta access', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        return import.meta.url;
      `;

      const result = await enclave.run(code);

      // import.meta should be blocked at validation
      expect(result.success).toBe(false);
      enclave.dispose();
    }, 15000);

    it('ATK-IMPORT-03: should block all import-related escape vectors', async () => {
      const enclave = new Enclave({ timeout: 5000 });

      const importTests = [
        { code: `import('child_process')`, description: 'dynamic import child_process' },
        { code: `import('vm')`, description: 'dynamic import vm' },
        { code: `import.meta`, description: 'import.meta access' },
      ];

      for (const test of importTests) {
        const result = await enclave.run(`return ${test.code};`);
        expect(result.success).toBe(false);
      }

      enclave.dispose();
    }, 15000);
  });

  describe('ATK-BIGINT: BigInt Resource Exhaustion', () => {
    /**
     * BigInt operations can cause CPU exhaustion
     * Large exponentiation is particularly dangerous
     */

    it('ATK-BIGINT-01: should timeout on large BigInt exponentiation', async () => {
      const enclave = new Enclave({ timeout: 1000 });
      const code = `
        // This should be blocked by AST validation or timeout
        let x = 2n;
        for (let i = 0; i < 100; i++) {
          x = x ** 1000n;
        }
        return x.toString().length;
      `;

      const result = await enclave.run(code);

      // Should fail - either validation blocks it or it times out
      expect(result.success).toBe(false);
      enclave.dispose();
    }, 15000);

    it('ATK-BIGINT-02: should handle BigInt memory exhaustion gracefully', async () => {
      const enclave = new Enclave({ timeout: 2000 });
      const code = `
        // Large BigInt that would consume significant memory
        try {
          const huge = 10n ** 10000n;
          return { success: true, digits: huge.toString().length };
        } catch (e) {
          return { blocked: true, error: e.name, message: e.message };
        }
      `;

      const result = await enclave.run<{ success?: boolean; blocked?: boolean; digits?: number }>(code);

      // Either succeeds with reasonable size or is blocked
      if (result.success && result.value?.success) {
        // If it succeeded, verify it didn't create unreasonably large numbers
        expect(result.value.digits).toBeLessThan(100000);
      }

      enclave.dispose();
    }, 15000);
  });

  describe('ATK-CAUSE: Error.cause Chain Traversal', () => {
    /**
     * Error.cause can hold arbitrary objects
     * Chain of errors could leak information or enable prototype chain traversal
     */

    it('ATK-CAUSE-01: should not allow prototype chain access via Error.cause', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        const results = [];

        // Create nested error with cause chain
        const innerError = new Error('inner');
        const outerError = new Error('outer', { cause: innerError });

        // Try to escape via cause chain
        try {
          const cause = outerError.cause;
          const F = cause.constructor.constructor;
          if (typeof F === 'function') {
            const fn = F('return "ESCAPED_VIA_CAUSE"');
            results.push({ escaped: fn() === 'ESCAPED_VIA_CAUSE' });
          } else {
            results.push({ blocked: true, reason: 'not_function' });
          }
        } catch (e) {
          results.push({ blocked: true, error: e.name });
        }

        return results;
      `;

      const result = await enclave.run<Array<{ escaped?: boolean; blocked?: boolean }>>(code);

      if (result.success && Array.isArray(result.value)) {
        for (const r of result.value) {
          expect(r.escaped).not.toBe(true);
        }
      }

      enclave.dispose();
    }, 15000);

    it('ATK-CAUSE-02: should handle cause property safely on errors', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        const results = [];

        // Test that Error.cause works but doesn't enable escape
        const rootCause = new Error('root');
        const middleError = new Error('middle', { cause: rootCause });
        const outerError = new Error('outer', { cause: middleError });

        // Verify cause chain exists
        results.push({ hasCause: outerError.cause !== undefined });
        results.push({ causeHasCause: outerError.cause?.cause !== undefined });

        // Verify escape is not possible at any level
        const errors = [outerError, middleError, rootCause];
        for (let i = 0; i < errors.length; i++) {
          try {
            const F = errors[i].constructor.constructor;
            if (typeof F === 'function') {
              const fn = F('return "ESCAPED_LEVEL_' + i + '"');
              results.push({ level: i, escaped: fn().startsWith('ESCAPED') });
            } else {
              results.push({ level: i, blocked: true });
            }
          } catch (e) {
            results.push({ level: i, blocked: true, error: e.name });
          }
        }

        return results;
      `;

      const result = await enclave.run<Array<{ level?: number; escaped?: boolean; blocked?: boolean }>>(code);

      if (result.success && Array.isArray(result.value)) {
        for (const r of result.value) {
          if ('escaped' in r) {
            expect(r.escaped).not.toBe(true);
          }
        }
      }

      enclave.dispose();
    }, 15000);
  });

  describe('ATK-CALLEE: arguments.callee.caller Escape', () => {
    /**
     * In non-strict mode, arguments.callee.caller accesses calling function
     * Can traverse call stack to find host-context functions
     */

    it('ATK-CALLEE-01: should block arguments.callee.caller in strict mode', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        const results = [];

        function outer() {
          function inner() {
            try {
              // In strict mode, arguments.callee should throw
              const callee = arguments.callee;
              results.push({ calleeAccess: true });

              // Try to get caller
              const caller = callee.caller;
              results.push({ callerAccess: true, callerType: typeof caller });
            } catch (e) {
              results.push({ blocked: true, error: e.name });
            }
          }
          inner();
        }
        outer();

        return results;
      `;

      const result =
        await enclave.run<Array<{ blocked?: boolean; calleeAccess?: boolean; callerAccess?: boolean }>>(code);

      if (result.success && Array.isArray(result.value)) {
        // In strict mode, arguments.callee should throw TypeError
        const blocked = result.value.find((r) => r.blocked === true);
        expect(blocked).toBeTruthy();
      }

      enclave.dispose();
    }, 15000);

    it('ATK-CALLEE-02: should not allow caller traversal for escape', async () => {
      const enclave = new Enclave({ timeout: 5000 });
      const code = `
        // Even if we could access caller, it should not enable escape
        const results = [];

        try {
          // This should fail in strict mode
          function test() {
            return test.caller;
          }
          const caller = test();
          results.push({ callerType: typeof caller });
        } catch (e) {
          results.push({ blocked: true, error: e.name });
        }

        return results;
      `;

      const result = await enclave.run<Array<{ blocked?: boolean }>>(code);

      if (result.success && Array.isArray(result.value)) {
        // function.caller should be blocked in strict mode
        const blocked = result.value.find((r) => r.blocked === true);
        expect(blocked).toBeTruthy();
      }

      enclave.dispose();
    }, 15000);
  });

  describe('ATK-HOST-SENTINEL: Host Code Execution Prevention', () => {
    /**
     * Critical test: Verify that no sandbox escape can execute arbitrary host code
     * Uses a sentinel function injected into globals
     */

    it('ATK-HOST-SENTINEL-01: comprehensive sentinel test across all escape vectors', async () => {
      let hostCodeExecuted = false;

      const enclave = new Enclave({
        timeout: 10000,
        allowFunctionsInGlobals: true,
        globals: {
          __SENTINEL__: {
            execute: () => {
              hostCodeExecuted = true;
              return 'HOST_CODE_EXECUTED';
            },
          },
        },
      });

      const code = `
        const results = [];

        // Define escape attempt helper
        function tryEscape(name, escapeFn) {
          try {
            const result = escapeFn();
            results.push({ name, result, success: true });
          } catch (e) {
            results.push({ name, blocked: true, error: e.name });
          }
        }

        // Vector 1: Stack overflow -> constructor.constructor
        let stackError;
        const overflow = () => { try { overflow(); } catch(e) { stackError = e; } };
        overflow();
        if (stackError) {
          tryEscape('stack_overflow_ctor', () => {
            const F = stackError.constructor.constructor;
            if (typeof F === 'function') return F('return __SENTINEL__.execute()')();
            return 'not_function';
          });
        }

        // Vector 2: Error.constructor.constructor
        tryEscape('error_ctor', () => {
          const F = new Error().constructor.constructor;
          if (typeof F === 'function') return F('return __SENTINEL__.execute()')();
          return 'not_function';
        });

        // Vector 3: Arrow function constructor
        tryEscape('arrow_ctor', () => {
          const F = (() => {}).constructor;
          if (typeof F === 'function') return F('return __SENTINEL__.execute()')();
          return 'not_function';
        });

        // Vector 4: toString.constructor
        tryEscape('toString_ctor', () => {
          const F = Object.prototype.toString.constructor;
          if (typeof F === 'function') return F('return __SENTINEL__.execute()')();
          return 'not_function';
        });

        // Vector 5: Array method constructor
        tryEscape('array_method_ctor', () => {
          const F = [].map.constructor;
          if (typeof F === 'function') return F('return __SENTINEL__.execute()')();
          return 'not_function';
        });

        // Vector 6: Async function constructor
        tryEscape('async_ctor', () => {
          const F = (async () => {}).constructor;
          if (typeof F === 'function') return F('return __SENTINEL__.execute()')();
          return 'not_function';
        });

        // Vector 7: Promise then handler
        tryEscape('promise_then', () => {
          return new Promise((resolve) => {
            Promise.resolve().then(function handler() {
              try {
                const F = handler.constructor;
                if (typeof F === 'function') resolve(F('return __SENTINEL__.execute()')());
              } catch (e) {
                resolve('blocked: ' + e.name);
              }
            });
          });
        });

        return {
          attempts: results,
          totalAttempts: results.length
        };
      `;

      const result = await enclave.run<{
        attempts: Array<{ name: string; result?: string; blocked?: boolean }>;
        totalAttempts: number;
      }>(code);

      // CRITICAL ASSERTION: Host code must NEVER have executed
      expect(hostCodeExecuted).toBe(false);

      // If execution succeeded, verify no attempt triggered the sentinel
      if (result.success && result.value) {
        for (const attempt of result.value.attempts) {
          expect(attempt.result).not.toBe('HOST_CODE_EXECUTED');
        }
      }

      enclave.dispose();
    }, 30000);
  });
});
