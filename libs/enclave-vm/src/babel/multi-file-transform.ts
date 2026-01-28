/**
 * Multi-file Babel Transform
 *
 * Orchestrates transpilation of multiple interdependent files with:
 * - Dependency graph analysis
 * - Topological sorting (dependencies first)
 * - Import rewriting for npm packages to CDN URLs
 * - Local import resolution (extension updates)
 *
 * SECURITY:
 * - File count limits per security level
 * - Total input/output size limits
 * - Filename sanitization
 * - No path traversal in filenames
 *
 * @packageDocumentation
 */

import { rewriteImports, type ImportRewriteConfig } from 'ast-guard';
import type { SafeTransformOptions, SafeTransformResult } from './babel-wrapper';

/**
 * Multi-file input: mapping of filename to source code
 */
export interface MultiFileInput {
  [filename: string]: string;
}

/**
 * Options for multi-file transform
 */
export interface MultiFileTransformOptions extends SafeTransformOptions {
  /**
   * Base path for resolving local imports (for informational purposes only)
   */
  basePath?: string;

  /**
   * Whether to resolve local imports by updating extensions
   * @default true
   */
  resolveLocalImports?: boolean;

  /**
   * Import rewrite configuration for npm packages
   */
  importRewrite?: ImportRewriteConfig;
}

/**
 * Result of multi-file transform
 */
export interface MultiFileTransformResult {
  /**
   * Transformed output files (filename -> code)
   */
  files: { [filename: string]: string };

  /**
   * Dependency graph (filename -> list of dependencies)
   */
  dependencies: { [filename: string]: string[] };

  /**
   * Warnings generated during transform
   */
  warnings: string[];

  /**
   * Import rewrite information (package -> CDN URL)
   */
  rewrittenImports?: Array<{ original: string; rewritten: string }>;
}

/**
 * Configuration for multi-file transform limits
 */
export interface MultiFileLimits {
  /**
   * Maximum number of files
   */
  maxFiles: number;

  /**
   * Maximum total input size in bytes
   */
  maxTotalInputSize: number;

  /**
   * Maximum total output size in bytes
   */
  maxTotalOutputSize: number;

  /**
   * Transform timeout in milliseconds
   */
  transformTimeout: number;
}

/**
 * Regex for valid filenames (no path traversal)
 */
const VALID_FILENAME_REGEX = /^[a-zA-Z0-9_\-./]+\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;

/**
 * Map of TypeScript/JSX extensions to output JavaScript extensions
 */
const EXTENSION_MAP: Record<string, string> = {
  '.ts': '.js',
  '.tsx': '.js',
  '.jsx': '.js',
  '.mts': '.mjs',
  '.cts': '.cjs',
};

/**
 * Validate a filename for security
 */
function validateFilename(filename: string): void {
  // Check for path traversal
  if (filename.includes('..')) {
    throw new Error(`Invalid filename "${filename}": path traversal not allowed`);
  }

  // Check for absolute paths
  if (filename.startsWith('/') || filename.startsWith('\\')) {
    throw new Error(`Invalid filename "${filename}": absolute paths not allowed`);
  }

  // Check against regex
  if (!VALID_FILENAME_REGEX.test(filename)) {
    throw new Error(
      `Invalid filename "${filename}": must match pattern (letters, numbers, _, -, /, .) with valid extension`,
    );
  }
}

/**
 * Get the output filename for a given input filename
 */
function getOutputFilename(inputFilename: string): string {
  for (const [inputExt, outputExt] of Object.entries(EXTENSION_MAP)) {
    if (inputFilename.endsWith(inputExt)) {
      return inputFilename.slice(0, -inputExt.length) + outputExt;
    }
  }
  // If no mapping, keep the same extension
  return inputFilename;
}

/**
 * Parse import sources from code to build dependency graph
 *
 * SECURITY: Uses a ReDoS-safe regex pattern. The pattern `[^'"]*` cannot
 * overlap with the following `['"]`, preventing polynomial backtracking.
 */
function extractImports(code: string): string[] {
  const imports: string[] = [];

  // Match import statements - safe pattern that avoids ReDoS
  // Uses [^'"]* which cannot overlap with the following quote character
  // Matches: import X from 'source', import { X } from "source", import 'source', etc.
  const importRegex = /import\b[^'"]*['"]([^'"]+)['"]/g;

  let match;
  while ((match = importRegex.exec(code)) !== null) {
    imports.push(match[1]);
  }

  // Also match dynamic imports: import('source')
  // Safe pattern - \s* and ['"] don't overlap (whitespace vs quotes)
  const dynamicImportRegex = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = dynamicImportRegex.exec(code)) !== null) {
    imports.push(match[1]);
  }

  return imports;
}

