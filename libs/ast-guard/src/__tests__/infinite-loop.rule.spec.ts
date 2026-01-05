/**
 * Tests for InfiniteLoopRule
 *
 * This rule detects obvious infinite loop patterns at static analysis time.
 * It provides defense-in-depth alongside runtime iteration limits.
 */

import { JSAstValidator } from '../validator';
import { InfiniteLoopRule } from '../rules/infinite-loop.rule';
import { createAgentScriptPreset } from '../presets/agentscript.preset';

describe('InfiniteLoopRule', () => {
  describe('For Loops - Infinite Patterns', () => {
    it('should detect for(;;) - missing test condition', async () => {
      const validator = new JSAstValidator([new InfiniteLoopRule()]);

      const code = `for(;;) { x++; }`;

      const result = await validator.validate(code);

      expect(result.valid).toBe(false);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].code).toBe('INFINITE_LOOP');
      expect(result.issues[0].message).toContain('missing test condition');
    });

    it('should detect for(;true;) - always true test', async () => {
      const validator = new JSAstValidator([new InfiniteLoopRule()]);

      const code = `for(;true;) { x++; }`;

      const result = await validator.validate(code);

      expect(result.valid).toBe(false);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].code).toBe('INFINITE_LOOP');
      expect(result.issues[0].message).toContain('always truthy');
    });

    it('should detect for(;1;) - truthy numeric literal', async () => {
      const validator = new JSAstValidator([new InfiniteLoopRule()]);

      const code = `for(;1;) { x++; }`;

      const result = await validator.validate(code);

      expect(result.valid).toBe(false);
      expect(result.issues[0].code).toBe('INFINITE_LOOP');
    });

    it('should detect for(;"string";) - truthy string literal', async () => {
      const validator = new JSAstValidator([new InfiniteLoopRule()]);

      const code = `for(;"hello";) { x++; }`;

      const result = await validator.validate(code);

      expect(result.valid).toBe(false);
      expect(result.issues[0].code).toBe('INFINITE_LOOP');
    });

    it('should detect for(;!false;) - negated false', async () => {
      const validator = new JSAstValidator([new InfiniteLoopRule()]);

      const code = `for(;!false;) { x++; }`;

      const result = await validator.validate(code);

      expect(result.valid).toBe(false);
      expect(result.issues[0].code).toBe('INFINITE_LOOP');
    });
  });

  describe('For Loops - Valid Patterns', () => {
    it('should allow for(let i=0; i<10; i++)', async () => {
      const validator = new JSAstValidator([new InfiniteLoopRule()]);

      const code = `for(let i = 0; i < 10; i++) { x++; }`;

      const result = await validator.validate(code);

      expect(result.valid).toBe(true);
    });

    it('should allow for(let i=arr.length-1; i>=0; i--)', async () => {
      const validator = new JSAstValidator([new InfiniteLoopRule()]);

      const code = `for(let i = arr.length - 1; i >= 0; i--) { x++; }`;

      const result = await validator.validate(code);

      expect(result.valid).toBe(true);
    });

    it('should allow for loop with variable condition', async () => {
      const validator = new JSAstValidator([new InfiniteLoopRule()]);

      const code = `for(let i = 0; i < n; i++) { x++; }`;

      const result = await validator.validate(code);

      expect(result.valid).toBe(true);
    });

    it('should allow for(;0;) - always false (will never execute)', async () => {
      const validator = new JSAstValidator([new InfiniteLoopRule()]);

      const code = `for(;0;) { x++; }`;

      const result = await validator.validate(code);

      expect(result.valid).toBe(true);
    });

    it('should allow for(;false;) - always false', async () => {
      const validator = new JSAstValidator([new InfiniteLoopRule()]);

      const code = `for(;false;) { x++; }`;

      const result = await validator.validate(code);

      expect(result.valid).toBe(true);
    });
  });

  describe('While Loops - Infinite Patterns', () => {
    it('should detect while(true)', async () => {
      const validator = new JSAstValidator([new InfiniteLoopRule()]);

      const code = `while(true) { x++; }`;

      const result = await validator.validate(code);

      expect(result.valid).toBe(false);
      expect(result.issues[0].code).toBe('INFINITE_LOOP');
      expect(result.issues[0].message).toContain('while loop');
      expect(result.issues[0].message).toContain('always truthy');
    });

    it('should detect while(1)', async () => {
      const validator = new JSAstValidator([new InfiniteLoopRule()]);

      const code = `while(1) { x++; }`;

      const result = await validator.validate(code);

      expect(result.valid).toBe(false);
      expect(result.issues[0].code).toBe('INFINITE_LOOP');
    });

    it('should detect while("string")', async () => {
      const validator = new JSAstValidator([new InfiniteLoopRule()]);

      const code = `while("hello") { x++; }`;

      const result = await validator.validate(code);

      expect(result.valid).toBe(false);
      expect(result.issues[0].code).toBe('INFINITE_LOOP');
    });

    it('should detect while(!false)', async () => {
      const validator = new JSAstValidator([new InfiniteLoopRule()]);

      const code = `while(!false) { x++; }`;

      const result = await validator.validate(code);

      expect(result.valid).toBe(false);
      expect(result.issues[0].code).toBe('INFINITE_LOOP');
    });

    it('should detect while([])', async () => {
      const validator = new JSAstValidator([new InfiniteLoopRule()]);

      const code = `while([]) { x++; }`;

      const result = await validator.validate(code);

      expect(result.valid).toBe(false);
      expect(result.issues[0].code).toBe('INFINITE_LOOP');
    });

    it('should detect while({})', async () => {
      const validator = new JSAstValidator([new InfiniteLoopRule()]);

      const code = `while({}) { x++; }`;

      const result = await validator.validate(code);

      expect(result.valid).toBe(false);
      expect(result.issues[0].code).toBe('INFINITE_LOOP');
    });
  });

  describe('While Loops - Valid Patterns', () => {
    it('should allow while(x < 10)', async () => {
      const validator = new JSAstValidator([new InfiniteLoopRule()]);

      const code = `while(x < 10) { x++; }`;

      const result = await validator.validate(code);

      expect(result.valid).toBe(true);
    });

    it('should allow while(condition)', async () => {
      const validator = new JSAstValidator([new InfiniteLoopRule()]);

      const code = `while(condition) { x++; }`;

      const result = await validator.validate(code);

      expect(result.valid).toBe(true);
    });

    it('should allow while(false) - never executes', async () => {
      const validator = new JSAstValidator([new InfiniteLoopRule()]);

      const code = `while(false) { x++; }`;

      const result = await validator.validate(code);

      expect(result.valid).toBe(true);
    });
  });

  describe('Do-While Loops - Infinite Patterns', () => {
    it('should detect do {} while(true)', async () => {
      const validator = new JSAstValidator([new InfiniteLoopRule()]);

      const code = `do { x++; } while(true);`;

      const result = await validator.validate(code);

      expect(result.valid).toBe(false);
      expect(result.issues[0].code).toBe('INFINITE_LOOP');
      expect(result.issues[0].message).toContain('do-while loop');
      expect(result.issues[0].message).toContain('always truthy');
    });

    it('should detect do {} while(1)', async () => {
      const validator = new JSAstValidator([new InfiniteLoopRule()]);

      const code = `do { x++; } while(1);`;

      const result = await validator.validate(code);

      expect(result.valid).toBe(false);
      expect(result.issues[0].code).toBe('INFINITE_LOOP');
    });

    it('should detect do {} while(!false)', async () => {
      const validator = new JSAstValidator([new InfiniteLoopRule()]);

      const code = `do { x++; } while(!false);`;

      const result = await validator.validate(code);

      expect(result.valid).toBe(false);
      expect(result.issues[0].code).toBe('INFINITE_LOOP');
    });
  });

  describe('Do-While Loops - Valid Patterns', () => {
    it('should allow do {} while(x < 10)', async () => {
      const validator = new JSAstValidator([new InfiniteLoopRule()]);

      const code = `do { x++; } while(x < 10);`;

      const result = await validator.validate(code);

      expect(result.valid).toBe(true);
    });

    it('should allow do {} while(false) - executes once', async () => {
      const validator = new JSAstValidator([new InfiniteLoopRule()]);

      const code = `do { x++; } while(false);`;

      const result = await validator.validate(code);

      expect(result.valid).toBe(true);
    });
  });

  describe('Configuration Options', () => {
    it('should respect checkForLoops: false', async () => {
      const validator = new JSAstValidator([new InfiniteLoopRule({ checkForLoops: false })]);

      const code = `for(;;) { x++; }`;

      const result = await validator.validate(code);

      expect(result.valid).toBe(true);
    });

    it('should respect checkWhileLoops: false', async () => {
      const validator = new JSAstValidator([new InfiniteLoopRule({ checkWhileLoops: false })]);

      const code = `while(true) { x++; }`;

      const result = await validator.validate(code);

      expect(result.valid).toBe(true);
    });

    it('should respect checkDoWhile: false', async () => {
      const validator = new JSAstValidator([new InfiniteLoopRule({ checkDoWhile: false })]);

      const code = `do { x++; } while(true);`;

      const result = await validator.validate(code);

      expect(result.valid).toBe(true);
    });

    it('should allow custom message', async () => {
      const validator = new JSAstValidator([new InfiniteLoopRule({ message: 'Custom infinite loop error' })]);

      const code = `for(;;) { x++; }`;

      const result = await validator.validate(code);

      expect(result.valid).toBe(false);
      expect(result.issues[0].message).toContain('Custom infinite loop error');
    });
  });

  describe('Integration with AgentScript Preset', () => {
    it('should block for(;;) in full AgentScript validation', async () => {
      const validator = new JSAstValidator(
        createAgentScriptPreset({
          allowedGlobals: ['callTool', '__safe_callTool', 'Math', 'JSON', '__maxIterations', 'x'],
        }),
      );

      const code = `
        async function __ag_main() {
          for(;;) { x++; }
        }
      `;

      const result = await validator.validate(code);

      expect(result.valid).toBe(false);
      expect(result.issues.some((i) => i.code === 'INFINITE_LOOP')).toBe(true);
    });

    it('should block while(true) in full AgentScript validation', async () => {
      const validator = new JSAstValidator(
        createAgentScriptPreset({
          allowedGlobals: ['callTool', '__safe_callTool', 'Math', 'JSON', '__maxIterations', 'x'],
          allowedLoops: { allowFor: true, allowWhile: true, allowForOf: true },
        }),
      );

      const code = `
        async function __ag_main() {
          while(true) { x++; }
        }
      `;

      const result = await validator.validate(code);

      expect(result.valid).toBe(false);
      expect(result.issues.some((i) => i.code === 'INFINITE_LOOP')).toBe(true);
    });

    it('should allow bounded for loop in AgentScript', async () => {
      const validator = new JSAstValidator(
        createAgentScriptPreset({
          allowedGlobals: ['callTool', '__safe_callTool', 'Math', 'JSON', '__maxIterations', 'i', 'arr', 'items', 'x'],
        }),
      );

      const code = `
        async function __ag_main() {
          for(let i = 0; i < items.length; i++) {
            x = items[i];
          }
          return x;
        }
      `;

      const result = await validator.validate(code);

      // Should not have infinite loop issues
      const infiniteLoopIssues = result.issues.filter((i) => i.code === 'INFINITE_LOOP');
      expect(infiniteLoopIssues).toHaveLength(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle nested infinite loops', async () => {
      const validator = new JSAstValidator([new InfiniteLoopRule()]);

      const code = `
        while(true) {
          for(;;) { x++; }
        }
      `;

      const result = await validator.validate(code);

      expect(result.valid).toBe(false);
      // Should report both
      expect(result.issues.filter((i) => i.code === 'INFINITE_LOOP')).toHaveLength(2);
    });

    it('should handle Infinity as always truthy', async () => {
      const validator = new JSAstValidator([new InfiniteLoopRule()]);

      const code = `while(Infinity) { x++; }`;

      const result = await validator.validate(code);

      expect(result.valid).toBe(false);
      expect(result.issues[0].code).toBe('INFINITE_LOOP');
    });

    it('should not flag undefined as truthy', async () => {
      const validator = new JSAstValidator([new InfiniteLoopRule()]);

      const code = `while(undefined) { x++; }`;

      const result = await validator.validate(code);

      // undefined is falsy, so this will never loop
      expect(result.valid).toBe(true);
    });

    it('should not flag NaN as truthy', async () => {
      const validator = new JSAstValidator([new InfiniteLoopRule()]);

      const code = `while(NaN) { x++; }`;

      const result = await validator.validate(code);

      // NaN is falsy, so this will never loop
      expect(result.valid).toBe(true);
    });

    it('should handle empty body loops', async () => {
      const validator = new JSAstValidator([new InfiniteLoopRule()]);

      const code = `for(;;);`;

      const result = await validator.validate(code);

      expect(result.valid).toBe(false);
      expect(result.issues[0].code).toBe('INFINITE_LOOP');
    });
  });

  describe('Error Location', () => {
    it('should provide correct line number for the issue', async () => {
      const validator = new JSAstValidator([new InfiniteLoopRule()]);

      const code = `
const x = 1;
const y = 2;
for(;;) {
  doSomething();
}
`;

      const result = await validator.validate(code);

      expect(result.valid).toBe(false);
      expect(result.issues[0].location).toBeDefined();
      expect(result.issues[0].location?.line).toBe(4);
    });
  });
});
