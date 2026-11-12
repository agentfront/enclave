/**
 * Import Rewrite Transform
 *
 * Transforms npm package imports to ESM CDN URLs with specific versions.
 * This enables sandboxed code to import npm packages from a trusted CDN
 * without needing a bundler or package manager.
 *
 * SECURITY CONSIDERATIONS:
 * - Only packages explicitly listed in packageVersions (or allowedPackages) can be imported,
 *   whichever way the import is written: an import declaration, a re-export, or a dynamic
 *   `import()` anywhere in the code
 * - A dynamic `import()` whose specifier is not a string literal cannot be checked and is refused
 * - Package names, subpaths and versions are validated against strict regex patterns
 * - CDN base URL must be HTTPS, without credentials, query or fragment
 * - Local imports (./foo, ../bar) are skipped by default
 *
 * The allowlist is the configuration's. Where the configuration comes from the same party as
 * the code (a script that passes `importRewrite` to `Babel.transform` inside the sandbox), the
 * transform is a convenience for that party and restricts nothing: whoever loads the output
 * treats it as the script's own text.
 *
 * @packageDocumentation
 */

import * as acorn from 'acorn';
import { generate } from 'astring';
import type { ImportDeclaration, ExportNamedDeclaration, ExportAllDeclaration, Program, Literal } from 'estree';
import { walkAll, type AnyNode } from '../utils/ast-walk';

/**
 * Configuration for import rewriting
 */
export interface ImportRewriteConfig {
  /**
   * Whether import rewriting is enabled
   */
  enabled: boolean;

  /**
   * Base URL for the ESM CDN (must be HTTPS)
   * @example 'https://esm.agentfront.dev'
   */
  cdnBaseUrl: string;

  /**
   * Package versions to use for each npm package.
   * - Specify a version string to pin: `'react': '18.2.0'` → `/react@18.2.0`
   * - Use empty string for latest: `'react': ''` → `/react` (no @version)
   *
   * Only packages listed here (or in allowedPackages) can be imported.
   * @example { 'react': '18.2.0', '@mui/material': '' }
   */
  packageVersions: Record<string, string>;

  /**
   * Optional allowlist of packages that can be imported without specifying a version.
   * Packages in this list but not in packageVersions will use latest (no @version in URL).
   * @example ['react', 'react-dom', '@mui/material']
   */
  allowedPackages?: string[];

  /**
   * Whether to skip local imports (./foo, ../bar)
   * @default true
   */
  skipLocalImports?: boolean;
}

/**
 * Result of import rewriting
 */
export interface ImportRewriteResult {
  /**
   * The rewritten code
   */
  code: string;

  /**
   * List of imports that were rewritten
   */
  rewrittenImports: Array<{
    /**
     * Original import source
     * @example '@mui/material/Button'
     */
    original: string;

    /**
     * Rewritten CDN URL
     * @example 'https://esm.agentfront.dev/@mui/material@5.15.0/Button'
     */
    rewritten: string;
  }>;

  /**
   * List of imports that were not rewritten (e.g., local imports)
   */
  skippedImports: string[];
}

/**
 * Regex to validate npm package names
 * Matches: 'react', '@mui/material', '@scope/package-name'
 * Based on npm package naming rules
 */
const PACKAGE_NAME_REGEX = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;

/**
 * Regex to validate subpaths (no path traversal)
 * Matches: 'Button', 'components/Button', 'esm/index'
 * Rejects: '../foo', './bar', paths with '..'
 */
const SUBPATH_REGEX = /^[a-zA-Z0-9\-_./]+$/;

/**
 * Regex to validate a package version: what follows `@` in one path segment of the CDN URL.
 * Matches versions, ranges and tags: '18.2.0', '^18.2.0', '~18', '18.x', '>=18', 'latest', '1.0.0-rc.1'
 * Rejects anything that would end the segment or change the URL: '/', '\', '?', '#', '%', '@', white space
 */
const VERSION_REGEX = /^[a-zA-Z0-9._\-+~^*=<>|]+$/;

/**
 * Check if an import is a local import (starts with ./ or ../)
 */
function isLocalImport(source: string): boolean {
  return source.startsWith('./') || source.startsWith('../');
}

/**
 * Parse an import source into package name and subpath
 *
 * @example
 * parseImportSource('react') => { packageName: 'react', subpath: undefined }
 * parseImportSource('@mui/material/Button') => { packageName: '@mui/material', subpath: 'Button' }
 * parseImportSource('lodash/debounce') => { packageName: 'lodash', subpath: 'debounce' }
 */