/**
 * Check if an import is a local import
 */
function isLocalImport(source: string): boolean {
  return source.startsWith('./') || source.startsWith('../');
}

/**
 * Resolve a local import to a filename in the file set
 */
function resolveLocalImport(importSource: string, fromFilename: string, availableFiles: Set<string>): string | null {
  // Remove leading ./
  let relativePath = importSource;
  if (relativePath.startsWith('./')) {
    relativePath = relativePath.slice(2);
  }

  // Handle ../ by going up from the current file's directory
  const fromDir = fromFilename.includes('/') ? fromFilename.split('/').slice(0, -1).join('/') : '';

  if (relativePath.startsWith('../')) {
    // Simple resolution - just resolve relative paths
    const parts = fromDir.split('/').filter(Boolean);
    const importParts = relativePath.split('/');

    for (const part of importParts) {
      if (part === '..') {
        if (parts.length > 0) {
          parts.pop();
        }
      } else if (part !== '.') {
        parts.push(part);
      }
    }
    relativePath = parts.join('/');
  } else if (fromDir) {
    // Prepend the directory
    relativePath = `${fromDir}/${relativePath}`;
  }

  // Try to find matching file with various extensions
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', ''];

  for (const ext of extensions) {
    const candidate = relativePath + ext;
    if (availableFiles.has(candidate)) {
      return candidate;
    }
    // Also try index files
    const indexCandidate = relativePath + '/index' + ext;
    if (availableFiles.has(indexCandidate)) {
      return indexCandidate;
    }
  }

  // Direct match
  if (availableFiles.has(relativePath)) {
    return relativePath;
  }

  return null;
}

/**
 * Determine the output extension for a given source extension.
 * If no extension, defaults to .js
 */
function getOutputExtension(sourceExt: string): string {
  if (sourceExt in EXTENSION_MAP) {
    return EXTENSION_MAP[sourceExt];
  }
  // Keep existing extension if it's already a JS extension, otherwise default to .js
  const jsExtensions = ['.js', '.mjs', '.cjs'];
  return jsExtensions.includes(sourceExt) ? sourceExt : '.js';
}

/**
 * Update local import paths in the output code
 */
function updateLocalImportPaths(code: string, _fileMap: Map<string, string>): string {
  // Replace import sources with updated extensions
  return code.replace(
    /(import\s+(?:(?:\{[^}]*\}|[\w*\s,]+)\s+from\s+)?['"])([^'"]+)(['"])/g,
    (match, prefix, source, suffix) => {
      if (isLocalImport(source)) {
        // Update extension in local imports
        for (const [inputExt, outputExt] of Object.entries(EXTENSION_MAP)) {
          if (source.endsWith(inputExt)) {
            return prefix + source.slice(0, -inputExt.length) + outputExt + suffix;
          }
        }
        // If no extension, add .js (most common case for extensionless imports)
        if (!source.match(/\.[a-z]+$/i)) {
          return prefix + source + '.js' + suffix;
        }
      }
      return match;
    },
  );
}

/**
 * Topological sort of files based on dependencies
 * Returns files in order where dependencies come before dependents
 */
function topologicalSort(
  files: string[],
  getDependencies: (filename: string) => string[],
): { sorted: string[]; cycles: string[][] } {
  const sorted: string[] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const cycles: string[][] = [];

  function visit(file: string, path: string[]): void {
    if (inStack.has(file)) {
      // Found a cycle
      const cycleStart = path.indexOf(file);
      cycles.push(path.slice(cycleStart).concat(file));
      return;
    }

    if (visited.has(file)) {
      return;
    }

    visited.add(file);
    inStack.add(file);

    const deps = getDependencies(file);
    for (const dep of deps) {
      visit(dep, [...path, file]);
    }

    inStack.delete(file);
    sorted.push(file);
  }

  for (const file of files) {
    visit(file, []);
  }

  return { sorted, cycles };
}

/**
 * Transform multiple files with Babel
 *
 * @param files - Map of filename to source code
 * @param options - Transform options
 * @param limits - Security limits for multi-file transform
 * @param singleFileTransform - Function to transform a single file
 * @returns Transformed files, dependencies, and warnings
 *
 * @example
 * ```typescript
 * const result = transformMultiple(
 *   {
 *     'theme.ts': 'export const theme = { primary: "#007bff" };',
 *     'App.tsx': 'import { theme } from "./theme"; const App = () => <div style={{color: theme.primary}}>Hello</div>;'
 *   },
 *   {
 *     presets: ['typescript', 'react'],
 *     importRewrite: {
 *       enabled: true,
 *       cdnBaseUrl: 'https://esm.agentfront.dev',
 *       packageVersions: { 'react': '18.2.0' }
 *     }
 *   },
 *   { maxFiles: 25, maxTotalInputSize: 5 * 1024 * 1024, maxTotalOutputSize: 25 * 1024 * 1024 },
 *   (code, opts) => ({ code: compiledCode })
 * );
 * ```
 */
