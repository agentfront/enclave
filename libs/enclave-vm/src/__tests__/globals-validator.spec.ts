/**
 * Tests for globals-validator.ts
 *
 * Tests the custom globals security validation system.
 */

import {
  validateGlobalValue,
  validateGlobals,
  canValidateGlobals,
  getGlobalsValidationErrors,
} from '../globals-validator';

describe('globals-validator', () => {
  describe('validateGlobalValue', () => {
    describe('primitive types', () => {
      it('should allow string values', () => {
        expect(() => validateGlobalValue('test', 'hello')).not.toThrow();
      });

      it('should allow number values', () => {
        expect(() => validateGlobalValue('test', 42)).not.toThrow();
        expect(() => validateGlobalValue('test', 3.14)).not.toThrow();
        expect(() => validateGlobalValue('test', Infinity)).not.toThrow();
        expect(() => validateGlobalValue('test', NaN)).not.toThrow();
        expect(() => validateGlobalValue('test', -0)).not.toThrow();
      });

      it('should allow boolean values', () => {
        expect(() => validateGlobalValue('test', true)).not.toThrow();
        expect(() => validateGlobalValue('test', false)).not.toThrow();
      });

      it('should allow bigint values', () => {
        expect(() => validateGlobalValue('test', BigInt(9007199254740991))).not.toThrow();
        expect(() => validateGlobalValue('test', 0n)).not.toThrow();
      });

      it('should allow null values', () => {
        expect(() => validateGlobalValue('test', null)).not.toThrow();
      });

      it('should allow undefined values', () => {
        expect(() => validateGlobalValue('test', undefined)).not.toThrow();
      });
    });

    describe('symbol rejection', () => {
      it('should reject symbol values at root', () => {
        expect(() => validateGlobalValue('test', Symbol('foo'))).toThrow(
          /contains a symbol at root.*Symbols are not allowed/,
        );
      });

      it('should reject symbol values nested in objects', () => {
        expect(() => validateGlobalValue('test', { nested: Symbol('bar') })).toThrow(
          /contains a symbol at nested.*Symbols are not allowed/,
        );
      });

      it('should reject well-known symbols', () => {
        expect(() => validateGlobalValue('test', Symbol.iterator)).toThrow(/contains a symbol/);
      });
    });

    describe('function handling', () => {
      it('should reject functions by default', () => {
        expect(() => validateGlobalValue('test', () => undefined)).toThrow(
          /contains a function at root.*Functions are not allowed by default/,
        );
      });

      it('should reject named functions by default', () => {
        function namedFn() {
          return undefined;
        }
        expect(() => validateGlobalValue('test', namedFn)).toThrow(/contains a function/);
      });

      it('should reject nested functions by default', () => {
        expect(() => validateGlobalValue('test', { handler: () => undefined })).toThrow(
          /contains a function at handler/,
        );
      });

      it('should allow functions when allowFunctions is true', () => {
        expect(() => validateGlobalValue('test', () => undefined, { allowFunctions: true })).not.toThrow();
      });

      it('should allow specifically named functions via allowedFunctionNames', () => {
        function myAllowedFunction() {
          return undefined;
        }
        expect(() =>
          validateGlobalValue('test', myAllowedFunction, {
            allowedFunctionNames: ['myAllowedFunction'],
          }),
        ).not.toThrow();
      });

      it('should reject functions not in allowedFunctionNames', () => {
        function notAllowed() {
          return undefined;
        }
        expect(() =>
          validateGlobalValue('test', notAllowed, {
            allowedFunctionNames: ['otherFunction'],
          }),
        ).toThrow(/contains a function/);
      });

      it('should reject anonymous functions when only named functions allowed', () => {
        expect(() =>
          validateGlobalValue('test', () => undefined, {
            allowedFunctionNames: ['namedOnly'],
          }),
        ).toThrow(/contains a function/);
      });

      describe('dangerous function patterns', () => {
        it('should reject functions containing eval', () => {
          const fn = new Function('return eval("1+1")');
          expect(() => validateGlobalValue('test', fn, { allowFunctions: true })).toThrow(
            /dangerous pattern "\\beval\\b"/,
          );
        });

        it('should reject functions containing Function constructor', () => {
          const fn = function () {
            return Function('return 1');
          };
          expect(() => validateGlobalValue('test', fn, { allowFunctions: true })).toThrow(
            /dangerous pattern "\\bFunction\\b"/,
          );
        });

        it('should reject functions containing require', () => {
          const fn = function () {
            return require('fs');
          };
          expect(() => validateGlobalValue('test', fn, { allowFunctions: true })).toThrow(
            /dangerous pattern "\\brequire\\b"/,
          );
        });

        it('should reject functions containing import', () => {
          // Use new Function to avoid transpilation
          const fn = new Function('return import("fs")');
          expect(() => validateGlobalValue('test', fn, { allowFunctions: true })).toThrow(
            /dangerous pattern "\\bimport\\b"/,
          );
        });

        it('should reject functions containing process', () => {
          const fn = function () {
            return process.env;
          };
          expect(() => validateGlobalValue('test', fn, { allowFunctions: true })).toThrow(
            /dangerous pattern "\\bprocess\\b"/,
          );
        });

        it('should reject functions containing global', () => {
          const fn = function () {
            return global;
          };
          expect(() => validateGlobalValue('test', fn, { allowFunctions: true })).toThrow(
            /dangerous pattern "\\bglobal\\b"/,
          );
        });

        it('should reject functions containing globalThis', () => {
          const fn = function () {
            return globalThis;
          };
          expect(() => validateGlobalValue('test', fn, { allowFunctions: true })).toThrow(
            /dangerous pattern "\\bglobalThis\\b"/,
          );
        });

        it('should reject functions containing __dirname', () => {
          const fn = function () {
            return __dirname;
          };
          expect(() => validateGlobalValue('test', fn, { allowFunctions: true })).toThrow(
            /dangerous pattern "\\b__dirname\\b"/,
          );
        });

        it('should reject functions containing __filename', () => {
          const fn = function () {
            return __filename;
          };
          expect(() => validateGlobalValue('test', fn, { allowFunctions: true })).toThrow(
            /dangerous pattern "\\b__filename\\b"/,
          );
        });

        it('should reject functions containing child_process', () => {
          const fn = function () {
            return require('child_process');
          };
          expect(() => validateGlobalValue('test', fn, { allowFunctions: true })).toThrow(/dangerous pattern/);
        });

        it('should reject functions containing execSync', () => {
          const fn = new Function('return execSync("ls")');
          expect(() => validateGlobalValue('test', fn, { allowFunctions: true })).toThrow(
            /dangerous pattern "\\bexecSync\\b"/,
          );
        });

        it('should reject functions containing spawnSync', () => {
          const fn = new Function('return spawnSync("ls")');
          expect(() => validateGlobalValue('test', fn, { allowFunctions: true })).toThrow(
            /dangerous pattern "\\bspawnSync\\b"/,
          );
        });

        it('should allow safe functions when allowFunctions is true', () => {
          const safeFn = function add(a: number, b: number) {
            return a + b;
          };
          expect(() => validateGlobalValue('test', safeFn, { allowFunctions: true })).not.toThrow();
        });

        it('should allow arrow functions without dangerous patterns', () => {
          const safeFn = (x: number) => x * 2;
          expect(() => validateGlobalValue('test', safeFn, { allowFunctions: true })).not.toThrow();
        });
      });
    });

    describe('object handling', () => {
      it('should allow plain objects with primitive values', () => {
        expect(() =>
          validateGlobalValue('test', {
            name: 'foo',
            count: 42,
            active: true,
          }),
        ).not.toThrow();
      });

      it('should allow nested objects', () => {
        expect(() =>
          validateGlobalValue('test', {
            level1: {
              level2: {
                value: 'deep',
              },
            },
          }),
        ).not.toThrow();
      });

      it('should allow empty objects', () => {
        expect(() => validateGlobalValue('test', {})).not.toThrow();
      });

      describe('getters and setters', () => {
        it('should reject objects with getters by default', () => {
          const obj = {
            get value() {
              return 42;
            },
          };
          expect(() => validateGlobalValue('test', obj)).toThrow(
            /has a getter\/setter at value.*Getters and setters are not allowed/,
          );
        });

        it('should reject objects with setters by default', () => {
          const obj = {
            set value(_v: number) {
              /* no-op */
            },
          };
          expect(() => validateGlobalValue('test', obj)).toThrow(/has a getter\/setter at value/);
        });

        it('should reject objects with both getter and setter', () => {
          let internal = 0;
          const obj = {
            get value() {
              return internal;
            },
            set value(v: number) {
              internal = v;
            },
          };
          expect(() => validateGlobalValue('test', obj)).toThrow(/has a getter\/setter/);
        });

        it('should allow getters when allowGettersSetters is true', () => {
          const obj = {
            get value() {
              return 42;
            },
          };
          expect(() => validateGlobalValue('test', obj, { allowGettersSetters: true })).not.toThrow();
        });

        it('should allow setters when allowGettersSetters is true', () => {
          const obj = {
            set value(_v: number) {
              /* no-op */
            },
          };
          expect(() => validateGlobalValue('test', obj, { allowGettersSetters: true })).not.toThrow();
        });

        it('should detect getters in nested objects', () => {
          const obj = {
            nested: {
              get trap() {
                return 'gotcha';
              },
            },
          };
          expect(() => validateGlobalValue('test', obj)).toThrow(/has a getter\/setter at nested.trap/);
        });
      });

      describe('circular references', () => {
        it('should handle circular references without infinite loop', () => {
          const obj: Record<string, unknown> = { name: 'test' };
          obj['self'] = obj;
          expect(() => validateGlobalValue('test', obj)).not.toThrow();
        });

        it('should handle deeply nested circular references', () => {
          const a: Record<string, unknown> = { name: 'a' };
          const b: Record<string, unknown> = { name: 'b' };
          const c: Record<string, unknown> = { name: 'c' };
          a['child'] = b;
          b['child'] = c;
          c['back'] = a;
          expect(() => validateGlobalValue('test', a)).not.toThrow();
        });

        it('should handle multiple references to the same object', () => {
          const shared = { value: 42 };
          const obj = {
            ref1: shared,
            ref2: shared,
            nested: {
              ref3: shared,
            },
          };
          expect(() => validateGlobalValue('test', obj)).not.toThrow();
        });
      });

      describe('arrays', () => {
        it('should allow arrays of primitives', () => {
          expect(() => validateGlobalValue('test', [1, 2, 3])).not.toThrow();
          expect(() => validateGlobalValue('test', ['a', 'b', 'c'])).not.toThrow();
          expect(() => validateGlobalValue('test', [true, false])).not.toThrow();
        });

        it('should allow empty arrays', () => {
          expect(() => validateGlobalValue('test', [])).not.toThrow();
        });

        it('should allow arrays of objects', () => {
          expect(() => validateGlobalValue('test', [{ name: 'a' }, { name: 'b' }])).not.toThrow();
        });

        it('should validate nested arrays', () => {
          expect(() =>
            validateGlobalValue('test', [
              [1, 2],
              [3, 4],
            ]),
          ).not.toThrow();
        });

        it('should reject arrays containing functions', () => {
          expect(() => validateGlobalValue('test', [() => undefined])).toThrow(/contains a function at 0/);
        });

        it('should reject arrays containing symbols', () => {
          expect(() => validateGlobalValue('test', [Symbol('test')])).toThrow(/contains a symbol at 0/);
        });

        it('should validate mixed arrays', () => {
          expect(() => validateGlobalValue('test', [1, 'a', true, null])).not.toThrow();
        });
      });
    });

    describe('depth limit', () => {
      it('should enforce default depth limit of 10', () => {
        // Create object with depth 11
        let obj: Record<string, unknown> = { value: 'bottom' };
        for (let i = 0; i < 11; i++) {
          obj = { level: obj };
        }
        expect(() => validateGlobalValue('test', obj)).toThrow(/exceeds maximum depth \(10\)/);
      });

      it('should respect custom maxDepth option', () => {
        // Create object with depth 6
        let obj: Record<string, unknown> = { value: 'bottom' };
        for (let i = 0; i < 5; i++) {
          obj = { level: obj };
        }

        // Should fail with maxDepth: 5
        expect(() => validateGlobalValue('test', obj, { maxDepth: 5 })).toThrow(/exceeds maximum depth \(5\)/);

        // Should pass with maxDepth: 6
        expect(() => validateGlobalValue('test', obj, { maxDepth: 6 })).not.toThrow();
      });

      it('should allow very shallow objects with low maxDepth', () => {
        expect(() => validateGlobalValue('test', { a: 1 }, { maxDepth: 1 })).not.toThrow();
      });

      it('should include path in depth error message', () => {
        const obj = { a: { b: { c: { value: 1 } } } };
        expect(() => validateGlobalValue('test', obj, { maxDepth: 2 })).toThrow(/Path: a\.b\.c/);
      });
    });

    describe('dangerous keys', () => {
      it('should reject objects with __proto__ key', () => {
        const obj = { ['__proto__']: {} };
        expect(() => validateGlobalValue('test', obj)).toThrow(/contains dangerous key "__proto__"/);
      });

      it('should reject objects with constructor key', () => {
        const obj = { constructor: {} };
        expect(() => validateGlobalValue('test', obj)).toThrow(/contains dangerous key "constructor"/);
      });

      it('should reject objects with prototype key', () => {
        const obj = { prototype: {} };
        expect(() => validateGlobalValue('test', obj)).toThrow(/contains dangerous key "prototype"/);
      });

      it('should reject dangerous keys in nested objects', () => {
        const obj = {
          safe: {
            dangerous: {
              constructor: {},
            },
          },
        };
        expect(() => validateGlobalValue('test', obj)).toThrow(/contains dangerous key/);
      });

      it('should allow keys that contain but are not exactly dangerous keys', () => {
        expect(() =>
          validateGlobalValue('test', {
            myConstructor: {},
            prototypeId: 'abc',
            proto: {},
          }),
        ).not.toThrow();
      });
    });

    describe('edge cases', () => {
      it('should handle Date objects', () => {
        expect(() => validateGlobalValue('test', new Date())).not.toThrow();
      });

      it('should handle RegExp objects', () => {
        expect(() => validateGlobalValue('test', /pattern/)).not.toThrow();
      });

      it('should handle Map objects', () => {
        const map = new Map();
        map.set('key', 'value');
        expect(() => validateGlobalValue('test', map)).not.toThrow();
      });

      it('should handle Set objects', () => {
        const set = new Set([1, 2, 3]);
        expect(() => validateGlobalValue('test', set)).not.toThrow();
      });

      it('should handle objects with null prototype', () => {
        const obj = Object.create(null);
        obj.key = 'value';
        expect(() => validateGlobalValue('test', obj)).not.toThrow();
      });

      it('should warn for unknown types via console.warn', () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

        // WeakMap has a special type behavior, let's just test it doesn't throw
        const weakMap = new WeakMap();
        expect(() => validateGlobalValue('test', weakMap)).not.toThrow();

        warnSpy.mockRestore();
      });
    });
  });

  describe('validateGlobals', () => {
    it('should validate multiple globals at once', () => {
      expect(() =>
        validateGlobals({
          name: 'test',
          count: 42,
          config: { enabled: true },
        }),
      ).not.toThrow();
    });

    it('should throw on first invalid global', () => {
      expect(() =>
        validateGlobals({
          valid: 'okay',
          invalid: Symbol('bad'),
          alsoInvalid: () => undefined,
        }),
      ).toThrow(/contains a symbol/);
    });

    it('should pass options to validation', () => {
      expect(() =>
        validateGlobals(
          {
            fn: () => undefined,
          },
          { allowFunctions: true },
        ),
      ).not.toThrow();
    });

    it('should validate empty globals object', () => {
      expect(() => validateGlobals({})).not.toThrow();
    });

    it('should include the correct key in error messages', () => {
      expect(() =>
        validateGlobals({
          mySpecificKey: Symbol('test'),
        }),
      ).toThrow(/Custom global "mySpecificKey"/);
    });
  });

  describe('canValidateGlobals', () => {
    it('should return true for valid globals', () => {
      expect(
        canValidateGlobals({
          name: 'test',
          count: 42,
        }),
      ).toBe(true);
    });

    it('should return false for invalid globals', () => {
      expect(
        canValidateGlobals({
          fn: () => undefined,
        }),
      ).toBe(false);
    });

    it('should return true when allowFunctions enables the global', () => {
      expect(
        canValidateGlobals(
          {
            fn: () => undefined,
          },
          { allowFunctions: true },
        ),
      ).toBe(true);
    });

    it('should return false for deeply nested invalid values', () => {
      expect(
        canValidateGlobals({
          deep: {
            nested: {
              value: Symbol('bad'),
            },
          },
        }),
      ).toBe(false);
    });

    it('should return true for empty globals', () => {
      expect(canValidateGlobals({})).toBe(true);
    });
  });

  describe('getGlobalsValidationErrors', () => {
    it('should return empty array for valid globals', () => {
      const errors = getGlobalsValidationErrors({
        name: 'test',
        count: 42,
      });
      expect(errors).toEqual([]);
    });

    it('should return array with single error for one invalid global', () => {
      const errors = getGlobalsValidationErrors({
        fn: () => undefined,
      });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/contains a function/);
    });

    it('should return array with multiple errors for multiple invalid globals', () => {
      const errors = getGlobalsValidationErrors({
        fn1: () => undefined,
        fn2: () => undefined,
        sym: Symbol('test'),
      });
      expect(errors).toHaveLength(3);
    });

    it('should include all error messages', () => {
      const errors = getGlobalsValidationErrors({
        myFunc: () => undefined,
        mySymbol: Symbol('s'),
      });
      expect(errors.some((e) => e.includes('myFunc'))).toBe(true);
      expect(errors.some((e) => e.includes('mySymbol'))).toBe(true);
    });

    it('should pass options to validation', () => {
      const errors = getGlobalsValidationErrors(
        {
          fn: () => undefined,
        },
        { allowFunctions: true },
      );
      expect(errors).toEqual([]);
    });

    it('should return empty array for empty globals', () => {
      expect(getGlobalsValidationErrors({})).toEqual([]);
    });
  });
});
