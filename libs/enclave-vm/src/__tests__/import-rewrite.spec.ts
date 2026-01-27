/**
 * Import Rewrite Transform Tests
 *
 * Tests for rewriting npm imports to CDN URLs.
 */

import { rewriteImports, isValidPackageName, isValidSubpath } from 'ast-guard';
import type { ImportRewriteConfig } from 'ast-guard';

describe('Import Rewrite Transform', () => {
  const defaultConfig: ImportRewriteConfig = {
    enabled: true,
    cdnBaseUrl: 'https://esm.agentfront.dev',
    packageVersions: {
      react: '18.2.0',
      'react-dom': '18.2.0',
      '@mui/material': '5.15.0',
      lodash: '4.17.21',
    },
  };

  describe('rewriteImports', () => {
    it('should rewrite simple package imports', () => {
      const code = `import React from 'react';`;
      const result = rewriteImports(code, defaultConfig);

      expect(result.code).toContain('https://esm.agentfront.dev/react@18.2.0');
      expect(result.rewrittenImports).toHaveLength(1);
      expect(result.rewrittenImports[0]).toEqual({
        original: 'react',
        rewritten: 'https://esm.agentfront.dev/react@18.2.0',
      });
    });

    it('should rewrite scoped package imports', () => {
      const code = `import Button from '@mui/material/Button';`;
      const result = rewriteImports(code, defaultConfig);

      expect(result.code).toContain('https://esm.agentfront.dev/@mui/material@5.15.0/Button');
      expect(result.rewrittenImports[0]).toEqual({
        original: '@mui/material/Button',
        rewritten: 'https://esm.agentfront.dev/@mui/material@5.15.0/Button',
      });
    });

    it('should rewrite package with subpath', () => {
      const code = `import debounce from 'lodash/debounce';`;
      const result = rewriteImports(code, defaultConfig);

      expect(result.code).toContain('https://esm.agentfront.dev/lodash@4.17.21/debounce');
    });

    it('should skip local imports by default', () => {
      const code = `
        import React from 'react';
        import { theme } from './theme';
        import utils from '../utils';
      `;
      const result = rewriteImports(code, defaultConfig);

      expect(result.code).toContain('https://esm.agentfront.dev/react@18.2.0');
      expect(result.code).toContain('./theme');
      expect(result.code).toContain('../utils');
      expect(result.skippedImports).toContain('./theme');
      expect(result.skippedImports).toContain('../utils');
    });

    it('should handle multiple imports from same package', () => {
      const code = `
        import { useState, useEffect } from 'react';
        import * as React from 'react';
      `;
      const result = rewriteImports(code, defaultConfig);

      // Both imports should be rewritten
      expect(result.rewrittenImports).toHaveLength(2);
      expect(result.rewrittenImports.every((r) => r.rewritten.includes('react@18.2.0'))).toBe(true);
    });

    it('should handle named imports', () => {
      const code = `import { Button, Card, TextField } from '@mui/material';`;
      const result = rewriteImports(code, {
        ...defaultConfig,
        packageVersions: {
          ...defaultConfig.packageVersions,
          '@mui/material': '5.15.0',
        },
      });

      expect(result.code).toContain('https://esm.agentfront.dev/@mui/material@5.15.0');
    });

    it('should handle namespace imports', () => {
      const code = `import * as MUI from '@mui/material';`;
      const result = rewriteImports(code, defaultConfig);

      expect(result.code).toContain('https://esm.agentfront.dev/@mui/material@5.15.0');
    });

    it('should handle side-effect imports', () => {
      const code = `import 'react';`;
      const result = rewriteImports(code, defaultConfig);

      expect(result.code).toContain('https://esm.agentfront.dev/react@18.2.0');
    });

    it('should return code unchanged when disabled', () => {
      const code = `import React from 'react';`;
      const result = rewriteImports(code, {
        ...defaultConfig,
        enabled: false,
      });

      expect(result.code).toBe(code);
      expect(result.rewrittenImports).toHaveLength(0);
    });

    it('should use latest (no @version) when version is empty string', () => {
      const code = `import React from 'react';`;
      const result = rewriteImports(code, {
        enabled: true,
        cdnBaseUrl: 'https://esm.agentfront.dev',
        packageVersions: {
          react: '', // empty string = latest
        },
      });

      expect(result.code).toContain('https://esm.agentfront.dev/react"');
      expect(result.code).not.toContain('@');
      expect(result.rewrittenImports[0]).toEqual({
        original: 'react',
        rewritten: 'https://esm.agentfront.dev/react',
      });
    });

    it('should use latest when package is in allowedPackages but not in packageVersions', () => {
      const code = `
        import React from 'react';
        import Button from '@mui/material/Button';
      `;
      const result = rewriteImports(code, {
        enabled: true,
        cdnBaseUrl: 'https://esm.agentfront.dev',
        packageVersions: {
          react: '18.2.0', // pinned version
          '@mui/material': '', // allowed with latest (no version)
        },
        // Note: if allowedPackages is provided, it's the exclusive list
        // Here we don't provide it, so packageVersions keys are the allowlist
      });

      // react should have version
      expect(result.code).toContain('https://esm.agentfront.dev/react@18.2.0');
      // @mui/material should not have version (latest)
      expect(result.code).toContain('https://esm.agentfront.dev/@mui/material/Button"');
      expect(result.code).not.toContain('@mui/material@');
    });

    it('should handle mix of versioned and latest packages', () => {
      const code = `
        import React from 'react';
        import ReactDOM from 'react-dom';
        import lodash from 'lodash';
      `;
      const result = rewriteImports(code, {
        enabled: true,
        cdnBaseUrl: 'https://esm.agentfront.dev',
        packageVersions: {
          react: '18.2.0',
          'react-dom': '', // latest
          lodash: '4.17.21',
        },
      });

      expect(result.code).toContain('react@18.2.0');
      expect(result.code).toContain('/react-dom"'); // no @version
      expect(result.code).toContain('lodash@4.17.21');
    });
  });

  describe('Security Validation', () => {
    it('should reject packages not in packageVersions', () => {
      const code = `import malicious from 'malicious-package';`;

      expect(() => rewriteImports(code, defaultConfig)).toThrow(/not allowed/);
    });

    it('should reject path traversal in subpaths', () => {
      const code = `import evil from 'lodash/../../../etc/passwd';`;

      // This should either:
      // 1. Fail because the package parsing gives a bad subpath
      // 2. Fail because the subpath validation catches '..'
      expect(() => rewriteImports(code, defaultConfig)).toThrow();
    });

    it('should reject non-HTTPS CDN URLs', () => {
      const code = `import React from 'react';`;

      expect(() =>
        rewriteImports(code, {
          ...defaultConfig,
          cdnBaseUrl: 'http://esm.agentfront.dev',
        }),
      ).toThrow(/HTTPS/);
    });

    it('should reject invalid CDN URLs', () => {
      const code = `import React from 'react';`;

      expect(() =>
        rewriteImports(code, {
          ...defaultConfig,
          cdnBaseUrl: 'not-a-url',
        }),
      ).toThrow(/Invalid CDN URL/);
    });

    it('should respect allowedPackages when provided', () => {
      const code = `import React from 'react';`;

      expect(() =>
        rewriteImports(code, {
          ...defaultConfig,
          allowedPackages: ['lodash'], // react not in allowlist
        }),
      ).toThrow(/not allowed/);
    });

    it('should allow packages in both packageVersions and allowedPackages', () => {
      const code = `import React from 'react';`;

      const result = rewriteImports(code, {
        ...defaultConfig,
        allowedPackages: ['react'], // react in allowlist
      });

      expect(result.rewrittenImports).toHaveLength(1);
    });
  });

  describe('isValidPackageName', () => {
    it('should accept valid package names', () => {
      expect(isValidPackageName('react')).toBe(true);
      expect(isValidPackageName('lodash')).toBe(true);
      expect(isValidPackageName('my-package')).toBe(true);
      expect(isValidPackageName('package_name')).toBe(true);
      expect(isValidPackageName('@scope/package')).toBe(true);
      expect(isValidPackageName('@mui/material')).toBe(true);
    });

    it('should reject invalid package names', () => {
      expect(isValidPackageName('')).toBe(false);
      expect(isValidPackageName('../foo')).toBe(false);
      expect(isValidPackageName('./bar')).toBe(false);
      expect(isValidPackageName('/absolute')).toBe(false);
    });
  });

  describe('isValidSubpath', () => {
    it('should accept valid subpaths', () => {
      expect(isValidSubpath('Button')).toBe(true);
      expect(isValidSubpath('components/Button')).toBe(true);
      expect(isValidSubpath('esm/index')).toBe(true);
      expect(isValidSubpath('utils/string-utils')).toBe(true);
    });

    it('should reject path traversal', () => {
      expect(isValidSubpath('../foo')).toBe(false);
      expect(isValidSubpath('foo/../bar')).toBe(false);
      expect(isValidSubpath('foo/../../etc/passwd')).toBe(false);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty file', () => {
      const result = rewriteImports('', defaultConfig);

      expect(result.code).toBe('');
      expect(result.rewrittenImports).toHaveLength(0);
    });

    it('should handle file with no imports', () => {
      const code = `const x = 1;\nconsole.log(x);`;
      const result = rewriteImports(code, defaultConfig);

      expect(result.rewrittenImports).toHaveLength(0);
    });

    it('should handle deeply nested subpaths', () => {
      const code = `import x from 'lodash/fp/flow/index';`;
      const result = rewriteImports(code, defaultConfig);

      expect(result.code).toContain('https://esm.agentfront.dev/lodash@4.17.21/fp/flow/index');
    });

    it('should preserve code structure', () => {
      // Note: import rewriting happens on raw code, not JSX-transformed code
      // The code must be valid JavaScript (no JSX) since we use acorn without JSX plugin
      const code = `
import React from 'react';

const App = () => {
  return React.createElement('div', null, 'Hello');
};

export default App;
      `.trim();

      const result = rewriteImports(code, defaultConfig);

      expect(result.code).toContain('const App');
      expect(result.code).toContain('export default');
    });
  });
});
