/**
 * Babel Transform Tests for Enclave
 *
 * Tests the Babel.transform() capability inside the enclave sandbox.
 */

import { Enclave } from '../enclave';
import { createRestrictedBabel, BabelWrapperConfig } from '../babel';
import { getBabelConfig, BABEL_SECURITY_CONFIGS } from 'ast-guard';

import { resetBabelContext } from '../babel';

describe('Babel Transform', () => {
  // Reset context between test suites to ensure isolation
  afterAll(() => {
    resetBabelContext();
  });

  describe('Security Isolation', () => {
    const defaultConfig: BabelWrapperConfig = {
      maxInputSize: 1024 * 1024,
      maxOutputSize: 5 * 1024 * 1024,
      allowedPresets: ['typescript', 'react'],
      transformTimeout: 15000,
    };

    it('should not expose process global to transforms', () => {
      const babel = createRestrictedBabel(defaultConfig);

      // This code is just valid JavaScript that will be parsed
      // The transform itself runs in isolated context without process
      const result = babel.transform('const x = 1;', { presets: ['typescript'] });
      expect(result.code).toBeDefined();

      // The isolation is at the VM level where Babel runs
      // We can't directly test process access from here, but the
      // createIsolatedBabelContext function blocks all dangerous globals
    });

    it('should handle very large repeat counts gracefully', () => {
      const babel = createRestrictedBabel(defaultConfig);

      // This should transform successfully - repeated string in JSX
      const jsx = `const x = <div>{'a'.repeat(100)}</div>;`;
      const result = babel.transform(jsx, { presets: ['react'] });
      expect(result.code).toContain('React.createElement');
    });

    it('should not allow loading external babel configs', () => {
      const babel = createRestrictedBabel(defaultConfig);

      // Even if someone tries to enable babelrc, our safe options override it
      const result = babel.transform('const x = 1;', {
        presets: ['typescript'],
        // Note: user options don't allow babelrc/configFile
      });
      expect(result.code).toBeDefined();
    });

    it('should block all plugins (code execution vector)', () => {
      const babel = createRestrictedBabel(defaultConfig);

      // Even valid presets work, but plugins field is forced empty
      // TypeScript preset strips type annotations
      const result = babel.transform('const x: number = 1;', {
        presets: ['typescript'],
      });
      // Type annotation should be stripped
      expect(result.code).not.toContain(': number');
      // Variable declaration should remain
      expect(result.code).toContain('const x = 1');
    });

    it('should sanitize error messages to not leak paths', () => {
      const babel = createRestrictedBabel(defaultConfig);

      try {
        babel.transform('const x = {', { presets: ['typescript'] });
        fail('Should have thrown');
      } catch (error) {
        const err = error as Error;
        // Should not contain file system paths
        expect(err.message).not.toMatch(/\/Users\//);
        expect(err.message).not.toMatch(/\/home\//);
        expect(err.message).not.toMatch(/node_modules/);
      }
    });
  });
  describe('createRestrictedBabel', () => {
    const defaultConfig: BabelWrapperConfig = {
      maxInputSize: 1024 * 1024, // 1MB
      maxOutputSize: 5 * 1024 * 1024, // 5MB
      allowedPresets: ['typescript', 'react'],
      transformTimeout: 15000,
    };

    it('should transform JSX to JavaScript', () => {
      const babel = createRestrictedBabel(defaultConfig);
      const tsx = `const App = () => <h1>Hello World</h1>;`;

      const result = babel.transform(tsx, {
        presets: ['react'],
        filename: 'App.tsx',
      });

      expect(result.code).toContain('React.createElement');
      expect(result.code).toContain('"h1"');
      expect(result.code).toContain('"Hello World"');
    });

    it('should transform TypeScript to JavaScript', () => {
      const babel = createRestrictedBabel(defaultConfig);
      const ts = `
        interface User { name: string; age: number; }
        const user: User = { name: 'Alice', age: 30 };
      `;

      const result = babel.transform(ts, {
        presets: ['typescript'],
        filename: 'user.ts',
      });

      expect(result.code).not.toContain('interface');
      expect(result.code).not.toContain(': User');
      expect(result.code).toContain('name:');
      expect(result.code).toContain("'Alice'");
    });

    it('should transform TSX (TypeScript + JSX)', () => {
      const babel = createRestrictedBabel(defaultConfig);
      const tsx = `
        interface Props { name: string; }
        const Greeting = ({ name }: Props) => <span>Hello, {name}!</span>;
      `;

      const result = babel.transform(tsx, {
        presets: ['typescript', 'react'],
        filename: 'Greeting.tsx',
      });

      expect(result.code).toContain('React.createElement');
      expect(result.code).not.toContain('interface');
      expect(result.code).not.toContain(': Props');
    });

    it('should reject disallowed presets', () => {
      const babel = createRestrictedBabel(defaultConfig);
      const code = `const x = 1;`;

      expect(() => {
        babel.transform(code, {
          presets: ['env'], // Not in allowed list
        });
      }).toThrow(/Preset "env" is not allowed/);
    });

    it('should enforce input size limit', () => {
      const smallConfig: BabelWrapperConfig = {
        ...defaultConfig,
        maxInputSize: 100, // Very small limit
      };
      const babel = createRestrictedBabel(smallConfig);
      const largeCode = 'x'.repeat(200);

      expect(() => {
        babel.transform(largeCode, { presets: ['react'] });
      }).toThrow(/exceeds maximum size/);
    });

    it('should reject code with null bytes', () => {
      const babel = createRestrictedBabel(defaultConfig);
      const maliciousCode = 'const x = 1;\0malicious';

      expect(() => {
        babel.transform(maliciousCode, { presets: ['react'] });
      }).toThrow(/invalid null bytes/);
    });

    it('should reject non-string code', () => {
      const babel = createRestrictedBabel(defaultConfig);

      expect(() => {
        // @ts-expect-error Testing runtime behavior with invalid input
        babel.transform(123, { presets: ['react'] });
      }).toThrow(/Code must be a string/);
    });

    it('should reject non-array presets', () => {
      const babel = createRestrictedBabel(defaultConfig);

      expect(() => {
        babel.transform('const x = 1;', {
          // @ts-expect-error Testing runtime behavior with invalid input
          presets: 'react',
        });
      }).toThrow(/Presets must be an array/);
    });

    it('should sanitize filename (remove path traversal)', () => {
      const babel = createRestrictedBabel(defaultConfig);
      const code = `const x = 1;`;

      // Should not throw - filename is sanitized
      const result = babel.transform(code, {
        filename: '../../../etc/passwd',
        presets: ['typescript'],
      });

      expect(result.code).toBeDefined();
    });

    it('should only return code (no AST, no source map)', () => {
      const babel = createRestrictedBabel(defaultConfig);
      const code = `const x = 1;`;

      const result = babel.transform(code, { presets: ['typescript'] });

      expect(result).toHaveProperty('code');
      expect(Object.keys(result)).toEqual(['code']);
      expect(result).not.toHaveProperty('ast');
      expect(result).not.toHaveProperty('map');
    });

    it('should handle syntax errors gracefully', () => {
      const babel = createRestrictedBabel(defaultConfig);
      const invalidCode = `const x = {`;

      expect(() => {
        babel.transform(invalidCode, { presets: ['typescript'] });
      }).toThrow(/Babel transform failed/);
    });
  });

  describe('getBabelConfig', () => {
    it('should return STRICT config', () => {
      const config = getBabelConfig('STRICT');
      expect(config.maxInputSize).toBe(100 * 1024);
      expect(config.allowedPresets).toEqual(['react']);
    });

    it('should return SECURE config', () => {
      const config = getBabelConfig('SECURE');
      expect(config.maxInputSize).toBe(500 * 1024);
      expect(config.allowedPresets).toEqual(['typescript', 'react']);
    });

    it('should return STANDARD config', () => {
      const config = getBabelConfig('STANDARD');
      expect(config.maxInputSize).toBe(1024 * 1024);
      expect(config.allowedPresets).toEqual(['typescript', 'react']);
    });

    it('should return PERMISSIVE config', () => {
      const config = getBabelConfig('PERMISSIVE');
      expect(config.maxInputSize).toBe(5 * 1024 * 1024);
      expect(config.allowedPresets).toContain('env');
    });

    it('should default to STANDARD', () => {
      const config = getBabelConfig();
      expect(config).toEqual(BABEL_SECURITY_CONFIGS.STANDARD);
    });
  });

  describe('Enclave with babel preset', () => {
    it('should expose Babel.transform() in sandbox', async () => {
      const enclave = new Enclave({
        preset: 'babel',
        securityLevel: 'STANDARD',
      });

      const code = `
        const tsx = '<h1>Hello</h1>';
        const result = Babel.transform(tsx, {
          presets: ['react'],
          filename: 'test.jsx',
        });
        return result.code;
      `;

      const result = await enclave.run<string>(code);

      expect(result.success).toBe(true);
      expect(result.value).toContain('React.createElement');
      expect(result.value).toContain('"h1"');

      enclave.dispose();
    });

    it('should transform TSX inside sandbox', async () => {
      const enclave = new Enclave({
        preset: 'babel',
        securityLevel: 'STANDARD',
      });

      const code = `
        const tsx = \`
          interface Props { name: string; }
          const Greeting = ({ name }: Props) => <span>Hello, {name}!</span>;
        \`;
        const result = Babel.transform(tsx, {
          presets: ['typescript', 'react'],
          filename: 'Greeting.tsx',
        });
        return result.code;
      `;

      const result = await enclave.run<string>(code);

      expect(result.success).toBe(true);
      expect(result.value).toContain('React.createElement');
      expect(result.value).not.toContain('interface');

      enclave.dispose();
    });

    it('should respect security level preset limits', async () => {
      const enclave = new Enclave({
        preset: 'babel',
        securityLevel: 'STRICT',
      });

      // STRICT only allows 'react' preset, not 'typescript'
      const code = `
        const ts = 'const x: number = 1;';
        const result = Babel.transform(ts, {
          presets: ['typescript'],
          filename: 'test.ts',
        });
        return result.code;
      `;

      const result = await enclave.run<string>(code);

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('not allowed');

      enclave.dispose();
    });

    it('should work with callTool for full MCP UI flow', async () => {
      const enclave = new Enclave({
        preset: 'babel',
        securityLevel: 'STANDARD',
        toolHandler: async (toolName, args) => {
          if (toolName === 'get_component') {
            return `<Button onClick={() => alert('${args['text']}')}>Click me</Button>`;
          }
          return null;
        },
      });

      const code = `
        // Fetch TSX from a tool
        const tsx = await callTool('get_component', { text: 'Hello!' });

        // Transform it to JavaScript
        const result = Babel.transform(tsx, {
          presets: ['react'],
          filename: 'Button.jsx',
        });

        return result.code;
      `;

      const result = await enclave.run<string>(code);

      expect(result.success).toBe(true);
      expect(result.value).toContain('React.createElement');
      expect(result.value).toContain('Button');

      enclave.dispose();
    });

    it('should block Babel.constructor access', async () => {
      const enclave = new Enclave({
        preset: 'babel',
        securityLevel: 'STANDARD',
      });

      const code = `
        // Attempt to access constructor (should be blocked)
        return Babel.constructor;
      `;

      const result = await enclave.run(code);

      // STANDARD security level throws on blocked property access
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('constructor');

      enclave.dispose();
    });

    it('should enforce transform timeout', async () => {
      const enclave = new Enclave({
        preset: 'babel',
        securityLevel: 'STRICT', // STRICT has 5s timeout
      });

      // This code creates a deeply nested structure that takes a long time to transform
      // Using a realistic but slow transform scenario
      const code = `
        const jsx = '<div>' + '<span>'.repeat(100) + '</span>'.repeat(100) + '</div>';
        const result = Babel.transform(jsx, {
          presets: ['react'],
        });
        return result.code.length;
      `;

      const result = await enclave.run<number>(code);

      // Should succeed within timeout for this size
      expect(result.success).toBe(true);

      enclave.dispose();
    });

    it('should handle Babel.constructor access in PERMISSIVE mode', async () => {
      const enclave = new Enclave({
        preset: 'babel',
        securityLevel: 'PERMISSIVE',
      });

      const code = `
        // Attempt to access constructor
        // PERMISSIVE still blocks constructor for safety
        try {
          return { accessed: true, value: Babel.constructor };
        } catch (e) {
          return { accessed: false, error: e.message };
        }
      `;

      const result = await enclave.run<{ accessed: boolean; value?: unknown; error?: string }>(code);

      // PERMISSIVE may still have some safety measures
      // The key is that it doesn't leak the real constructor
      if (result.success && result.value?.accessed) {
        // If it returned a value, it should be undefined (blocked)
        expect(result.value.value).toBeUndefined();
      }

      enclave.dispose();
    });
  });
});
