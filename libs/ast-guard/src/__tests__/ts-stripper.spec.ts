/**
 * TypeScript Stripper Tests
 */

import { TypeScriptStripper, stripTypeScript, isTypeScriptLike } from '../ts-stripper';
import { transformAgentScript } from '../agentscript-transformer';
import { JSAstValidator } from '../validator';

describe('TypeScript Stripper', () => {
  describe('isTypeScriptLike', () => {
    it('should detect TypeScript syntax', () => {
      expect(isTypeScriptLike('const x: number = 1;')).toBe(true);
      expect(isTypeScriptLike('interface Foo { x: number }')).toBe(true);
      expect(isTypeScriptLike('type Foo = string')).toBe(true);
      expect(isTypeScriptLike('enum Status { Active }')).toBe(true);
      expect(isTypeScriptLike('const x = 1 as number')).toBe(true);
    });

    it('should not detect plain JavaScript', () => {
      expect(isTypeScriptLike('const x = 1;')).toBe(false);
      expect(isTypeScriptLike('function foo() { return 1; }')).toBe(false);
    });
  });

  describe('stripTypeScript', () => {
    it('should strip type annotations', () => {
      const result = stripTypeScript('const x: number = 1;');
      expect(result.success).toBe(true);
      expect(result.output).toContain('const x');
      expect(result.output).toContain('= 1');
      expect(result.output).not.toContain(': number');
    });

    it('should strip interface declarations', () => {
      const result = stripTypeScript(`
        interface User {
          id: number;
          name: string;
        }
        const user = { id: 1, name: 'test' };
      `);
      expect(result.success).toBe(true);
      expect(result.output).not.toContain('interface');
      expect(result.output).toContain("const user = { id: 1, name: 'test' }");
    });

    it('should strip type alias declarations', () => {
      const result = stripTypeScript('type ID = string | number;');
      expect(result.success).toBe(true);
      expect(result.output.trim()).toBe('');
    });

    it('should transpile enums to objects', () => {
      const result = stripTypeScript('enum Status { Active, Inactive }');
      expect(result.success).toBe(true);
      expect(result.output).toContain('const Status');
      expect(result.output).toContain('Active: 0');
      expect(result.output).toContain('Inactive: 1');
    });

    it('should strip function parameter types', () => {
      const result = stripTypeScript('function add(a: number, b: number): number { return a + b; }');
      expect(result.success).toBe(true);
      expect(result.output).toContain('function add(a');
      expect(result.output).toContain(', b');
      expect(result.output).toContain('{ return a + b; }');
    });

    it('should strip generic type parameters', () => {
      const result = stripTypeScript('function identity<T>(x: T): T { return x; }');
      expect(result.success).toBe(true);
      expect(result.output).toContain('function identity');
      expect(result.output).toContain('(x');
      expect(result.output).toContain('return x');
      expect(result.output).not.toContain('<T>');
    });

    it('should strip type assertions', () => {
      const result = stripTypeScript('const x = value as string;');
      expect(result.success).toBe(true);
      expect(result.output).toContain('const x = value');
      expect(result.output).not.toContain('as string');
    });

    it('should strip non-null assertions', () => {
      const result = stripTypeScript('const x = value!;');
      expect(result.success).toBe(true);
      expect(result.output).toContain('const x = value');
      expect(result.output).not.toContain('!');
    });

    it('should strip access modifiers', () => {
      const result = stripTypeScript(`
        class Foo {
          public x: number;
          private y: string;
          readonly z: boolean;
        }
      `);
      expect(result.success).toBe(true);
      expect(result.output).not.toContain('public');
      expect(result.output).not.toContain('private');
      expect(result.output).not.toContain('readonly');
    });

    it('should NOT strip import/export as aliases', () => {
      const result = stripTypeScript("import { foo as bar } from 'module';");
      expect(result.success).toBe(true);
      expect(result.output).toContain('as bar');
    });

    it('should strip import type statements', () => {
      const result = stripTypeScript("import type { Foo } from 'module';");
      expect(result.success).toBe(true);
      expect(result.output.trim()).toBe('');
    });
  });

  describe('Integration with agentscript transformer', () => {
    it('should transform TypeScript AgentScript code', () => {
      const tsCode = `
        interface User {
          id: number;
          name: string;
        }
        const users: User[] = await callTool('users:list', {});
        return users.map(u => u.name);
      `;

      const result = transformAgentScript(tsCode);

      // Should have stripped TypeScript and transformed to AgentScript
      expect(result).toContain('__ag_main');
      expect(result).toContain('__safe_callTool');
      expect(result).not.toContain('interface');
      expect(result).not.toContain(': User[]');
    });

    it('should handle enums in AgentScript', () => {
      const tsCode = `
        enum Status { Active = 'active', Inactive = 'inactive' }
        const status: Status = Status.Active;
        return status;
      `;

      const result = transformAgentScript(tsCode);

      expect(result).toContain('const Status = {');
      expect(result).toContain("Active: 'active'");
      expect(result).not.toContain('enum');
    });
  });

  describe('Integration with validator', () => {
    it('should validate TypeScript code after stripping', async () => {
      const validator = new JSAstValidator([]);
      const tsCode = 'const x: number = 1;';

      const result = await validator.validate(tsCode, {
        typescript: { enabled: true },
      });

      // When TypeScript is enabled, it should strip types and parse successfully
      expect(result.parseError).toBeUndefined();
      expect(result.valid).toBe(true);
    });

    it('should auto-detect and strip TypeScript when not explicitly disabled', async () => {
      const validator = new JSAstValidator([]);
      const tsCode = 'interface Foo { x: number }';

      const result = await validator.validate(tsCode, {
        typescript: { enabled: true },
      });

      // Interface should be stripped, resulting in valid (empty) code
      expect(result.parseError).toBeUndefined();
    });

    it('should fail on TypeScript when explicitly disabled', async () => {
      const validator = new JSAstValidator([]);
      const tsCode = 'const x: number = 1;';

      const result = await validator.validate(tsCode, {
        typescript: { enabled: false },
      });

      // Should fail to parse because TypeScript syntax is not stripped
      expect(result.valid).toBe(false);
      expect(result.parseError).toBeDefined();
    });
  });
});
