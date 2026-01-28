/**
 * Babel Preset for Enclave
 *
 * Extends the AgentScript preset with Babel.transform() support.
 * Security limits are determined by the security level.
 *
 * @packageDocumentation
 */

import { ValidationRule } from '../interfaces';
import { createAgentScriptPreset, AgentScriptOptions, SecurityLevel } from './agentscript.preset';

/**
 * Babel configuration per security level
 *
 * These limits control resource usage for Babel transforms:
 * - maxInputSize: Maximum source code size to transform
 * - maxOutputSize: Maximum transformed output size
 * - transformTimeout: Maximum time for transformation (reserved)
 * - allowedPresets: Which Babel presets can be used
 * - Multi-file limits (maxFiles, maxTotalInputSize, maxTotalOutputSize)
 */
export interface BabelSecurityConfig {
  /**
   * Maximum input code size in bytes (single file)
   */
  maxInputSize: number;

  /**
   * Maximum output code size in bytes (single file)
   */
  maxOutputSize: number;

  /**
   * Transform timeout in milliseconds
   */
  transformTimeout: number;

  /**
   * Allowed Babel preset names
   */
  allowedPresets: string[];

  /**
   * Maximum number of files for multi-file transform
   */
  maxFiles: number;

  /**
   * Maximum total input size across all files (bytes)
   */
  maxTotalInputSize: number;

  /**
   * Maximum total output size across all files (bytes)
   */
  maxTotalOutputSize: number;
}

/**
 * Babel security configurations per security level
 *
 * STRICT: Minimal - only JSX transformation (react preset)
 * SECURE: Standard - TypeScript + React
 * STANDARD: Standard - TypeScript + React
 * PERMISSIVE: Extended - TypeScript + React + env
 *
 * Multi-file limits per level:
 * | Level      | Max Files | Max Total Input | Max Total Output |
 * |------------|-----------|-----------------|------------------|
 * | STRICT     | 3         | 200 KB          | 1 MB             |
 * | SECURE     | 10        | 1 MB            | 5 MB             |
 * | STANDARD   | 25        | 5 MB            | 25 MB            |
 * | PERMISSIVE | 100       | 25 MB           | 125 MB           |
 */
export const BABEL_SECURITY_CONFIGS: Record<SecurityLevel, BabelSecurityConfig> = {
  /**
   * STRICT: Minimal Babel access
   * - Small input limit (100KB)
   * - Only react preset (JSX transformation)
   * - No TypeScript (reduces attack surface)
   * - Max 3 files for multi-file transform
   */
  STRICT: {
    maxInputSize: 100 * 1024, // 100KB
    maxOutputSize: 500 * 1024, // 500KB
    transformTimeout: 5000, // 5s
    allowedPresets: ['react'], // Minimal - JSX only
    maxFiles: 3,
    maxTotalInputSize: 200 * 1024, // 200KB
    maxTotalOutputSize: 1024 * 1024, // 1MB
  },

  /**
   * SECURE: Standard Babel access
   * - Medium input limit (500KB)
   * - TypeScript + React presets
   * - Max 10 files for multi-file transform
   */
  SECURE: {
    maxInputSize: 500 * 1024, // 500KB
    maxOutputSize: 2 * 1024 * 1024, // 2MB
    transformTimeout: 10000, // 10s
    allowedPresets: ['typescript', 'react'],
    maxFiles: 10,
    maxTotalInputSize: 1024 * 1024, // 1MB
    maxTotalOutputSize: 5 * 1024 * 1024, // 5MB
  },

  /**
   * STANDARD: Standard Babel access (same as SECURE)
   * - Medium input limit (1MB)
   * - TypeScript + React presets
   * - Max 25 files for multi-file transform
   */
  STANDARD: {
    maxInputSize: 1024 * 1024, // 1MB
    maxOutputSize: 5 * 1024 * 1024, // 5MB
    transformTimeout: 15000, // 15s
    allowedPresets: ['typescript', 'react'],
    maxFiles: 25,
    maxTotalInputSize: 5 * 1024 * 1024, // 5MB
    maxTotalOutputSize: 25 * 1024 * 1024, // 25MB
  },

  /**
   * PERMISSIVE: Extended Babel access
   * - Large input limit (5MB)
   * - TypeScript + React + env presets
   * - Max 100 files for multi-file transform
   */
  PERMISSIVE: {
    maxInputSize: 5 * 1024 * 1024, // 5MB
    maxOutputSize: 25 * 1024 * 1024, // 25MB
    transformTimeout: 30000, // 30s
    allowedPresets: ['typescript', 'react', 'env'],
    maxFiles: 100,
    maxTotalInputSize: 25 * 1024 * 1024, // 25MB
    maxTotalOutputSize: 125 * 1024 * 1024, // 125MB
  },
};

/**
 * Options for Babel preset
 *
 * Extends AgentScriptOptions with Babel-specific options.
 * The security level controls both AST validation and Babel limits.
 */
export type BabelPresetOptions = AgentScriptOptions;

/**
 * Get Babel configuration for a security level
 *
 * Use this to retrieve the Babel limits (input/output size, allowed presets)
 * for a given security level.
 *
 * @param securityLevel - The security level (default: STANDARD)
 * @returns Babel security configuration
 *
 * @example
 * ```typescript
 * import { getBabelConfig } from 'ast-guard';
 *
 * const config = getBabelConfig('SECURE');
 * console.log(config.allowedPresets); // ['typescript', 'react']
 * console.log(config.maxInputSize);   // 524288 (500KB)
 * ```
 */
export function getBabelConfig(securityLevel: SecurityLevel = 'STANDARD'): BabelSecurityConfig {
  const config = BABEL_SECURITY_CONFIGS[securityLevel];
  return { ...config, allowedPresets: [...config.allowedPresets] };
}

/**
 * Create a Babel preset for AST validation
 *
 * This preset extends the AgentScript preset with:
 * - `Babel` global (the restricted Babel.transform API)
 * - `__safe_Babel` (transformed version)
 *
 * The Babel global provides:
 * - `Babel.transform(code, options)` - Transform TSX/JSX code
 *
 * Security measures:
 * - Preset whitelist per security level
 * - Input/output size limits per security level
 * - No plugins allowed (they execute arbitrary code)
 * - No source maps (path leakage)
 * - No AST output
 *
 * @param options - Babel preset options
 * @returns Array of validation rules
 *
 * @example
 * ```typescript
 * import { createBabelPreset, JSAstValidator } from 'ast-guard';
 *
 * const rules = createBabelPreset({
 *   securityLevel: 'SECURE',
 * });
 *
 * const validator = new JSAstValidator(rules);
 * const result = await validator.validate(code);
 * ```
 *
 * @example
 * ```javascript
 * // Inside enclave with babel preset:
 * const js = Babel.transform(tsx, {
 *   filename: 'App.tsx',
 *   presets: ['typescript', 'react'],
 *   sourceType: 'module',
 * }).code;
 *
 * return js;
 * ```
 */
export function createBabelPreset(options: BabelPresetOptions = {}): ValidationRule[] {
  const securityLevel = options.securityLevel ?? 'STANDARD';
  const baseGlobals = options.allowedGlobals ?? [];

  return createAgentScriptPreset({
    ...options,
    securityLevel,
    allowedGlobals: [
      ...baseGlobals,
      'Babel', // The Babel global
      '__safe_Babel', // Transformed version (for consistency)
    ],
  });
}
