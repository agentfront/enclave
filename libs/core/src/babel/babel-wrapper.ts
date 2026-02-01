/**
 * Babel Wrapper for Enclave
 *
 * Provides a restricted Babel.transform() API for use inside the enclave sandbox.
 * Uses @babel/standalone for browser-compatible transformation.
 *
 * SECURITY: Babel transforms run in an isolated VM context with NO access to:
 * - File system (fs, path)
 * - Process/environment (process, env)
 * - Network (http, https, net)
 * - Child processes (child_process)
 * - Module loading (require, import)
 *
 * Only pure JavaScript transformation is allowed.
 *
 * @packageDocumentation
 */

import * as vm from 'vm';
import * as BabelStandalone from '@babel/standalone';
import { rewriteImports, type ImportRewriteConfig } from '@enclave-vm/ast';

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
 * Create an isolated VM context for Babel transforms
 *
 * SECURITY: This context has NO access to Node.js APIs.
 * Only safe JavaScript globals are provided.
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

  // Inject ONLY the safe globals needed for Babel to work
  // These are pure JavaScript APIs with no I/O capabilities
  const safeGlobals = {
    // Core JavaScript types (needed for Babel's internal operations)
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

  // EXPLICITLY BLOCK dangerous Node.js globals by setting them to undefined
  // This prevents any accidental access even if @babel/standalone tries
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

// Cache the isolated context and Babel instance for performance
let isolatedContext: vm.Context | null = null;
let babelInContext: { transform: (code: string, options: unknown) => { code: string } } | null = null;

/**
 * Get or create the isolated Babel context
 */
function getIsolatedBabel(): { transform: (code: string, options: unknown) => { code: string } } {
  if (babelInContext) {
    return babelInContext;
  }

  // Create isolated context
  isolatedContext = createIsolatedBabelContext();

  // Inject Babel into the isolated context
  // We serialize the Babel transform function and create a wrapper
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

  // Run the script in the isolated context
  babelInContext = wrapperScript.runInContext(isolatedContext) as {
    transform: (code: string, options: unknown) => { code: string };
  };

  return babelInContext;
}

/**
 * Create a restricted Babel object for sandbox use
 *
 * SECURITY: All transforms run in an isolated VM context with:
 * - NO access to fs, process, require, or any Node.js APIs
 * - NO access to network APIs
 * - NO ability to load external code
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

      // 8. Execute the transform in isolated context with timeout
      let result: { code: string };
      try {
        // Ensure the isolated context is initialized
        getIsolatedBabel();

        // Create a script that calls transform with our options
        // This runs in the isolated context with timeout
        const transformScript = new vm.Script(`
          __babel_result__ = __babel_transform__(__babel_code__, __babel_options__);
        `);

        // Inject the code and options into the isolated context
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

        // Clean up temporary variables
        delete (isolatedContext as Record<string, unknown>)['__babel_code__'];
        delete (isolatedContext as Record<string, unknown>)['__babel_options__'];
        delete (isolatedContext as Record<string, unknown>)['__babel_result__'];
      } catch (error) {
        // Re-throw with sanitized message (remove file paths)
        const err = error as Error;
        const sanitizedMessage = (err.message || 'Unknown transform error')
          .replace(/\/[^\s:]+/g, '<path>') // Remove file paths
          .replace(/at\s+[^\s]+\s+\([^)]+\)/g, '') // Remove stack locations
          .replace(/evalmachine\.<anonymous>/g, '<transform>') // Remove VM internals
          .trim();

        // Check for timeout
        if (err.message?.includes('Script execution timed out')) {
          throw new Error(
            `Babel transform timed out after ${config.transformTimeout}ms. ` +
              `The code may be too complex or contain infinite loops.`,
          );
        }

        throw new Error(`Babel transform failed: ${sanitizedMessage}`);
      }

      // 9. Validate output
      let outputCode = result?.code ?? '';

      if (typeof outputCode !== 'string') {
        throw new Error('Transform produced invalid output');
      }

      // 10. Apply import rewriting if configured
      if (options?.importRewrite?.enabled) {
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
 * Reset the isolated Babel context
 *
 * Useful for testing or if you want to ensure a fresh context.
 * Note: This is generally not needed as the context is reused for performance.
 */
export function resetBabelContext(): void {
  isolatedContext = null;
  babelInContext = null;
}
