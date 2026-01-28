/**
 * Multi-file Babel Transform Tests
 *
 * Tests for transforming multiple interdependent files with Babel.
 */

import { Enclave } from '../enclave';
import {
  transformMultiple,
  createRestrictedBabel,
  resetBabelContext,
  type MultiFileInput,
  type MultiFileLimits,
  type BabelWrapperConfig,
} from '../babel';

describe('Multi-file Babel Transform', () => {
  // Reset context between test suites to ensure isolation
  afterAll(() => {
    resetBabelContext();
  });

  const defaultBabelConfig: BabelWrapperConfig = {
    maxInputSize: 1024 * 1024,
    maxOutputSize: 5 * 1024 * 1024,
    allowedPresets: ['typescript', 'react'],
    transformTimeout: 15000,
  };

  const defaultLimits: MultiFileLimits = {
    maxFiles: 25,
    maxTotalInputSize: 5 * 1024 * 1024,
    maxTotalOutputSize: 25 * 1024 * 1024,
    transformTimeout: 15000,
  };

  describe('transformMultiple', () => {
    it('should transform multiple TypeScript files', () => {
      const babel = createRestrictedBabel(defaultBabelConfig);
      const files: MultiFileInput = {
        'theme.ts': `export const theme = { primary: '#007bff' };`,
        'utils.ts': `export const formatDate = (d: Date): string => d.toISOString();`,
      };

      const result = transformMultiple(files, { presets: ['typescript'] }, defaultLimits, babel.transform);

      expect(Object.keys(result.files)).toHaveLength(2);
      expect(result.files['theme.js']).toBeDefined();
      expect(result.files['utils.js']).toBeDefined();
      expect(result.files['theme.js']).not.toContain(': string');
      expect(result.warnings).toHaveLength(0);
    });

    it('should transform TSX files with React preset', () => {
      const babel = createRestrictedBabel(defaultBabelConfig);
      const files: MultiFileInput = {
        'App.tsx': `
          interface Props { name: string; }
          const App = ({ name }: Props) => <h1>Hello, {name}!</h1>;
          export default App;
        `,
      };

      const result = transformMultiple(files, { presets: ['typescript', 'react'] }, defaultLimits, babel.transform);

      expect(result.files['App.js']).toContain('React.createElement');
      expect(result.files['App.js']).not.toContain('interface');
    });

    it('should handle files with local imports', () => {
      const babel = createRestrictedBabel(defaultBabelConfig);
      const files: MultiFileInput = {
        'theme.ts': `export const theme = { primary: '#007bff' };`,
        'App.tsx': `
          import { theme } from './theme';
          const App = () => <div style={{ color: theme.primary }}>Hello</div>;
          export default App;
        `,
      };

      const result = transformMultiple(files, { presets: ['typescript', 'react'] }, defaultLimits, babel.transform);

      expect(result.files['App.js']).toBeDefined();
      expect(result.files['theme.js']).toBeDefined();
      // Local imports should have extensions updated
      expect(result.files['App.js']).toContain("'./theme.js'");
      expect(result.dependencies['App.tsx']).toContain('theme.ts');
    });

    it('should build correct dependency graph', () => {
      const babel = createRestrictedBabel(defaultBabelConfig);
      const files: MultiFileInput = {
        'a.ts': `import { b } from './b'; export const a = b + 1;`,
        'b.ts': `import { c } from './c'; export const b = c + 1;`,
        'c.ts': `export const c = 1;`,
      };

      const result = transformMultiple(files, { presets: ['typescript'] }, defaultLimits, babel.transform);

      expect(result.dependencies['a.ts']).toContain('b.ts');
      expect(result.dependencies['b.ts']).toContain('c.ts');
      expect(result.dependencies['c.ts']).toHaveLength(0);
    });

    it('should detect and warn about circular dependencies', () => {
      const babel = createRestrictedBabel(defaultBabelConfig);
      const files: MultiFileInput = {
        'a.ts': `import { b } from './b'; export const a = b + 1;`,
        'b.ts': `import { a } from './a'; export const b = a + 1;`,
      };

      const result = transformMultiple(files, { presets: ['typescript'] }, defaultLimits, babel.transform);

      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings.some((w) => w.includes('Circular dependency'))).toBe(true);
    });

    it('should warn about unresolved imports', () => {
      const babel = createRestrictedBabel(defaultBabelConfig);
      const files: MultiFileInput = {
        'app.ts': `import { missing } from './nonexistent';`,
      };

      const result = transformMultiple(files, { presets: ['typescript'] }, defaultLimits, babel.transform);

      expect(result.warnings.some((w) => w.includes('Unresolved import'))).toBe(true);
    });
  });

  describe('Import Rewriting', () => {
    it('should rewrite npm imports to CDN URLs', () => {
      const babel = createRestrictedBabel(defaultBabelConfig);
      const files: MultiFileInput = {
        'App.tsx': `
          import React from 'react';
          const App = () => <div>Hello</div>;
          export default App;
        `,
      };

      const result = transformMultiple(
        files,
        {
          presets: ['typescript', 'react'],
          importRewrite: {
            enabled: true,
            cdnBaseUrl: 'https://esm.agentfront.dev',
            packageVersions: {
              react: '18.2.0',
            },
          },
        },
        defaultLimits,
        babel.transform,
      );

      expect(result.files['App.js']).toContain('https://esm.agentfront.dev/react@18.2.0');
      expect(result.rewrittenImports).toBeDefined();
      expect(result.rewrittenImports?.some((r) => r.original === 'react')).toBe(true);
    });

    it('should rewrite scoped package imports', () => {
      const babel = createRestrictedBabel(defaultBabelConfig);
      const files: MultiFileInput = {
        'MyCard.tsx': `
          import React from 'react';
          import Button from '@mui/material/Button';
          import Card from '@mui/material/Card';
          const MyCard = () => (
            <Card>
              <Button>Click me</Button>
            </Card>
          );
          export default MyCard;
        `,
      };

      const result = transformMultiple(
        files,
        {
          presets: ['typescript', 'react'],
          importRewrite: {
            enabled: true,
            cdnBaseUrl: 'https://esm.agentfront.dev',
            packageVersions: {
              react: '18.2.0',
              '@mui/material': '5.15.0',
            },
          },
        },
        defaultLimits,
        babel.transform,
      );

      expect(result.files['MyCard.js']).toContain('https://esm.agentfront.dev/react@18.2.0');
      expect(result.files['MyCard.js']).toContain('https://esm.agentfront.dev/@mui/material@5.15.0/Button');
      expect(result.files['MyCard.js']).toContain('https://esm.agentfront.dev/@mui/material@5.15.0/Card');
    });

    it('should keep local imports as-is (with updated extensions)', () => {
      const babel = createRestrictedBabel(defaultBabelConfig);
      const files: MultiFileInput = {
        'theme.ts': `export const theme = { primary: '#007bff' };`,
        'App.tsx': `
          import React from 'react';
          import { theme } from './theme';
          const App = () => <div style={{ color: theme.primary }}>Hello</div>;
          export default App;
        `,
      };

      const result = transformMultiple(
        files,
        {
          presets: ['typescript', 'react'],
          importRewrite: {
            enabled: true,
            cdnBaseUrl: 'https://esm.agentfront.dev',
            packageVersions: {
              react: '18.2.0',
            },
          },
        },
        defaultLimits,
        babel.transform,
      );

      // npm import should be rewritten to CDN
      expect(result.files['App.js']).toContain('https://esm.agentfront.dev/react@18.2.0');
      // Local import should stay local with updated extension
      expect(result.files['App.js']).toContain("'./theme.js'");
    });
  });

  describe('Security Limits', () => {
    it('should reject when file count exceeds limit', () => {
      const babel = createRestrictedBabel(defaultBabelConfig);
      const files: MultiFileInput = {
        'a.ts': 'export const a = 1;',
        'b.ts': 'export const b = 1;',
        'c.ts': 'export const c = 1;',
        'd.ts': 'export const d = 1;',
      };

      const strictLimits: MultiFileLimits = {
        ...defaultLimits,
        maxFiles: 3,
      };

      expect(() => transformMultiple(files, { presets: ['typescript'] }, strictLimits, babel.transform)).toThrow(
        /Too many files/,
      );
    });

    it('should reject when total input size exceeds limit', () => {
      const babel = createRestrictedBabel(defaultBabelConfig);
      const largeCode = 'x'.repeat(1000);
      const files: MultiFileInput = {
        'a.ts': largeCode,
        'b.ts': largeCode,
      };

      const strictLimits: MultiFileLimits = {
        ...defaultLimits,
        maxTotalInputSize: 100,
      };

      expect(() => transformMultiple(files, { presets: ['typescript'] }, strictLimits, babel.transform)).toThrow(
        /Total input size exceeds/,
      );
    });

    it('should reject invalid filenames', () => {
      const babel = createRestrictedBabel(defaultBabelConfig);

      expect(() =>
        transformMultiple(
          { '../etc/passwd': 'export const x = 1;' },
          { presets: ['typescript'] },
          defaultLimits,
          babel.transform,
        ),
      ).toThrow(/path traversal not allowed/);

      expect(() =>
        transformMultiple(
          { '/absolute/path.ts': 'export const x = 1;' },
          { presets: ['typescript'] },
          defaultLimits,
          babel.transform,
        ),
      ).toThrow(/absolute paths not allowed/);
    });

    it('should reject empty file set', () => {
      const babel = createRestrictedBabel(defaultBabelConfig);

      expect(() => transformMultiple({}, { presets: ['typescript'] }, defaultLimits, babel.transform)).toThrow(
        /No files provided/,
      );
    });
  });

  describe('Enclave Integration', () => {
    it('should expose Babel.transformMultiple in sandbox', async () => {
      const enclave = new Enclave({
        preset: 'babel',
        securityLevel: 'STANDARD',
      });

      try {
        const code = `
          const files = {
            'theme.ts': 'export const theme = { primary: "#007bff" };',
            'App.tsx': \`
              import { theme } from './theme';
              const App = () => <div style={{ color: theme.primary }}>Hello</div>;
              export default App;
            \`
          };

          const result = Babel.transformMultiple(files, {
            presets: ['typescript', 'react'],
          });

          return {
            fileCount: Object.keys(result.files).length,
            hasTheme: 'theme.js' in result.files,
            hasApp: 'App.js' in result.files,
            warnings: result.warnings,
          };
        `;

        const result = await enclave.run<{
          fileCount: number;
          hasTheme: boolean;
          hasApp: boolean;
          warnings: string[];
        }>(code);

        expect(result.success).toBe(true);
        expect(result.value?.fileCount).toBe(2);
        expect(result.value?.hasTheme).toBe(true);
        expect(result.value?.hasApp).toBe(true);
      } finally {
        enclave.dispose();
      }
    });

    it('should transform with import rewriting in sandbox', async () => {
      const enclave = new Enclave({
        preset: 'babel',
        securityLevel: 'STANDARD',
      });

      try {
        const code = `
          const files = {
            'App.tsx': \`
              import React from 'react';
              import Button from '@mui/material/Button';
              const App = () => <Button>Click me</Button>;
              export default App;
            \`
          };

          const result = Babel.transformMultiple(files, {
            presets: ['typescript', 'react'],
            importRewrite: {
              enabled: true,
              cdnBaseUrl: 'https://esm.agentfront.dev',
              packageVersions: {
                'react': '18.2.0',
                '@mui/material': '5.15.0'
              }
            }
          });

          return {
            code: result.files['App.js'],
            rewrittenImports: result.rewrittenImports,
          };
        `;

        const result = await enclave.run<{
          code: string;
          rewrittenImports: Array<{ original: string; rewritten: string }>;
        }>(code);

        expect(result.success).toBe(true);
        expect(result.value?.code).toContain('https://esm.agentfront.dev/react@18.2.0');
        expect(result.value?.code).toContain('https://esm.agentfront.dev/@mui/material@5.15.0/Button');
        expect(result.value?.rewrittenImports?.length).toBeGreaterThan(0);
      } finally {
        enclave.dispose();
      }
    });

    it('should respect security level limits for multi-file transforms', async () => {
      const enclave = new Enclave({
        preset: 'babel',
        securityLevel: 'STRICT', // STRICT allows max 3 files
      });

      try {
        const code = `
          const files = {
            'a.tsx': '<div>A</div>',
            'b.tsx': '<div>B</div>',
            'c.tsx': '<div>C</div>',
            'd.tsx': '<div>D</div>', // 4th file - should exceed STRICT limit
          };

          try {
            Babel.transformMultiple(files, { presets: ['react'] });
            return { error: null };
          } catch (e) {
            return { error: e.message };
          }
        `;

        const result = await enclave.run<{ error: string | null }>(code);

        expect(result.success).toBe(true);
        expect(result.value?.error).toContain('Too many files');
      } finally {
        enclave.dispose();
      }
    });

    it('should handle the example from the plan', async () => {
      const enclave = new Enclave({
        preset: 'babel',
        securityLevel: 'STANDARD',
      });

      try {
        const code = `
          const files = {
            'theme.ts': \`
              export const theme = { primary: '#007bff' };
            \`,
            'MyCard.tsx': \`
              import React from 'react';
              import Button from '@mui/material/Button';
              import Card from '@mui/material/Card';
              import { theme } from './theme';

              const MyCard = () => {
                return (
                  <Card>
                    <span style={{ color: theme.primary }}>Content</span>
                    <Button>Refresh</Button>
                  </Card>
                );
              };
              export default MyCard;
            \`
          };

          const result = Babel.transformMultiple(files, {
            presets: ['typescript', 'react'],
            importRewrite: {
              enabled: true,
              cdnBaseUrl: 'https://esm.agentfront.dev',
              packageVersions: {
                'react': '18.2.0',
                '@mui/material': '5.15.0'
              }
            }
          });

          return {
            outputFiles: Object.keys(result.files),
            themeCode: result.files['theme.js'],
            myCardCode: result.files['MyCard.js'],
            rewrittenCount: result.rewrittenImports?.length || 0,
          };
        `;

        const result = await enclave.run<{
          outputFiles: string[];
          themeCode: string;
          myCardCode: string;
          rewrittenCount: number;
        }>(code);

        expect(result.success).toBe(true);
        expect(result.value?.outputFiles).toContain('theme.js');
        expect(result.value?.outputFiles).toContain('MyCard.js');
        // theme.ts has no types, so it's just valid JS output
        expect(result.value?.themeCode).toContain('primary');
        expect(result.value?.myCardCode).toContain('React.createElement');
        expect(result.value?.myCardCode).toContain('https://esm.agentfront.dev/react@18.2.0');
        expect(result.value?.myCardCode).toContain('https://esm.agentfront.dev/@mui/material@5.15.0');
        // Local import should be kept as local with updated extension
        expect(result.value?.myCardCode).toContain('./theme.js');
        expect(result.value?.rewrittenCount).toBeGreaterThan(0);
      } finally {
        enclave.dispose();
      }
    });
  });

  describe('Extension Mapping', () => {
    it('should map .ts to .js', () => {
      const babel = createRestrictedBabel(defaultBabelConfig);
      const files: MultiFileInput = {
        'utils.ts': `export const add = (a: number, b: number) => a + b;`,
      };

      const result = transformMultiple(files, { presets: ['typescript'] }, defaultLimits, babel.transform);

      expect(result.files['utils.js']).toBeDefined();
      expect(result.files['utils.ts']).toBeUndefined();
    });

    it('should map .tsx to .js', () => {
      const babel = createRestrictedBabel(defaultBabelConfig);
      const files: MultiFileInput = {
        'App.tsx': `export const App = () => <div>Hello</div>;`,
      };

      const result = transformMultiple(files, { presets: ['typescript', 'react'] }, defaultLimits, babel.transform);

      expect(result.files['App.js']).toBeDefined();
    });

    it('should map .jsx to .js', () => {
      const babel = createRestrictedBabel(defaultBabelConfig);
      const files: MultiFileInput = {
        'App.jsx': `export const App = () => <div>Hello</div>;`,
      };

      const result = transformMultiple(files, { presets: ['react'] }, defaultLimits, babel.transform);

      expect(result.files['App.js']).toBeDefined();
    });

    it('should preserve .js extension', () => {
      const babel = createRestrictedBabel(defaultBabelConfig);
      const files: MultiFileInput = {
        'utils.js': `export const add = (a, b) => a + b;`,
      };

      const result = transformMultiple(files, { presets: ['react'] }, defaultLimits, babel.transform);

      expect(result.files['utils.js']).toBeDefined();
    });
  });
});
