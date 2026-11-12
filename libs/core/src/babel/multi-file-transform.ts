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
 * - The file set is a script's: besides Babel itself (which has its own timeout), everything
 *   done here with a file's text or name takes time linear in the size of the input, and the
 *   text is measured against the limits before it is worked on (see ./text-scan)
 *
 * @packageDocumentation
 */

import { rewriteImports, type ImportRewriteConfig } from '@enclave-vm/ast';
import type { SafeTransformOptions, SafeTransformResult } from './babel-wrapper';
import { findImportSources, hasFileExtension, mapStaticImportSources } from './text-scan';

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
 * Longest file name accepted. The size limits count the text of the files, not their names, and
 * a name is repeated in the dependency report and in warnings; with this bound the size of both
 * follows from the limits on the text.
 */
const MAX_FILENAME_LENGTH = 255;

/**
 * Validate a filename for security
 */
function validateFilename(filename: string): void {
  if (filename.length > MAX_FILENAME_LENGTH) {
    throw new Error(`Invalid filename "${filename.slice(0, 32)}...": longer than ${MAX_FILENAME_LENGTH} characters`);
  }

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
 * Check if an import is a local import
 */
function isLocalImport(source: string): boolean {
  return source.startsWith('./') || source.startsWith('../');
}

/**
 * Extensions tried for a local import, in this order; the last entry is the path as written
 */
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', ''];

/**
 * The files of the set that are below a directory, by their path relative to it ('' is the root
 * of the set: every file, by its name).
 */
function filesBelow(directory: string, availableFiles: ReadonlySet<string>): Map<string, string> {
  const below = new Map<string, string>();
  for (const file of availableFiles) {
    if (directory === '') {
      below.set(file, file);
    } else if (
      file.length > directory.length &&
      file.charCodeAt(directory.length) === 47 /* '/' */ &&
      file.startsWith(directory)
    ) {
      below.set(file.slice(directory.length + 1), file);
    }
  }
  return below;
}

/**
 * The file a path names among `files`: the path with one of the known extensions, or an index
 * file in a directory of that name.
 */
function findFile(files: ReadonlyMap<string, string>, path: string): string | null {
  for (const ext of RESOLVE_EXTENSIONS) {
    const direct = files.get(path + ext);
    if (direct !== undefined) {
      return direct;
    }
    const index = files.get(path + '/index' + ext);
    if (index !== undefined) {
      return index;
    }
  }
  return null;
}

/**
 * Resolution of the local imports of one file to filenames in the file set
 *
 * A file can hold as many imports as its size allows, so resolving one import takes time that
 * follows from the length of that import alone: the name of the importing file is taken apart
 * once, and the files below each directory an import can start from are listed once (see
 * `filesBelow`) and then looked up by the rest of the import's path.
 */
function createLocalImportResolver(
  fromFilename: string,
  availableFiles: ReadonlySet<string>,
): (importSource: string) => string | null {
  const lastSlash = fromFilename.lastIndexOf('/');
  const fromDir = lastSlash === -1 ? '' : fromFilename.slice(0, lastSlash);
  const dirParts = fromDir.split('/').filter(Boolean);

  // Files below the importing file's own directory
  let belowDir: Map<string, string> | undefined;
  // By the number of leading segments of that directory an import keeps after its `..` steps:
  // the files below that ancestor, and the file the ancestor's own path names
  const belowAncestor: Array<Map<string, string> | undefined> = [];
  const ancestorItself: Array<string | null | undefined> = [];

  return (importSource: string): string | null => {
    // Remove leading ./
    const relativePath = importSource.startsWith('./') ? importSource.slice(2) : importSource;

    if (!relativePath.startsWith('../')) {
      belowDir ??= filesBelow(fromDir, availableFiles);
      return findFile(belowDir, relativePath);
    }

    // Go up from the importing file's directory: `kept` leading segments of it remain, followed
    // by the segments the import adds
    let kept = dirParts.length;
    const added: string[] = [];
    for (const part of relativePath.split('/')) {
      if (part === '..') {
        if (added.length > 0) {
          added.pop();
        } else if (kept > 0) {
          kept--;
        }
      } else if (part !== '.') {
        added.push(part);
      }
    }

    const ancestor = (): string => dirParts.slice(0, kept).join('/');

    if (added.length === 0 && kept > 0) {
      // The import names an ancestor directory itself
      let resolved = ancestorItself[kept];
      if (resolved === undefined) {
        resolved = findFile(filesBelow('', availableFiles), ancestor());
        ancestorItself[kept] = resolved;
      }
      return resolved;
    }

    let below = belowAncestor[kept];
    if (below === undefined) {
      below = filesBelow(ancestor(), availableFiles);
      belowAncestor[kept] = below;
    }
    return findFile(below, added.join('/'));
  };
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
 * The specifier a local import has in the output: the extension of the output file instead of
 * the source file's, and `.js` where the import names no extension. Other specifiers are returned
 * as they are.
 */
function outputImportSource(source: string): string {
  if (isLocalImport(source)) {
    // Update extension in local imports
    for (const [inputExt, outputExt] of Object.entries(EXTENSION_MAP)) {
      if (source.endsWith(inputExt)) {
        return source.slice(0, -inputExt.length) + outputExt;
      }
    }
    // If no extension, add .js (most common case for extensionless imports)
    if (!hasFileExtension(source)) {
      return source + '.js';
    }
  }
  return source;
}

/**
 * Update local import paths in the output code
 */
function updateLocalImportPaths(code: string): string {
  return mapStaticImportSources(code, outputImportSource);
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
    const pathToDeps = [...path, file];
    for (const dep of deps) {
      visit(dep, pathToDeps);
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
  const rewrittenOriginals = new Set<string>();

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
    const imports = findImportSources(code);
    const resolveLocalImport = createLocalImportResolver(filename, fileSet);
    // A file is a dependency once, however many of the imports name it: the report and the
    // warnings about cycles then follow from the number of files, not from the number of imports
    const localDeps = new Set<string>();

    for (const importSource of imports) {
      if (isLocalImport(importSource)) {
        const resolved = resolveLocalImport(importSource);
        if (resolved) {
          localDeps.add(resolved);
        } else if (resolveLocalImports) {
          warnings.push(`Unresolved import "${importSource}" in ${filename}`);
        }
      }
    }

    dependencies[filename] = [...localDeps];
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

  for (const filename of sorted) {
    const inputCode = files[filename];
    const outputFilename = getOutputFilename(filename);

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

      if (typeof transformedCode !== 'string') {
        throw new Error('Transform produced invalid output');
      }

      // The output limit holds for the text the steps below are about to read, not only for
      // the text they produce
      const transformedSize = Buffer.byteLength(transformedCode, 'utf-8');
      if (totalOutputSize + transformedSize > limits.maxTotalOutputSize) {
        throw new Error(
          `Total output size exceeds limit: ${totalOutputSize + transformedSize} bytes > ${limits.maxTotalOutputSize} bytes`,
        );
      }

      // Then, update local import paths
      transformedCode = updateLocalImportPaths(transformedCode);

      // Finally, apply import rewriting if configured
      if (options.importRewrite?.enabled) {
        const rewriteResult = rewriteImports(transformedCode, options.importRewrite);
        transformedCode = rewriteResult.code;

        // Collect rewritten imports
        for (const rewritten of rewriteResult.rewrittenImports) {
          // Avoid duplicates
          if (!rewrittenOriginals.has(rewritten.original)) {
            rewrittenOriginals.add(rewritten.original);
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
