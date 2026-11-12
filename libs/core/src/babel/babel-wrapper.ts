/**
 * Babel Wrapper for Enclave
 *
 * Provides a restricted Babel.transform() API for use inside the enclave sandbox.
 * Uses @babel/standalone for browser-compatible transformation.
 *
 * SECURITY: where Babel runs, and what restricts it.
 *
 * `@babel/standalone` is loaded into the host realm and runs there, with the host's intrinsics
 * and the host's authority, like any other function a host puts in `globals`. It is called from
 * a separate VM context, and what that context provides is a timeout for the call: a function
 * runs in the realm it was created in, whichever context calls it, so the context is not an
 * isolation boundary and takes nothing away from Babel.
 *
 * What a script can make Babel do is restricted by what this wrapper passes on:
 * - the source text is data: Babel parses and prints it and never executes it
 * - presets are names from the security level's allowlist; plugins are always none
 * - no configuration files, no source maps, no AST in the result
 * - a sanitized file name, a size limit on the input and on the output, and the timeout
 * - the work the wrapper itself does on a script's text is linear in its size
 *
 * A defect in Babel's parser or in a preset would therefore be a defect in host code. A host
 * that needs Babel isolated from its process runs the enclave in a process of its own.
 *
 * @packageDocumentation
 */

import * as vm from 'vm';
import * as BabelStandalone from '@babel/standalone';
import { rewriteImports, type ImportRewriteConfig } from '@enclave-vm/ast';
import { removeStackLocations } from './text-scan';

/**
 * Safe transform options that can be passed by sandbox code
 */
export interface SafeTransformOptions {
  /**
   * Filename for error messages (no path traversal allowed)
   */
  filename?: string;

  /**
   * Presets to use (must be in allowed list)
   */
  presets?: string[];

  /**
   * Source type for parsing
   */
  sourceType?: 'module' | 'script';

  /**
   * Import rewrite configuration for transforming npm imports to CDN URLs
   */
  importRewrite?: ImportRewriteConfig;
}

/**
 * Safe transform result (only code, no AST or source maps)
 */
export interface SafeTransformResult {
  /**
   * The transformed code
   */
  code: string;
}

/**
 * Configuration for the Babel wrapper
 * These values come from security level via getBabelConfig()
 */
export interface BabelWrapperConfig {
  /**
   * Maximum input code size in bytes
   */
  maxInputSize: number;

  /**
   * Maximum output code size in bytes
   */
  maxOutputSize: number;

  /**
   * Allowed preset names
   */
  allowedPresets: string[];

  /**
   * Transform timeout in milliseconds
   */
  transformTimeout: number;
}

/**
 * Sanitize filename to prevent path traversal attacks
 */