export function transformMultiple(
  files: MultiFileInput,
  options: MultiFileTransformOptions,
  limits: MultiFileLimits,
  singleFileTransform: (code: string, options: SafeTransformOptions) => SafeTransformResult,
): MultiFileTransformResult {
  const warnings: string[] = [];
  const outputFiles: { [filename: string]: string } = {};
  const dependencies: { [filename: string]: string[] } = {};
  const allRewrittenImports: Array<{ original: string; rewritten: string }> = [];

  // 1. Validate file count
  const filenames = Object.keys(files);
  if (filenames.length === 0) {
    throw new Error('No files provided');
  }
  if (filenames.length > limits.maxFiles) {
    throw new Error(`Too many files: ${filenames.length} > ${limits.maxFiles} (max for this security level)`);
  }

  // 2. Validate filenames and calculate total input size
  let totalInputSize = 0;
  for (const filename of filenames) {
    validateFilename(filename);

    const code = files[filename];
    if (typeof code !== 'string') {
      throw new Error(`Invalid content for file "${filename}": must be a string`);
    }

    totalInputSize += Buffer.byteLength(code, 'utf-8');
  }

  if (totalInputSize > limits.maxTotalInputSize) {
    throw new Error(`Total input size exceeds limit: ${totalInputSize} bytes > ${limits.maxTotalInputSize} bytes`);
  }

  // 3. Build dependency graph
  const fileSet = new Set(filenames);
  const resolveLocalImports = options.resolveLocalImports !== false;

  for (const filename of filenames) {
    const code = files[filename];
    const imports = extractImports(code);
    const localDeps: string[] = [];

    for (const importSource of imports) {
      if (isLocalImport(importSource)) {
        const resolved = resolveLocalImport(importSource, filename, fileSet);
        if (resolved) {
          localDeps.push(resolved);
        } else if (resolveLocalImports) {
          warnings.push(`Unresolved import "${importSource}" in ${filename}`);
        }
      }
    }

    dependencies[filename] = localDeps;
  }

  // 4. Topological sort
  const { sorted, cycles } = topologicalSort(filenames, (f) => dependencies[f] || []);

  if (cycles.length > 0) {
    // Circular dependencies are allowed but warned
    for (const cycle of cycles) {
      warnings.push(`Circular dependency detected: ${cycle.join(' -> ')}`);
    }
  }

  // 5. Transform each file in order
  let totalOutputSize = 0;
  const filenameToOutputFilename = new Map<string, string>();

  for (const filename of sorted) {
    const inputCode = files[filename];
    const outputFilename = getOutputFilename(filename);
    filenameToOutputFilename.set(filename, outputFilename);

    try {
      // First, apply Babel transform
      // Note: We don't pass importRewrite to single file transform because
      // we handle it at the multi-file level after all files are transformed
      const { importRewrite: _, ...singleFileOptions } = options;
      const transformResult = singleFileTransform(inputCode, {
        ...singleFileOptions,
        filename,
      });

      let transformedCode = transformResult.code;

      // Then, update local import paths
      transformedCode = updateLocalImportPaths(transformedCode, filenameToOutputFilename);

      // Finally, apply import rewriting if configured
      if (options.importRewrite?.enabled) {
        const rewriteResult = rewriteImports(transformedCode, options.importRewrite);
        transformedCode = rewriteResult.code;

        // Collect rewritten imports
        for (const rewritten of rewriteResult.rewrittenImports) {
          // Avoid duplicates
          if (!allRewrittenImports.some((r) => r.original === rewritten.original)) {
            allRewrittenImports.push(rewritten);
          }
        }
      }

      // Track output size
      const outputSize = Buffer.byteLength(transformedCode, 'utf-8');
      totalOutputSize += outputSize;

      if (totalOutputSize > limits.maxTotalOutputSize) {
        throw new Error(
          `Total output size exceeds limit: ${totalOutputSize} bytes > ${limits.maxTotalOutputSize} bytes`,
        );
      }

      outputFiles[outputFilename] = transformedCode;
    } catch (error) {
      throw new Error(`Failed to transform "${filename}": ${(error as Error).message}`);
    }
  }

  return {
    files: outputFiles,
    dependencies,
    warnings,
    rewrittenImports: allRewrittenImports.length > 0 ? allRewrittenImports : undefined,
  };
}