function parseImportSource(source: string): { packageName: string; subpath?: string } {
  // Handle scoped packages (@scope/name)
  if (source.startsWith('@')) {
    const parts = source.split('/');
    if (parts.length >= 2) {
      const packageName = `${parts[0]}/${parts[1]}`;
      const subpath = parts.length > 2 ? parts.slice(2).join('/') : undefined;
      return { packageName, subpath };
    }
  }

  // Handle regular packages
  const parts = source.split('/');
  const packageName = parts[0];
  const subpath = parts.length > 1 ? parts.slice(1).join('/') : undefined;

  return { packageName, subpath };
}

/**
 * Validate a package name against security rules
 */
function validatePackageName(packageName: string): void {
  if (!PACKAGE_NAME_REGEX.test(packageName)) {
    throw new Error(`Invalid package name: "${packageName}". Package names must follow npm naming conventions.`);
  }
}

/**
 * Validate a subpath against security rules
 */
function validateSubpath(subpath: string): void {
  if (!SUBPATH_REGEX.test(subpath)) {
    throw new Error(`Invalid subpath: "${subpath}". Subpaths must not contain path traversal sequences.`);
  }

  // Additional check for path traversal
  if (subpath.includes('..')) {
    throw new Error(`Invalid subpath: "${subpath}". Path traversal is not allowed.`);
  }
}

/**
 * Validate a package version against security rules
 */
function validateVersion(packageName: string, version: unknown): void {
  const text = String(version);
  if (!VERSION_REGEX.test(text) || text.includes('..')) {
    throw new Error(
      `Invalid version for package "${packageName}": "${text}". ` +
        `A version is a version number, a range or a tag, without path or URL characters.`,
    );
  }
}

/**
 * Validate the CDN base URL
 *
 * Every rewritten import is the base URL followed by a path, so the base URL has to end where a
 * path can follow: it names a host over HTTPS and optionally a path, and nothing else.
 */
function validateCdnUrl(cdnBaseUrl: string): void {
  let url: URL;
  try {
    url = new URL(cdnBaseUrl);
  } catch {
    throw new Error(`Invalid CDN URL: "${cdnBaseUrl}"`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`CDN URL must use HTTPS: "${cdnBaseUrl}"`);
  }
  if (url.username !== '' || url.password !== '' || cdnBaseUrl.includes('?') || cdnBaseUrl.includes('#')) {
    throw new Error(`Invalid CDN URL: "${cdnBaseUrl}" must not contain credentials, a query or a fragment`);
  }
}

/**
 * The specifier of a dynamic import when it is written as a string: a string literal, or a
 * template literal without substitutions. `undefined` for anything else.
 */
function staticSpecifier(source: AnyNode): string | undefined {
  if (source?.type === 'Literal' && typeof source.value === 'string') {
    return source.value;
  }
  if (source?.type === 'TemplateLiteral' && source.expressions.length === 0 && source.quasis.length === 1) {
    const cooked = source.quasis[0].value.cooked;
    return typeof cooked === 'string' ? cooked : undefined;
  }
  return undefined;
}

/**
 * Rewrite imports in JavaScript/TypeScript code to use CDN URLs
 *
 * @param code - The source code to transform
 * @param config - Import rewrite configuration
 * @returns The transformed code and list of rewritten imports
 *
 * @example
 * ```typescript
 * const result = rewriteImports(
 *   `import React from 'react';
 *    import Button from '@mui/material/Button';`,
 *   {
 *     enabled: true,
 *     cdnBaseUrl: 'https://esm.agentfront.dev',
 *     packageVersions: {
 *       'react': '18.2.0',
 *       '@mui/material': '5.15.0'
 *     }
 *   }
 * );
 *
 * // result.code:
 * // import React from 'https://esm.agentfront.dev/react@18.2.0';
 * // import Button from 'https://esm.agentfront.dev/@mui/material@5.15.0/Button';
 * ```
 */