function sanitizeFilename(filename: string): string {
  // Remove any path separators and parent directory references
  const sanitized = filename
    .replace(/\.\./g, '') // Remove parent directory references
    .replace(/[/\\]/g, '') // Remove path separators
    .replace(/[<>:"|?*]/g, '') // Remove invalid filename chars
    .slice(0, 255); // Limit length

  return sanitized || 'input.tsx';
}

/**
 * Longest error text of a failed transform that is cleaned and passed on. Babel quotes the
 * source around a syntax error in its message, so the message can be as long as the source; a
 * script gets the diagnosis, not a copy of its text.
 */
const MAX_ERROR_MESSAGE_LENGTH = 2000;

/**
 * The message of a failed transform without host paths, stack locations and VM internals.
 * The text is cut to `MAX_ERROR_MESSAGE_LENGTH` before anything is applied to it and again
 * afterwards, and each step is linear in its length.
 */
function sanitizeTransformErrorMessage(message: unknown): string {
  const text = typeof message === 'string' && message.length > 0 ? message : 'Unknown transform error';
  const truncated = text.length > MAX_ERROR_MESSAGE_LENGTH;
  const bounded = truncated ? text.slice(0, MAX_ERROR_MESSAGE_LENGTH) : text;

  const sanitized = removeStackLocations(bounded.replace(/\/[^\s:]+/g, '<path>')) // Remove file paths, stack locations
    .replace(/evalmachine\.<anonymous>/g, '<transform>') // Remove VM internals
    .trim();

  return sanitized.length > MAX_ERROR_MESSAGE_LENGTH || truncated
    ? sanitized.slice(0, MAX_ERROR_MESSAGE_LENGTH) + '...'
    : sanitized;
}

/**
 * Create the VM context Babel transforms are called from
 *
 * The context exists so that a transform can be given a timeout (see the header of this file).
 * The only code that ever runs in it is the one-line script that calls the host's Babel; Babel
 * itself uses the host's globals, not the ones defined here, so nothing below restricts it.
 */
function createIsolatedBabelContext(): vm.Context {
  // Create a fresh context with minimal globals
  const context = vm.createContext(
    {},
    {
      // Disable code generation from strings (extra safety)
      codeGeneration: {
        strings: false,
        wasm: false,
      },
    },
  );

  // Globals of the calling context. They are the host's own objects, and the calling script
  // does not use them: they are not what Babel works with (Babel has the host's globals).
  const safeGlobals = {
    // Core JavaScript types
    Object,
    Array,
    String,
    Number,
    Boolean,
    Symbol,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Date,
    RegExp,
    Error,
    TypeError,
    SyntaxError,
    RangeError,
    ReferenceError,

    // Math and JSON (pure functions, no I/O)
    Math,
    JSON,

    // Essential functions
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURI,
    decodeURI,
    encodeURIComponent,
    decodeURIComponent,

    // Primitives
    undefined,
    NaN,
    Infinity,

    // Console for debugging (optional, could be removed for stricter security)
    // Intentionally empty - these are no-op stubs to prevent errors in sandbox code
    console: {
      log: () => {
        /* intentionally empty - no-op stub for sandbox */
      },
      warn: () => {
        /* intentionally empty - no-op stub for sandbox */
      },
      error: () => {
        /* intentionally empty - no-op stub for sandbox */
      },
      info: () => {
        /* intentionally empty - no-op stub for sandbox */
      },
    },
  };

  // Add safe globals to context
  for (const [key, value] of Object.entries(safeGlobals)) {
    Object.defineProperty(context, key, {
      value,
      writable: false,
      configurable: false,
      enumerable: true,
    });
  }

  // Names of Node.js and browser APIs, defined as undefined in the calling context. This keeps
  // the calling script from naming them; it does not affect Babel, which is host code.
  const blockedGlobals = [
    // Node.js core
    'process',
    'global',
    'globalThis',
    'Buffer',
    'require',
    'module',
    'exports',
    '__dirname',
    '__filename',

    // File system
    'fs',
    'path',

    // Network
    'http',
    'https',
    'net',
    'dgram',
    'dns',
    'tls',

    // Process management
    'child_process',
    'cluster',
    'worker_threads',

    // Other dangerous APIs
    'vm', // Prevent nested VM escape
    'eval',
    'Function',
    'Proxy',
    'Reflect',

    // Browser APIs that shouldn't exist in Node but block anyway
    'fetch',
    'XMLHttpRequest',
    'WebSocket',
    'localStorage',
    'sessionStorage',
    'indexedDB',
  ];

  for (const name of blockedGlobals) {
    try {
      Object.defineProperty(context, name, {
        value: undefined,
        writable: false,
        configurable: false,
        enumerable: false,
      });
    } catch {
      // Ignore if we can't define it
    }
  }

  return context;
}

// The calling context and the Babel entry point, created once and shared by every Enclave of
// the process
let isolatedContext: vm.Context | null = null;
let babelInContext: { transform: (code: string, options: unknown) => { code: string } } | null = null;

/**
 * Get or create the context Babel is called from
 */
function getIsolatedBabel(): { transform: (code: string, options: unknown) => { code: string } } {
  if (babelInContext) {
    return babelInContext;
  }

  // Create the calling context
  isolatedContext = createIsolatedBabelContext();

  // Make the host's Babel callable from that context. This is the host function itself: it
  // is not copied or re-evaluated there, and it runs in the host realm when called.
  Object.defineProperty(isolatedContext, '__babel_transform__', {
    value: BabelStandalone.transform.bind(BabelStandalone),
    writable: false,
    configurable: false,
    enumerable: false,
  });

  // Create a script that returns the transform function
  const wrapperScript = new vm.Script(`
    (function() {
      var transform = __babel_transform__;
      return {
        transform: function(code, options) {
          return transform(code, options);
        }
      };
    })()
  `);

  // Run the script in the calling context
  babelInContext = wrapperScript.runInContext(isolatedContext) as {
    transform: (code: string, options: unknown) => { code: string };
  };

  return babelInContext;
}

/**
 * Create a restricted Babel object for sandbox use
 *
 * SECURITY: Babel runs in the host realm (see the header of this file). A transform is
 * restricted by what this function passes to it and checks around it:
 * - the source is parsed and printed, never executed
 * - no plugins, no configuration files, no source maps, no AST output
 * - Timeout enforcement
 * - Input/output size limits
 * - Preset whitelist
 *
 * @param config - Configuration from security level
 * @returns Restricted Babel object with transform() method
 *
 * @example
 * ```typescript
 * const babel = createRestrictedBabel({
 *   maxInputSize: 1024 * 1024,
 *   maxOutputSize: 5 * 1024 * 1024,
 *   allowedPresets: ['typescript', 'react'],
 *   transformTimeout: 15000,
 * });
 *
 * const result = babel.transform(tsxCode, {
 *   filename: 'App.tsx',
 *   presets: ['typescript', 'react'],
 * });
 *
 * console.log(result.code);
 * ```
 */
export function createRestrictedBabel(config: BabelWrapperConfig): {
  transform: (code: string, options?: SafeTransformOptions) => SafeTransformResult;
} {
  const allowedPresets = new Set(config.allowedPresets);

  return {
    transform(code: string, options?: SafeTransformOptions): SafeTransformResult {
      // 1. Validate input code type
      if (typeof code !== 'string') {
        throw new TypeError('Code must be a string');
      }

      // 2. Check for null bytes (potential injection)
      if (code.includes('\0')) {
        throw new Error('Code contains invalid null bytes');
      }

      // 3. Validate input size
      const inputBytes = Buffer.byteLength(code, 'utf-8');
      if (inputBytes > config.maxInputSize) {
        throw new Error(
          `Code exceeds maximum size (${inputBytes} bytes > ${config.maxInputSize} bytes). ` +
            `Reduce input size or use a higher security level.`,
        );
      }

      // 4. Validate and filter presets against security-level allowlist
      const requestedPresets = options?.presets ?? [];

      if (!Array.isArray(requestedPresets)) {
        throw new TypeError('Presets must be an array');
      }

      for (const preset of requestedPresets) {
        if (typeof preset !== 'string') {
          throw new TypeError('Each preset must be a string');
        }
        if (!allowedPresets.has(preset)) {
          throw new Error(
            `Preset "${preset}" is not allowed at this security level. ` +
              `Allowed presets: ${[...allowedPresets].join(', ')}`,
          );
        }
      }

      // 5. Sanitize filename
      const filename = sanitizeFilename(options?.filename ?? 'input.tsx');

      // 6. Validate sourceType
      const sourceType = options?.sourceType ?? 'module';
      if (sourceType !== 'module' && sourceType !== 'script') {
        throw new Error('sourceType must be "module" or "script"');
      }

      // 7. Build safe options - explicitly disable dangerous features
      const safeOptions = {
        filename,
        presets: requestedPresets,
        sourceType,
        // Security: Explicitly disable dangerous options
        plugins: [], // NO plugins allowed - they execute arbitrary code
        sourceMaps: false, // No source maps (path leakage risk)
        ast: false, // No AST output
        code: true, // Only code output
        // Disable other potentially dangerous options
        inputSourceMap: undefined,
        sourceFileName: undefined,
        sourceRoot: undefined,
        babelrc: false, // Don't load .babelrc files
        configFile: false, // Don't load babel.config.js
      };

      // 8. Call the transform from the separate context, which gives the call a timeout
      let result: { code: string };
      try {
        // Ensure the calling context is initialized
        getIsolatedBabel();

        // Create a script that calls transform with our options
        // The script runs in the calling context; the transform it calls runs in the host realm
        const transformScript = new vm.Script(`
          __babel_result__ = __babel_transform__(__babel_code__, __babel_options__);
        `);

        // Hand the code and options to the calling context
        Object.defineProperty(isolatedContext!, '__babel_code__', {
          value: code,
          writable: true,
          configurable: true,
          enumerable: false,
        });
        Object.defineProperty(isolatedContext!, '__babel_options__', {
          value: safeOptions,
          writable: true,
          configurable: true,
          enumerable: false,
        });
        Object.defineProperty(isolatedContext!, '__babel_result__', {
          value: null,
          writable: true,
          configurable: true,
          enumerable: false,
        });

        // Run with timeout
        transformScript.runInContext(isolatedContext!, {
          timeout: config.transformTimeout,
        });

        // Get the result
        result = (isolatedContext as Record<string, unknown>)['__babel_result__'] as { code: string };
      } catch (error) {
        const message = (error as { message?: unknown } | null)?.message;

        // Check for timeout
        if (typeof message === 'string' && message.includes('Script execution timed out')) {
          throw new Error(
            `Babel transform timed out after ${config.transformTimeout}ms. ` +
              `The code may be too complex or contain infinite loops.`,
          );
        }

        // Re-throw with sanitized message (remove file paths)
        throw new Error(`Babel transform failed: ${sanitizeTransformErrorMessage(message)}`);
      } finally {
        // Clean up temporary variables, also after a failed transform: the context is shared,
        // and the source text of one call is not kept on it for the next
        if (isolatedContext) {
          delete (isolatedContext as Record<string, unknown>)['__babel_code__'];
          delete (isolatedContext as Record<string, unknown>)['__babel_options__'];
          delete (isolatedContext as Record<string, unknown>)['__babel_result__'];
        }
      }

      // 9. Validate output
      let outputCode = result?.code ?? '';

      if (typeof outputCode !== 'string') {
        throw new Error('Transform produced invalid output');
      }

      // 10. Apply import rewriting if configured. The output limit holds for the text the
      // rewrite is about to read, not only for the text it produces.
      if (options?.importRewrite?.enabled) {
        const transformedBytes = Buffer.byteLength(outputCode, 'utf-8');
        if (transformedBytes > config.maxOutputSize) {
          throw new Error(
            `Output exceeds maximum size (${transformedBytes} bytes > ${config.maxOutputSize} bytes). ` +
              `The transformed code is too large.`,
          );
        }

        try {
          const rewriteResult = rewriteImports(outputCode, options.importRewrite);
          outputCode = rewriteResult.code;
        } catch (rewriteError) {
          throw new Error(`Import rewrite failed: ${(rewriteError as Error).message}`);
        }
      }

      // 11. Check output size
      const outputBytes = Buffer.byteLength(outputCode, 'utf-8');
      if (outputBytes > config.maxOutputSize) {
        throw new Error(
          `Output exceeds maximum size (${outputBytes} bytes > ${config.maxOutputSize} bytes). ` +
            `The transformed code is too large.`,
        );
      }

      // 12. Return only the code (not AST, not source map, not metadata)
      return { code: outputCode };
    },
  };
}

/**
 * Get available presets in @babel/standalone
 *
 * This is useful for documentation and validation.
 * Note: Not all presets are allowed in the enclave - see BABEL_SECURITY_CONFIGS.
 */
export function getAvailableBabelPresets(): string[] {
  return ['env', 'react', 'typescript', 'flow'];
}

/**
 * Reset the context Babel is called from
 *
 * Useful for testing or if you want to ensure a fresh context.
 * Note: This is generally not needed as the context is reused for performance.
 */
export function resetBabelContext(): void {
  isolatedContext = null;
  babelInContext = null;
}
