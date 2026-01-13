/**
 * TypeScript stripper configuration types.
 *
 * @module ts-stripper/config
 */

/**
 * Configuration for TypeScript stripping behavior.
 */
export interface TypeScriptConfig {
  /**
   * Whether TypeScript stripping is enabled.
   * When true, code will be scanned for TypeScript syntax and stripped.
   * @default true
   */
  enabled?: boolean;

  /**
   * How to handle enum declarations.
   * - 'transpile': Convert to JavaScript object (recommended)
   * - 'strip': Remove entirely (will break code using enums)
   * - 'error': Throw error when enum is encountered
   * @default 'transpile'
   */
  enumHandling?: 'transpile' | 'strip' | 'error';

  /**
   * Whether to preserve line/column positions by replacing
   * TypeScript syntax with whitespace instead of removing it.
   * @default true
   */
  preservePositions?: boolean;
}

/**
 * Result of TypeScript stripping operation.
 */
export interface TypeScriptStripResult {
  /**
   * Whether stripping completed successfully.
   */
  success: boolean;

  /**
   * The output JavaScript code with TypeScript syntax removed.
   */
  output: string;

  /**
   * Error information if stripping failed.
   */
  error?: {
    message: string;
    location?: { line: number; column: number };
  };

  /**
   * Statistics about the stripping operation.
   */
  stats: {
    inputLength: number;
    outputLength: number;
    strippedChars: number;
    durationMs: number;
    typesStripped: number;
    interfacesStripped: number;
    enumsTranspiled: number;
  };
}

/**
 * Default TypeScript configuration.
 */
export const DEFAULT_TYPESCRIPT_CONFIG: Required<TypeScriptConfig> = {
  enabled: true,
  enumHandling: 'transpile',
  preservePositions: true,
};
