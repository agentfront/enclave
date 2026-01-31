/**
 * Comprehensive Babel Preset Tests
 *
 * Extended tests for import rewriting, multi-file transforms,
 * and edge cases.
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
import { rewriteImports, type ImportRewriteConfig } from '@enclave-vm/ast';

describe('Babel Preset Comprehensive Tests', () => {
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

  describe('Import Rewriting - Advanced Scenarios', () => {
    const baseConfig: ImportRewriteConfig = {
      enabled: true,
      cdnBaseUrl: 'https://esm.agentfront.dev',
      packageVersions: {
        react: '18.2.0',
        'react-dom': '18.2.0',
        '@mui/material': '5.15.0',
        '@mui/icons-material': '5.15.0',
        '@emotion/react': '11.11.0',
        '@emotion/styled': '11.11.0',
        lodash: '4.17.21',
        axios: '',
        dayjs: '',
      },
    };

    it('should handle multiple imports from different packages', () => {
      const code = `
        import React, { useState, useEffect, useCallback } from 'react';
        import ReactDOM from 'react-dom';
        import { Button, Card, TextField } from '@mui/material';
        import { Add, Delete, Edit } from '@mui/icons-material';
        import axios from 'axios';
      `;
      const result = rewriteImports(code, baseConfig);

      expect(result.code).toContain('react@18.2.0');
      expect(result.code).toContain('react-dom@18.2.0');
      expect(result.code).toContain('@mui/material@5.15.0');
      expect(result.code).toContain('@mui/icons-material@5.15.0');
      expect(result.code).toContain('/axios"'); // latest, no version
      expect(result.rewrittenImports).toHaveLength(5);
    });

    it('should handle export from statements', () => {
      // Export from statements (re-exports) are now handled by the transform
      const code = `
        export { useState, useEffect } from 'react';
        export { Button } from '@mui/material';
      `;
      const result = rewriteImports(code, baseConfig);

      // Re-exports should be rewritten to CDN URLs
      expect(result.rewrittenImports.length).toBe(2);
      expect(result.code).toContain('react@18.2.0');
      expect(result.code).toContain('@mui/material@5.15.0');
    });

    it('should handle deeply nested scoped package paths', () => {
      const code = `
        import Button from '@mui/material/Button';
        import CardContent from '@mui/material/CardContent';
        import useTheme from '@mui/material/styles/useTheme';
        import AddIcon from '@mui/icons-material/Add';
      `;
      const result = rewriteImports(code, baseConfig);

      expect(result.code).toContain('@mui/material@5.15.0/Button');
      expect(result.code).toContain('@mui/material@5.15.0/CardContent');
      expect(result.code).toContain('@mui/material@5.15.0/styles/useTheme');
      expect(result.code).toContain('@mui/icons-material@5.15.0/Add');
    });

    it('should handle mixed versioned and latest packages', () => {
      const code = `
        import React from 'react';
        import axios from 'axios';
        import dayjs from 'dayjs';
        import _ from 'lodash';
      `;
      const result = rewriteImports(code, baseConfig);

      expect(result.code).toContain('react@18.2.0');
      expect(result.code).toContain('/axios"'); // latest
      expect(result.code).not.toContain('axios@');
      expect(result.code).toContain('/dayjs"'); // latest
      expect(result.code).not.toContain('dayjs@');
      expect(result.code).toContain('lodash@4.17.21');
    });

    it('should preserve import order', () => {
      const code = `
import React from 'react';
import axios from 'axios';
import { Button } from '@mui/material';
`;
      const result = rewriteImports(code, baseConfig);

      const reactIndex = result.code.indexOf('react');
      const axiosIndex = result.code.indexOf('axios');
      const muiIndex = result.code.indexOf('@mui');

      expect(reactIndex).toBeLessThan(axiosIndex);
      expect(axiosIndex).toBeLessThan(muiIndex);
    });

    it('should handle comments near imports', () => {
      const code = `
        // React for UI
        import React from 'react';
        /* MUI components */
        import { Button } from '@mui/material';
      `;
      const result = rewriteImports(code, baseConfig);

      expect(result.code).toContain('react@18.2.0');
      expect(result.code).toContain('@mui/material@5.15.0');
    });

    it('should not rewrite string literals that look like imports', () => {
      const code = `
        import React from 'react';
        const str = "import axios from 'axios'";
        const template = \`import lodash from 'lodash'\`;
      `;
      const result = rewriteImports(code, baseConfig);

      // Only the real import should be rewritten
      expect(result.rewrittenImports).toHaveLength(1);
      expect(result.rewrittenImports[0].original).toBe('react');
    });
  });

  describe('Multi-file Transform - Complex Scenarios', () => {
    it('should handle a realistic component library structure', () => {
      const babel = createRestrictedBabel(defaultBabelConfig);
      const files: MultiFileInput = {
        'components/index.ts': `
          import { Button } from './Button';
          import { Card } from './Card';
          import { Input } from './Input';
          export { Button, Card, Input };
        `,
        'components/Button.tsx': `
          import React from 'react';
          import { theme } from '../theme';
          export const Button = ({ children }: { children: React.ReactNode }) => (
            <button style={{ color: theme.primary }}>{children}</button>
          );
        `,
        'components/Card.tsx': `
          import React from 'react';
          import { theme } from '../theme';
          export const Card = ({ children }: { children: React.ReactNode }) => (
            <div style={{ background: theme.background }}>{children}</div>
          );
        `,
        'components/Input.tsx': `
          import React from 'react';
          import { theme } from '../theme';
          export const Input = (props: React.InputHTMLAttributes<HTMLInputElement>) => (
            <input style={{ borderColor: theme.border }} {...props} />
          );
        `,
        'theme.ts': `
          export const theme = {
            primary: '#007bff',
            background: '#ffffff',
            border: '#cccccc',
          };
        `,
      };

      const result = transformMultiple(files, { presets: ['typescript', 'react'] }, defaultLimits, babel.transform);

      expect(Object.keys(result.files)).toHaveLength(5);
      expect(result.files['components/index.js']).toBeDefined();
      expect(result.files['components/Button.js']).toBeDefined();
      expect(result.files['theme.js']).toBeDefined();

      // Check that imports are updated
      expect(result.files['components/Button.js']).toContain('../theme.js');
      expect(result.files['components/index.js']).toContain('./Button.js');

      // Check dependencies
      expect(result.dependencies['components/Button.tsx']).toContain('theme.ts');
    });

    it('should handle index file imports', () => {
      const babel = createRestrictedBabel(defaultBabelConfig);
      const files: MultiFileInput = {
        'utils/index.ts': `
          export const formatDate = (d: Date) => d.toISOString();
          export const formatNumber = (n: number) => n.toLocaleString();
        `,
        'app.ts': `
          import { formatDate, formatNumber } from './utils';
          console.log(formatDate(new Date()), formatNumber(1000));
        `,
      };

      const result = transformMultiple(files, { presets: ['typescript'] }, defaultLimits, babel.transform);

      expect(result.files['app.js']).toBeDefined();
      expect(result.dependencies['app.ts']).toContain('utils/index.ts');
    });

    it('should handle diamond dependency pattern', () => {
      const babel = createRestrictedBabel(defaultBabelConfig);
      // A depends on B and C, both B and C depend on D
      const files: MultiFileInput = {
        'a.ts': `
          import { b } from './b';
          import { c } from './c';
          export const a = b + c;
        `,
        'b.ts': `
          import { d } from './d';
          export const b = d * 2;
        `,
        'c.ts': `
          import { d } from './d';
          export const c = d * 3;
        `,
        'd.ts': `
          export const d = 10;
        `,
      };

      const result = transformMultiple(files, { presets: ['typescript'] }, defaultLimits, babel.transform);

      expect(Object.keys(result.files)).toHaveLength(4);
      expect(result.dependencies['a.ts']).toContain('b.ts');
      expect(result.dependencies['a.ts']).toContain('c.ts');
      expect(result.dependencies['b.ts']).toContain('d.ts');
      expect(result.dependencies['c.ts']).toContain('d.ts');
    });

    it('should handle files in nested directories', () => {
      const babel = createRestrictedBabel(defaultBabelConfig);
      const files: MultiFileInput = {
        'src/features/auth/login.tsx': `
          import React from 'react';
          import { Button } from '../../components/Button';
          export const Login = () => <Button>Login</Button>;
        `,
        'src/components/Button.tsx': `
          import React from 'react';
          export const Button = ({ children }: { children: React.ReactNode }) => <button>{children}</button>;
        `,
      };

      const result = transformMultiple(files, { presets: ['typescript', 'react'] }, defaultLimits, babel.transform);

      expect(result.files['src/features/auth/login.js']).toBeDefined();
      expect(result.files['src/components/Button.js']).toBeDefined();
    });

    it('should handle self-referencing (circular) imports gracefully', () => {
      const babel = createRestrictedBabel(defaultBabelConfig);
      const files: MultiFileInput = {
        'types.ts': `
          import { User } from './user';
          export interface Config { user: User; }
        `,
        'user.ts': `
          import { Config } from './types';
          export interface User { name: string; config?: Config; }
        `,
      };

      const result = transformMultiple(files, { presets: ['typescript'] }, defaultLimits, babel.transform);

      expect(result.warnings.some((w) => w.includes('Circular'))).toBe(true);
      expect(Object.keys(result.files)).toHaveLength(2);
    });

    it('should transform with full import rewriting workflow', () => {
      const babel = createRestrictedBabel(defaultBabelConfig);
      const files: MultiFileInput = {
        'App.tsx': `
          import React, { useState } from 'react';
          import { Button, Card } from '@mui/material';
          import { useApi } from './hooks/useApi';

          export const App = () => {
            const [count, setCount] = useState(0);
            const { data } = useApi();

            return (
              <Card>
                <p>Count: {count}</p>
                <p>Data: {JSON.stringify(data)}</p>
                <Button onClick={() => setCount(c => c + 1)}>Increment</Button>
              </Card>
            );
          };
        `,
        'hooks/useApi.ts': `
          import { useState, useEffect } from 'react';

          export const useApi = () => {
            const [data, setData] = useState(null);
            useEffect(() => {
              // Simulated API call
              setData({ message: 'Hello' });
            }, []);
            return { data };
          };
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

      // Check output files exist
      expect(result.files['App.js']).toBeDefined();
      expect(result.files['hooks/useApi.js']).toBeDefined();

      // Check npm imports are rewritten to CDN
      expect(result.files['App.js']).toContain('https://esm.agentfront.dev/react@18.2.0');
      expect(result.files['App.js']).toContain('https://esm.agentfront.dev/@mui/material@5.15.0');
      expect(result.files['hooks/useApi.js']).toContain('https://esm.agentfront.dev/react@18.2.0');

      // Check local imports are preserved with updated extensions
      expect(result.files['App.js']).toContain('./hooks/useApi.js');

      // Check JSX is transformed
      expect(result.files['App.js']).toContain('React.createElement');

      // Check TypeScript is stripped
      expect(result.files['hooks/useApi.js']).not.toContain(': null');

      // Check rewritten imports are tracked
      expect(result.rewrittenImports?.length).toBeGreaterThan(0);
    });
  });

  describe('Security Edge Cases', () => {
    it('should reject package names with special characters', () => {
      const config: ImportRewriteConfig = {
        enabled: true,
        cdnBaseUrl: 'https://esm.agentfront.dev',
        packageVersions: {
          'react<script>': '1.0.0',
        },
      };

      const code = `import x from 'react<script>';`;

      expect(() => rewriteImports(code, config)).toThrow();
    });

    it('should reject subpaths with encoded characters', () => {
      const config: ImportRewriteConfig = {
        enabled: true,
        cdnBaseUrl: 'https://esm.agentfront.dev',
        packageVersions: {
          lodash: '4.17.21',
        },
      };

      // This should fail because %2e%2e contains % which is not in the allowed subpath chars
      const code = `import x from 'lodash/%2e%2e/etc/passwd';`;

      // The subpath validation catches unusual characters like %
      expect(() => rewriteImports(code, config)).toThrow(/Invalid subpath/);
    });

    it('should handle very long package names gracefully', () => {
      const longName = 'a'.repeat(200);
      const config: ImportRewriteConfig = {
        enabled: true,
        cdnBaseUrl: 'https://esm.agentfront.dev',
        packageVersions: {
          [longName]: '1.0.0',
        },
      };

      const code = `import x from '${longName}';`;
      const result = rewriteImports(code, config);

      expect(result.code).toContain(longName);
    });

    it('should reject files with path traversal in multi-file transform', () => {
      const babel = createRestrictedBabel(defaultBabelConfig);

      expect(() =>
        transformMultiple(
          { '../../etc/passwd': 'export const x = 1;' },
          { presets: ['typescript'] },
          defaultLimits,
          babel.transform,
        ),
      ).toThrow(/path traversal/);

      expect(() =>
        transformMultiple(
          { 'foo/../../../etc/passwd': 'export const x = 1;' },
          { presets: ['typescript'] },
          defaultLimits,
          babel.transform,
        ),
      ).toThrow(/path traversal/);
    });

    it('should reject files with invalid extensions', () => {
      const babel = createRestrictedBabel(defaultBabelConfig);

      expect(() =>
        transformMultiple(
          { 'malicious.exe': 'export const x = 1;' },
          { presets: ['typescript'] },
          defaultLimits,
          babel.transform,
        ),
      ).toThrow(/Invalid filename/);

      expect(() =>
        transformMultiple(
          { 'script.sh': 'export const x = 1;' },
          { presets: ['typescript'] },
          defaultLimits,
          babel.transform,
        ),
      ).toThrow(/Invalid filename/);
    });
  });

  describe('Enclave Integration - Full Workflow', () => {
    it('should support complete UI component transformation workflow', async () => {
      const enclave = new Enclave({
        preset: 'babel',
        securityLevel: 'STANDARD',
      });

      try {
        const code = `
          const files = {
            'Button.tsx': \`
              import React from 'react';

              interface ButtonProps {
                variant?: 'primary' | 'secondary';
                children: React.ReactNode;
                onClick?: () => void;
              }

              export const Button: React.FC<ButtonProps> = ({
                variant = 'primary',
                children,
                onClick
              }) => (
                <button
                  className={\\\`btn btn-\\\${variant}\\\`}
                  onClick={onClick}
                >
                  {children}
                </button>
              );
            \`,
            'Card.tsx': \`
              import React from 'react';
              import { Button } from './Button';

              interface CardProps {
                title: string;
                children: React.ReactNode;
              }

              export const Card: React.FC<CardProps> = ({ title, children }) => (
                <div className="card">
                  <h2>{title}</h2>
                  <div className="card-body">{children}</div>
                  <Button variant="secondary">Close</Button>
                </div>
              );
            \`
          };

          const result = Babel.transformMultiple(files, {
            presets: ['typescript', 'react'],
            importRewrite: {
              enabled: true,
              cdnBaseUrl: 'https://esm.agentfront.dev',
              packageVersions: {
                'react': '18.2.0'
              }
            }
          });

          return {
            files: Object.keys(result.files),
            buttonHasReact: result.files['Button.js'].includes('React.createElement'),
            buttonHasCDN: result.files['Button.js'].includes('esm.agentfront.dev'),
            cardImportsButton: result.files['Card.js'].includes('./Button.js'),
            noTypeScript: !result.files['Button.js'].includes('interface'),
            rewrittenCount: result.rewrittenImports?.length || 0
          };
        `;

        const result = await enclave.run<{
          files: string[];
          buttonHasReact: boolean;
          buttonHasCDN: boolean;
          cardImportsButton: boolean;
          noTypeScript: boolean;
          rewrittenCount: number;
        }>(code);

        expect(result.success).toBe(true);
        expect(result.value?.files).toContain('Button.js');
        expect(result.value?.files).toContain('Card.js');
        expect(result.value?.buttonHasReact).toBe(true);
        expect(result.value?.buttonHasCDN).toBe(true);
        expect(result.value?.cardImportsButton).toBe(true);
        expect(result.value?.noTypeScript).toBe(true);
        expect(result.value?.rewrittenCount).toBeGreaterThan(0);
      } finally {
        enclave.dispose();
      }
    });

    it('should handle errors gracefully in sandbox', async () => {
      const enclave = new Enclave({
        preset: 'babel',
        securityLevel: 'STANDARD',
      });

      try {
        const code = `
          try {
            // Try to import a package not in packageVersions
            Babel.transformMultiple(
              { 'app.tsx': "import evil from 'evil-package';" },
              {
                presets: ['react'],
                importRewrite: {
                  enabled: true,
                  cdnBaseUrl: 'https://esm.agentfront.dev',
                  packageVersions: { 'react': '18.2.0' }
                }
              }
            );
            return { error: null };
          } catch (e) {
            return { error: e.message };
          }
        `;

        const result = await enclave.run<{ error: string | null }>(code);

        expect(result.success).toBe(true);
        expect(result.value?.error).toContain('not allowed');
      } finally {
        enclave.dispose();
      }
    });

    it('should handle syntax errors gracefully', async () => {
      const enclave = new Enclave({
        preset: 'babel',
        securityLevel: 'STANDARD',
      });

      try {
        const code = `
          try {
            Babel.transformMultiple(
              { 'broken.tsx': 'const x = {' },  // Syntax error
              { presets: ['typescript'] }
            );
            return { error: null };
          } catch (e) {
            return { error: e.message, hasFailed: true };
          }
        `;

        const result = await enclave.run<{ error: string | null; hasFailed: boolean }>(code);

        expect(result.success).toBe(true);
        expect(result.value?.hasFailed).toBe(true);
        expect(result.value?.error).toBeTruthy();
      } finally {
        enclave.dispose();
      }
    });

    it('should support single-file transform with import rewriting', async () => {
      const enclave = new Enclave({
        preset: 'babel',
        securityLevel: 'STANDARD',
      });

      try {
        const code = `
          const tsx = \`
            import React from 'react';
            import { useState } from 'react';

            const Counter = () => {
              const [count, setCount] = useState(0);
              return <button onClick={() => setCount(c => c + 1)}>{count}</button>;
            };

            export default Counter;
          \`;

          const result = Babel.transform(tsx, {
            presets: ['typescript', 'react'],
            filename: 'Counter.tsx',
            importRewrite: {
              enabled: true,
              cdnBaseUrl: 'https://esm.agentfront.dev',
              packageVersions: {
                'react': '18.2.0'
              }
            }
          });

          return {
            hasReactElement: result.code.includes('React.createElement'),
            hasCDNImport: result.code.includes('esm.agentfront.dev/react@18.2.0'),
            hasExport: result.code.includes('export default')
          };
        `;

        const result = await enclave.run<{
          hasReactElement: boolean;
          hasCDNImport: boolean;
          hasExport: boolean;
        }>(code);

        expect(result.success).toBe(true);
        expect(result.value?.hasReactElement).toBe(true);
        expect(result.value?.hasCDNImport).toBe(true);
        expect(result.value?.hasExport).toBe(true);
      } finally {
        enclave.dispose();
      }
    });

    it('should work with latest versions (no @version in URL)', async () => {
      const enclave = new Enclave({
        preset: 'babel',
        securityLevel: 'STANDARD',
      });

      try {
        // Note: imports must be used to avoid being tree-shaken by Babel
        const code = `
          const files = {
            'app.tsx': \`
              import React from 'react';
              import axios from 'axios';
              import dayjs from 'dayjs';
              // Use the imports to prevent tree-shaking
              const App = () => <div>{axios.name} {dayjs.name}</div>;
              export { axios, dayjs };
            \`
          };

          const result = Babel.transformMultiple(files, {
            presets: ['typescript', 'react'],
            importRewrite: {
              enabled: true,
              cdnBaseUrl: 'https://esm.agentfront.dev',
              packageVersions: {
                'react': '18.2.0',  // pinned
                'axios': '',        // latest
                'dayjs': ''         // latest
              }
            }
          });

          const outputCode = result.files['app.js'];
          return {
            code: outputCode,
            hasReactVersion: outputCode.includes('react@18.2.0'),
            // Check axios has no @ version - look for the URL without @
            hasAxiosLatest: outputCode.includes('esm.agentfront.dev/axios') && !outputCode.includes('axios@'),
            hasDayjsLatest: outputCode.includes('esm.agentfront.dev/dayjs') && !outputCode.includes('dayjs@')
          };
        `;

        const result = await enclave.run<{
          code: string;
          hasReactVersion: boolean;
          hasAxiosLatest: boolean;
          hasDayjsLatest: boolean;
        }>(code);

        expect(result.success).toBe(true);
        expect(result.value?.hasReactVersion).toBe(true);
        expect(result.value?.hasAxiosLatest).toBe(true);
        expect(result.value?.hasDayjsLatest).toBe(true);
      } finally {
        enclave.dispose();
      }
    });
  });

  describe('Performance and Limits', () => {
    it('should handle many small files efficiently', () => {
      const babel = createRestrictedBabel(defaultBabelConfig);
      const files: MultiFileInput = {};

      // Create 20 small files
      for (let i = 0; i < 20; i++) {
        files[`file${i}.ts`] = `export const value${i} = ${i};`;
      }

      const startTime = Date.now();
      const result = transformMultiple(files, { presets: ['typescript'] }, defaultLimits, babel.transform);
      const duration = Date.now() - startTime;

      expect(Object.keys(result.files)).toHaveLength(20);
      expect(duration).toBeLessThan(5000); // Should complete in under 5 seconds
    });

    it('should respect maxFiles limit', () => {
      const babel = createRestrictedBabel(defaultBabelConfig);
      const files: MultiFileInput = {};

      // Create more files than STRICT allows (max 3)
      for (let i = 0; i < 5; i++) {
        files[`file${i}.ts`] = `export const x = ${i};`;
      }

      const strictLimits: MultiFileLimits = {
        maxFiles: 3,
        maxTotalInputSize: 1024 * 1024,
        maxTotalOutputSize: 5 * 1024 * 1024,
        transformTimeout: 15000,
      };

      expect(() => transformMultiple(files, { presets: ['typescript'] }, strictLimits, babel.transform)).toThrow(
        /Too many files/,
      );
    });

    it('should respect maxTotalInputSize limit', () => {
      const babel = createRestrictedBabel(defaultBabelConfig);
      const largeContent = 'export const x = ' + '"a".repeat(10000);'.repeat(100);
      const files: MultiFileInput = {
        'large.ts': largeContent,
      };

      const tinyLimits: MultiFileLimits = {
        maxFiles: 10,
        maxTotalInputSize: 100, // Very small limit
        maxTotalOutputSize: 5 * 1024 * 1024,
        transformTimeout: 15000,
      };

      expect(() => transformMultiple(files, { presets: ['typescript'] }, tinyLimits, babel.transform)).toThrow(
        /Total input size exceeds/,
      );
    });
  });

  describe('TypeScript-specific Features', () => {
    it('should strip type annotations', () => {
      const babel = createRestrictedBabel(defaultBabelConfig);
      const files: MultiFileInput = {
        'types.ts': `
          export interface User {
            id: number;
            name: string;
            email: string;
          }

          export type Status = 'active' | 'inactive';

          export const createUser = (name: string, email: string): User => ({
            id: Date.now(),
            name,
            email
          });
        `,
      };

      const result = transformMultiple(files, { presets: ['typescript'] }, defaultLimits, babel.transform);

      expect(result.files['types.js']).not.toContain('interface');
      expect(result.files['types.js']).not.toContain(': User');
      expect(result.files['types.js']).not.toContain(': string');
      expect(result.files['types.js']).toContain('createUser');
    });

    it('should handle enums', () => {
      const babel = createRestrictedBabel(defaultBabelConfig);
      const files: MultiFileInput = {
        'enums.ts': `
          export enum Status {
            Active = 'active',
            Inactive = 'inactive',
            Pending = 'pending'
          }

          export const getStatus = (s: Status): string => s;
        `,
      };

      const result = transformMultiple(files, { presets: ['typescript'] }, defaultLimits, babel.transform);

      // Enums should be converted to objects
      expect(result.files['enums.js']).toContain('Status');
      expect(result.files['enums.js']).not.toContain(': Status');
    });

    it('should handle generics', () => {
      const babel = createRestrictedBabel(defaultBabelConfig);
      const files: MultiFileInput = {
        'generics.ts': `
          export const identity = <T>(value: T): T => value;
          export const map = <T, U>(arr: T[], fn: (item: T) => U): U[] => arr.map(fn);
        `,
      };

      const result = transformMultiple(files, { presets: ['typescript'] }, defaultLimits, babel.transform);

      expect(result.files['generics.js']).not.toContain('<T>');
      expect(result.files['generics.js']).not.toContain(': T');
      expect(result.files['generics.js']).toContain('identity');
      expect(result.files['generics.js']).toContain('map');
    });
  });

  describe('JSX-specific Features', () => {
    it('should transform JSX fragments', () => {
      const babel = createRestrictedBabel(defaultBabelConfig);
      const files: MultiFileInput = {
        'fragments.tsx': `
          import React from 'react';
          export const List = () => (
            <>
              <li>Item 1</li>
              <li>Item 2</li>
              <li>Item 3</li>
            </>
          );
        `,
      };

      const result = transformMultiple(files, { presets: ['typescript', 'react'] }, defaultLimits, babel.transform);

      expect(result.files['fragments.js']).toContain('React.createElement');
      // Fragments are transformed to React.Fragment
      expect(result.files['fragments.js']).toContain('Fragment');
    });

    it('should handle JSX spread attributes', () => {
      const babel = createRestrictedBabel(defaultBabelConfig);
      const files: MultiFileInput = {
        'spread.tsx': `
          import React from 'react';
          interface Props { className?: string; id?: string; }
          export const Box = (props: Props) => <div {...props} />;
        `,
      };

      const result = transformMultiple(files, { presets: ['typescript', 'react'] }, defaultLimits, babel.transform);

      expect(result.files['spread.js']).toContain('React.createElement');
    });

    it('should handle JSX expressions', () => {
      const babel = createRestrictedBabel(defaultBabelConfig);
      const files: MultiFileInput = {
        'expressions.tsx': `
          import React from 'react';
          export const Conditional = ({ show }: { show: boolean }) => (
            <div>
              {show && <span>Visible</span>}
              {show ? <p>Yes</p> : <p>No</p>}
            </div>
          );
        `,
      };

      const result = transformMultiple(files, { presets: ['typescript', 'react'] }, defaultLimits, babel.transform);

      expect(result.files['expressions.js']).toContain('React.createElement');
    });
  });
});
