import { JSAstValidator } from '../validator';
import {
  DisallowedIdentifierRule,
  ForbiddenLoopRule,
  RequiredFunctionCallRule,
  UnreachableCodeRule,
  CallArgumentValidationRule,
  NoEvalRule,
  NoAsyncRule,
} from '../rules';
import { ValidationSeverity } from '../interfaces';

describe('Validation Rules', () => {
  describe('DisallowedIdentifierRule', () => {
    it('should detect disallowed identifiers', async () => {
      const rule = new DisallowedIdentifierRule({ disallowed: ['eval', 'Function'] });
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate('const x = eval("test");', {
        rules: { 'disallowed-identifier': true },
      });
      expect(result.valid).toBe(false);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].code).toBe('DISALLOWED_IDENTIFIER');
      expect(result.issues[0].data?.['identifier']).toBe('eval');
    });

    it('should not report allowed identifiers', async () => {
      const rule = new DisallowedIdentifierRule({ disallowed: ['eval'] });
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate('const x = Math.max(1, 2);', {
        rules: { 'disallowed-identifier': true },
      });
      expect(result.valid).toBe(true);
    });

    it('should detect object with toString arrow returning disallowed identifier', async () => {
      const rule = new DisallowedIdentifierRule({ disallowed: ['constructor'] });
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate('obj[{toString: () => "constructor"}]', {
        rules: { 'disallowed-identifier': true },
      });
      expect(result.valid).toBe(false);
      expect(result.issues[0].code).toBe('DISALLOWED_IDENTIFIER');
      expect(result.issues[0].data?.['identifier']).toBe('constructor');
    });

    it('should detect object with toString method shorthand returning disallowed identifier', async () => {
      const rule = new DisallowedIdentifierRule({ disallowed: ['constructor'] });
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate('obj[{toString() { return "constructor" }}]', {
        rules: { 'disallowed-identifier': true },
      });
      expect(result.valid).toBe(false);
      expect(result.issues[0].code).toBe('DISALLOWED_IDENTIFIER');
      expect(result.issues[0].data?.['identifier']).toBe('constructor');
    });

    it('should detect object with valueOf arrow returning disallowed identifier', async () => {
      const rule = new DisallowedIdentifierRule({ disallowed: ['__proto__'] });
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate('obj[{valueOf: () => "__proto__"}]', {
        rules: { 'disallowed-identifier': true },
      });
      expect(result.valid).toBe(false);
      expect(result.issues[0].code).toBe('DISALLOWED_IDENTIFIER');
      expect(result.issues[0].data?.['identifier']).toBe('__proto__');
    });

    it('should detect object with toString function expression returning disallowed identifier', async () => {
      const rule = new DisallowedIdentifierRule({ disallowed: ['prototype'] });
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate('obj[{toString: function() { return "prototype" }}]', {
        rules: { 'disallowed-identifier': true },
      });
      expect(result.valid).toBe(false);
      expect(result.issues[0].code).toBe('DISALLOWED_IDENTIFIER');
      expect(result.issues[0].data?.['identifier']).toBe('prototype');
    });

    it('should detect object inside array coercion', async () => {
      const rule = new DisallowedIdentifierRule({ disallowed: ['constructor'] });
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate('obj[[{toString: () => "constructor"}]]', {
        rules: { 'disallowed-identifier': true },
      });
      expect(result.valid).toBe(false);
      expect(result.issues[0].code).toBe('DISALLOWED_IDENTIFIER');
      expect(result.issues[0].data?.['identifier']).toBe('constructor');
    });

    it('should not false positive on safe objects without toString/valueOf', async () => {
      const rule = new DisallowedIdentifierRule({ disallowed: ['constructor', '__proto__'] });
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate('obj[{foo: "bar"}]', {
        rules: { 'disallowed-identifier': true },
      });
      expect(result.valid).toBe(true);
    });

    it('should not false positive on toString returning non-disallowed string', async () => {
      const rule = new DisallowedIdentifierRule({ disallowed: ['constructor', '__proto__'] });
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate('obj[{toString: () => "safe"}]', {
        rules: { 'disallowed-identifier': true },
      });
      expect(result.valid).toBe(true);
    });

    it('should detect template literal key', async () => {
      const rule = new DisallowedIdentifierRule({ disallowed: ['constructor'] });
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate('obj[`constructor`]', {
        rules: { 'disallowed-identifier': true },
      });
      expect(result.valid).toBe(false);
      expect(result.issues[0].code).toBe('DISALLOWED_IDENTIFIER');
      expect(result.issues[0].data?.['identifier']).toBe('constructor');
    });

    it('should detect conditional expression (consequent)', async () => {
      const rule = new DisallowedIdentifierRule({ disallowed: ['constructor'] });
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate("obj[true ? 'constructor' : 'x']", {
        rules: { 'disallowed-identifier': true },
      });
      expect(result.valid).toBe(false);
      expect(result.issues[0].code).toBe('DISALLOWED_IDENTIFIER');
      expect(result.issues[0].data?.['identifier']).toBe('constructor');
    });

    it('should detect conditional expression (alternate)', async () => {
      const rule = new DisallowedIdentifierRule({ disallowed: ['constructor'] });
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate("obj[false ? 'x' : 'constructor']", {
        rules: { 'disallowed-identifier': true },
      });
      expect(result.valid).toBe(false);
      expect(result.issues[0].code).toBe('DISALLOWED_IDENTIFIER');
      expect(result.issues[0].data?.['identifier']).toBe('constructor');
    });

    it('should detect sequence expression', async () => {
      const rule = new DisallowedIdentifierRule({ disallowed: ['constructor'] });
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate("obj[(0, 'constructor')]", {
        rules: { 'disallowed-identifier': true },
      });
      expect(result.valid).toBe(false);
      expect(result.issues[0].code).toBe('DISALLOWED_IDENTIFIER');
      expect(result.issues[0].data?.['identifier']).toBe('constructor');
    });

    it('should detect assignment expression as computed key', async () => {
      const rule = new DisallowedIdentifierRule({ disallowed: ['constructor'] });
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate("let x; obj[x = 'constructor']", {
        rules: { 'disallowed-identifier': true },
      });
      expect(result.valid).toBe(false);
      expect(result.issues[0].code).toBe('DISALLOWED_IDENTIFIER');
      expect(result.issues[0].data?.['identifier']).toBe('constructor');
    });

    it('should detect logical OR expression', async () => {
      const rule = new DisallowedIdentifierRule({ disallowed: ['constructor'] });
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate("obj['' || 'constructor']", {
        rules: { 'disallowed-identifier': true },
      });
      expect(result.valid).toBe(false);
      expect(result.issues[0].code).toBe('DISALLOWED_IDENTIFIER');
      expect(result.issues[0].data?.['identifier']).toBe('constructor');
    });

    it('should detect logical AND expression', async () => {
      const rule = new DisallowedIdentifierRule({ disallowed: ['constructor'] });
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate("obj['constructor' && 'constructor']", {
        rules: { 'disallowed-identifier': true },
      });
      expect(result.valid).toBe(false);
      expect(result.issues[0].code).toBe('DISALLOWED_IDENTIFIER');
      expect(result.issues[0].data?.['identifier']).toBe('constructor');
    });

    it('should detect nullish coalescing expression', async () => {
      const rule = new DisallowedIdentifierRule({ disallowed: ['constructor'] });
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate("obj[null ?? 'constructor']", {
        rules: { 'disallowed-identifier': true },
      });
      expect(result.valid).toBe(false);
      expect(result.issues[0].code).toBe('DISALLOWED_IDENTIFIER');
      expect(result.issues[0].data?.['identifier']).toBe('constructor');
    });

    it('should detect getter-based toString coercion', async () => {
      const rule = new DisallowedIdentifierRule({ disallowed: ['constructor'] });
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate("obj[{get toString(){ return () => 'constructor' }}]", {
        rules: { 'disallowed-identifier': true },
      });
      expect(result.valid).toBe(false);
      expect(result.issues[0].code).toBe('DISALLOWED_IDENTIFIER');
      expect(result.issues[0].data?.['identifier']).toBe('constructor');
    });

    it('should allow template literal with expressions (not statically resolvable)', async () => {
      const rule = new DisallowedIdentifierRule({ disallowed: ['constructor'] });
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate("obj[`${'con'}structor`]", {
        rules: { 'disallowed-identifier': true },
      });
      expect(result.valid).toBe(true);
    });

    it('should allow safe template literal', async () => {
      const rule = new DisallowedIdentifierRule({ disallowed: ['constructor'] });
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate('obj[`safe`]', {
        rules: { 'disallowed-identifier': true },
      });
      expect(result.valid).toBe(true);
    });

    it('should use custom message template', async () => {
      const rule = new DisallowedIdentifierRule({
        disallowed: ['eval'],
        messageTemplate: 'Cannot use {identifier} here',
      });
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate('eval("x")', {
        rules: { 'disallowed-identifier': true },
      });
      expect(result.issues[0].message).toBe('Cannot use eval here');
    });
  });

  describe('ForbiddenLoopRule', () => {
    it('should detect all loop types by default', async () => {
      const rule = new ForbiddenLoopRule();
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate(
        `
        for (let i = 0; i < 10; i++) {}
        while (true) {}
        do {} while (false);
        for (const x of [1, 2]) {}
        for (const x in {}) {}
      `,
        { rules: { 'forbidden-loop': true } },
      );

      expect(result.valid).toBe(false);
      expect(result.issues.length).toBe(5);
      expect(result.issues.every((issue) => issue.code === 'FORBIDDEN_LOOP')).toBe(true);
    });

    it('should allow specific loop types when configured', async () => {
      const rule = new ForbiddenLoopRule({ allowFor: true, allowForOf: true });
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate(
        `
        for (let i = 0; i < 10; i++) {}
        for (const x of [1, 2]) {}
      `,
        { rules: { 'forbidden-loop': true } },
      );

      expect(result.valid).toBe(true);
    });

    it('should still detect forbidden loops', async () => {
      const rule = new ForbiddenLoopRule({ allowFor: true });
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate('while (true) {}', {
        rules: { 'forbidden-loop': true },
      });
      expect(result.valid).toBe(false);
      expect(result.issues[0].data?.['loopType']).toBe('while');
    });
  });

  describe('RequiredFunctionCallRule', () => {
    it('should detect missing required function calls', async () => {
      const rule = new RequiredFunctionCallRule({ required: ['callTool'] });
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate('const x = 1;', {
        rules: { 'required-function-call': true },
      });
      expect(result.valid).toBe(false);
      expect(result.issues[0].code).toBe('REQUIRED_FUNCTION_NOT_CALLED');
      expect(result.issues[0].data?.['function']).toBe('callTool');
    });

    it('should pass when required function is called', async () => {
      const rule = new RequiredFunctionCallRule({ required: ['callTool'] });
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate('callTool("test");', {
        rules: { 'required-function-call': true },
      });
      expect(result.valid).toBe(true);
    });

    it('should detect member function calls', async () => {
      const rule = new RequiredFunctionCallRule({ required: ['callTool'] });
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate('obj.callTool("test");', {
        rules: { 'required-function-call': true },
      });
      expect(result.valid).toBe(true);
    });

    it('should enforce minimum call count', async () => {
      const rule = new RequiredFunctionCallRule({ required: ['callTool'], minCalls: 2 });
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate('callTool("test");', {
        rules: { 'required-function-call': true },
      });
      expect(result.valid).toBe(false);
      expect(result.issues[0].data?.['actual']).toBe(1);
      expect(result.issues[0].data?.['expectedMin']).toBe(2);
    });

    it('should enforce maximum call count', async () => {
      const rule = new RequiredFunctionCallRule({
        required: ['callTool'],
        minCalls: 1,
        maxCalls: 2,
      });
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate('callTool(1); callTool(2); callTool(3);', {
        rules: { 'required-function-call': true },
      });
      expect(result.valid).toBe(false);
      expect(result.issues[0].code).toBe('FUNCTION_CALLED_TOO_MANY_TIMES');
    });
  });

  describe('UnreachableCodeRule', () => {
    it('should detect code after return', async () => {
      const rule = new UnreachableCodeRule();
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate(`
        function test() {
          return 1;
          const unreachable = 2;
        }
      `);

      expect(result.issues.length).toBeGreaterThanOrEqual(1);
      expect(result.issues[0].code).toBe('UNREACHABLE_CODE');
      expect(result.issues[0].severity).toBe(ValidationSeverity.WARNING);
    });

    it('should detect code after throw', async () => {
      const rule = new UnreachableCodeRule();
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate(`
        function test() {
          throw new Error();
          const unreachable = 2;
        }
      `);

      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues[0].code).toBe('UNREACHABLE_CODE');
    });

    it('should not report false positives', async () => {
      const rule = new UnreachableCodeRule();
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate(`
        function test(x) {
          if (x) {
            return 1;
          }
          return 2;
        }
      `);

      expect(result.issues).toHaveLength(0);
    });
  });

  describe('CallArgumentValidationRule', () => {
    it('should validate argument count', async () => {
      const rule = new CallArgumentValidationRule({
        functions: {
          callTool: { minArgs: 2, maxArgs: 2 },
        },
      });
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate('callTool("test");', {
        rules: { 'call-argument-validation': true },
      });
      expect(result.valid).toBe(false);
      expect(result.issues[0].code).toBe('INVALID_ARGUMENT_COUNT');
    });

    it('should validate argument types', async () => {
      const rule = new CallArgumentValidationRule({
        functions: {
          callTool: { expectedTypes: ['string', 'object'] },
        },
      });
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate('callTool(123, {});', {
        rules: { 'call-argument-validation': true },
      });
      expect(result.valid).toBe(false);
      expect(result.issues[0].code).toBe('INVALID_ARGUMENT_TYPE');
    });

    it('should pass valid calls', async () => {
      const rule = new CallArgumentValidationRule({
        functions: {
          callTool: { minArgs: 2, expectedTypes: ['string', 'object'] },
        },
      });
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate('callTool("test", {});', {
        rules: { 'call-argument-validation': true },
      });
      expect(result.valid).toBe(true);
    });

    it('should use custom validator', async () => {
      const rule = new CallArgumentValidationRule({
        functions: {
          callTool: {
            validator: (args) => {
              return args.length === 0 ? 'Must provide arguments' : null;
            },
          },
        },
      });
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate('callTool();', {
        rules: { 'call-argument-validation': true },
      });
      expect(result.valid).toBe(false);
      expect(result.issues[0].code).toBe('CUSTOM_ARGUMENT_VALIDATION_FAILED');
    });

    it('should throw error when no functions configured', () => {
      expect(() => {
        new CallArgumentValidationRule({ functions: {} });
      }).toThrow('CallArgumentValidationRule requires at least one function configuration');
    });

    it('should validate maxArgs', async () => {
      const rule = new CallArgumentValidationRule({
        functions: {
          callTool: { maxArgs: 2 },
        },
      });
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate('callTool(1, 2, 3);', {
        rules: { 'call-argument-validation': true },
      });
      expect(result.valid).toBe(false);
      expect(result.issues[0].code).toBe('INVALID_ARGUMENT_COUNT');
      expect(result.issues[0].message).toContain('at most 2');
    });

    it('should handle member expression calls', async () => {
      const rule = new CallArgumentValidationRule({
        functions: {
          callTool: { minArgs: 1 },
        },
      });
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate('obj.callTool();', {
        rules: { 'call-argument-validation': true },
      });
      expect(result.valid).toBe(false);
      expect(result.issues[0].code).toBe('INVALID_ARGUMENT_COUNT');
    });

    it('should ignore non-configured functions', async () => {
      const rule = new CallArgumentValidationRule({
        functions: {
          callTool: { minArgs: 2 },
        },
      });
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate('otherFunction();', {
        rules: { 'call-argument-validation': true },
      });
      expect(result.valid).toBe(true);
    });

    it('should detect array type', async () => {
      const rule = new CallArgumentValidationRule({
        functions: {
          callTool: { expectedTypes: ['array'] },
        },
      });
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate('callTool([1, 2, 3]);', {
        rules: { 'call-argument-validation': true },
      });
      expect(result.valid).toBe(true);
    });

    it('should detect function type', async () => {
      const rule = new CallArgumentValidationRule({
        functions: {
          callTool: { expectedTypes: ['function'] },
        },
      });
      const validator = new JSAstValidator([rule]);

      const arrowResult = await validator.validate('callTool(() => {});', {
        rules: { 'call-argument-validation': true },
      });
      expect(arrowResult.valid).toBe(true);

      const funcResult = await validator.validate('callTool(function() {});', {
        rules: { 'call-argument-validation': true },
      });
      expect(funcResult.valid).toBe(true);
    });

    it('should detect literal null type', async () => {
      const rule = new CallArgumentValidationRule({
        functions: {
          callTool: { expectedTypes: ['literal'] },
        },
      });
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate('callTool(null);', {
        rules: { 'call-argument-validation': true },
      });
      expect(result.valid).toBe(true);
    });

    it('should use custom message', async () => {
      const rule = new CallArgumentValidationRule({
        functions: {
          callTool: { minArgs: 2, message: 'Custom error message' },
        },
      });
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate('callTool(1);', {
        rules: { 'call-argument-validation': true },
      });
      expect(result.valid).toBe(false);
      expect(result.issues[0].message).toBe('Custom error message');
    });

    it('should handle unknown identifier types', async () => {
      const rule = new CallArgumentValidationRule({
        functions: {
          callTool: { expectedTypes: ['string'] },
        },
      });
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate('const x = "test"; callTool(x);', {
        rules: { 'call-argument-validation': true },
      });
      // Should report type mismatch since identifier type is unknown
      expect(result.valid).toBe(false);
      expect(result.issues[0].data?.['actual']).toBe('unknown');
    });
  });

  describe('NoEvalRule', () => {
    it('should detect eval() calls', async () => {
      const rule = new NoEvalRule();
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate('eval("x = 1");');
      expect(result.valid).toBe(false);
      expect(result.issues[0].code).toBe('NO_EVAL');
    });

    it('should detect new Function() calls', async () => {
      const rule = new NoEvalRule();
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate('new Function("return 1")');
      expect(result.valid).toBe(false);
      expect(result.issues[0].code).toBe('NO_EVAL');
    });

    it('should detect setTimeout with string', async () => {
      const rule = new NoEvalRule();
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate('setTimeout("alert(1)", 1000);');
      expect(result.valid).toBe(false);
      expect(result.issues[0].code).toBe('NO_EVAL');
    });

    it('should allow setTimeout with function', async () => {
      const rule = new NoEvalRule();
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate('setTimeout(() => {}, 1000);');
      expect(result.valid).toBe(true);
    });
  });

  describe('NoAsyncRule', () => {
    it('should detect async functions', async () => {
      const rule = new NoAsyncRule();
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate('async function test() {}', {
        rules: { 'no-async': true },
      });
      expect(result.valid).toBe(false);
      expect(result.issues[0].code).toBe('NO_ASYNC');
    });

    it('should detect await expressions', async () => {
      const rule = new NoAsyncRule();
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate('async function test() { await Promise.resolve(); }', {
        rules: { 'no-async': true },
      });
      expect(result.valid).toBe(false);
      expect(result.issues.some((issue) => issue.code === 'NO_AWAIT')).toBe(true);
    });

    it('should allow async when configured', async () => {
      const rule = new NoAsyncRule({ allowAsyncFunctions: true, allowAwait: true });
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate('async function test() { await Promise.resolve(); }', {
        rules: { 'no-async': true },
      });
      expect(result.valid).toBe(true);
    });

    it('should detect async arrow functions', async () => {
      const rule = new NoAsyncRule();
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate('const test = async () => {};', {
        rules: { 'no-async': true },
      });
      expect(result.valid).toBe(false);
      expect(result.issues[0].code).toBe('NO_ASYNC');
      expect(result.issues[0].message).toContain('Async arrow functions');
    });

    it('should use custom message for arrow functions', async () => {
      const rule = new NoAsyncRule({ message: 'Custom async message' });
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate('const test = async () => {};', {
        rules: { 'no-async': true },
      });
      expect(result.valid).toBe(false);
      expect(result.issues[0].message).toBe('Custom async message');
    });
  });
});