export function rewriteImports(code: string, config: ImportRewriteConfig): ImportRewriteResult {
  // Return early if disabled
  if (!config.enabled) {
    return {
      code,
      rewrittenImports: [],
      skippedImports: [],
    };
  }

  // Validate CDN URL
  validateCdnUrl(config.cdnBaseUrl);

  const skipLocalImports = config.skipLocalImports ?? true;

  // If allowedPackages is provided, use it as the exclusive allowlist
  // Otherwise, use packageVersions keys as the allowlist
  const allowedPackages = config.allowedPackages
    ? new Set(config.allowedPackages)
    : new Set(Object.keys(config.packageVersions));

  // Parse the code into an AST
  // Note: acorn only parses JavaScript. For TypeScript/JSX, run Babel transform first.
  let ast: Program;
  try {
    ast = acorn.parse(code, {
      ecmaVersion: 'latest',
      sourceType: 'module',
    }) as unknown as Program;
  } catch (error) {
    throw new Error(`Failed to parse JavaScript code for import rewriting: ${(error as Error).message}`);
  }

  const rewrittenImports: Array<{ original: string; rewritten: string }> = [];
  const skippedImports: string[] = [];

  // Helper function to rewrite a module source. `replaceSourceNode` is given where the node that
  // holds the specifier is not a string literal that can be updated in place.
  const rewriteSource = (source: string, sourceNode: Literal, replaceSourceNode?: (node: Literal) => void): void => {
    // Skip local imports if configured
    if (isLocalImport(source)) {
      if (skipLocalImports) {
        skippedImports.push(source);
        return;
      }
    }

    // Parse the import source
    const { packageName, subpath } = parseImportSource(source);

    // Check if package is allowed
    if (!allowedPackages.has(packageName)) {
      throw new Error(
        `Package "${packageName}" is not allowed. ` +
          `Only packages listed in packageVersions or allowedPackages can be imported: ${[...allowedPackages].join(', ')}`,
      );
    }

    // Validate package name
    validatePackageName(packageName);

    // Validate subpath if present
    if (subpath) {
      validateSubpath(subpath);
    }

    // Get version from config (may be empty string or undefined for latest)
    const version = Object.hasOwn(config.packageVersions, packageName)
      ? config.packageVersions[packageName]
      : undefined;
    if (version) {
      validateVersion(packageName, version);
    }

    // Construct CDN URL
    // If version is empty or undefined, don't include @version (use latest)
    const packageWithVersion = version ? `${packageName}@${version}` : packageName;
    const cdnUrl = subpath
      ? `${config.cdnBaseUrl}/${packageWithVersion}/${subpath}`
      : `${config.cdnBaseUrl}/${packageWithVersion}`;

    // Update the source
    if (replaceSourceNode) {
      replaceSourceNode({ type: 'Literal', value: cdnUrl, raw: JSON.stringify(cdnUrl) });
    } else {
      sourceNode.value = cdnUrl;
      sourceNode.raw = JSON.stringify(cdnUrl);
    }

    rewrittenImports.push({
      original: source,
      rewritten: cdnUrl,
    });
  };

  // Every node of the tree, in source order: import and export declarations stand at the top
  // level of a module, a dynamic import can stand wherever an expression can
  walkAll(ast, (node: AnyNode) => {
    if (node.type === 'ImportDeclaration') {
      const importNode = node as ImportDeclaration;
      const source = importNode.source.value as string;
      rewriteSource(source, importNode.source as Literal);
    } else if (node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') {
      const exportNode = node as ExportNamedDeclaration | ExportAllDeclaration;
      // Only process re-exports (those with a source)
      if (exportNode.source) {
        const source = exportNode.source.value as string;
        rewriteSource(source, exportNode.source as Literal);
      }
    } else if (node.type === 'ImportExpression') {
      // The same check as for a declaration. A specifier that is computed when the code runs
      // cannot be checked here, so it is not let through.
      const source = staticSpecifier(node.source);
      if (source === undefined) {
        throw new Error(
          'Dynamic import() is only allowed with a string literal as its specifier: ' +
            'a specifier computed at run time cannot be checked against the allowed packages.',
        );
      }
      rewriteSource(source, node.source as Literal, (literal) => {
        node.source = literal;
      });
    }
  });

  // Generate code from the modified AST
  const rewrittenCode = generate(ast);

  return {
    code: rewrittenCode,
    rewrittenImports,
    skippedImports,
  };
}

/**
 * Check if a string is a valid npm package name
 */
export function isValidPackageName(name: string): boolean {
  return PACKAGE_NAME_REGEX.test(name);
}

/**
 * Check if a string is a valid subpath (no path traversal)
 */
export function isValidSubpath(subpath: string): boolean {
  return SUBPATH_REGEX.test(subpath) && !subpath.includes('..');
}
