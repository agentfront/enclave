import { JSAstValidator, DEFAULT_MAX_ISSUES } from '../validator';
import { DisallowedIdentifierRule } from '../rules/disallowed-identifier.rule';
import { UnreachableCodeRule } from '../rules/unreachable-code.rule';
import { UnknownGlobalRule } from '../rules/unknown-global.rule';
import { ValidationSeverity } from '../interfaces';

describe('JSAstValidator', () => {
  describe('constructor', () => {
    it('should create validator without rules', () => {
      const validator = new JSAstValidator();
      expect(validator.getRules()).toHaveLength(0);
    });

    it('should create validator with rules', () => {
      const rule = new DisallowedIdentifierRule({ disallowed: ['eval'] });
      const validator = new JSAstValidator([rule]);
      expect(validator.getRules()).toHaveLength(1);
    });
  });

  describe('registerRule', () => {
    it('should register a rule', () => {
      const validator = new JSAstValidator();
      const rule = new DisallowedIdentifierRule({ disallowed: ['eval'] });
      validator.registerRule(rule);
      expect(validator.getRules()).toHaveLength(1);
      expect(validator.getRule('disallowed-identifier')).toBe(rule);
    });

    it('should throw error when registering duplicate rule', () => {
      const validator = new JSAstValidator();
      const rule = new DisallowedIdentifierRule({ disallowed: ['eval'] });
      validator.registerRule(rule);
      expect(() => validator.registerRule(rule)).toThrow('already registered');
    });
  });

  describe('unregisterRule', () => {
    it('should unregister an existing rule', () => {
      const validator = new JSAstValidator();
      const rule = new DisallowedIdentifierRule({ disallowed: ['eval'] });
      validator.registerRule(rule);
      expect(validator.getRules()).toHaveLength(1);

      const result = validator.unregisterRule('disallowed-identifier');
      expect(result).toBe(true);
      expect(validator.getRules()).toHaveLength(0);
    });

    it('should return false when unregistering non-existent rule', () => {
      const validator = new JSAstValidator();
      const result = validator.unregisterRule('non-existent-rule');
      expect(result).toBe(false);
    });
  });

  describe('getRule', () => {
    it('should return undefined for non-existent rule', () => {
      const validator = new JSAstValidator();
      const result = validator.getRule('non-existent');
      expect(result).toBeUndefined();
    });
  });

  describe('validate', () => {
    it('should validate valid code', async () => {
      const validator = new JSAstValidator();
      const result = await validator.validate('const x = 1;');
      expect(result.valid).toBe(true);
      expect(result.issues).toHaveLength(0);
      expect(result.ast).toBeDefined();
    });

    it('should detect parse errors', async () => {
      const validator = new JSAstValidator();
      const result = await validator.validate('const x = ;');
      expect(result.valid).toBe(false);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].code).toBe('PARSE_ERROR');
      expect(result.parseError).toBeDefined();
    });

    it('should throw error for empty source', async () => {
      const validator = new JSAstValidator();
      await expect(validator.validate('')).rejects.toThrow('Source cannot be empty');
    });

    it('should throw error for non-string source', async () => {
      const validator = new JSAstValidator();
      await expect(validator.validate(null as any)).rejects.toThrow('Source must be a string');
    });

    it('should run enabled rules', async () => {
      const rule = new DisallowedIdentifierRule({ disallowed: ['eval'] });
      const validator = new JSAstValidator([rule]);
      const result = await validator.validate('eval("x")');
      expect(result.valid).toBe(false);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].code).toBe('DISALLOWED_IDENTIFIER');
    });

    it('should respect rule configuration', async () => {
      const rule = new DisallowedIdentifierRule({ disallowed: ['eval'] });
      const validator = new JSAstValidator([rule]);

      // Disable rule
      const result = await validator.validate('eval("x")', {
        rules: {
          'disallowed-identifier': false,
        },
      });
      expect(result.valid).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it('should stop on first error when configured', async () => {
      const rule = new DisallowedIdentifierRule({ disallowed: ['eval', 'Function'] });
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate('eval("x"); Function("y");', {
        stopOnFirstError: true,
      });

      expect(result.valid).toBe(false);
      expect(result.issues).toHaveLength(1);
    });

    it('should respect max issues limit', async () => {
      const rule = new DisallowedIdentifierRule({ disallowed: ['eval'] });
      const validator = new JSAstValidator([rule]);

      const result = await validator.validate('eval("x"); eval("y"); eval("z");', {
        maxIssues: 2,
      });

      expect(result.valid).toBe(false);
      expect(result.issues.length).toBeLessThanOrEqual(2);
    });

    describe('maxIssues', () => {
      const calls = (count: number): string => Array.from({ length: count }, () => 'eval("x");').join('\n');
      // Warnings first (unreachable code), then an error
      const warningsThenError = `
        function f() {
          return 1;
          1; 2; 3; 4;
        }
        eval("x");
      `;
      const mixedRules = () => [new UnreachableCodeRule(), new DisallowedIdentifierRule({ disallowed: ['eval'] })];

      it('collects at most DEFAULT_MAX_ISSUES issues when it is not set', async () => {
        const validator = new JSAstValidator([new DisallowedIdentifierRule({ disallowed: ['eval'] })]);

        const result = await validator.validate(calls(DEFAULT_MAX_ISSUES + 50));

        expect(result.valid).toBe(false);
        expect(result.issues).toHaveLength(DEFAULT_MAX_ISSUES);
        expect(result.incomplete).toBe(true);
      });

      it('collects every issue with maxIssues: 0', async () => {
        const validator = new JSAstValidator([new DisallowedIdentifierRule({ disallowed: ['eval'] })]);

        const result = await validator.validate(calls(DEFAULT_MAX_ISSUES + 50), { maxIssues: 0 });

        expect(result.issues).toHaveLength(DEFAULT_MAX_ISSUES + 50);
        expect(result.incomplete).toBeUndefined();
      });

      it('does not report a result as incomplete when the list has room left', async () => {
        const validator = new JSAstValidator([new DisallowedIdentifierRule({ disallowed: ['eval'] })]);

        const result = await validator.validate(calls(3), { maxIssues: 10 });

        expect(result.issues).toHaveLength(3);
        expect(result.incomplete).toBeUndefined();
      });

      it('keeps running the rules while the list holds only warnings', async () => {
        const validator = new JSAstValidator(mixedRules());

        const result = await validator.validate(warningsThenError, { maxIssues: 2 });

        expect(result.valid).toBe(false);
        expect(result.issues).toHaveLength(2);
        expect(result.issues.map((issue) => issue.severity)).toContain(ValidationSeverity.ERROR);
        expect(result.incomplete).toBe(true);
        expect(result.rulesExecuted).toBe(2);
      });

      it('leaves a source with nothing but warnings valid, with the list cut at the cap', async () => {
        const validator = new JSAstValidator([new UnreachableCodeRule()]);

        const result = await validator.validate(warningsThenError, { maxIssues: 2 });

        expect(result.valid).toBe(true);
        expect(result.issues).toHaveLength(2);
        expect(result.incomplete).toBe(true);
      });

      it('counts the rules that ran when it stops early', async () => {
        const validator = new JSAstValidator([
          new DisallowedIdentifierRule({ disallowed: ['eval'] }),
          new UnreachableCodeRule(),
        ]);

        const stopped = await validator.validate(warningsThenError, { stopOnFirstError: true });
        expect(stopped.rulesExecuted).toBe(1);
        expect(stopped.incomplete).toBe(true);

        const complete = await validator.validate(warningsThenError);
        expect(complete.rulesExecuted).toBe(2);
        expect(complete.incomplete).toBeUndefined();
      });
    });

    describe('unknown-global issues', () => {
      it('state the list of allowed globals once per validation', async () => {
        const validator = new JSAstValidator([
          new UnknownGlobalRule({ allowedGlobals: ['callTool', 'Math'], allowStandardGlobals: false }),
        ]);

        const result = await validator.validate('first; second; third;');

        expect(result.issues.map((issue) => issue.code)).toEqual([
          'UNKNOWN_GLOBAL',
          'UNKNOWN_GLOBAL',
          'UNKNOWN_GLOBAL',
        ]);
        expect(result.issues[0].message).toContain('Allowed globals: Math, callTool');
        expect(result.issues[0].data).toEqual({ identifier: 'first', allowedGlobals: ['Math', 'callTool'] });
        expect(result.issues[1].message).not.toContain('Allowed globals');
        expect(result.issues[1].data).toEqual({ identifier: 'second' });
        expect(result.issues[2].data).toEqual({ identifier: 'third' });

        // Once per validation, not once per validator
        const again = await validator.validate('fourth;');
        expect(again.issues[0].message).toContain('Allowed globals: Math, callTool');
      });
    });
  });

  describe('getStats', () => {
    it('should calculate stats correctly', async () => {
      const validator = new JSAstValidator([
        new DisallowedIdentifierRule({ disallowed: ['eval'] }),
        new UnreachableCodeRule(),
      ]);

      const result = await validator.validate(`
        eval("x");
        function test() {
          return 1;
          const unreachable = 2;
        }
      `);

      const stats = validator.getStats(result, 100);
      expect(stats.totalIssues).toBeGreaterThan(0);
      expect(stats.errors).toBeGreaterThan(0);
      expect(stats.durationMs).toBe(100);
    });
  });
});
